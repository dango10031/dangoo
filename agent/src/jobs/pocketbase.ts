import {fromDangoo} from '../adapters/pocketbase-mapping.js';
import {imageNodeInput,applyImageResult} from './node-input.js';
declare const $app:any,$os:any,$http:any,Record:any,Collection:any;
const collection='agent_node_jobs';
const families=[
  ['gpt-image-2','gpt-image-2-image-to-image-official-stable'],
  ['gpt-image-2-0-text-to-image-channel-low-price','gpt-image-2-0-edit-channel-low-price'],
  ['nano-banana2-gemini31flash-text-to-image-official-stable','nano-banana2-gemini31flash-image-to-image-official-stable'],
  ['nano-banana2','nano-banana2-gemini31flash-image-to-image-channel-low-price'],
  ['nano-banana-pro-text-to-image-ultra-official-stable','nano-banana-pro-edit-ultra-official-stable'],
  ['nano-banana-pro','nano-banana-pro-edit-channel-low-price'],
].map(([key,i2])=>({key:key!,t2:key!,i2:i2!,media:'image'}));
const json=(r:any,key:string)=>JSON.parse(String(r.get(key)||'null'));
const fail=(code:string):never=>{throw new Error(code);};
export function enabled(){return /^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/.test(String($os.getenv('AGENT_AIGC_INTERNAL_URL')||''));}
export function bootstrap(){
  try{$app.findCollectionByNameOrId(collection);return;}catch{/* collection already exists */}
  $app.save(new Collection({type:'base',name:collection,listRule:null,viewRule:null,createRule:null,updateRule:null,deleteRule:null,
    fields:[{name:'owner',type:'text',required:true,max:190},{name:'canvas',type:'text',required:true,max:128},{name:'operation_id',type:'text',max:128},{name:'payload',type:'json'},{name:'created',type:'autodate',onCreate:true}],
    indexes:['CREATE UNIQUE INDEX agent_node_job_operation ON agent_node_jobs (owner, canvas, operation_id) WHERE operation_id != \'\'']}));
}
function canvas(app:any,id:string,owner:string){
  let r:any;try{r=app.findRecordById('canvases',id);}catch{/* missing canvas */}
  if(!r||String(r.get('rh_user_id'))!==owner||r.getBool('is_deleted'))fail('CANVAS_NOT_FOUND');
  return r;
}
function owned(app:any,id:string,owner:string,canvasId:string){
  let r:any;try{r=app.findRecordById(collection,id);}catch{/* missing job */}
  if(!r||String(r.get('owner'))!==owner||String(r.get('canvas'))!==canvasId)fail('JOB_NOT_FOUND');
  return r;
}
function request(e:any,path:string,body?:unknown){
  if(!enabled())fail('GENERATION_NOT_CONFIGURED');
  const input=e.requestInfo().headers||{};
  const headers:any={'Content-Type':'application/json'};
  for(const [target,keys] of Object.entries({Authorization:['authorization','Authorization'],Cookie:['cookie','Cookie'],'X-RH-Vibex-App':['x_rh_vibex_app','x-rh-vibex-app'],'X-RH-Vibex-Ticket':['x_rh_vibex_ticket','x-rh-vibex-ticket'],'X-RH-Vibex-Sign':['x_rh_vibex_sign','x-rh-vibex-sign']})) {
    for(const key of keys)if(input[key]){headers[target]=String(input[key]);break;}
  }
  const response=$http.send({url:String($os.getenv('AGENT_AIGC_INTERNAL_URL'))+path,method:body===undefined?'GET':'POST',headers,body:body===undefined?'':JSON.stringify(body),timeout:65});
  let result:any;try{result=JSON.parse(response.raw);}catch{fail('AIGC_INVALID_RESPONSE');}
  if(response.statusCode<200||response.statusCode>=300||(result.error&&result.ok!==true))fail('AIGC_REQUEST_FAILED');
  return result;
}
function publicJob(record:any,p:any){return {id:record.id,operationId:p.operationId||'',nodeId:p.nodeId,state:p.state,remoteId:p.remoteId,results:[],storageState:p.storageState||'pending',applyState:p.applyState||'pending',error:p.error,revision:p.appliedRevision,outputUrl:p.outputUrl};}
function persist(record:any,p:any,app=$app){record.set('payload',p);app.save(record);}
function summarize(record:any,p:any){return {id:record.id,nodeId:p.nodeId,expectedRevision:p.revision,model:p.body.model,prompt:p.body.prompt,referenceCount:(p.body.imageUrls||[]).length,price:p.price,expiresAt:p.expiresAt,approved:p.approved===true};}

