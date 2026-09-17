/** Stable, provider-neutral contract. Business identity comes from the host, never tool arguments. */
export const CONTRACT_VERSION = '1.0.0';
export type JsonSchema = Record<string, unknown>;
export type Json = null | boolean | number | string | Json[] | {[key: string]: Json};
export interface AssetRef { assetId: string; version: number; role?: 'reference' | 'edit_source' | 'result'; }
export type ContentPart = {type:'text'; text:string} | {type:'image'; url:string; mimeType?:string; asset?:AssetRef} | {type:'asset'; ref:AssetRef};
export interface ToolCall {id:string; name:string; arguments:unknown;}
export interface Message {id:string; role:'system'|'user'|'assistant'|'tool'; content:ContentPart[]; toolCalls?:ToolCall[]; callId?:string; createdAt:number;}
export interface Usage {inputTokens:number; outputTokens:number; cachedTokens?:number;}
export interface ModelCapabilities {contextWindow:number; maxOutputTokens:number; tools:boolean; vision:boolean; parallelTools:boolean;}
export interface ToolSpec {name:string; description:string; inputSchema:JsonSchema; revision:string;}
export interface ProviderRequest {model:string; messages:Message[]; tools:ToolSpec[]; signal:AbortSignal; maxOutputTokens:number; temperature?:number;}
export type ProviderEvent = {type:'text.delta'; text:string} | {type:'tool.call'; call:ToolCall} | {type:'usage'; usage:Usage} | {type:'done'; reason:'stop'|'tool_calls'|'length'};
export interface Provider {id:string; revision:string; capabilities(model:string):ModelCapabilities; stream(request:ProviderRequest):AsyncIterable<ProviderEvent>; scoped?(scope:Scope):Provider; listPlatformModels?: () => string[];}
export interface ProviderRegistryLike {get(id:string):Provider; list():{id:string; revision:string}[];}
export type RunState = 'queued'|'running'|'waiting_user'|'waiting_jobs'|'compacting'|'completed'|'partial'|'stopped'|'failed';
export interface Scope {ownerId:string; canvasId:string;}
export interface Selection {nodeIds:string[]; assets:AssetRef[]; revision?:number;}
export interface Session {id:string; scope:Scope; createdAt:number; providerId:string; model:string;}
export interface Run {id:string; sessionId:string; turnId:string; state:RunState; providerId:string; model:string; providerRevision:string; toolRevision:string; skillRevision:string; createdAt:number; updatedAt:number; error?:string; wait?:WaitRequest;}
export interface AgentEvent {sessionId:string; runId?:string; turnId?:string; sequence:number; type:string; data:Record<string,unknown>; createdAt:number;}
export interface WaitRequest {kind:'question'|'approval'|'jobs'; id:string; prompt:string; options?:string[]; jobIds?:string[]; payload?:Record<string,unknown>;}
export interface ToolResult {content:ContentPart[]; data?:unknown; error?:{code:string; message:string; retryable?:boolean}; wait?:WaitRequest;}
export interface ToolContext {session:Session; run:Run; signal:AbortSignal; operationId:string; selection?:Selection; emit(type:string,data:Record<string,unknown>):void;}
export interface ToolDefinition extends ToolSpec {
  effect:'read'|'write'|'external'; parallelSafe:boolean; timeoutMs?:number;
  lockKey?(args:unknown, context:ToolContext):string;
  execute(args:unknown, context:ToolContext):Promise<ToolResult>;
  /** Called after a crash; never blindly repeats external effects. */
  reconcile?(operationId:string, context:ToolContext):Promise<ToolResult|undefined>;
}
export interface ToolRegistryLike {snapshot():{revision:string; tools:readonly ToolDefinition[]};}
export interface SkillMetadata {name:string; description:string; revision:string; scope:'builtin'|'workspace'|'user'; enabled:boolean; implicit:boolean; dependencies:string[]; path:string;}
export interface SkillSnapshot {revision:string; skills:readonly SkillMetadata[];}
export interface SkillRegistryLike {snapshot():SkillSnapshot; catalog(snapshot?:SkillSnapshot):string; read(name:string,snapshot?:SkillSnapshot):Promise<string>; resource(name:string,relativePath:string,snapshot?:SkillSnapshot):Promise<string>;}
export interface ContextState {messages:Message[]; summary?:string; summaryVersion:number; pinned:Record<string,unknown>; viewedAssets:AssetRef[];}
export interface CompactResult {state:ContextState; changed:boolean; reason?:string;}
export interface ContextManagerLike {
  estimate(messages:Message[]):number;
  prepare(state:ContextState, system:string, capabilities:ModelCapabilities, tools?:ToolSpec[]):Message[];
  needsCompact(state:ContextState, capabilities:ModelCapabilities, system?:string, tools?:ToolSpec[]):boolean;
  exceedsWindow(state:ContextState, capabilities:ModelCapabilities, system?:string, tools?:ToolSpec[]):boolean;
  compact(state:ContextState, provider:Provider, model:string, signal:AbortSignal):Promise<CompactResult>;
}
export interface AssetRecord extends AssetRef {name:string; mediaType:'image'|'video'|'audio'; source:'upload'|'generation'|'import'|'edit'; metadataRevision:number; width?:number; height?:number; durationMs?:number; description?:string; tags:string[]; canvasId?:string; createdAt:number; parents:AssetRef[]; storageState:'pending'|'stored'|'failed';}
export interface AssetAccess {ref:AssetRef; kind:'image'|'video'|'audio'; url:string; expiresAt?:number; mimeType:string;}
export interface AssetSearch {query?:string; mediaType?:AssetRecord['mediaType']; scope?:'canvas'|'library'; cursor?:string; limit?:number;}
export interface AssetGateway {available:boolean; search(scope:Scope,query:AssetSearch):Promise<{items:AssetRecord[];nextCursor?:string}>; get(scope:Scope,ref:AssetRef):Promise<AssetRecord>; view(scope:Scope,ref:AssetRef):Promise<AssetAccess>;}
export interface CanvasNode {id:string; kind:string; x:number; y:number; data:Record<string,unknown>;}
export interface CanvasEdge {id:string; from:string; to:string;}
export interface CanvasSnapshot {canvasId:string; revision:number; nodes:CanvasNode[]; edges:CanvasEdge[]; selection?:Selection;}
export type CanvasOperation =
 | {type:'create';node:CanvasNode} | {type:'update';nodeId:string;patch:Record<string,unknown>}
 | {type:'delete';nodeId:string} | {type:'duplicate';nodeId:string;newId:string;x:number;y:number}
 | {type:'connect';edge:CanvasEdge} | {type:'disconnect';edgeId:string}
 | {type:'layout';positions:{nodeId:string;x:number;y:number}[]}
 | {type:'attach_asset';nodeId:string;asset:AssetRef} | {type:'select_result';nodeId:string;asset:AssetRef}
 | {type:'group';id:string;nodeIds:string[]} | {type:'ungroup';id:string};
