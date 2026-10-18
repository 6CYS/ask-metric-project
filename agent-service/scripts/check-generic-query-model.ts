/** 固定配对：真实模型 + 当前版本真实目录解析/契约/治理/planner/SQL；数据仅内存合成。 */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {BACKGROUND_CONTEXT, type AgentMessage} from '@earendil-works/pi-agent-core';
import {loadConfig} from '../src/config.js';
import {createAskMetricModels} from '../src/models.js';
import {HarnessHost} from '../src/harnessHost.js';
import {NativeSessionStore} from '../src/nativeSessions.js';
import {NativeFrameStore, NativeBusinessResultStore} from '../src/business-context/store.js';
import {BusinessContextService} from '../src/business-context/service.js';
import {createCapabilities} from '../src/business-context/capabilities.js';
import {createFieldResolvers} from '../src/business-context/resolvers.js';
import {createAskMetricTools} from '../src/tools/index.js';
import {loadBusinessSkills, createBusinessSkillReadTool} from '../src/businessSkills.js';
import {projectEntries} from '../src/sessionProjection.js';
import {frameClarificationOptions} from '../src/business-context/modelView.js';
import {renderClarificationOptions} from '../src/business-context/clarificationOptions.js';
import {toContextDelta} from '../src/business-context/turnArgs.js';
import {BackendApiError, type BackendClient, type BackendUser, type BasicQuerySpec} from '../src/backendClient.js';
import type {BusinessFrame, FieldResolution} from '../src/business-context/types.js';

