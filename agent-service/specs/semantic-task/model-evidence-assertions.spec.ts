import {expect, it} from 'vitest';
import {assertSuccessfulQueryEvidence, assertSuccessfulQueryFrames, authoritativeAnswer, assertAuthoritativeAnswer} from '../../scripts/model-evidence-assertions.js';
const expected = [{metric: 'M', org: 'O', day: '2026-05-31'}];
const payload = () => ({status: 'succeeded', task_id: 'query-1', result_id: 'result-1', row_count: 1, result_truncated: false,
  rows: [{metric_code: 'M', org_code: 'O', stat_date: '2026-05-31', metric_value: 1}]});
const feedback = (value = payload()) => ({status: 'reused', state: {evidence: {kind: 'metric_read', status: 'succeeded', payloads: [value]}}});
it('同条件复用必须具有正式成功且完整的精确证据', () => {
  expect(() => assertSuccessfulQueryEvidence(feedback(), expected)).not.toThrow();
});
it('正式status成功但没有证据不能替代SQL', () => {
  expect(() => assertSuccessfulQueryEvidence({status: 'succeeded', state: {}}, expected)).toThrow('REUSE_FORMAL_EVIDENCE_REQUIRED');
});
it.each(['metric_code', 'org_code', 'stat_date'])('复用证据的%s不同即失败', field => {
  const value = payload(); (value.rows[0] as Record<string, unknown>)[field] = 'WRONG';
  expect(() => assertSuccessfulQueryEvidence(feedback(value), expected)).toThrow('EXACT_REUSED_QUERY_EVIDENCE');
});
it('截断证据不能替代SQL', () => {
  expect(() => assertSuccessfulQueryEvidence(feedback({...payload(), result_truncated: true}), expected)).toThrow('REUSE_EVIDENCE_MUST_BE_COMPLETE');
});
it('完整性未知或数据点缺失的证据不能替代SQL', () => {
  const value: any = payload(); delete value.result_truncated;
  expect(() => assertSuccessfulQueryEvidence(feedback(value), expected)).toThrow('REUSE_EVIDENCE_COMPLETENESS_REQUIRED');
  value.result_truncated = false; delete value.rows[0].metric_value;
  expect(() => assertSuccessfulQueryEvidence(feedback(value), expected)).toThrow('REUSE_QUERY_VALUE_REQUIRED');
});
it('失败或未完成的证据不能替代SQL', () => {
  expect(() => assertSuccessfulQueryEvidence(feedback({...payload(), status: 'failed'}), expected)).toThrow('REUSE_EVIDENCE_SUCCESS_REQUIRED');
});
it('额外的范围或重复证据不能被静默去重后当成功', () => {
  const value = payload(); value.rows.push({...value.rows[0]!}); value.row_count = 2;
  expect(() => assertSuccessfulQueryEvidence(feedback(value), expected)).toThrow('EXACT_REUSED_QUERY_EVIDENCE');
});
it('无任务和结果引用的孤立数据不能替代SQL', () => {
  const value: any = payload(); delete value.result_id;
  expect(() => assertSuccessfulQueryEvidence(feedback(value), expected)).toThrow('REUSE_EVIDENCE_RESULT_REQUIRED');
});
it('没有rows时允许同一正式查询的完整metric_value事实，并核验身份', () => {
  const value = {status: 'succeeded', task_id: 'query-1', result_id: 'result-1', fact_count: 1, facts_truncated: false,
    facts: [{fact_id: 'fact-1', task_id: 'query-1', field: 'metric_value', metric_code: 'M', org_code: 'O', date: '2026-05-31', value: '1'}]};
  expect(() => assertSuccessfulQueryEvidence({status: 'reused', state: {evidence: value}}, expected)).not.toThrow();
  value.facts[0]!.task_id = 'unrelated';
  expect(() => assertSuccessfulQueryEvidence({status: 'reused', state: {evidence: value}}, expected)).toThrow('REUSE_FACT_TASK_MISMATCH');
});
it('投影只使用最后权威正文，之前传输失败后成功恢复单独记录', () => {
  const delivery = authoritativeAnswer([
    {role: 'assistant', entry_id: 'temporary-error', text: '暂时超时', error: 'timeout'},
    {role: 'assistant', entry_id: 'tool-call', text: ''},
    {role: 'assistant', entry_id: 'final-success', text: '正式查询结果'},
  ]);
  expect(delivery.final).toMatchObject({entry_id: 'final-success', text: '正式查询结果'});
  expect(delivery.recovered).toBe(true);
  expect(delivery.intermediate_errors).toEqual([{entry_id: 'temporary-error', error: 'timeout'}]);
  expect(() => assertAuthoritativeAnswer(delivery, {stopReason: 'stop'})).not.toThrow();
});
it('旧成功证据和任意非空错误文案不能掩盖最终投影失败', () => {
  const delivery = authoritativeAnswer([{role: 'assistant', text: '请重试未完成部分', error: 'timeout'}]);
  expect(() => assertSuccessfulQueryEvidence(feedback(), expected)).not.toThrow();
  expect(() => assertAuthoritativeAnswer(delivery)).toThrow('FINAL_DELIVERY_ERROR');
});
it('先成功后最终失败不能取前一条成功正文代替', () => {
  const delivery = authoritativeAnswer([{role: 'assistant', text: '前一条结果'}, {role: 'assistant', text: '最终错误', error: 'failed'}]);
  expect(delivery.recovered).toBe(false);
  expect(() => assertAuthoritativeAnswer(delivery)).toThrow('FINAL_DELIVERY_ERROR');
});
it.each(['error', 'aborted'])('最终模型%s不能因投影非空而计为完成', stopReason => {
  const delivery = authoritativeAnswer([{role: 'assistant', text: '非空正文'}]);
  expect(() => assertAuthoritativeAnswer(delivery, {stopReason})).toThrow('FINAL_MODEL_RESPONSE_INCOMPLETE');
});
it('只有工具中间消息、没有最终正文不能计为完成', () => {
  expect(() => assertAuthoritativeAnswer(authoritativeAnswer([{role: 'assistant', text: ''}]))).toThrow('FINAL_VISIBLE_ANSWER_REQUIRED');
});
it('正式反馈要求用户补充时不能拿旧证据和追问文本计为成功', () => {
  const wrong = {...feedback(), status: 'needs_user'};
  expect(() => assertSuccessfulQueryEvidence(wrong, expected)).toThrow('REUSE_FORMAL_SUCCESS_REQUIRED');
});
it('历史双目标回看需要两个精确正式来源，少一项或读错历史都失败', () => {
  const first = payload(), second = {...payload(), task_id: 'query-2', result_id: 'result-2', rows: [{...payload().rows[0]!, org_code: 'O2', stat_date: '2026-06-30'}]};
  const want = [...expected, {metric: 'M', org: 'O2', day: '2026-06-30'}];
  const both = {status: 'reused', state: {evidence: {kind: 'semantic_results', status: 'succeeded', results: [first, second]}}};
  expect(() => assertSuccessfulQueryEvidence(both, want)).not.toThrow();
  expect(() => assertSuccessfulQueryEvidence(feedback(), want)).toThrow('EXACT_REUSED_QUERY_EVIDENCE');
  second.rows[0]!.org_code = 'WRONG';
  expect(() => assertSuccessfulQueryEvidence(both, want)).toThrow('EXACT_REUSED_QUERY_EVIDENCE');
});
const frameQuery = () => ({result_ref: 'query:q1:r1', spec: {metric_codes: ['M'], org_codes: ['O'], time: {start: '2026-05-31', end: '2026-05-31'}, selection: 'exact', operation: {kind: 'value'}}});
const successFrame = (): any => ({capability: 'metric_query', status: 'success', resultRef: 'query:q1:r1', fields: {
  metrics: {resolvedValue: {codes: ['M']}}, organizations: {resolvedValue: {codes: ['O']}},
  time: {resolvedValue: {start: '2026-05-31', end: '2026-05-31'}}, selection: {resolvedValue: 'exact'}, operation: {resolvedValue: {kind: 'value'}},
}});
it('每次SQL都必须有其正式结果引用及完整规范条件相同的成功Frame', () => {
  expect(() => assertSuccessfulQueryFrames([frameQuery()], [successFrame()])).not.toThrow();
});
it.each(['metrics', 'organizations', 'time', 'selection', 'operation'])('Frame的%s不匹配不能用其他Frame存在代替', field => {
  const frame = successFrame(); frame.fields[field].resolvedValue = 'WRONG';
  expect(() => assertSuccessfulQueryFrames([frameQuery()], [frame])).toThrow('QUERY_MUST_HAVE_OWN_MATCHING_SUCCESS_FRAME');
});
it('存在旧Frame或同条件但不同查询引用的Frame仍不能证明新SQL经过Frame', () => {
  const frame = {...successFrame(), resultRef: 'query:old:old'};
  expect(() => assertSuccessfulQueryFrames([frameQuery()], [frame])).toThrow('QUERY_MUST_HAVE_OWN_MATCHING_SUCCESS_FRAME');
});
it('两个SQL必须分别有对应Frame，不能共用任意一个Frame证明全部执行', () => {
  const first = frameQuery(), second = {...frameQuery(), result_ref: 'query:q2:r2'};
  expect(() => assertSuccessfulQueryFrames([first, second], [successFrame()])).toThrow('QUERY_MUST_HAVE_OWN_MATCHING_SUCCESS_FRAME');
  expect(() => assertSuccessfulQueryFrames([first, second], [successFrame(), {...successFrame(), resultRef: second.result_ref}])).not.toThrow();
});
it('未成功的Frame不能证明正式查询完成', () => {
  expect(() => assertSuccessfulQueryFrames([frameQuery()], [{...successFrame(), status: 'executing'}])).toThrow('QUERY_MUST_HAVE_OWN_MATCHING_SUCCESS_FRAME');
});