export interface NodeCapability {kind:string;name:string;description:string;parameters:JsonSchema;runnable:boolean;}
export interface JobRecord {id:string;operationId:string;nodeId:string;state:'created'|'submitting'|'submitted'|'running'|'succeeded'|'failed'|'canceled'|'submission_unknown';remoteId?:string;results:AssetRef[];storageState:'pending'|'stored'|'failed';applyState:'pending'|'applied'|'conflict'|'target_missing';error?:string;}
export interface NodeQuote {id:string;nodeId:string;expectedRevision:number;model:string;prompt:string;referenceCount:number;price:Record<string,unknown>;expiresAt:number;approved:boolean;}
export interface CanvasGateway {
  capabilities():{contractVersion:string;revision:string;nodes:NodeCapability[];operations:CanvasOperation['type'][];jobs:boolean};
  read(scope:Scope):Promise<CanvasSnapshot>;
  apply(scope:Scope,input:{expectedRevision:number;operationId:string;operations:CanvasOperation[]}):Promise<{revision:number;operationId:string}>;
  operation?(scope:Scope,id:string):Promise<{revision:number;operationId:string}|undefined>;
  quote?(scope:Scope,input:{nodeId:string;expectedRevision:number}):Promise<NodeQuote>;
  imageModels?(scope:Scope):Promise<unknown>;
  getQuote?(scope:Scope,id:string):Promise<NodeQuote>;
  approveQuote?(scope:Scope,id:string):Promise<NodeQuote>;
  run?(scope:Scope,input:{nodeId:string;operationId:string;expectedRevision:number;quoteId?:string}):Promise<JobRecord>;
  job?(scope:Scope,id:string):Promise<JobRecord>;
  jobOperation?(scope:Scope,id:string):Promise<JobRecord|undefined>;
  cancel?(scope:Scope,id:string):Promise<JobRecord>;
}
export interface HostBridge {contractVersion:string;canvasId:string;getSelection():Selection;beforeSend?():Promise<void>;locateNode(id:string):void;previewAsset(ref:AssetRef):void;onCanvasChanged?(revision:number):void;}
