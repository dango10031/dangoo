import type {CanvasSnapshot} from '../contracts/index.js';
import {IntegrationError} from '../adapters/assets.js';

export interface ImageModel {output_type?:string;scalar_params?:Array<{name:string;default?:unknown;enum?:unknown[]}>;media_params?:Array<{name:string;required?:boolean}>;}
export function imageNodeInput(snapshot:CanvasSnapshot,nodeId:string,models:Record<string,ImageModel>,families:Array<{key:string;t2?:string;i2:string;media:string}>) {
  const node=snapshot.nodes.find(n=>n.id===nodeId);
  if(!node||node.kind!=='generate')throw new IntegrationError('NODE_NOT_RUNNABLE','当前仅支持标准图片生成节点');
  const d=node.data, params=(d.genParams??{}) as Record<string,unknown>;
  if(Number(params.count??1)!==1)throw new IntegrationError('UNSUPPORTED_NODE_OPTIONS','请将节点生成数量设为 1');
  if(d.cameraSnapshot||d.cameraNodeId||d.cropContext||params.transparentBg)throw new IntegrationError('UNSUPPORTED_NODE_OPTIONS','此节点含暂未接入的摄影机、选区或透明背景参数，请使用画布原有生成按钮');
  const incoming=snapshot.edges.filter(e=>e.to===nodeId).map(e=>snapshot.nodes.find(n=>n.id===e.from)).filter(Boolean);
  const prompts=incoming.filter(n=>n!.kind==='prompt').map(n=>String(n!.data.prompt||'')).filter(Boolean);
  const prompt=[...prompts,String(d.prompt||'')].filter(Boolean).join('\n');
  if(!prompt.trim())throw new IntegrationError('PROMPT_REQUIRED','生成节点或上游提示词节点需要提示词');
  const ownResults=Array.isArray(d.results)?d.results as Array<Record<string,unknown>>:[];
  const ownUrl=typeof d.url==='string'&&!ownResults.some(r=>r.url===d.url&&r.itemStatus==='success')?d.url:undefined;
  const refs=[ownUrl,...(Array.isArray(d.refUrls)?d.refUrls:[]),...incoming.filter(n=>n!.kind!=='video'&&!(Array.isArray(n!.data.results)&&(n!.data.results as Array<Record<string,unknown>>)[Number(n!.data.activeResultIndex)||0]?.isVideo)).map(n=>n!.data.url)].filter((v):v is string=>typeof v==='string'&&!!v);
  const imageUrls=Array.from(new Set(refs)).slice(0,9);
  if(imageUrls.some(u=>!/^https?:\/\//.test(u)&&!u.startsWith('/api/files/media_files/')))throw new IntegrationError('REFERENCE_UNAVAILABLE','参考图需要先保存到画布媒体存储');
  const selected=String(params.model||d.model||'');
  const family=families.find(f=>f.key===selected||f.i2===selected||f.t2===selected);
  const model=family?(imageUrls.length?family.i2:family.t2):selected;
  const info=model?models[model]:undefined;
  if(!model||!info||info.output_type!=='image')throw new IntegrationError('MODEL_NOT_SUPPORTED','请选择已启用的标准图片模型');
  if(info.media_params?.some(p=>p.required)&&!imageUrls.length)throw new IntegrationError('REFERENCE_REQUIRED','此模型需要参考图片');
  const body:Record<string,unknown>={model,prompt,page:'canvas-agent'};
  for(const p of info.scalar_params??[]) {
    const value=params[p.name]??p.default;
    if(value===undefined||value==='empty')continue;
    if(p.enum&&!p.enum.includes(value))throw new IntegrationError('INVALID_NODE_PARAMETER',`节点参数 ${p.name} 不在模型支持范围`);
    body[p.name]=value;
  }
  if(imageUrls.length)body.imageUrls=imageUrls;
  return {nodeId,revision:snapshot.revision,body};
}

type CanvasDoc={rev?:number;cards?:Array<Record<string,unknown>>;view?:unknown};

/** Append only the reserved result; preserve edits and a user's active result selection. */
export function applyImageResult<T extends CanvasDoc>(doc:T,nodeId:string,operationId:string,result:Record<string,unknown>):{doc:T;applyState:'target_missing'|'conflict'|'applied'} {
  const cards=Array.isArray(doc.cards)?doc.cards:[];
  const card=cards.find((c)=>c.id===nodeId);
  if(!card)return {doc,applyState:'target_missing' as const};
  if(card.kind!=='generate')return {doc,applyState:'conflict' as const};
  const items=Array.isArray(card.results)?card.results as Array<Record<string,unknown>>:[];
  if(items.some((r)=>r.agentOperationId===operationId))return {doc,applyState:'applied' as const};
  const item={...result,agentOperationId:operationId,itemStatus:'success',isVideo:false};
  const next:Record<string,unknown>={...card,results:[...items,item]};
  if(!items.length&&!card.url){next.url=result.url;next.activeResultIndex=0;next.jobStatus='success';}
  return {doc:{...doc,rev:(Number(doc.rev)||0)+1,cards:cards.map((c)=>c.id===nodeId?next:c)} as T,applyState:'applied' as const};
}
