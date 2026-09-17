import test from 'node:test';
import assert from 'node:assert/strict';
import {AgentRuntime} from '../src/core/runtime.js';
import {SqliteStore} from '../src/core/store.js';
import {ProviderRegistry} from '../src/providers/index.js';
import {LocalCanvasGateway,UnavailableAssetGateway,createCanvasTools} from '../src/adapters/index.js';
import type {Provider,ProviderEvent} from '../src/contracts/index.js';

test('real runtime -> registered canvas tool -> SQLite canvas -> durable conversation events',async()=>{
 const store=new SqliteStore();const canvas=new LocalCanvasGateway(':memory:');
 const scope={ownerId:'alice',canvasId:'art'};canvas.seed(scope);
 let rounds=0;
 const provider:Provider={id:'fixture',revision:'fixture-1',capabilities:()=>({contextWindow:32000,maxOutputTokens:1000,tools:true,vision:false,parallelTools:true}),async *stream(request){
   rounds++;
   if(rounds===1){
     yield {type:'tool.call',call:{id:'vendor:id/with.special',name:'canvas_apply',arguments:{expectedRevision:0,operations:[{type:'create',node:{id:'composition',kind:'prompt',x:50,y:80,data:{title:'构图方向',prompt:'低饱和暖沙色，保留主体'}}}]}}} satisfies ProviderEvent;
     yield {type:'done',reason:'tool_calls'};
   }else{
     const result=request.messages.find(m=>m.role==='tool');assert(result,'model receives paired tool result');
     assert.match(JSON.stringify(result),/revision/);
     yield {type:'text.delta',text:'已加入构图节点。'};yield {type:'done',reason:'stop'};
   }
 }};
 const runtime=new AgentRuntime({store,providers:new ProviderRegistry([provider]),tools:createCanvasTools(canvas,new UnavailableAssetGateway()),canvas});
 await runtime.ready();const session=runtime.createSession({...scope,model:'fixture'});
 let off=()=>{};const terminal=new Promise<string>((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('runtime did not terminate')),3000);
   off=runtime.subscribe(session.id,e=>{if(e.type==='run.updated'&&['completed','failed','partial'].includes(String(e.data.state))){clearTimeout(timer);resolve(String(e.data.state));}});
 });
 await runtime.sendMessage(session.id,{text:'加入一个构图提示词节点',selection:{nodeIds:[],assets:[]}});
 assert.equal(await terminal,'completed');off();
 const actual=await canvas.read(scope);assert.equal(actual.revision,1);assert.equal(actual.nodes[0].id,'composition');
 const events=runtime.getEvents(session.id);assert(events.some(e=>e.type==='canvas.changed'));assert(events.some(e=>e.type==='assistant.delta'));
 assert.equal(new Set(events.map(e=>e.sequence)).size,events.length);
 await new Promise(resolve=>setTimeout(resolve,5));canvas.close();store.close();
});
