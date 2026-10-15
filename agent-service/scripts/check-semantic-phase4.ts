/** 阶段4配对/重复运行；成功标准由冻结语料和独立审计判断，不把运行结束当业务成功。 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,mkdtemp} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {BACKGROUND_CONTEXT} from '@earendil-works/pi-agent-core';
import {loadConfig} from '../src/config.js';
import {createAskMetricModels} from '../src/models.js';
import {HarnessHost} from '../src/harnessHost.js';
import {NativeSessionStore} from '../src/nativeSessions.js';
import {NativeSemanticTaskStore} from '../src/semantic-task/store.js';
import {createAskMetricTools} from '../src/tools/index.js';
import {loadBusinessSkills,createBusinessSkillReadTool} from '../src/businessSkills.js';
import {projectEntries} from '../src/sessionProjection.js';
import {createSyntheticBackend} from './phase4-synthetic-backend.js';
import type {BackendUser} from '../src/backendClient.js';
const arg=(key:string,fallback:string)=>process.argv.find(x=>x.startsWith(`--${key}=`))?.slice(key.length+3)??fallback;
const corpusPath=resolve(arg('corpus','../docs/verification/pi-semantic-task-phase4-20261015/corpus-v1.json'));
const corpusBytes=await readFile(corpusPath),corpus=JSON.parse(corpusBytes.toString()),mode=arg('mode','paired');
assert(['paired','stability'].includes(mode));assert(new Set(corpus.cases.map((c:any)=>c.id)).size===corpus.cases.length);
if(!process.argv.includes('--live')){console.log(JSON.stringify({dry_run:true,mode,cases:corpus.cases.length,stability:corpus.stability}));process.exit(0);}
const config=loadConfig();assert.equal(new URL(config.model.baseUrl).hostname,'api.siliconflow.cn');assert.equal(config.model.name,'deepseek-ai/DeepSeek-V4-Flash');
const destination=resolve(arg('report',`../docs/verification/pi-semantic-task-phase4-20261015/${mode}.json`));
const files=['src/harnessHost.ts','src/sessionProjection.ts','src/config.ts','src/models.ts','src/semantic-task/planService.ts','src/semantic-task/service.ts','src/semantic-task/tools.ts','src/semantic-task/feedback.ts','src/semantic-task/prompt.ts','src/business-context/service.ts','src/prompts/businessSystemPrompt.ts','scripts/check-semantic-phase4.ts','scripts/phase4-synthetic-backend.ts','scripts/semantic-task-fixture.py','scripts/generic-query-fixture.py','../backend-next/src/ask_metric/api/routes/business_context.py','../backend-next/src/ask_metric/application/goal_facts.py'];
files.push('src/backendClient.ts','src/semantic-task/protocol.ts','src/semantic-task/store.ts','../backend-next/src/ask_metric/domain/time_expression.py','../backend-next/src/ask_metric/application/field_resolution.py');
const hashes=Object.fromEntries(await Promise.all(files.map(async p=>[p,createHash('sha256').update(await readFile(p)).digest('hex')])));
const root=await mkdtemp(join(tmpdir(),'phase4-model-')),skills=await loadBusinessSkills(),hosts=new Map<string,{host:HarnessHost;store:NativeSessionStore}>();
for(const protocol of mode==='paired'?['fixed_v1','semantic_v2']:['semantic_v2']){
 const directory=join(root,protocol);await mkdir(directory);const store=new NativeSessionStore(directory),local={...config,dataDir:directory,businessProtocol:protocol as 'fixed_v1'|'semantic_v2'};
 hosts.set(protocol,{store,host:new HarnessHost(local,a=>createAskMetricModels(local,a),store,[...createAskMetricTools(),createBusinessSkillReadTool(skills)],{skills})});
}
const actor:BackendUser={id:'synthetic-semantic',username:'synthetic',display_name:'阶段4合成验收',org_code:'SYNTH_ROOT',org_name:'合成集团',role_code:'USER'},tasks:any[]=[];
async function save(){await mkdir(dirname(destination),{recursive:true});await writeFile(destination,JSON.stringify({mode,environment:'same_current_source_real_model_synthetic_backend',real_database:false,requires_independent_audit:true,corpus_sha256:createHash('sha256').update(corpusBytes).digest('hex'),source_hashes:hashes,config:{model:config.model.name,gateway_origin:new URL(config.model.baseUrl).origin,max_tokens:config.model.maxTokens,context_window:config.model.contextWindow,extra_body:Object.fromEntries(Object.entries(config.model.extraBody).filter(([key])=>['temperature','top_p','top_k','presence_penalty','frequency_penalty','seed','enable_thinking','thinking','reasoning_effort'].includes(key))),model_retry:config.modelRetry,first_response_ms:config.modelFirstResponseTimeoutMs,stream_idle_ms:config.modelStreamIdleTimeoutMs,per_turn_budget_ms:120000},native_session_directory:root,finished_tasks:tasks.length,independent_production_corpus:false,tasks},null,2));}
async function run(c:any,protocol:string,repetition:number){
 const {host}=hosts.get(protocol)!;const hosted=await host.createSession(actor),b=createSyntheticBackend(),store=new NativeSemanticTaskStore(hosted.session),turns:any[]=[];
 try{for(const[index,message]of c.messages.entries()){
  const before=b.queries.length,started=performance.now();let failure:string|undefined;
  const admission=await host.admitPrompt(hosted,{protocol_version:3,request_id:`${mode}-${c.id}-${repetition}-${index}`,message},{actor,backend:b.client});assert(admission.ok);
  const timer=setTimeout(()=>void host.abort(hosted,admission.operationId),120000);
  try{const result=await host.drivePrompt(hosted,admission);assert(result.ok&&result.outcome.kind==='settled'&&result.outcome.outcome.status==='completed','MODEL_TURN_COMPLETED');}catch(e){failure=e instanceof Error?e.message:String(e);}finally{clearTimeout(timer);}
  const entries=await hosted.lane.findEntries({order:'oldestFirst'},BACKGROUND_CONTEXT),start=entries.map(e=>e.type==='message'&&e.message.role==='user').lastIndexOf(true),current=entries.slice(start),messages=current.flatMap(e=>e.type==='message'?[e.message]:[]);
  const receipts=messages.flatMap(m=>m.role==='toolResult'?[{name:m.toolName,details:m.details,is_error:!!m.isError}]:[]),calls=messages.flatMap(m=>m.role==='assistant'?m.content.filter(b=>b.type==='toolCall').map(c=>({name:c.name,args:c.arguments})):[]),answer=projectEntries(current).filter(m=>m.role==='assistant').map(m=>m.text).join('\n');
  const plan=await store.plan((await store.planIndex()).focus??'');turns.push({turn:index+1,message,run_failure:failure,model_calls:admission.request.timings?.model_ms.length,elapsed_ms:Math.round(performance.now()-started),queries:b.queries.slice(before),receipts,calls,answer,completion:plan?.completion,model_error_codes:messages.flatMap(m=>m.role==='assistant'&&/^402\b/u.test(m.errorMessage??'')?['HTTP_402']:[])});
 }}finally{await host.closeSession(hosted.sessionId);}
 tasks.push({case_id:c.id,group:c.group,protocol,repetition,turns});await save();console.log(JSON.stringify({case_id:c.id,protocol,repetition,run_failures:turns.filter(t=>t.run_failure).map(t=>t.run_failure)}));if(turns.some(t=>t.model_error_codes.includes('HTTP_402')))throw new Error('MODEL_GATEWAY_HTTP_402: stopped batch; restore gateway before retry');
}
try{if(mode==='paired')for(const[index,c]of corpus.cases.entries())for(const protocol of index%2?['semantic_v2','fixed_v1']:['fixed_v1','semantic_v2'])await run(c,protocol,1);
else for(let i=1;i<=corpus.stability.repetitions;i++)for(const id of corpus.stability.case_ids)await run(corpus.cases.find((c:any)=>c.id===id),'semantic_v2',i);
}finally{await save();for(const{host,store}of hosts.values()){await host.close();await store.close();}}
