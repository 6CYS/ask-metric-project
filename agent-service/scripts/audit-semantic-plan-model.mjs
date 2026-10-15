/** 只审计已有合成验收证据；不联网，原报告与失败保持不变。 */
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
const [input, output] = process.argv.slice(2);
assert(input && output && input !== output, '指定不同输入/输出文件');
const report = JSON.parse(await readFile(input, 'utf8'));
const flatten = value => value?.kind === 'semantic_results' ? value.results.flatMap(flatten) : value ? [value] : [];
const canonical = query => JSON.stringify([query.org_codes, query.metric_codes, query.time]);
const turns = report.turns.map(turn => {
  let failure;
  const feedback = turn.receipts.filter(receipt => receipt.details?.protocol_version === 2 && receipt.details.state && receipt.details.status);
  const final = feedback.at(-1)?.details, base = turn.scenario.split('-repeat-')[0], pending = base === 'missing-followup' && turn.turn === 1;
  try {
    assert.equal(final?.status, pending ? 'needs_user' : 'succeeded', 'FORMAL_STATUS');
    assert(turn.answer.trim(), 'VISIBLE_ANSWER');
    assert(!/达到工具调用限额|处理未完成|相同提案未取得进展|业务目标尚未形成可执行任务/u.test(turn.answer), 'DELIVERY_NOT_INCOMPLETE');
    assert.equal(turn.queries.length, pending ? 0 : ['composite','calculation','analysis-result-driven'].includes(base) ? 2 : 1, 'EXECUTION_COUNT');
    if (!pending) {
      assert.equal(turn.task.completion, 'full', 'FULL_EVIDENCE');
      assert(turn.task.steps.every(step => step.status === 'succeeded' && !step.evidence?.truncated), 'ALL_TARGET_EVIDENCE');
      const sorted = turn.queries.map(item => canonical(item.spec)).sort();
      const spec = (org, metric, date) => canonical({org_codes:[org],metric_codes:[metric],time:{start:date,end:date}});
      if (base === 'composite') assert.deepEqual(sorted, [spec('SYNTH_O1','SYNTH_M:D','2026-05-31'),spec('SYNTH_O2','SYNTH_M:Y','2026-06-30')].sort(), 'TUPLE_BINDING');
      if (base === 'calculation') {
        assert.deepEqual(sorted, [spec('SYNTH_O1','SYNTH_M:D','2026-05-31'),spec('SYNTH_O1','SYNTH_M:D','2026-06-30')].sort());
        assert(feedback.flatMap(item => flatten(item.details.state.evidence)).some(item => item.kind === 'metric_calculate' && item.status === 'succeeded'), 'FORMAL_CALCULATION');
      }
      if (base === 'rank-position') {
        const query = turn.queries[0].spec;
        assert.deepEqual(query.org_codes,['SYNTH_O1']); assert.deepEqual([...query.comparison_scope.org_codes].sort(),['SYNTH_O1','SYNTH_O2']); assert.equal(query.operation.kind,'rank_position');
      }
      if (base === 'ranking') {assert.equal(turn.queries[0].spec.operation.top_n,1); assert.deepEqual([...turn.queries[0].spec.org_codes].sort(),['SYNTH_O1','SYNTH_O2']);}
      if (base === 'analysis-result-driven') {
        assert.deepEqual(sorted,[spec('SYNTH_O1','SYNTH_M:D','2026-05-31'),spec('SYNTH_O1','SYNTH_M:Y','2026-05-31')].sort());
        const successes = feedback.map(item => item.details.state.targets.filter(target => target.kind === 'query' && target.status === 'succeeded').length);
        assert(successes.includes(1) && successes.includes(2), 'RESULT_DRIVEN_SECOND_STAGE');
      }
    }
  } catch (error) {failure = error.message;}
  return {scenario:turn.scenario,turn:turn.turn,passed:!failure,failure,original_passed:turn.passed,original_failure:turn.failure,status:final?.status,model_calls:turn.model_calls};
});
const source = [];
for (const [path, hash] of Object.entries(report.source_hashes ?? {})) {
  const actual = createHash('sha256').update(await readFile(resolve(path))).digest('hex'); source.push({path, matches:actual === hash});
}
const result = {source_report:input, environment:report.environment, natural_language_factual_attribution_audited:false,
  note:'检查任务义务、条件绑定、执行次数、正式结果与结果驱动阶段；工具预算耗尽不算完成。小规模合成样本不证明95%覆盖率。',
  source_hashes_match:source.every(item=>item.matches),source_hash_checks:source,passed:turns.filter(turn=>turn.passed).length,total:turns.length,turns};
await writeFile(output,JSON.stringify(result,null,2)); console.log(JSON.stringify({passed:result.passed,total:result.total,source_hashes_match:result.source_hashes_match}));
if (result.passed !== result.total || !result.source_hashes_match) process.exitCode=1;
