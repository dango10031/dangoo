import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { CanvasGateway, CanvasSnapshot, CanvasOperation, Scope } from '../contracts/index.js';
import { CONTRACT_VERSION } from '../contracts/index.js';
import { IntegrationError } from './assets.js';

import {applyCanvasOperations, NODE_CATALOG, SUPPORTED_OPERATIONS} from './canvas-operations.js';
export {applyCanvasOperations, NODE_CATALOG} from './canvas-operations.js';
const id=(s:unknown)=>typeof s==='string'&&/^[\w.-]{1,128}$/.test(s);
const invalid=(message:string):never=>{throw new IntegrationError('INVALID_OPERATION',message);};

/** Local integration workbench. Deliberately isolated from real Dangoo and billing. */
export class LocalCanvasGateway implements CanvasGateway {
  private db:Database.Database;
  constructor(path:string){
    this.db=new Database(path);this.db.pragma('journal_mode = WAL');this.db.pragma('busy_timeout = 5000');
    this.db.exec('CREATE TABLE IF NOT EXISTS bridge_canvases (owner TEXT NOT NULL, id TEXT NOT NULL, doc TEXT NOT NULL, PRIMARY KEY(owner,id)); CREATE TABLE IF NOT EXISTS bridge_operations (owner TEXT NOT NULL, canvas TEXT NOT NULL, id TEXT NOT NULL, hash TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(owner,canvas,id));');
  }
  capabilities(){return {contractVersion:CONTRACT_VERSION,revision:'local-workbench-v1',nodes:structuredClone(NODE_CATALOG),operations:[...SUPPORTED_OPERATIONS],jobs:false};}
  seed(scope:Scope,doc?:CanvasSnapshot){this.db.prepare('INSERT OR IGNORE INTO bridge_canvases VALUES (?,?,?)').run(scope.ownerId,scope.canvasId,JSON.stringify(doc??{canvasId:scope.canvasId,revision:0,nodes:[],edges:[]}));}
  async read(scope:Scope):Promise<CanvasSnapshot>{const row=this.db.prepare('SELECT doc FROM bridge_canvases WHERE owner=? AND id=?').get(scope.ownerId,scope.canvasId) as {doc:string}|undefined;if(!row)throw new IntegrationError('CANVAS_NOT_FOUND','画布不存在或无权访问');return JSON.parse(row.doc);}
  async apply(scope:Scope,input:{expectedRevision:number;operationId:string;operations:CanvasOperation[]}){
    if(!id(input.operationId)||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0)invalid('操作 ID 或版本号不合法');
    const hash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
    return this.db.transaction(()=>{
      const prior=this.db.prepare('SELECT hash,result FROM bridge_operations WHERE owner=? AND canvas=? AND id=?').get(scope.ownerId,scope.canvasId,input.operationId) as {hash:string;result:string}|undefined;
      if(prior){if(prior.hash!==hash)throw new IntegrationError('IDEMPOTENCY_CONFLICT','同一操作 ID 被用于不同请求');return JSON.parse(prior.result) as {revision:number;operationId:string};}
      const row=this.db.prepare('SELECT doc FROM bridge_canvases WHERE owner=? AND id=?').get(scope.ownerId,scope.canvasId) as {doc:string}|undefined;
      if(!row)throw new IntegrationError('CANVAS_NOT_FOUND','画布不存在或无权访问');
      const current=JSON.parse(row.doc) as CanvasSnapshot;
      if(current.revision!==input.expectedRevision)throw new IntegrationError('REVISION_CONFLICT',`画布已更新，请重新读取。当前版本 ${current.revision}`);
      const next=applyCanvasOperations(current,input.operations);const result={revision:next.revision,operationId:input.operationId};
      this.db.prepare('UPDATE bridge_canvases SET doc=? WHERE owner=? AND id=?').run(JSON.stringify(next),scope.ownerId,scope.canvasId);
      this.db.prepare('INSERT INTO bridge_operations VALUES (?,?,?,?,?)').run(scope.ownerId,scope.canvasId,input.operationId,hash,JSON.stringify(result));return result;
    }).immediate();
  }
  async operation(scope:Scope,operationId:string){
    const row=this.db.prepare('SELECT result FROM bridge_operations WHERE owner=? AND canvas=? AND id=?').get(scope.ownerId,scope.canvasId,operationId) as {result:string}|undefined;
    return row?JSON.parse(row.result) as {revision:number;operationId:string}:undefined;
  }
  close(){this.db.close();}
}
