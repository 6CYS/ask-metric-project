/** Prompt / 工具说明 / 四 Skill 的真实模型配对；业务目录、权限、记录及计算始终用隔离合成桩。 */
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
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
import {resolveFrame} from '../src/business-context/core.js';
import {toContextDelta, toCompactTurnArgs} from '../src/business-context/turnArgs.js';
import {createAskMetricTools} from '../src/tools/index.js';
import {loadBusinessSkills, createBusinessSkillReadTool, visibleBusinessSkills} from '../src/businessSkills.js';
import {projectEntries} from '../src/sessionProjection.js';
import {frameClarificationOptions} from '../src/business-context/modelView.js';
import {renderClarificationOptions} from '../src/business-context/clarificationOptions.js';
import {runTool, testRequestContext, MemoryCommandBridge} from '../src/tools/testUtils.js';
import {BackendApiError, type BackendClient, type BackendUser, type BasicQuerySpec, type CalculationFact, type CalculationSpec,
  type AvailabilityRequest} from '../src/backendClient.js';
import type {BusinessFrame, BusinessSessionState, ContextDelta, FieldResolution} from '../src/business-context/types.js';
const ORGS: Record<string,string> = {合成机构甲:'SYNTH_O1',合成机构乙:'SYNTH_O2',合成机构丙:'SYNTH_O3'};
const METRIC='合成收入指标', CODE='SYNTH_M1', DATE='2026-07-31', NEXT='2026-08-31';
const day=(date=DATE)=>({start:date,end:date});
const MONTH={start:'2026-07-01',end:DATE};
const actor:BackendUser={id:'synthetic-prompt-skill-ab',username:'synthetic',display_name:'合成配对验收',org_code:'SYNTH_O1',org_name:'合成机构甲',role_code:'USER'};
type QueryExpected={kind:'query';orgs:string[];time:{start:string;end:string};selection:'exact'|'latest_in_range';ranking?:number;reference?:'single'|'union';confirm?:true};
type Expected=QueryExpected|{kind:'clarify'|'calculate'|'coverage'|'unsupported'};
type Step={message:string;expected:Expected};
type Scenario={name:string;seed?:'single'|'multiple'|'confirmation';preRead?:string[];steps:Step[]};
const scenarios:Scenario[]=[
 {name:'clear_first_and_date_followup',steps:[
  {message:`查询合成机构甲 2026 年 7 月 31 日${METRIC}的数值。`,expected:{kind:'query',orgs:['SYNTH_O1'],time:day(),selection:'exact'}},
  {message:'把日期改成2026-08-31，其余条件不变。',expected:{kind:'query',orgs:['SYNTH_O1'],time:day(NEXT),selection:'exact'}}]},
 {name:'ambiguous_month_ranking_and_recovery',steps:[
  {message:`对合成机构甲 2026 年 7 月${METRIC}进行排名。`,expected:{kind:'clarify'}},
  {message:'取该月最后有数据的日期，列出前3名，其他条件保持不变，请继续排名。',expected:{kind:'query',orgs:['SYNTH_O1'],time:MONTH,selection:'latest_in_range',ranking:3}}]},
 {name:'unique_reference_without_count',seed:'single',preRead:['metric-query'],steps:[
  {message:'对刚才查过的机构按原指标和日期列出前3名。',expected:{kind:'query',orgs:['SYNTH_O1'],time:day(),selection:'exact',ranking:3,reference:'single'}}]},
 {name:'two_sources_union_count',seed:'multiple',preRead:['metric-query'],steps:[
  {message:'把前两笔查询的三家机构合在一起，去重后按原指标和日期列出前3名。',expected:{kind:'query',orgs:['SYNTH_O1','SYNTH_O2','SYNTH_O3'],time:day(),selection:'exact',ranking:3,reference:'union'}}]},
 {name:'saved_candidate_confirm_and_date_change',seed:'confirmation',preRead:['metric-query'],steps:[
  {message:'可以，就按这个机构来，同时把日期改成2026-08-31，其他条件不变，请继续。',expected:{kind:'query',orgs:['SYNTH_O3'],time:day(NEXT),selection:'exact',ranking:3,confirm:true}}]},
 {name:'real_prime_and_historical_calculation',steps:[
  {message:`查询合成机构甲和合成机构乙2026-07-31的${METRIC}原值。`,expected:{kind:'query',orgs:['SYNTH_O1','SYNTH_O2'],time:day(),selection:'exact'}},
  {message:'使用刚才查询的原值，按合成机构甲减合成机构乙计算差额，保留两位小数，列出两家原值和差额。',expected:{kind:'calculate'}}]},
 {name:'coverage_discovery',preRead:['data-coverage'],steps:[{message:'合成机构甲2026年7月哪些指标有记录？',expected:{kind:'coverage'}}]},
 {name:'unsupported_cause_boundary',preRead:['analysis-boundary','result-calculation'],steps:[{message:'请分析合成机构甲收入下降的业务原因，并预测下一季度走势。',expected:{kind:'unsupported'}}]},
];
const normalized=(value:string)=>value.normalize('NFKC').replace(/\s+/g,'').toLowerCase();
async function resolveCatalog(entity:string,raw:string[]):Promise<FieldResolution>{
 if(entity==='date'){
  const v=normalized(raw.join(''));
  if([DATE,'2026年7月31日'].includes(v))return{status:'resolved',value:day()};
  if([NEXT,'2026年8月31日'].includes(v))return{status:'resolved',value:day(NEXT)};
  return v==='2026年7月'?{status:'resolved',value:MONTH}:{status:'invalid'};
 }
 const cat=entity==='metric'?{[METRIC]:CODE}:ORGS;
 const names=raw.map(value=>cat[value]?value:Object.keys(cat).find(name=>cat[name]===value));
 return names.length&&names.every((name):name is string=>!!name)?{status:'resolved',value:{codes:names.map(name=>cat[name]!),names}}:{status:'not_found',candidates:[]};
}
function makeBackend(){
 const queries:BasicQuerySpec[]=[],calculations:Array<CalculationSpec&{source_policy?:string;scope_id?:string}>=[],coverage:AvailabilityRequest[]=[];
 const results=new Map<string,{facts:CalculationFact[];rows:Record<string,unknown>[];spec:BasicQuerySpec}>();
 let factChecks=0;
 const resultFor=(task:string,spec:BasicQuerySpec)=>{
  const facts=[...(spec.org_codes??[])].reverse().map((org,index):CalculationFact=>({fact_id:`fact:${task}:${index}:metric_value`,task_id:task,field:'metric_value',
   value:org==='SYNTH_O1'?'125.50':org==='SYNTH_O2'?'210.25':'300.00',unit:'元',metric_code:CODE,metric_name:METRIC,org_code:org,
   org_name:Object.keys(ORGS).find(name=>ORGS[name]===org)!,date:spec.time.end}));
  const rows=facts.map(fact=>({...fact,stat_date:fact.date,metric_value:fact.value}));
  results.set(task,{facts,rows,spec:structuredClone(spec)});
  return{task_id:task,result_id:`result-${task}`,status:'succeeded',facts,rows,columns:Object.keys(rows[0]??{}),row_count:rows.length,truncated:false,
   message:'隔离合成查询已完成。',evidence:{logical_dsl:spec}};
 };
 const backend={
  resolveBusinessField:resolveCatalog,
  matchMetricQuestion:async(question:string)=>({mentions:question.includes(METRIC)?[{text:METRIC,start:question.indexOf(METRIC),end:question.indexOf(METRIC)+METRIC.length,resolution:{status:'resolved',value:{codes:[CODE],names:[METRIC]}}}]:[]}),
  searchMetrics:async(keyword:string)=>({total:METRIC.includes(keyword)||keyword===CODE?1:0,items:METRIC.includes(keyword)||keyword===CODE?[{metric_code:CODE,metric_name:METRIC,unit:'元',score:1,match_type:keyword===METRIC||keyword===CODE?'exact':'contains'}]:[],semantic_suggestions:[]}),
  searchOrganizations:async(keyword:string)=>{const items=Object.entries(ORGS).filter(([name,code])=>name.includes(keyword)||code===keyword).map(([name,code])=>({org_code:code,org_name:name,score:1,match_type:keyword===name||keyword===code?'exact':'contains'}));return{items,total:items.length};},
  metricCatalogOverview:async()=>({total:1,groups:[{unit:'元',count:1,examples:[{code:CODE,name:METRIC}]}]}),
  createAgentQueryContext:async()=>({conversation_id:'synthetic-prompt-skill-ab'}),
  basicQueries:async(spec:BasicQuerySpec)=>{queries.push(structuredClone(spec));return{query:spec,result:resultFor(`query-${queries.length}`,spec)};},
  getTask:async(task:string)=>{assert.ok(results.has(task),'SYNTHETIC_TASK_NOT_FOUND');return{task_id:task,status:'SUCCEEDED',version:1,result:{result_id:`result-${task}`}};},
  getTaskResult:async(task:string,offset=0,limit=100)=>{factChecks++;const r=results.get(task);assert.ok(r,'只能读取已保存合成任务');return{task_id:task,result_id:`result-${task}`,status:'succeeded',facts:r.facts.slice(offset,offset+limit),rows:r.rows.slice(offset,offset+limit),columns:Object.keys(r.rows[0]??{}),row_count:r.rows.length,truncated:false,offset,limit,has_more:offset+limit<r.rows.length,next_offset:offset+limit<r.rows.length?offset+limit:null};},
  calculate:async(spec:CalculationSpec&{source_policy?:string;scope_id?:string})=>{
   calculations.push(structuredClone(spec));
   if(spec.scope_policy!=='cross_org')throw new BackendApiError(422,'不同机构的事实计算须显式设置 scope_policy=cross_org。','CALCULATION_SCOPE_MISMATCH');
   const fact=(id:string)=>[...results.values()].flatMap(result=>result.facts).find(value=>value.fact_id===id);
   if(spec.source_policy!=='conversation_snapshots'||spec.expressions.length!==1||Object.keys(spec.bindings).length!==2||Object.keys(spec.constants??{}).length)throw new BackendApiError(422,'须使用两条正式快照原值求差。','CALCULATION_SOURCE_INVALID');
   const expression=spec.expressions[0]!;const m=expression.expression.replace(/[()\s]/g,'').match(/^([A-Za-z_]\w*)-([A-Za-z_]\w*)$/);
   if(!m||fact(spec.bindings[m[1]!]!.fact_id)?.org_code!=='SYNTH_O1'||fact(spec.bindings[m[2]!]!.fact_id)?.org_code!=='SYNTH_O2')throw new BackendApiError(422,'表达式必须按甲减乙绑定实际 fact_id。','CALCULATION_DIRECTION_INVALID');
   return{status:'succeeded',calculation_id:'synthetic-calc',task_id:'query-1',scope_id:spec.scope_id,inputs:Object.fromEntries(Object.entries(spec.bindings).map(([name,binding])=>[name,fact(binding.fact_id)])),results:[{...expression,value:'-84.75',display_value:'-84.75',unit:'元',variables:[m[1],m[2]]}],public_answer:'合成机构甲原值125.50元，合成机构乙原值210.25元。甲减乙差额：-84.75元。'};
  },
  dataAvailability:async(spec:AvailabilityRequest)=>{coverage.push(structuredClone(spec));return{status:'succeeded',request:spec,mode:spec.dimension,metric_count:1,org_count:spec.org_codes.length,org_names:['合成机构甲'],items:[{metric_code:CODE,metric_name:METRIC}],groups:[{date_count:1,earliest:DATE,latest:DATE,dates:[DATE],has_more:false}],page:spec.page??1,page_size:spec.page_size??20,has_more:false,notice:'合成记录覆盖不证明每天有记录或数值有效。'};},
 }as unknown as BackendClient;
 return{backend,queries,calculations,coverage,results,resultFor,get factChecks(){return factChecks;}};
}
async function seed(frames:NativeFrameStore,sessionId:string,mode:Scenario['seed'],backend:ReturnType<typeof makeBackend>){
 if(!mode)return[];
 const service=new BusinessContextService(frames,createCapabilities(),createFieldResolvers()),roots:BusinessFrame[]=[];
 for(const[index,orgs]of(mode==='single'?[["合成机构甲"]]:[["合成机构甲"],["合成机构乙","合成机构丙"]]).entries()){
  const id={sessionId,requestId:`seed-${index}`,turnId:`seed-${index}`};
  const frame=await service.resolve({capabilityHint:'metric_query',baseReference:null,executionMode:'execute',fieldChanges:[
   {fieldHint:'metrics',operation:'set',rawValue:METRIC},{fieldHint:'organizations',operation:'set',rawValue:orgs},{fieldHint:'time',operation:'set',rawValue:DATE},
   {fieldHint:'selection',operation:'set',rawValue:'exact'},{fieldHint:'operation',operation:'set',rawValue:{kind:'ranking',position:'top',top_n:3}}]},id,{originalMessage:`${orgs.join('、')} ${METRIC} ${DATE} 前3名`,currentDate:'2026-10-13',turnId:id.turnId,resolveCatalog});
  assert.equal(frame.status,'ready');const task=`seed-${index}`;
  const result=backend.resultFor(task,{org_codes:orgs.map(name=>ORGS[name]!),metric_codes:[CODE],time:day(),selection:'exact'});
  roots.push(await service.finishExecution(await service.beginExecution(frame.frameId,id),{status:'success',resultRef:`query:${task}:result-${task}`,resultSummary:{rowCount:result.row_count}}));
 }
 if(mode==='confirmation'){
  const base=roots.at(-1)!,frameId=randomUUID();
  const pending:BusinessFrame={...base,frameId,operationFrameId:frameId,parentFrameId:base.frameId,requestId:'seed-confirmation',turnId:'seed-confirmation',status:'clarifying',createdAt:new Date().toISOString(),
   fields:{...base.fields,organizations:{rawValue:'合成简称',resolutionStatus:'needs_confirmation',source:'explicit',resolver:'organization',candidates:[{value:'合成机构丙',code:'SYNTH_O3',metadata:{rawValueIndex:0}}]}},
   delta:{capabilityHint:'metric_query',baseReference:{frameId:base.frameId},executionMode:'execute',fieldChanges:[{fieldHint:'organizations',operation:'set',rawValue:'合成简称'}]},issues:[{field:'organizations',reason:'needs_confirmation'}]};
  delete pending.resultRef;delete pending.resultSummary;await frames.save(pending,(await frames.state()).version,'seed-confirmation');
 }
 return roots;
}
function fixtureDelta(step:Step,index:number,seedMode:Scenario['seed'],roots:BusinessFrame[]):ContextDelta{
 const e=step.expected;
 const delta:ContextDelta={capabilityHint:e.kind==='coverage'?'data_availability':e.kind==='calculate'?'metric_calculate':'metric_query',baseReference:seedMode||index?'current':null,executionMode:'execute',fieldIntents:e.kind==='calculate'?{}:{organizations:{mode:'inherit',sourceText:null,expectedCount:null}},fieldChanges:[]};
 if(e.kind==='query'){
  if(!seedMode&&!index)delta.fieldChanges.push({fieldHint:'metrics',operation:'set',rawValue:{fromQuestion:true}},{fieldHint:'organizations',operation:'set',rawValue:e.orgs.map(code=>Object.keys(ORGS).find(name=>ORGS[name]===code)!)},{fieldHint:'time',operation:'set',rawValue:step.message.includes('2026 年')?'2026 年 7 月 31 日':DATE});
  if(index&&e.time.start===NEXT||e.confirm)delta.fieldChanges.push({fieldHint:'time',operation:'set',rawValue:NEXT});
  if(e.reference)delta.fieldChanges.push({fieldHint:'organizations',operation:'set',rawValue:{fromHistory:true,sourceText:step.message,sources:(e.reference==='single'?roots.slice(0,1):roots).map(frame=>({frame:{frameId:frame.frameId},field:'organizations'})),combine:e.reference,...(e.reference==='union'?{expectedCount:3}:{})}});
  if(e.confirm)delta.fieldChanges.push({fieldHint:'organizations',operation:'set',rawValue:{confirm:true,evidence:{decision:'accept',sourceText:'可以，就按这个机构来'}}});
  if(!seedMode&&!index||e.ranking&&!e.confirm)delta.fieldChanges.push({fieldHint:'selection',operation:'set',rawValue:e.selection});
  if(e.ranking&&!e.confirm)delta.fieldChanges.push({fieldHint:'operation',operation:'set',rawValue:{kind:'ranking',position:'top',top_n:e.ranking}});
  if(!seedMode&&!index||e.reference||e.confirm)delta.fieldIntents={organizations:{mode:e.confirm?'confirm':'set',sourceText:step.message,expectedCount:e.reference==='union'?3:null}};
 }else if(e.kind==='clarify'){
  delta.fieldIntents={organizations:{mode:'set',sourceText:'合成机构甲',expectedCount:null}};
  delta.fieldChanges=[{fieldHint:'metrics',operation:'set',rawValue:{fromQuestion:true}},{fieldHint:'organizations',operation:'set',rawValue:'合成机构甲'},{fieldHint:'time',operation:'set',rawValue:'2026 年 7 月'},{fieldHint:'selection',operation:'set',rawValue:{clarify:true,sourceText:step.message}},{fieldHint:'operation',operation:'set',rawValue:{clarify:true,sourceText:step.message}}];
 }else if(e.kind==='coverage'){
  delta.fieldIntents={organizations:{mode:'set',sourceText:'合成机构甲',expectedCount:null}};
  delta.fieldChanges=[{fieldHint:'organizations',operation:'set',rawValue:'合成机构甲'},{fieldHint:'time',operation:'set',rawValue:'2026年7月'},{fieldHint:'dimension',operation:'set',rawValue:'metrics'}];
 }
 return delta;
}
function assertSpec(actual:BasicQuerySpec,e:QueryExpected){
 assert.deepEqual([...(actual.org_codes??[])].sort(),[...e.orgs].sort(),'机构绑定完整');assert.deepEqual(actual.metric_codes,[CODE],'正式指标保留');assert.deepEqual(actual.time,e.time,'完整日期范围保留');assert.equal(actual.selection,e.selection,'用户取数口径');
 if(e.ranking)assert.deepEqual(actual.operation,{kind:'ranking',position:'top',top_n:e.ranking});else assert.ok(!actual.operation||actual.operation.kind==='value','未要求排名不能排序');
}
async function checkFixtures(sessions:NativeSessionStore,compact:boolean){
 const checks:Array<Record<string,unknown>>=[],tools=createAskMetricTools({compactTurnArgs:compact});
 for(const scenario of scenarios){
  const session=await sessions.create(actor.id),frames=new NativeFrameStore(session),backend=makeBackend(),roots=await seed(frames,session.metadata.id,scenario.seed,backend),commands=new MemoryCommandBridge();
  if(scenario.seed)commands.conversationId='synthetic-prompt-skill-ab';
  for(const[index,step]of scenario.steps.entries()){
   const request=testRequestContext(backend.backend,commands,{actor,originalMessage:step.message,sessionId:session.metadata.id,requestId:`fixture-${scenario.name}-${index}`,operationId:`fixture-${scenario.name}-${index}`,frames,businessResults:new NativeBusinessResultStore(session)});
   if(step.expected.kind==='unsupported'){const r=await runTool(tools.find(t=>t.name==='business_capability_explain')!,{capability:'cause_analysis'},request);assert.equal(r.details.status,'unsupported');}
   else{
    const delta=fixtureDelta(step,index,scenario.seed,roots);
    if(step.expected.kind==='calculate'){
     const f=backend.results.get('query-1')!.facts;
     delta.fieldChanges=[{fieldHint:'expressions',operation:'set',rawValue:[{name:'difference',label:'甲减乙',expression:'a-b',decimal_places:2}]},{fieldHint:'bindings',operation:'set',rawValue:{a:{fact_id:f.find(x=>x.org_code==='SYNTH_O1')!.fact_id},b:{fact_id:f.find(x=>x.org_code==='SYNTH_O2')!.fact_id}}},{fieldHint:'scope_policy',operation:'set',rawValue:'cross_org'}];
    }
    const r=await runTool(tools.find(t=>t.name==='resolve_business_turn')!,compact?toCompactTurnArgs(delta):delta,request);
    if(step.expected.kind==='clarify'){assert.equal(r.details.status,'NEEDS_CLARIFICATION');const f=await frames.get((await frames.state()).focusFrameId!);assert.equal(f?.fields.organizations?.resolutionStatus,'resolved');assert.deepEqual(f?.fields.time?.resolvedValue,MONTH);}
    else{assert.equal(r.details.status,'READY',JSON.stringify(r));const p=JSON.parse(r.content[0].text);const execution=await runTool(tools.find(t=>t.name==='execute_business_frame')!,{frameId:p.frameId},request);assert.equal(execution.details.status,'succeeded',JSON.stringify(execution));if(step.expected.kind==='query')assertSpec(backend.queries.at(-1)!,step.expected);}
   }
   checks.push({scenario:scenario.name,turn:index+1,passed:true,model_called:false,actual_registered_tools_exercised:true});
  }
 }
 return checks;
}
function assistant(content:unknown,stopReason='toolUse'){return{role:'assistant',content,api:'openai-completions',provider:'controlled-fixture',model:'controlled-skill-read',stopReason,timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}as AgentMessage;}
async function preRead(hosted:Awaited<ReturnType<HarnessHost['createSession']>>,names:string[],skills:Awaited<ReturnType<typeof loadBusinessSkills>>,backend:BackendClient){
 for(const name of names){
  const id=`controlled-skill-read-${name}`,tool=createBusinessSkillReadTool(skills),r=await runTool(tool,{name},testRequestContext(backend,new MemoryCommandBridge(),{actor}));assert.equal(r.details.status,'ok');
  await hosted.lane.appendMessage(assistant([{type:'toolCall',id,name:tool.name,arguments:{name}}]),BACKGROUND_CONTEXT);
  await hosted.lane.appendMessage({role:'toolResult',toolCallId:id,toolName:tool.name,content:r.content,details:r.details,isError:false,timestamp:Date.now()},BACKGROUND_CONTEXT);
 }
 const m=(await hosted.lane.findEntries({order:'oldestFirst'},BACKGROUND_CONTEXT)).flatMap(e=>e.type==='message'?[e.message]:[]);
 assert.deepEqual([...visibleBusinessSkills(m,skills)].sort(),[...names].sort());
}
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'?v as Record<string,unknown>:{};
type Call={id:string;name:string;args:unknown};
type Measures={tool_calls:number;error_calls:number;error_rate:number;expected_business_refusals:number;ungrounded_condition_proposals:number;ungrounded_condition_executions:number;unnecessary_clarifications:number;repeated_clarifications:number;query_count:number;calculation_count:number;coverage_count:number;model_calls:number;elapsed_ms:number};
type TurnReport={scenario:string;turn:number;starting_state?:BusinessSessionState;passed:boolean;message:string;expected:Expected;failure?:string;tools:Call[];receipts:unknown[];query_specs:BasicQuerySpec[];calculation_specs:unknown[];coverage_specs:AvailabilityRequest[];answer:string;focus?:BusinessFrame;measures:Measures;ungrounded_proposals:unknown[]};
function aggregate(turns:TurnReport[]){const sum=(k:keyof Measures)=>turns.reduce((n,t)=>n+t.measures[k],0),n=sum('tool_calls');return{cases:new Set(turns.map(t=>t.scenario)).size,turns:turns.length,achieved_turns:turns.filter(t=>t.passed).length,tool_calls:n,error_calls:sum('error_calls'),error_rate:n?sum('error_calls')/n:0,expected_business_refusals:sum('expected_business_refusals'),ungrounded_condition_proposals:sum('ungrounded_condition_proposals'),ungrounded_condition_executions:sum('ungrounded_condition_executions'),unnecessary_clarifications:sum('unnecessary_clarifications'),repeated_clarifications:sum('repeated_clarifications'),model_calls:sum('model_calls')};}
function guesses(calls:Call[],e:Expected){const errors:unknown[]=[];
 for(const call of calls.filter(c=>c.name==='resolve_business_turn')){let d:ContextDelta;try{d=toContextDelta(call.args);}catch{continue;}
  for(const c of d.fieldChanges.filter(c=>c.operation==='set')){const v=object(c.rawValue);
   if(e.kind==='clarify'&&(c.fieldHint==='selection'&&typeof c.rawValue==='string'||c.fieldHint==='operation'&&v.kind==='ranking'))errors.push({call_id:call.id,field:c.fieldHint,value:c.rawValue,reason:'user_not_supplied_business_choice'});
   if(e.kind==='query'&&c.fieldHint==='operation'&&v.kind==='ranking'&&v.top_n!==e.ranking)errors.push({call_id:call.id,field:c.fieldHint,value:c.rawValue,reason:'operation_changes_user_request'});
   if(e.kind==='query'&&c.fieldHint==='selection'&&typeof c.rawValue==='string'&&c.rawValue!==e.selection)errors.push({call_id:call.id,field:c.fieldHint,value:c.rawValue,reason:'selection_changes_user_request'});
  }
 }return errors;
}
async function main(){
 const live=process.argv.includes('--live'),phase=process.argv.find(a=>a.startsWith('--phase='))?.slice(8)??'before';assert.ok(['before','after'].includes(phase),'INVALID_PHASE');
 const fromCase=process.argv.find(a=>a.startsWith('--from-case='))?.slice('--from-case='.length);
 const partial=process.argv.includes('--partial');
 assert.ok(!fromCase||scenarios.some(s=>s.name===fromCase),'UNKNOWN_RESUME_CASE');
 const custom=process.argv.find(a=>a.startsWith('--report-base='))?.slice('--report-base='.length);
 const dir=await mkdtemp(join(tmpdir(),`pi-prompt-skill-ab-${phase}-`)),sessions=new NativeSessionStore(dir),skills=await loadBusinessSkills();
 assert.deepEqual(skills.map(s=>s.name).sort(),['analysis-boundary','data-coverage','metric-query','result-calculation']);
 if(!live){try{console.log(JSON.stringify({status:'fixtures_valid',model_called:false,checks:await checkFixtures(sessions,process.env.AGENT_COMPACT_TURN_ARGS==='true'),session_data:dir}));}finally{await sessions.close();}return;}
 const config={...loadConfig(),dataDir:dir},tools=[...createAskMetricTools({compactTurnArgs:config.compactTurnArgs}),createBusinessSkillReadTool(skills)],host=new HarnessHost(config,a=>createAskMetricModels(config,a),sessions,tools,{skills});
 const turns:TurnReport[]=[],reportBase=custom?resolve(custom):resolve(import.meta.dirname,`../../docs/verification/prompt-skill-ab-20261013-${phase}`);
 const paths=['src/prompts/businessSystemPrompt.ts','src/tools/businessContext.ts','src/business-context/capabilities.ts','src/businessSkills.ts',...skills.map(s=>`skills/${s.name}/SKILL.md`)];
 const sourceHashes=Object.fromEntries(await Promise.all(paths.map(async p=>[p,createHash('sha256').update(await readFile(resolve(import.meta.dirname,'..',p))).digest('hex')])));
 const scriptHash=createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');
 try{
  const fixtureChecks=await checkFixtures(sessions,!!config.compactTurnArgs);
  for(const s of scenarios.slice(fromCase?scenarios.findIndex(s=>s.name===fromCase):0)){
   const hosted=await host.createSession(actor),frames=new NativeFrameStore(hosted.session),b=makeBackend(),roots=await seed(frames,hosted.sessionId,s.seed,b);
   if(s.seed==='confirmation'){const p=await frames.get((await frames.state()).focusFrameId!);await hosted.lane.appendMessage({role:'user',content:'把机构换成合成简称，原指标日期和前3名不变。',timestamp:Date.now()},BACKGROUND_CONTEXT);await hosted.lane.appendMessage(assistant([{type:'text',text:renderClarificationOptions(frameClarificationOptions(p!))}],'stop'),BACKGROUND_CONTEXT);}
   await preRead(hosted,s.preRead??[],skills,b.backend);
   for(const[index,step]of s.steps.entries()){
    const startingState=await frames.state();
    const requestId=`${s.name}-${index+1}`,before={query:b.queries.length,calculate:b.calculations.length,coverage:b.coverage.length},started=performance.now();let failure:string|undefined,modelCalls=0,timedOut=false;
    try{const a=await host.admitPrompt(hosted,{protocol_version:3,request_id:requestId,message:step.message},{actor,backend:b.backend});assert.ok(a.ok,'PROMPT_ADMISSION_FAILED');const timer=setTimeout(()=>{timedOut=true;void host.abort(hosted,a.operationId);},180000);try{const o=await host.drivePrompt(hosted,a);if(!(o.ok&&o.outcome.kind==='settled'&&o.outcome.outcome.status==='completed'))throw new Error('MODEL_TURN_NOT_COMPLETED');}finally{clearTimeout(timer);modelCalls=a.request.timings?.model_ms.length??0;}assert.ok(!timedOut,'MODEL_TURN_VALIDATION_DEADLINE');}catch(error){failure=error instanceof Error?error.message:String(error);}
    const entries=await hosted.lane.findEntries({order:'oldestFirst'},BACKGROUND_CONTEXT),lastUser=entries.map(e=>e.type==='message'&&e.message.role==='user').lastIndexOf(true),current=entries.slice(lastUser),messages=current.flatMap(e=>e.type==='message'?[e.message]:[]);
    const calls=messages.flatMap(m=>m.role==='assistant'?m.content.filter(c=>c.type==='toolCall').map(c=>({id:c.id,name:c.name,args:c.arguments})):[]);
    const receipts=messages.flatMap(m=>m.role==='toolResult'?[{id:m.toolCallId,name:m.toolName,is_error:!!m.isError,details:m.details,text:m.content.filter(c=>c.type==='text').map(c=>c.text).join('\n')}]:[]);
    const lastAnswer=projectEntries(current).filter(m=>m.role==='assistant'&&m.text.trim()).at(-1);
    const answer=lastAnswer?.role==='assistant'?lastAnswer.text:'',focus=await frames.get((await frames.state()).focusFrameId!),queries=b.queries.slice(before.query),calculations=b.calculations.slice(before.calculate),coverage=b.coverage.slice(before.coverage),clarifies=receipts.filter(r=>object(r.details).status==='NEEDS_CLARIFICATION'),proposalErrors=guesses(calls,step.expected);let executionErrors=0;
    try{
     if(failure)throw new Error(failure);assert.ok(answer.trim(),'必须有用户可见交付');const e=step.expected;
     if(e.kind==='query'){
      assert.equal(queries.length,1,'明确目标实际查询一次');assertSpec(queries[0]!,e);assert.equal(focus?.status,'success');
      if(e.reference){const deltas=calls.filter(c=>c.name==='resolve_business_turn').flatMap(c=>{try{return[toContextDelta(c.args)];}catch{return[];}}),h=deltas.flatMap(d=>d.fieldChanges).find(c=>c.fieldHint==='organizations'&&object(c.rawValue).fromHistory===true);if(h){assert.equal(object(h.rawValue).combine,e.reference);assert.equal((object(h.rawValue).sources as unknown[]).length,e.reference==='single'?1:2);}else{
        assert.equal(e.reference,'single','多源机构合并必须提交union字段来源');
        const state=await frames.state(),allFrames=await frames.list(),source=roots[0];
        const selected=deltas.find(d=>{const base=d.baseReference,intent=d.fieldIntents?.organizations;return !!source&&((base==='current'&&startingState.focusFrameId===source.frameId&&Object.keys(startingState.operations).length===1)||(!!base&&typeof base==='object'&&resolveFrame(base,state,allFrames,focus?.turnId).frameId===source.frameId))&&intent?.mode==='inherit'&&intent.sourceText===null&&intent.expectedCount===null;});
        assert.ok(selected&&source&&['organizations','metrics','time'].every(name=>focus?.fields[name]?.sourceFrameId===source.frameId),'指代须有唯一整笔Frame来源或单源字段引用，不能仅依靠current或正文');
      }}
      if(e.confirm)assert.ok(calls.some(c=>{try{return toContextDelta(c.args).fieldChanges.some(x=>x.fieldHint==='organizations'&&object(x.rawValue).confirm===true);}catch{return false;}}),'同意须确认已保存候选');
     }else if(e.kind==='clarify'){
      assert.equal(queries.length,0);assert.equal(clarifies.length,1,'业务缺项须一次保存并澄清');assert.equal(focus?.status,'clarifying');assert.deepEqual(focus?.fields.organizations?.resolvedValue,{codes:['SYNTH_O1'],names:['合成机构甲']});assert.deepEqual(focus?.fields.metrics?.resolvedValue,{codes:[CODE],names:[METRIC]});assert.deepEqual(focus?.fields.time?.resolvedValue,MONTH);for(const f of['selection','operation'])assert.equal(focus?.fields[f]?.resolutionStatus,'ambiguous');
     }else if(e.kind==='calculate'){assert.equal(queries.length,0,'历史原值不重新查询');assert.equal(calculations.length,1);assert.equal(focus?.capability,'metric_calculate');assert.equal(focus?.status,'success');assert.ok(answer.replaceAll('\u2212','-').includes('-84.75'),'CALCULATED_RESULT_NOT_DELIVERED');assert.ok(b.factChecks>=2,'精确事实复核未省略');}
     else if(e.kind==='coverage'){assert.equal(queries.length,0);assert.equal(coverage.length,1);assert.deepEqual(coverage[0]!.org_codes,['SYNTH_O1']);assert.equal(coverage[0]!.dimension,'metrics');assert.equal(coverage[0]!.start,MONTH.start);assert.equal(coverage[0]!.end,MONTH.end);assert.ok(!coverage[0]!.metric_codes?.length,'发现指标不能猜筛选');assert.equal(focus?.status,'success');}
     else{assert.equal(queries.length+calculations.length+coverage.length,0,'未支持目标不能偷换取数');assert.ok(receipts.some(r=>r.name==='business_capability_explain'&&object(r.details).status==='unsupported'),'CAPABILITY_BOUNDARY_NOT_DELIVERED');}
    }catch(error){failure=error instanceof Error?error.message:String(error);}
    for(const spec of queries){if(step.expected.kind!=='query')executionErrors++;else try{assertSpec(spec,step.expected);}catch{executionErrors++;}}
    const err=receipts.filter(r=>r.is_error||['ARGUMENT_ERROR','error','failed'].includes(String(object(r.details).status))).length;
    const report:TurnReport={scenario:s.name,turn:index+1,starting_state:startingState,passed:!failure,message:step.message,expected:step.expected,...(failure?{failure}:{}),tools:calls,receipts,query_specs:structuredClone(queries),calculation_specs:structuredClone(calculations),coverage_specs:structuredClone(coverage),answer,...(focus?{focus}:{}),ungrounded_proposals:proposalErrors,
     measures:{tool_calls:calls.length,error_calls:err,error_rate:calls.length?err/calls.length:0,expected_business_refusals:step.expected.kind==='unsupported'?receipts.filter(r=>r.name==='business_capability_explain'&&object(r.details).status==='unsupported').length:0,ungrounded_condition_proposals:proposalErrors.length,ungrounded_condition_executions:executionErrors,unnecessary_clarifications:step.expected.kind==='clarify'?0:clarifies.length,repeated_clarifications:Math.max(0,clarifies.length-1),query_count:queries.length,calculation_count:calculations.length,coverage_count:coverage.length,model_calls:modelCalls,elapsed_ms:Math.round(performance.now()-started)}};
    turns.push(report);await writeFile(reportBase+'.checkpoint.json',JSON.stringify({phase,model:config.model.name,script_hash:scriptHash,source_hashes:sourceHashes,session_data:dir,scenarios,turns},null,2));console.log(JSON.stringify({phase,scenario:s.name,turn:index+1,passed:report.passed,failure,measures:report.measures,tools:calls.map(c=>c.name)}));
   }
   assert.equal(roots.length,s.seed==='single'?1:s.seed?2:0);await host.closeSession(hosted.sessionId);
  }
  const summary=aggregate(turns),report={phase,environment:'configured_real_model_isolated_synthetic_backend',created_at:new Date().toISOString(),model:config.model.name,model_called:true,model_max_tokens:config.model.maxTokens,model_extra_body:config.model.extraBody,compact_turn_args:!!config.compactTurnArgs,real_database_verified:false,production_accessed:false,source_hashes:sourceHashes,script_hash:scriptHash,session_data:dir,original_evaluation_script_hash:'d3bf49afccf886ab279d3dad84bed1e70c261f38ff7642663dd0b2c5b5c4117a',instrumentation_revision:'explicit_assert_messages_checkpoint_resume',...(fromCase?{resume_from_case:fromCase}:{}),fixed_sampling:'one run per version/scenario; preserve all failures; no reply fishing',scenarios,fixture_checks:fixtureChecks,summary,turns};
  await mkdir(dirname(reportBase),{recursive:true});await writeFile(`${reportBase}.json`,JSON.stringify(report,null,2));
  const lines=turns.map(t=>`| ${t.scenario} / ${t.turn} | ${t.passed?'通过':'失败'} | ${t.measures.error_calls}/${t.measures.tool_calls} | ${t.measures.ungrounded_condition_proposals}/${t.measures.ungrounded_condition_executions} | ${t.measures.unnecessary_clarifications}/${t.measures.repeated_clarifications} | ${t.failure?.replace(/\n/g,' ').slice(0,160)??'条件与目标完整'} |`);
  await writeFile(`${reportBase}.md`,`# Prompt / Skills 真实模型：${phase}\n\n模型：${report.model}；${report.created_at}。各版本每场景一次，失败不重新抽样。真实模型＋隔离合成目录、权限、记录与计算；未访问任何真实业务数据库或生产业务服务。\n\n${JSON.stringify(summary,null,2)}\n\n| 场景 / 回合 | 目标 | 错误调用/全部调用 | 无依据提案/执行 | 不必要/重复澄清 | 说明 |\n| --- | --- | --- | --- | --- | --- |\n${lines.join('\n')}\n\n历史引用与确认采用已通过业务字段校验的隔离种子 Frame，不是模型建立的真实历史；计算场景首轮由实际模型查询再继续计算。preRead 场景通过真实 business_skill_read 生成工具原生回执后加入上下文，仅控制已读正文；未插入业务成功回执或额外答案提示。其他场景由模型自然按需读取。前后模型、场景、干预相同，并记录脚本 hash 与源码 hash。\n\n错误调用按 isError、ARGUMENT_ERROR/error/failed 回执计数，unsupported 预期业务拒绝单列、不计错误。分母为回合内模型全部工具调用，排除受控预读。无依据提案自动检查取数口径与排名条数，执行检查完整 spec；机构/指标/日期来源另以完整目标断言与原始记录核验。已知条件回合结构化 NEEDS_CLARIFICATION 计不必要澄清；应澄清回合超过一次计重复。正文追问但无结构化回执不算有效澄清，按目标失败保留供人工复核。单次小样本不能证明统计显著改善，合成业务验收不代表生产或真实数据库验收。\n\n完整参数、回执、Frame、spec 见同名 JSON。\n`);
  if(phase==='after'&&!partial){
   const before=JSON.parse(await readFile(reportBase.replace(/-after$/,'-before')+'.json','utf8'))as typeof report;
   assert.deepEqual(before.scenarios,scenarios);assert.ok([scriptHash,'d3bf49afccf886ab279d3dad84bed1e70c261f38ff7642663dd0b2c5b5c4117a'].includes(before.script_hash),'UNREVIEWED_MEASUREMENT_SCRIPT_CHANGE');assert.equal(before.model,report.model);assert.equal(before.model_max_tokens,report.model_max_tokens);assert.equal(before.compact_turn_args,report.compact_turn_args);assert.deepEqual(before.model_extra_body,report.model_extra_body);
   const paired=turns.map(t=>{const old=before.turns.find(o=>o.scenario===t.scenario&&o.turn===t.turn)!;return{scenario:t.scenario,turn:t.turn,before:{passed:old.passed,...old.measures},after:{passed:t.passed,...t.measures},result:old.passed?t.passed?'shared_pass':'candidate_only_failure':t.passed?'baseline_only_failure':'shared_failure'};});
   const counts=Object.fromEntries(['shared_pass','candidate_only_failure','baseline_only_failure','shared_failure'].map(k=>[k,paired.filter(p=>p.result===k).length])),base=reportBase.replace(/-after$/,'');
   await writeFile(`${base}.json`,JSON.stringify({created_at:new Date().toISOString(),model:report.model,before:before.summary,after:summary,counts,paired,limitations:'one sample/version; synthetic backend; controlled pre-read subset; not significance or production acceptance'},null,2));
   const keys=['achieved_turns','error_calls','error_rate','ungrounded_condition_proposals','ungrounded_condition_executions','unnecessary_clarifications','repeated_clarifications','model_calls']as const;
   await writeFile(`${base}.md`,`# System Prompt、工具说明和四 Skill 配对验证\n\n真实模型：${report.model}；固定 8 场景 / 11 回合，各版本一次。业务目录、权限、事实、计算为隔离合成桩，未访问真实业务数据库或生产服务。\n\n| 指标 | 修改前 | 修改后 |\n| --- | --- | --- |\n${keys.map(k=>`| ${k} | ${before.summary[k]} | ${summary[k]} |`).join('\n')}\n\n同组结果：${JSON.stringify(counts)}。\n\n| 场景 / 回合 | 前 | 后 | 分类 |\n| --- | --- | --- | --- |\n${paired.map(p=>`| ${p.scenario} / ${p.turn} | ${p.before.passed?'通过':'失败'}；错误${p.before.error_calls} | ${p.after.passed?'通过':'失败'}；错误${p.after.error_calls} | ${p.result} |`).join('\n')}\n\n完整指标定义、干预和失败见同目录 before/after Markdown 与 JSON。每版本仅一次，模型存在随机性，不能宣称统计显著改善；合成业务桩不代表真实目录、数据库或生产已验收。正文中的无结构化追问不算有效澄清，会造成该目标失败并保留人工复核。\n`);
  }
  console.log(JSON.stringify({phase,summary,report:`${reportBase}.json`}));if(summary.achieved_turns!==summary.turns)process.exitCode=1;
 }finally{await host.close();await sessions.close();}
}
await main();
