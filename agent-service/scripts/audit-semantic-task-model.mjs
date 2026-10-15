/** 独立复核已保存验收记录；不联网、不覆盖原始失败报告。 */
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
const input = process.argv[2], output = process.argv[3];
assert(input && output && input !== output, '需要不同的输入和输出报告路径');
const report = JSON.parse(await readFile(input, 'utf8'));
const turns = report.turns.map(turn => {
  let failure;
  const needsUser = ['missing-and-followup', 'relative-range', 'base-confirm'].includes(turn.scenario) && turn.turn === 1;
  const feedback = turn.receipts.filter(receipt => receipt.details?.protocol_version === 2 && receipt.details?.state && typeof receipt.details.status === 'string');
  const status = feedback.at(-1)?.details.status;
  try {
    assert.equal(status, needsUser ? 'needs_user' : 'succeeded', 'FORMAL_STATUS');
    assert(turn.answer.trim(), 'VISIBLE_ANSWER');
    assert.equal(turn.queries.length, needsUser ? 0 : 1, 'EXECUTION_COUNT');
    if (!needsUser) {
      assert.equal(turn.task.completion, 'full', 'FULL_EVIDENCE');
      assert.equal(turn.task.target.status, 'succeeded', 'FORMAL_EXECUTION');
      const query = turn.queries[0].spec;
      assert.deepEqual(query.metric_codes, ['SYNTH_M:D']); assert.deepEqual(query.org_codes, ['SYNTH_O1']);
      if (turn.scenario === 'relative-range') {
        const prior = report.turns.find(item => item.scenario === turn.scenario && item.turn === 1);
        assert.deepEqual(query.time, prior.task.target.fields.time.candidates[1].metadata.calendar, 'SAVED_DATE_CHOICE');
        assert.equal(query.selection, 'all_in_range');
      } else {assert.deepEqual(query.time, {start: '2026-05-31', end: '2026-05-31'}); assert.equal(query.selection, 'exact');}
    }
  } catch (error) {failure = error.message;}
  return {scenario: turn.scenario, turn: turn.turn, passed: !failure, failure, formal_status: status,
    original_passed: turn.passed, original_failure: turn.failure,
    test_detector_correction: !turn.passed && !failure ? 'read-only context receipt has no business status and must not replace execution feedback' : undefined};
});
const audited = {source_report: input, original_passed: report.passed, original_total: report.total,
  note: '原报告保留。只读上下文回执不属于业务执行状态；以正式执行回执、查询次数、任务快照及原始日期候选独立复核。',
  passed: turns.filter(turn => turn.passed).length, total: turns.length, turns};
await writeFile(output, JSON.stringify(audited, null, 2));
console.log(JSON.stringify({passed: audited.passed, total: audited.total}));
if (audited.passed !== audited.total) process.exitCode = 1;
