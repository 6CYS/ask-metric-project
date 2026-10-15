/** 对完整配对任务审计；失败和未知usage必须保留，不能用成功子集替代全部计划。 */
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {resolve, dirname, basename, join} from 'node:path';
const input = resolve(process.argv[2] ?? '../docs/verification/token-optimization-20261015/paired.json');
const report = JSON.parse(await readFile(input, 'utf8'));
const sum = (values) => values.reduce((n, v) => n + v, 0);
const median = (values) => {const s = [...values].sort((a, b) => a - b); return s.length ? (s[Math.floor((s.length - 1) / 2)] + s[Math.floor(s.length / 2)]) / 2 : null;};
const p95 = (values) => {const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.ceil(s.length * 0.95) - 1] : null;};
function measures(tasks) {
  const turns = tasks.flatMap(task => task.turns), rows = [...new Map(turns.flatMap(turn => turn.usage).map(u => [u.usage_id, u])).values()];
  const available = rows.filter(u => u.usage_known);
  const known = rows.length > 0 && rows.every(u => u.usage_known && u.accounting_complete !== false);
  return {tasks: tasks.length, passed_tasks: tasks.filter(t => t.passed).length, turns: turns.length, passed_turns: turns.filter(t => t.passed).length,
    model_calls: sum(turns.map(t => t.physical_calls?.length ?? t.model_calls)), unique_usage_rows: rows.length,
    sql_executions: sum(turns.map(t => t.query_count)), unknown_usage_calls: rows.filter(u => !u.usage_known).length,
    incomplete_accounting_calls: rows.filter(u => u.accounting_complete === false).length,
    input_tokens: known ? sum(rows.map(u => u.input_tokens)) : null, output_tokens: known ? sum(rows.map(u => u.output_tokens)) : null,
    cache_read_tokens: known ? sum(rows.map(u => u.cache_read_tokens)) : null,
    noncache_input_tokens: known ? sum(rows.map(u => u.noncache_input_tokens)) : null,
    total_tokens: known ? sum(rows.map(u => u.total_tokens)) : null,
    known_usage_subtotal: {calls: available.length, input_tokens: sum(available.map(u => u.input_tokens)), output_tokens: sum(available.map(u => u.output_tokens)),
      cache_read_tokens: sum(available.map(u => u.cache_read_tokens)), noncache_input_tokens: sum(available.map(u => u.noncache_input_tokens)), total_tokens: sum(available.map(u => u.total_tokens))},
    task_input_median: known ? median(tasks.map(t => sum(t.turns.flatMap(x => x.usage).map(u => u.input_tokens)))) : null,
    task_input_p95: known ? p95(tasks.map(t => sum(t.turns.flatMap(x => x.usage).map(u => u.input_tokens)))) : null,
    task_calls_median: median(tasks.map(t => sum(t.turns.map(x => x.model_calls)))),
    task_calls_p95: p95(tasks.map(t => sum(t.turns.map(x => x.model_calls)))),
    accounting_status: known ? 'complete_provider_reported_usage' : 'reported_only_incomplete_not_total_bill',
    restore_zero_sql: turns.every(t => t.restore_zero_sql),
    restore_zero_model: turns.every(t => t.restore_zero_model === true),
    restore_zero_model_measured: turns.every(t => typeof t.restore_zero_model === 'boolean'),
    failures: turns.filter(t => !t.passed).map(t => ({turn: t.turn, failures: t.failures}))};
}
const baseline = report.tasks.filter(t => t.version === 'baseline'), candidate = report.tasks.filter(t => t.version === 'candidate');
const key = (t) => `${t.case_id}:${t.repetition}`;
const businessHashes = (task) => task.turns.map(t => (t.query_evidence ?? []).map(e => [e.target, e.rows_sha256])
  .sort((a, b) => JSON.stringify(a[0]).localeCompare(JSON.stringify(b[0]))));