export function handle(e:any,action:string){
  try{
    const owner=String(e.get('authEmail')||'').trim().toLowerCase();if(!owner)return e.json(401,{error:'AUTH_REQUIRED'});
    const canvasId=e.request.pathValue('id'), body=e.requestInfo().body||{};
    const current=canvas($app,canvasId,owner);
    if(action==='models'){
      const catalogue=request(e,'/api/aigc/models');
      return e.json(200,{models:(catalogue.models||[]).filter((m:any)=>m.output_type==='image').map((m:any)=>({model:m.model,parameters:m.scalar_params,referenceRequired:(m.media_params||[]).some((p:any)=>p.required)})),families});
    }
    if(action==='quote'){
      const doc=json(current,'canvas_data');
      if(Number(doc.rev||0)!==body.expectedRevision)fail('REVISION_CONFLICT');
      const catalogue=request(e,'/api/aigc/models');
      const models=catalogue.models||catalogue;
      const indexed=Array.isArray(models)?Object.fromEntries(models.map((m:any)=>[m.name||m.model,m])):models;
      const input=imageNodeInput(fromDangoo(canvasId,doc),String(body.nodeId),indexed,families);
      if(Array.isArray(input.body.imageUrls))input.body.imageUrls=input.body.imageUrls.map(url=>request(e,'/api/media/rh-url',{url}).url);
      const price=request(e,'/api/agent-bridge/v1/wallet-quote',input.body);
      if(price.ok!==true)fail('PRICE_UNAVAILABLE');
      const rec=new Record($app.findCollectionByNameOrId(collection));rec.set('owner',owner);rec.set('canvas',canvasId);rec.set('operation_id','');
      const payload={...input,price,expiresAt:Date.now()+10*60*1000,approved:false,state:'created'};
      persist(rec,payload);return e.json(200,summarize(rec,payload));
    }
    if(action==='operation'){
      const matches=$app.findRecordsByFilter(collection,'owner = {:o} && canvas = {:c} && operation_id = {:i}','',1,0,{o:owner,c:canvasId,i:e.request.pathValue('operationId')});
      return e.json(200,matches.length?publicJob(matches[0],json(matches[0],'payload')):null);
    }
    const jobId=String(body.quoteId||e.request.pathValue('jobId')||'');
    let rec=owned($app,jobId,owner,canvasId),p=json(rec,'payload');
    if(action==='quote_get')return e.json(200,summarize(rec,p));
    if(action==='approve'){
      $app.runInTransaction((app:any)=>{
        rec=owned(app,jobId,owner,canvasId);p=json(rec,'payload');
        if(p.state!=='created'||p.expiresAt<Date.now())fail('QUOTE_EXPIRED');
        if(Number(json(canvas(app,canvasId,owner),'canvas_data').rev||0)!==p.revision)fail('REVISION_CONFLICT');
        p.approved=true;persist(rec,p,app);
      });return e.json(200,summarize(rec,p));
    }
    if(action==='run'){
      if(!/^[\w.-]{1,128}$/.test(String(body.operationId||'')))fail('INVALID_OPERATION');
      let submit=false;
      $app.runInTransaction((app:any)=>{
        rec=owned(app,jobId,owner,canvasId);p=json(rec,'payload');
        if(body.nodeId!==p.nodeId||body.expectedRevision!==p.revision)fail('QUOTE_MISMATCH');
        if(p.operationId){if(p.operationId!==body.operationId)fail('IDEMPOTENCY_CONFLICT');return;}
        if(!p.approved)fail('APPROVAL_REQUIRED');
        if(p.expiresAt<Date.now())fail('QUOTE_EXPIRED');
        if(Number(json(canvas(app,canvasId,owner),'canvas_data').rev||0)!==p.revision)fail('REVISION_CONFLICT');
        p.operationId=body.operationId;p.state='submitting';rec.set('operation_id',body.operationId);persist(rec,p,app);submit=true;
      });
      if(submit){
        try{
          const accepted=request(e,'/api/aigc/submit',{...p.body,idemKey:p.operationId,agentMaxCharge:p.price.estimatedPrice});
          if(!accepted.taskId)fail('SUBMISSION_UNKNOWN');
          p.remoteId=String(accepted.taskId);p.state='submitted';p.chargeAmount=accepted.chargeAmount;persist(rec,p);
        }catch{
          p.state='submission_unknown';p.error='提交结果未知，将按操作记录对账，禁止自动重试';persist(rec,p);
        }
      }
      return e.json(200,publicJob(rec,p));
    }
    if(action==='get'){
      if(p.state==='submitting'||p.state==='submission_unknown'){
        const matches=$app.findRecordsByFilter('aigc_tasks','user_email = {:o} && idem_key = {:i} && model_name = {:m}','-created',2,0,{o:owner,i:p.operationId,m:p.body.model});
        if(matches.length===1){p.remoteId=String(matches[0].get('task_id'));p.state='submitted';delete p.error;persist(rec,p);}
        else {p.state='submission_unknown';persist(rec,p);return e.json(200,publicJob(rec,p));}
      }
      if(p.remoteId&&['submitted','running'].includes(p.state)){
        const remote=request(e,'/api/aigc/jobs/'+encodeURIComponent(p.remoteId)+'/poll',{});
        const state=String(remote.status||'').toUpperCase();
        if(state==='FAILED'||state==='CANCEL'){p.state='failed';p.error='节点生成失败';}
        else if(state==='SUCCESS'&&remote.outputs?.[0]?.url){p.state='succeeded';p.remoteOutput=String(remote.outputs[0].url);}
        else p.state='running';persist(rec,p);
      }
      if(p.state==='succeeded'&&p.storageState!=='stored'){
        try{const media=request(e,'/api/media/save-remote',{url:p.remoteOutput,mediaType:'image'});if(!media.url)fail('STORAGE_FAILED');p.outputUrl=media.url;p.storageState='stored';delete p.error;}
        catch{p.storageState='failed';p.error='图片已生成，永久存储尚未完成，可再次查询重试转存';}persist(rec,p);
      }
      if(p.state==='succeeded'&&p.storageState==='stored'&&p.applyState!=='applied'){
        $app.runInTransaction((app:any)=>{
          rec=owned(app,jobId,owner,canvasId);p=json(rec,'payload');
          if(p.applyState==='applied')return;
          const target=canvas(app,canvasId,owner),doc=json(target,'canvas_data');
          const applied=applyImageResult(doc,p.nodeId,p.operationId,{url:p.outputUrl,model:p.body.model,promptText:p.body.prompt,taskId:p.remoteId,costText:p.chargeAmount?'¥'+Number(p.chargeAmount).toFixed(2):''});
          p.applyState=applied.applyState;
          if(applied.doc!==doc){target.set('canvas_data',applied.doc);app.save(target);}p.appliedRevision=applied.doc.rev;persist(rec,p,app);
        });
      }
      return e.json(200,publicJob(rec,p));
    }
    fail('INVALID_ACTION');
  }catch(err:any){
    const raw=String(err.code||err.message||'BRIDGE_ERROR');
    const code=/^[A-Z_]+$/.test(raw)?raw:'BRIDGE_ERROR';
    return e.json(code.endsWith('NOT_FOUND')?404:['REVISION_CONFLICT','IDEMPOTENCY_CONFLICT','QUOTE_EXPIRED'].includes(code)?409:code==='APPROVAL_REQUIRED'?403:400,{error:code});
  }
}
