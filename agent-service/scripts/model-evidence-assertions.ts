/** 真实模型验收只允许以正式成功且完整的查询证据替代同条件重复SQL。 */
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
export type EvidenceQuery = {metric: string; org: string; day: string};
type ProjectedAnswer = {role: string; text?: string; error?: string; entry_id?: string};
export function authoritativeAnswer(messages: ProjectedAnswer[]) {
  const answers = messages.filter(message => message.role === 'assistant' && message.text?.trim());
  const final = answers.at(-1);
  const intermediateErrors = answers.slice(0, -1).flatMap(message => message.error ? [{entry_id: message.entry_id, error: message.error}] : []);
  return {final, intermediate_errors: intermediateErrors, recovered: !!final && !final.error && intermediateErrors.length > 0};
}
export function assertAuthoritativeAnswer(delivery: ReturnType<typeof authoritativeAnswer>, finalModelMessage?: {stopReason?: string}) {
  const final = delivery.final;
  assert(final, 'FINAL_VISIBLE_ANSWER_REQUIRED');
  assert(final.text?.trim(), 'FINAL_VISIBLE_ANSWER_REQUIRED');
  assert(!final.error, 'FINAL_DELIVERY_ERROR');
  assert(!['error', 'aborted'].includes(finalModelMessage?.stopReason ?? ''), 'FINAL_MODEL_RESPONSE_INCOMPLETE');
}
export function assertSuccessfulQueryFrames(queries: Array<{spec: any; result_ref?: string}>, frames: any[]) {
  for (const query of queries) {
    assert(query.result_ref, 'QUERY_RESULT_REFERENCE_REQUIRED');
    assert(frames.some(frame => frame.capability === 'metric_query' && frame.status === 'success' && frame.resultRef === query.result_ref
      && isDeepStrictEqual(frame.fields.metrics?.resolvedValue?.codes, query.spec.metric_codes)
      && isDeepStrictEqual(frame.fields.organizations?.resolvedValue?.codes, query.spec.org_codes)
      && isDeepStrictEqual(frame.fields.time?.resolvedValue, query.spec.time)
      && isDeepStrictEqual(frame.fields.selection?.resolvedValue, query.spec.selection)
      && isDeepStrictEqual(frame.fields.operation?.resolvedValue, query.spec.operation ?? {kind: 'value'})
      && isDeepStrictEqual(frame.fields.comparison_organizations?.resolvedValue?.codes, query.spec.comparison_scope?.org_codes)),
    'QUERY_MUST_HAVE_OWN_MATCHING_SUCCESS_FRAME');
  }
}
export function assertSuccessfulQueryEvidence(feedback: any, expected: EvidenceQuery[]) {
  assert(['succeeded', 'reused'].includes(feedback?.status), 'REUSE_FORMAL_SUCCESS_REQUIRED');
  assert(feedback.state?.evidence, 'REUSE_FORMAL_EVIDENCE_REQUIRED');
  const actual: EvidenceQuery[] = [];
  const visit = (value: any) => {
    assert(value && typeof value === 'object', 'REUSE_EVIDENCE_OBJECT_REQUIRED');
    assert(!['truncated', 'result_truncated', 'facts_truncated'].some(key => value[key] === true), 'REUSE_EVIDENCE_MUST_BE_COMPLETE');
    if (value.status !== undefined) assert.equal(value.status, 'succeeded', 'REUSE_EVIDENCE_SUCCESS_REQUIRED');
    const nested = [...(Array.isArray(value.results) ? value.results : []), ...(Array.isArray(value.payloads) ? value.payloads : [])];
    if (nested.length) {for (const item of nested) visit(item); return;}
    assert.equal(typeof value.task_id, 'string', 'REUSE_EVIDENCE_TASK_REQUIRED');
    assert.equal(typeof value.result_id, 'string', 'REUSE_EVIDENCE_RESULT_REQUIRED');
    const rows = Array.isArray(value.rows) ? value.rows : undefined;
    if (rows) {
      assert(rows.length > 0, 'REUSE_EVIDENCE_ROWS_REQUIRED');
      assert(value.result_truncated === false || value.truncated === false, 'REUSE_EVIDENCE_COMPLETENESS_REQUIRED');
      assert.equal(value.row_count, rows.length, 'REUSE_EVIDENCE_ALL_ROWS_REQUIRED');
      for (const row of rows) {
        assert([row.metric_code, row.org_code, row.stat_date].every(item => typeof item === 'string'), 'REUSE_EVIDENCE_IDENTITY_REQUIRED');
        assert(row.metric_value !== null && row.metric_value !== undefined, 'REUSE_QUERY_VALUE_REQUIRED');
        actual.push({metric: row.metric_code, org: row.org_code, day: row.stat_date});
      }
    } else {
      assert(Array.isArray(value.facts) && value.facts.length > 0, 'REUSE_EVIDENCE_FACTS_REQUIRED');
      assert.equal(value.facts_truncated, false, 'REUSE_FACT_COMPLETENESS_REQUIRED');
      assert.equal(value.fact_count, value.facts.length, 'REUSE_EVIDENCE_ALL_FACTS_REQUIRED');
      for (const fact of value.facts) {
        assert([fact.fact_id, fact.task_id, fact.metric_code, fact.org_code, fact.date].every(item => typeof item === 'string'), 'REUSE_FACT_IDENTITY_REQUIRED');
        assert.equal(fact.task_id, value.task_id, 'REUSE_FACT_TASK_MISMATCH');
        assert.equal(fact.field, 'metric_value', 'REUSE_QUERY_FACT_REQUIRED');
        assert(fact.value !== null && fact.value !== undefined, 'REUSE_QUERY_VALUE_REQUIRED');
        actual.push({metric: fact.metric_code, org: fact.org_code, day: fact.date});
      }
    }
  };
  visit(feedback.state.evidence);
  const tuple = (query: EvidenceQuery) => JSON.stringify([query.metric, query.org, query.day]);
  assert.deepEqual(actual.map(tuple).sort(), expected.map(tuple).sort(), 'EXACT_REUSED_QUERY_EVIDENCE');
}