assert(new Set(report.tasks.map(t => `${key(t)}:${t.version}`)).size === report.tasks.length, 'DUPLICATE_TASK');
const pairs = baseline.map(old => {
  const next = candidate.find(t => key(t) === key(old));
  return {key: key(old), group: old.group, classification: !next ? 'missing_candidate' : old.passed ? next.passed ? 'shared_pass' : 'candidate_only_failure' : next.passed ? 'baseline_only_failure' : 'shared_failure',
    baseline: measures([old]), candidate: next ? measures([next]) : null,
    exact_result_hashes_equal: next ? JSON.stringify(businessHashes(old)) === JSON.stringify(businessHashes(next)) : null,
    terminal_states_equal: next ? JSON.stringify(old.turns.map(t => [t.status, t.formal_issue_codes])) === JSON.stringify(next.turns.map(t => [t.status, t.formal_issue_codes])) : null};
});
const counts = Object.fromEntries(['shared_pass', 'candidate_only_failure', 'baseline_only_failure', 'shared_failure', 'missing_candidate'].map(c => [c, pairs.filter(p => p.classification === c).length]));
const before = measures(baseline), after = measures(candidate);
const reduction = (a, b) => a === null || b === null || !a ? null : 1 - b / a;
const pairedOrdinary = pairs.filter(p => p.group === 'ordinary' && p.classification === 'shared_pass');
const ordinaryBefore = measures(baseline.filter(t => pairedOrdinary.some(p => p.key === key(t)))), ordinaryAfter = measures(candidate.filter(t => pairedOrdinary.some(p => p.key === key(t))));
const full = report.finished_tasks === report.planned_tasks && pairs.length > 0 && pairs.every(p => p.candidate !== null);
const fullyKnownPairs = pairs.filter(p => p.candidate && !p.baseline.unknown_usage_calls && !p.candidate.unknown_usage_calls
  && !p.baseline.incomplete_accounting_calls && !p.candidate.incomplete_accounting_calls);
const sharedFailuresAcceptable = pairs.filter(p => p.classification === 'shared_failure').every(p => p.group === 'diagnostic' && p.terminal_states_equal
  && p.baseline.failures.length > 0 && p.candidate.failures.length > 0
  && [...p.baseline.failures, ...p.candidate.failures].every(turn => turn.failures.every(error => error === 'FORMAL_QUERY_SUCCESS')));
const sharedPassResultsEqual = pairs.filter(p => p.classification === 'shared_pass').every(p => p.exact_result_hashes_equal);
const allRestoreZeroSql = before.restore_zero_sql && after.restore_zero_sql;
const allRestoreZeroModel = before.restore_zero_model && after.restore_zero_model;
const audit = {created_at: new Date().toISOString(), source: basename(input), source_script_sha256: report.script_sha256,
  corpus_sha256: report.corpus_sha256, complete_planned_matrix: full, planned_tasks: report.planned_tasks, finished_tasks: report.finished_tasks,
  classifications: counts, all_tasks: {baseline: before, candidate: after, input_reduction: full ? reduction(before.input_tokens, after.input_tokens) : null,
    total_token_reduction: full ? reduction(before.total_tokens, after.total_tokens) : null,
    call_reduction: full ? reduction(before.model_calls, after.model_calls) : null},
  paired_successful_ordinary: {pairs: pairedOrdinary.length, baseline: ordinaryBefore, candidate: ordinaryAfter,
    input_reduction: reduction(ordinaryBefore.input_tokens, ordinaryAfter.input_tokens), total_token_reduction: reduction(ordinaryBefore.total_tokens, ordinaryAfter.total_tokens),
    call_reduction: reduction(ordinaryBefore.model_calls, ordinaryAfter.model_calls)},
  paired_complete_usage_cohort: {pairs: fullyKnownPairs.length,
    baseline: measures(baseline.filter(t => fullyKnownPairs.some(p => p.key === key(t)))), candidate: measures(candidate.filter(t => fullyKnownPairs.some(p => p.key === key(t))))},
  failure_path_costs: {baseline: measures(baseline.filter(t => !t.passed)), candidate: measures(candidate.filter(t => !t.passed))},
  regression_gate: {passed: full && counts.candidate_only_failure === 0 && sharedFailuresAcceptable && counts.missing_candidate === 0 && after.unknown_usage_calls === 0 && before.unknown_usage_calls === 0
    && after.incomplete_accounting_calls === 0 && before.incomplete_accounting_calls === 0
    && sharedPassResultsEqual && allRestoreZeroSql && allRestoreZeroModel,
    no_candidate_only_failure: counts.candidate_only_failure === 0, no_unknown_usage: after.unknown_usage_calls === 0 && before.unknown_usage_calls === 0,
    all_usage_accounting_complete: after.incomplete_accounting_calls === 0 && before.incomplete_accounting_calls === 0,
    shared_failures_are_preserved_diagnostics: sharedFailuresAcceptable,
    all_shared_pass_business_result_hashes_equal: sharedPassResultsEqual,
    restore_zero_sql: allRestoreZeroSql, restore_zero_model: allRestoreZeroModel}, pairs,
  limitations: ['Current authorized development database and configured real model; no production access.',
    'Real backend positive authorization and session ownership checked. Revocation and nested-source negative authorization use separate isolated tests; real account permissions were not changed.',
    'No supplier cache flush; AB/BA alternation reduces ordering bias, cache cost must be reported separately.',
    'Independent fixed query references validate precise numeric, NULL, unit, row order and target identities; final prose needs separate semantic assertions/manual review for unsupported claims.']};