const METRIC='经营收益金额当日数', CODE='SYNTH_M:D', DATE='2026-05-31', NEXT='2026-06-30';
const MONTH={start:'2026-05-01',end:DATE}, day=(date=DATE)=>({start:date,end:date});
const ORGS:Record<string,string>={合成机构甲:'SYNTH_O1',合成机构乙:'SYNTH_O2',合成机构丙:'SYNTH_O3',合成机构丁:'SYNTH_O4',待确认机构正式全称:'SYNTH_PENDING'};
const actor:BackendUser={id:'synthetic-generic-query',username:'synthetic',display_name:'隔离通用验收',org_code:'SYNTH_ROOT',org_name:'合成集团',role_code:'USER'};
type Expect={kind:'value'|'position'|'clarify_scope'|'clarify_time_scope'|'confirm_metric'|'partial'; org?:string; time?:{start:string;end:string}; selection?:string; compare?:string[]; metricText?:string};
type Step={message:string;expected:Expect;select?:'metrics'|'organizations'};
type Scenario={name:string;seed?:boolean;steps:Step[]};
const scenarios:Scenario[]=[
 {name:'explicit_value',steps:[{message:`查询合成机构甲2026年5月31日${METRIC}。`,expected:{kind:'value',org:'SYNTH_O1',time:day(),selection:'exact'}}]},
 {name:'position_not_top_n',steps:[{message:`查询合成机构甲2026年5月31日${METRIC}在合成机构甲、合成机构乙、合成机构丙三家中的位次。`,expected:{kind:'position',org:'SYNTH_O1',time:day(),selection:'exact',compare:['SYNTH_O1','SYNTH_O2','SYNTH_O3']}}]},
 {name:'position_with_missing_data',steps:[{message:`合成机构甲2026年5月${METRIC}在合成机构甲、合成机构乙、合成机构丙、合成机构丁中的位次是多少？取当月最后有数据日期，并说明比较范围的缺数情况。`,expected:{kind:'position',org:'SYNTH_O1',time:MONTH,selection:'latest_in_range',compare:['SYNTH_O1','SYNTH_O2','SYNTH_O3','SYNTH_O4']}}]},
 {name:'position_missing_scope',steps:[{message:`查询合成机构甲2026年5月31日${METRIC}的位次。`,expected:{kind:'clarify_scope',org:'SYNTH_O1',time:day()}}]},
 {name:'original_goal_missing_business_choices',steps:[{message:`对合成机构乙2026年6月${METRIC}进行排名，我想知道该机构在可比较机构总体中的位次。`,expected:{kind:'clarify_time_scope',org:'SYNTH_O2',time:{start:'2026-06-01',end:NEXT}}}]},
 {name:'full_typo_mention_confirmation',steps:[
  {message:'查询合成机构甲2026年5月经营收益金融当日数，取该月最后有数据的日期。',expected:{kind:'confirm_metric',org:'SYNTH_O1',time:MONTH,metricText:'经营收益金融当日数'}},
  {message:METRIC,select:'metrics',expected:{kind:'value',org:'SYNTH_O1',time:MONTH,selection:'latest_in_range'}}]},
 {name:'partial_point_choice_then_change',seed:true,steps:[
  {message:METRIC,select:'metrics',expected:{kind:'partial',time:day()}},
  {message:'选择这个机构，同时把日期改为2026-06-30，其余不变。',select:'organizations',expected:{kind:'value',org:'SYNTH_PENDING',time:day(NEXT),selection:'exact'}}]},
];
const obj=(v:unknown):Record<string,any>=>v&&typeof v==='object'?v as Record<string,any>:{};
const bridgeCache=new Map<string,unknown>();
function python(payload:unknown):any{
 const input=JSON.stringify(payload),cached=bridgeCache.get(input);if(cached)return structuredClone(cached);
 const root=resolve(import.meta.dirname,'../..'),executable=join(root,'backend-next/.venv/bin/python');
 const out=JSON.parse(execFileSync(executable,[join(import.meta.dirname,'generic-query-fixture.py')],{input,encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024}));
 if(!out.ok)throw new BackendApiError(422,out.message,out.error==='ValidationError'?'QUERY_SPEC_INVALID':'FIXTURE_GOVERNANCE_REJECTED');
 if(obj(payload).action!=='query')bridgeCache.set(input,out.value);return out.value;
}
const resolveCatalog=async(entity:string,raw:string[]):Promise<FieldResolution>=>python({action:'resolve',entity,raw});
function backend(){
 const queries:any[]=[],results=new Map<string,any>();
 const client={resolveBusinessField:resolveCatalog,matchMetricQuestion:async(question:string)=>python({action:'mentions',question}),
  searchMetrics:async(keyword:string)=>({items:METRIC.includes(keyword)||keyword===CODE?[{metric_code:CODE,metric_name:METRIC,unit:'元',score:1,match_type:'exact'}]:[],total:METRIC.includes(keyword)||keyword===CODE?1:0,semantic_suggestions:[]}),
  searchOrganizations:async(keyword:string)=>{const items=Object.entries(ORGS).filter(([name,code])=>name.includes(keyword)||code===keyword).map(([name,code])=>({org_code:code,org_name:name,score:1,match_type:name===keyword?'exact':'contains'}));return{items,total:items.length};},
  metricCatalogOverview:async()=>({total:2,groups:[{unit:'元',count:2,examples:[{code:CODE,name:METRIC}]}]}),
  createAgentQueryContext:async()=>({conversation_id:'synthetic-generic-query'}),
  basicQueries:async(spec:BasicQuerySpec)=>{
   const call:any={spec:structuredClone(spec)};queries.push(call);const actual=python({action:'query',spec});call.actual=actual;
   const id=`synthetic-query-${queries.length}`,facts=actual.rows.map((row:any,index:number)=>({...row,fact_id:`fact:${id}:${index}:metric_value`,task_id:id,field:'metric_value',value:String(row.metric_value),unit:'元',date:row.stat_date}));
   const result={task_id:id,result_id:`result-${id}`,status:'succeeded',rows:actual.rows,columns:Object.keys(actual.rows[0]??{}),row_count:actual.rows.length,truncated:false,facts,
    message:'隔离合成 SQL 执行完成。',evidence:{logical_dsl:spec,synthetic_sql_executed:true,ranking:actual.rows.map((r:any)=>({with_data:r.rank_population,without_data:r.missing_population,total:r.comparison_population}))}};
   results.set(id,result);return{query:spec,result};
  },getTask:async(id:string)=>({task_id:id,status:'SUCCEEDED',version:1,result:{result_id:`result-${id}`}}),
  getTaskResult:async(id:string)=>{assert.ok(results.has(id),'SYNTHETIC_TASK_MISSING');return results.get(id);},
 }as unknown as BackendClient;return{client,queries};
}
async function seed(frames:NativeFrameStore,sessionId:string){
 const service=new BusinessContextService(frames,createCapabilities(),createFieldResolvers()),initial=await service.resolve({capabilityHint:'metric_query',baseReference:null,executionMode:'resolve_more',fieldChanges:[
  {fieldHint:'metrics',operation:'set',rawValue:METRIC},{fieldHint:'organizations',operation:'set',rawValue:'待确认机构正式全称'},
  {fieldHint:'time',operation:'set',rawValue:DATE},{fieldHint:'selection',operation:'set',rawValue:'exact'}]},
 {sessionId,turnId:'seed',requestId:'seed'},{originalMessage:`${METRIC} 待确认机构正式全称 ${DATE}`,currentDate:'2026-10-13',turnId:'seed',resolveCatalog});
 assert.equal(initial.status,'ready','SEED_MUST_VALIDATE');const id=randomUUID();
 const pending:BusinessFrame={...initial,frameId:id,operationFrameId:id,status:'clarifying',fields:{...initial.fields,
  metrics:{rawValue:'经营收益金融当日数',source:'explicit',resolver:'metric',resolutionStatus:'needs_confirmation',candidates:[{value:METRIC,code:CODE,metadata:{rawValueIndex:0}}]},
  organizations:{rawValue:'待确认机构',source:'explicit',resolver:'organization',resolutionStatus:'needs_confirmation',candidates:[{value:'待确认机构正式全称',code:'SYNTH_PENDING',metadata:{rawValueIndex:0}}]}},
  issues:[{field:'metrics',reason:'needs_confirmation'},{field:'organizations',reason:'needs_confirmation'}]};
 return frames.save(pending,(await frames.state()).version,'seed-pending');
}
function check(frame:BusinessFrame|undefined,queries:any[],e:Expect,receipts:any[]){
 assert.ok(frame,'BUSINESS_STATE_REQUIRED');
 assert.deepEqual(frame.fields.time?.resolvedValue,e.time,'KNOWN_TIME_PRESERVED');
 if(e.kind==='value'||e.kind==='position'){
  assert.equal(queries.length,1,'COMPLETE_GOAL_QUERIED_ONCE');const q=queries[0].spec;
  assert.deepEqual(q.org_codes,[e.org],'SUBJECT_PRESERVED');assert.deepEqual(q.metric_codes,[CODE],'FULL_METRIC_BASIS_PRESERVED');assert.deepEqual(q.time,e.time,'TIME_CONTRACT');assert.equal(q.selection,e.selection,'TIME_SELECTION');
  assert.equal(q.operation?.kind??'value',e.kind==='position'?'rank_position':'value','GOAL_KIND');assert.equal(frame.status,'success','FORMAL_EXECUTION_REQUIRED');
  if(e.kind==='position'){
   assert.deepEqual([...q.comparison_scope.org_codes].sort(),[...e.compare!].sort(),'COMPARISON_UNIVERSE');
   const rows=queries[0].actual.rows;assert.equal(rows.length,1,'RETURN_ONLY_SUBJECT');assert.equal(rows[0].rank,3,'RANK_BEFORE_SUBJECT_FILTER');assert.equal(rows[0].rank_population,3,'ACTUAL_VALID_POPULATION');
  }
 }else{
  assert.equal(queries.length,0,'NO_QUERY_WITH_UNRESOLVED_CHOICES');assert.equal(frame.status,'clarifying','PENDING_STATE_SAVED');
  if(e.kind==='partial'){assert.equal(frame.fields.metrics?.resolutionStatus,'resolved','POINT_CHOICE_RETAINED');assert.notEqual(frame.fields.organizations?.resolutionStatus,'resolved','OTHER_CHOICE_NOT_AUTO_CONFIRMED');}
  if(e.kind==='confirm_metric')assert.ok((frame.fields.metrics?.metadata?.extractedRawValues as string[]|undefined)?.includes(e.metricText!)||(Array.isArray(frame.fields.metrics?.rawValue)&&frame.fields.metrics.rawValue.includes(e.metricText!)),'FULL_RAW_MENTION_PRESERVED');
  if(e.kind==='clarify_scope'||e.kind==='clarify_time_scope'){
   assert.equal(obj(frame.fields.operation?.resolvedValue).kind,'rank_position','POSITION_GOAL_PRESERVED');assert.ok(frame.issues.some(x=>x.field==='comparison_organizations'),'ONLY_GENUINE_COMPARISON_CHOICE');
   assert.deepEqual(obj(frame.fields.organizations?.resolvedValue).codes,[e.org],'KNOWN_SUBJECT_PRESERVED');
   if(e.kind==='clarify_time_scope')assert.notEqual(frame.fields.selection?.resolutionStatus,'resolved','DO_NOT_GUESS_MONTH_SELECTION');
  }
  assert.ok(receipts.some(r=>r.details?.status==='NEEDS_CLARIFICATION'),'STRUCTURED_CLARIFICATION_REQUIRED');
 }
}
async function main(){
 const phase=process.argv.find(a=>a.startsWith('--phase='))?.slice(8)??'before',reportBase=process.argv.find(a=>a.startsWith('--report-base='))?.slice(14);
 assert.ok(reportBase,'REPORT_BASE_REQUIRED');const data=await mkdtemp(join(tmpdir(),`generic-query-${phase}-`)),sessions=new NativeSessionStore(data),skills=await loadBusinessSkills();
 const config={...loadConfig(),dataDir:data},host=new HarnessHost(config,a=>createAskMetricModels(config,a),sessions,[...createAskMetricTools(),createBusinessSkillReadTool(skills)],{skills});
 const turns:any[]=[];const scriptHash=createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');
 const save=async()=>{await mkdir(dirname(reportBase),{recursive:true});await writeFile(reportBase+'.json',JSON.stringify({phase,model:config.model.name,max_tokens:config.model.maxTokens,extra_body:config.model.extraBody,script_hash:scriptHash,fixture_hash:createHash('sha256').update(await readFile(join(import.meta.dirname,'generic-query-fixture.py'))).digest('hex'),session_data:data,scenarios,environment:'real_model_current_source_governance_sql_in_memory_synthetic_data',real_database:false,production_accessed:false,sampling:'one sample per version and turn; all failures retained',turns},null,2));};
 try{
  for(const scenario of scenarios){
   const hosted=await host.createSession(actor),frames=new NativeFrameStore(hosted.session),b=backend();
   if(scenario.seed){const pending=await seed(frames,hosted.sessionId);await hosted.lane.appendMessage({role:'user',content:'查询待确认机构的经营收益金融当日数，日期为2026-05-31。',timestamp:Date.now()},BACKGROUND_CONTEXT);await hosted.lane.appendMessage({role:'assistant',content:[{type:'text',text:renderClarificationOptions(frameClarificationOptions(pending))}],api:'openai-completions',provider:'fixture',model:'fixture',stopReason:'stop',timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}as AgentMessage,BACKGROUND_CONTEXT);}
   for(const[index,step]of scenario.steps.entries()){
    const started=performance.now(),previous=await frames.get((await frames.state()).focusFrameId??''),q0=b.queries.length;let failure:string|undefined,calls=0;
    const options=previous?frameClarificationOptions(previous).flatMap(g=>g.options).filter(o=>o.field===step.select):[];
    const selected=step.select&&previous&&options.length?{clarification_selection:{frame_id:previous.frameId,option_ids:[options[0]!.id]}}:{};
    try{
     const admission=await host.admitPrompt(hosted,{protocol_version:3,request_id:`${scenario.name}-${index}`,message:step.message,...selected},{actor,backend:b.client});assert.ok(admission.ok,'PROMPT_ADMISSION');
     const timer=setTimeout(()=>void host.abort(hosted,admission.operationId),180000);try{const out=await host.drivePrompt(hosted,admission);assert.ok(out.ok&&out.outcome.kind==='settled'&&out.outcome.outcome.status==='completed','MODEL_TURN_COMPLETED');}finally{clearTimeout(timer);calls=admission.request.timings?.model_ms.length??0;}
    }catch(e){failure=e instanceof Error?e.message:String(e);}
    const entries=await hosted.lane.findEntries({order:'oldestFirst'},BACKGROUND_CONTEXT),last=entries.map(e=>e.type==='message'&&e.message.role==='user').lastIndexOf(true),current=entries.slice(last),messages=current.flatMap(e=>e.type==='message'?[e.message]:[]);
    const tools=messages.flatMap(m=>m.role==='assistant'?m.content.filter(c=>c.type==='toolCall').map(c=>({id:c.id,name:c.name,args:c.arguments})):[]),receipts=messages.flatMap(m=>m.role==='toolResult'?[{id:m.toolCallId,name:m.toolName,is_error:!!m.isError,details:m.details,content:m.content}]:[]);
    const frame=await frames.get((await frames.state()).focusFrameId??''),queries=b.queries.slice(q0),answer=projectEntries(current).filter(m=>m.role==='assistant').map(m=>m.text).join('\n');
    try{if(failure)throw new Error(failure);check(frame,queries,step.expected,receipts);assert.ok(answer.trim(),'VISIBLE_DELIVERY');}catch(e){failure=e instanceof Error?e.message:String(e);}
    const changes=tools.filter(t=>t.name==='resolve_business_turn').flatMap(t=>{try{return toContextDelta(t.args).fieldChanges;}catch{return[];}}),guesses=changes.filter(c=>c.operation==='set'&&(c.fieldHint==='operation'&&obj(c.rawValue).kind==='ranking'||step.expected.kind==='clarify_time_scope'&&c.fieldHint==='selection'&&typeof c.rawValue==='string'));
    const clarifies=receipts.filter(r=>obj(r.details).status==='NEEDS_CLARIFICATION').length;
    const measures={tool_calls:tools.length,error_calls:receipts.filter(r=>r.is_error||['ARGUMENT_ERROR','error','failed'].includes(String(obj(r.details).status))).length,unguarded_condition_proposals:guesses.length,unguarded_condition_executions:queries.filter(q=>{try{check(frame,[q],step.expected,receipts);return false;}catch{return true;}}).length,unnecessary_clarifications:['value','position'].includes(step.expected.kind)?clarifies:0,repeated_clarifications:Math.max(0,clarifies-1),model_calls:calls,elapsed_ms:Math.round(performance.now()-started)};
    const result={scenario:scenario.name,turn:index+1,message:step.message,selection:selected,expected:step.expected,passed:!failure,failure,tools,receipts,queries,frame,answer,measures};turns.push(result);await save();console.log(JSON.stringify({phase,scenario:scenario.name,turn:index+1,passed:!failure,failure,measures}));
   }
   await host.closeSession(hosted.sessionId);
  }
 }finally{await save();await host.close();await sessions.close();}
}
void main().catch(e=>{console.error(e instanceof Error?e.message:String(e));process.exitCode=1;});
