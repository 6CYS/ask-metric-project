/** 冻结独立期望对照正式SQL/结果；不联网，不改原始运行记录。 */
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
const [input,output,corpusFile='../docs/verification/pi-semantic-task-phase4-20261015/corpus-v1.json']=process.argv.slice(2);assert(input&&output&&input!==output);
const raw=JSON.parse(await readFile(input,'utf8')),bytes=await readFile(corpusFile),corpus=JSON.parse(bytes);assert.equal(raw.corpus_sha256,createHash('sha256').update(bytes).digest('hex'));
const sorted=items=>items.map(x=>JSON.stringify(x)).sort();
const flatten=v=>v?.kind==='semantic_results'?v.results.flatMap(flatten):v?[v]:[];
function inspect(e,t,protocol){
 assert(!t.model_error_codes?.includes('HTTP_402'),'MODEL_GATEWAY_HTTP_402');assert(!t.run_failure,t.run_failure);assert(t.answer.trim(),'VISIBLE_ANSWER');assert(!/达到工具调用限额|处理未完成|模型响应未完成|本轮模型响应未完成|尚未形成可执行任务|本次分析尚未完成|相同参数重复/u.test(t.answer),'DELIVERY_NOT_INCOMPLETE');
 if(e.no_query){assert.equal(t.queries.length,0,'NO_SQL_BEFORE_USER_INPUT');assert(t.receipts.some(r=>['needs_user','NEEDS_CLARIFICATION'].includes(r.details?.status)),'FORMAL_NECESSARY_CLARIFICATION');return;}
 assert(t.queries.length,'BUSINESS_EXECUTION_REQUIRED');const actual=[];
 for(const q of t.queries){assert(Array.isArray(q.rows),'SUCCESSFUL_SQL');const s=q.spec;assert(s.time.start===s.time.end&&!s.time.dates||s.time.dates,'NO_UNREQUESTED_RANGE');
  for(const org of s.org_codes)for(const metric of s.metric_codes)for(const date of s.time.dates??[s.time.start])actual.push({org,metric,date});
  assert.equal(s.selection??'exact','exact','EXACT_DATE_SELECTION');
  for(const[field,v]of Object.entries(e.operation??{kind:'value'}))assert.equal((s.operation??{kind:'value'})[field],v,'QUERY_OPERATION');
  if(e.comparison_orgs)assert.deepEqual(sorted(s.comparison_scope?.org_codes??[]),sorted(e.comparison_orgs),'COMPARISON_POPULATION');else assert(!s.comparison_scope,'NO_EXTRA_COMPARISON_SCOPE');
 }
 assert.deepEqual(sorted(actual),sorted(e.tuples),'COMPLETE_TUPLE_BINDING_WITHOUT_DUPLICATE_SQL');const rows=t.queries.flatMap(q=>q.rows);
 if(e.empty)assert.equal(rows.length,0,'EMPTY_RESULT');else if(e.null)assert(rows.length&&rows.every(r=>r.metric_value===null),'NULL_NOT_ZERO');else assert(rows.length,'EXPECTED_DATA');
 if(e.result_orgs)assert.deepEqual(sorted(rows.map(r=>r.org_code)),sorted(e.result_orgs),'RANK_RESULT');
 const evidence=t.receipts.flatMap(r=>flatten(r.details?.state?.evidence??r.details));
 if(e.calculation){const calc=evidence.find(v=>v.kind==='metric_calculate'&&v.status==='succeeded');assert(calc,'FORMAL_CALCULATION');assert(calc.results?.some(r=>Number(r.value)===Number(e.calculation_value)),'CALCULATION_DIRECTION_AND_VALUE');}
 if(e.staged){const counts=t.receipts.filter(r=>r.details?.protocol_version===2&&r.details?.state).map(r=>r.details.state.targets.filter(v=>v.kind==='query'&&v.status==='succeeded').length);assert(counts.includes(1)&&counts.includes(2),'RESULT_DRIVEN_SECOND_STAGE');}
 if(protocol==='semantic_v2')assert.equal(t.completion,'full','COMPLETE_EVIDENCE');
}
const tasks=raw.tasks.map(task=>{const c=corpus.cases.find(c=>c.id===task.case_id);assert(c);const turns=task.turns.map((t,i)=>{let failure;try{inspect(c.expect[i],t,task.protocol);}catch(e){failure=e.message;}return {turn:t.turn,passed:!failure,failure,model_calls:t.model_calls,elapsed_ms:t.elapsed_ms,executions:t.queries.length};});return {case_id:task.case_id,protocol:task.protocol,repetition:task.repetition,passed:turns.length===c.expect.length&&turns.every(t=>t.passed),turns};});
const source=[];for(const[p,hash]of Object.entries(raw.source_hashes))source.push({path:p,matches:createHash('sha256').update(await readFile(resolve(p))).digest('hex')===hash});
const groups=raw.mode==='paired'?corpus.cases.map(c=>{const a=tasks.find(t=>t.case_id===c.id&&t.protocol==='fixed_v1'),b=tasks.find(t=>t.case_id===c.id&&t.protocol==='semantic_v2');return {case_id:c.id,classification:!a||!b?'pending':a.passed&&b.passed?'both_passed':!a.passed&&!b.passed?'shared_failure':a.passed?'candidate_only_failure':'baseline_only_failure'};}):corpus.stability.case_ids.map(id=>{const runs=tasks.filter(t=>t.case_id===id);return {case_id:id,runs:runs.length,passed:runs.filter(t=>t.passed).length,all_repetitions_passed:runs.length===corpus.stability.repetitions&&runs.every(t=>t.passed)};});
const expected=raw.mode==='paired'?corpus.cases.length*2:corpus.stability.case_ids.length*corpus.stability.repetitions;
const result={source_report:input,mode:raw.mode,finished:tasks.length===expected,source_hashes_match:source.every(x=>x.matches),source_hash_checks:source,passed:tasks.filter(t=>t.passed).length,total:tasks.length,expected_total:expected,groups,tasks,independent_production_corpus:false,natural_language_factual_attribution_audited:false,note:'统计完整任务；重复不增加独立样本数；新旧同源码和预算，不等于Git历史版本对照；不足以声明95%覆盖率。'};
await writeFile(output,JSON.stringify(result,null,2));console.log(JSON.stringify({finished:result.finished,passed:result.passed,total:result.total,source_hashes_match:result.source_hashes_match,groups}));
if(!result.finished||!result.source_hashes_match||raw.mode==='stability'&&tasks.some(t=>!t.passed))process.exitCode=1;