const ordinaryInputReduction = audit.paired_successful_ordinary.input_reduction, ordinaryCallReduction = audit.paired_successful_ordinary.call_reduction;
const ordinaryMedianReduction = reduction(ordinaryBefore.task_input_median, ordinaryAfter.task_input_median);
audit.performance_gate = {passed: full && ordinaryMedianReduction !== null && ordinaryMedianReduction >= 0.2 && ordinaryCallReduction !== null && ordinaryCallReduction > 0
  && ordinaryAfter.task_input_p95 <= ordinaryBefore.task_input_p95 && ordinaryAfter.task_calls_p95 <= ordinaryBefore.task_calls_p95
  && audit.all_tasks.input_reduction !== null && audit.all_tasks.input_reduction > 0 && audit.all_tasks.call_reduction !== null && audit.all_tasks.call_reduction > 0,
  ordinary_input_median_reduction_required: 0.2, ordinary_input_median_reduction: ordinaryMedianReduction, ordinary_input_total_reduction: ordinaryInputReduction, ordinary_call_reduction: ordinaryCallReduction,
  all_task_input_reduction: audit.all_tasks.input_reduction, all_task_call_reduction: audit.all_tasks.call_reduction};
audit.acceptance_passed = audit.regression_gate.passed && audit.performance_gate.passed;
const base = join(dirname(input), basename(input).replace(/\.json$/, '-audit'));
await writeFile(`${base}.json`, JSON.stringify(audit, null, 2));
const pct = (n) => n === null ? '未知' : `${(n * 100).toFixed(2)}%`;
await writeFile(`${base}.md`, `# Token 优化真实模型与开发数据库配对验收\n\n模型：${report.model}。协议：semantic_v2。冻结语料：${report.corpus_sha256}。完整计划：${full ? '已完成' : '未完成'}，${report.finished_tasks}/${report.planned_tasks} 个版本任务。报告不含令牌和业务金额。\n\n| 全部任务指标 | 冻结基线 | 候选 |\n| --- | ---: | ---: |\n${[['通过任务',before.passed_tasks,after.passed_tasks],['通过回合',before.passed_turns,after.passed_turns],['模型调用',before.model_calls,after.model_calls],['业务取数请求',before.sql_executions,after.sql_executions],['输入 token',before.input_tokens,after.input_tokens],['输出 token',before.output_tokens,after.output_tokens],['缓存输入',before.cache_read_tokens,after.cache_read_tokens],['非缓存输入',before.noncache_input_tokens,after.noncache_input_tokens],['总 token',before.total_tokens,after.total_tokens],['用量未知调用',before.unknown_usage_calls,after.unknown_usage_calls]].map(row=>`| ${row.join(' | ')} |`).join('\n')}\n\n全部计划任务输入减少 ${pct(audit.all_tasks.input_reduction)}，调用减少 ${pct(audit.all_tasks.call_reduction)}；双方成功的普通任务 ${pairedOrdinary.length} 对，输入减少 ${pct(audit.paired_successful_ordinary.input_reduction)}，调用减少 ${pct(audit.paired_successful_ordinary.call_reduction)}。失败及重试成本已包含，未知用量不计零。sql_executions 是兼容字段名，实际计数 basicQueries 业务取数请求，不代表数据库物理 SQL。\n\n分类：${JSON.stringify(counts)}。准确性及恢复门槛：${audit.regression_gate.passed ? '通过' : '未通过'}。\n\n${audit.limitations.map(x=>`- ${x}`).join('\n')}\n\n详细每次唯一 usage_id、step、attempt、规范条件、结果 hash、旧 Frame 及恢复检查见 [原始脱敏报告](${basename(input)}) 和 [审计 JSON](${basename(base)}.json)。\n`);
console.log(JSON.stringify({audit: `${base}.json`, complete: full, classifications: counts, regression_passed: audit.regression_gate.passed,
  performance_passed: audit.performance_gate.passed, acceptance_passed: audit.acceptance_passed,
  input_reduction: audit.all_tasks.input_reduction, call_reduction: audit.all_tasks.call_reduction}));
if (!audit.acceptance_passed) process.exitCode = 1;
