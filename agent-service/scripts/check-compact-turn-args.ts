/**
 * 二期真实模型对照：同模型、流式开启、合成后端，逐案交替旧/新参数格式；不访问业务数据库。
 * node --env-file=.env --import tsx scripts/check-compact-turn-args.ts --live --repeat 3 --report /tmp/compact.json
 * --case original,... 可缩小诊断范围；--concurrency 1..3 控制并发用例对（默认1）。
 * --supplementary 交替运行其余合成语义探针。每对旧/新串行，每次迭代有屏障。
 * 不带 --live 只列出验收计划；--self-check 离线核对门禁计算。
 */
import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {mkdtemp, mkdir, readFile, rename, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";
import {loadConfig} from "../src/config.js";
import {createAskMetricModels} from "../src/models.js";
import {HarnessHost} from "../src/harnessHost.js";
import {NativeSessionStore} from "../src/nativeSessions.js";
import {createAskMetricTools} from "../src/tools/index.js";
import {createBusinessSkillReadTool, loadBusinessSkills} from "../src/businessSkills.js";
import {cases} from "./query-intent-v2-cases.js";
import {assertNativeBusinessExecution, runQueryIntentCase, type QueryIntentTurnReport} from "./check-query-intent-v2.js";

type Mode = "baseline" | "compact";
interface SemanticRow {suite: string; case: string; turn: number; iteration: number; mode: Mode; passed: boolean}
export type CompactTurnReport = QueryIntentTurnReport & {suite: "query-intent"; mode: Mode; compact_turn_args: boolean};
interface SupplementaryRun {
  suite: string; iteration: number; mode: Mode; exit_code: number | null; report: string | null;
  log: string; rows: SemanticRow[]; error: string | null;
}
const supplementaryScripts = [
  "check-history-focus-model.ts", "check-context-semantics.ts", "check-multiturn-model.ts",
  "check-confirmation-model.ts", "check-metric-name-model.ts", "check-metric-typo-model.ts", "check-composed-model.ts",
] as const;
// 旧探针没有统一返回计划；固定完整语料数量，提前中断不能被误认为完整验收。
const supplementaryCaseCounts: Record<(typeof supplementaryScripts)[number], number> = {
  "check-history-focus-model.ts": 10, "check-context-semantics.ts": 9, "check-multiturn-model.ts": 8,
  "check-confirmation-model.ts": 2, "check-metric-name-model.ts": 4, "check-metric-typo-model.ts": 3,
  "check-composed-model.ts": 10,
};
const modesFor = (iteration: number): Mode[] => iteration % 2 ? ["baseline", "compact"] : ["compact", "baseline"];

/** 一个 worker 负责完整旧/新用例对；整轮完成后才开始下一次迭代。 */
export async function runPairedIterations<T>(items: readonly T[], repeat: number, concurrency: number,
  run: (item: T, iteration: number, mode: Mode) => Promise<void>): Promise<void> {
  for (let iteration = 1; iteration <= repeat; iteration++) {
    let next = 0;
    const workers = Array.from({length: Math.min(concurrency, items.length)}, async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        const item = items[index]!;
        for (const mode of modesFor(iteration)) await run(item, iteration, mode);
      }
    });
    // 即使某个 worker 异常，也等同轮其他任务退出，避免提前关闭正在使用的宿主。
    const outcomes = await Promise.allSettled(workers);
    const errors = outcomes.flatMap(outcome => outcome.status === "rejected" ? [outcome.reason] : []);
    if (errors.length) throw new AggregateError(errors, "paired_iteration_failed");
  }
}

/** 调用时固定快照，写盘串行且原子替换；读取中的验收报告始终是完整 JSON。 */
export function createReportWriter(path: string) {
  let pending: Promise<void> = Promise.resolve();
  const temporary = `${path}.${process.pid}.tmp`;
  return {
    write(value: unknown): Promise<void> {
      const snapshot = JSON.stringify(value, null, 2);
      pending = pending.then(async () => {
        await writeFile(temporary, snapshot);
        await rename(temporary, path);
      });
      return pending;
    },
    flush(): Promise<void> {return pending;},
  };
}

const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/** 缺失的一次用例不能消失在分母里；与失败一样保留，并单独标记覆盖不全。 */
export function evaluateSemanticGates(rows: SemanticRow[], repeat: number) {
  const keys = [...new Set(rows.map(row => JSON.stringify([row.suite, row.case, row.turn])))];
  const regressions: Array<{suite: string; case: string; turn: number; baseline_failures: number; compact_failures: number}> = [];
  const totals = {baseline: {passed: 0, total: keys.length * repeat}, compact: {passed: 0, total: keys.length * repeat}};
  let coverageComplete = keys.length > 0;
  for (const key of keys) {
    const [suite, caseId, turn] = JSON.parse(key) as [string, string, number];
    const failures = {baseline: 0, compact: 0};
    for (const mode of ["baseline", "compact"] as const) for (let iteration = 1; iteration <= repeat; iteration++) {
      const matches = rows.filter(row => row.suite === suite && row.case === caseId && row.turn === turn
        && row.mode === mode && row.iteration === iteration);
      if (matches.length !== 1) coverageComplete = false;
      if (matches.length === 1 && matches[0]!.passed) totals[mode].passed += 1;
      else failures[mode] += 1;
    }
    if (failures.compact >= 2 && failures.baseline <= 1) regressions.push({suite, case: caseId, turn,
      baseline_failures: failures.baseline, compact_failures: failures.compact});
  }
  const enoughRepeats = repeat === 3;
  const passRateNotLower = totals.compact.passed >= totals.baseline.passed;
  return {passed: enoughRepeats && coverageComplete && !regressions.length && passRateNotLower,
    repetitions_required: 3, repetitions: repeat, enough_repetitions: enoughRepeats,
    coverage_complete: coverageComplete, regressions, pass_rate_not_lower: passRateNotLower,
    baseline: {...totals.baseline, pass_rate: totals.baseline.total ? totals.baseline.passed / totals.baseline.total : null},
    compact: {...totals.compact, pass_rate: totals.compact.total ? totals.compact.passed / totals.compact.total : null}};
}

/** 性能只比较同案同轮次两边都语义成功的取数回合，避免失败的短响应制造虚假提速。 */
export function evaluateQueryPerformance(rows: CompactTurnReport[]) {
  const baseline = rows.filter(row => row.mode === "baseline" && row.expected.queryCount > 0);
  const paired = baseline.flatMap(old => {
    const next = rows.find(row => row.mode === "compact" && row.case === old.case
      && row.turn === old.turn && row.iteration === old.iteration);
    return old.passed && next?.passed ? [{baseline: old, compact: next}] : [];
  });
  const tokenPairs = paired.filter(pair => pair.baseline.first_model_output_tokens !== null
    && pair.compact.first_model_output_tokens !== null);
  const visiblePairs = paired.filter(pair => pair.baseline.first_visible_ms !== null && pair.compact.first_visible_ms !== null);
  const baselineTokens = median(tokenPairs.map(pair => pair.baseline.first_model_output_tokens!));
  const compactTokens = median(tokenPairs.map(pair => pair.compact.first_model_output_tokens!));
  const baselineVisible = median(visiblePairs.map(pair => pair.baseline.first_visible_ms!));
  const compactVisible = median(visiblePairs.map(pair => pair.compact.first_visible_ms!));
  const tokenReduction = baselineTokens !== null && baselineTokens > 0 && compactTokens !== null
    ? (baselineTokens - compactTokens) / baselineTokens : null;
  const visibleReduction = baselineVisible !== null && compactVisible !== null ? baselineVisible - compactVisible : null;
  const tokenCoverage = paired.length > 0 && tokenPairs.length === paired.length;
  const visibleCoverage = paired.length > 0 && visiblePairs.length === paired.length;
  const tokensPassed = tokenCoverage && tokenReduction !== null && tokenReduction >= 0.3;
  const visiblePassed = visibleCoverage && visibleReduction !== null && visibleReduction >= 1_500;
  return {passed: tokensPassed && visiblePassed, cohort: "paired_semantically_successful_query_turns",
    candidate_query_pairs: baseline.length, successful_pairs: paired.length,
    first_call_output_tokens: {passed: tokensPassed, pairs: tokenPairs.length, missing_pairs: paired.length - tokenPairs.length,
      baseline_median: baselineTokens, compact_median: compactTokens, reduction: tokenReduction, required_reduction: 0.3},
    first_visible_ms: {passed: visiblePassed, pairs: visiblePairs.length, missing_pairs: paired.length - visiblePairs.length,
      baseline_median: baselineVisible, compact_median: compactVisible, reduction_ms: visibleReduction, required_reduction_ms: 1_500}};
}

async function selfCheck() {
  const calls = [{name: "resolve_business_turn"}, {name: "resolve_business_turn"}];
  const failedResolution = {name: "resolve_business_turn", statuses: [{status: "ARGUMENT_ERROR"}]};
  const succeededResolution = {name: "resolve_business_turn", statuses: [{status: "succeeded"}]};
  assertNativeBusinessExecution(calls, [failedResolution, succeededResolution]);
  assert.throws(() => assertNativeBusinessExecution(calls, [failedResolution]));
  assert.throws(() => assertNativeBusinessExecution(calls, [{name: "resolve_business_turn", statuses: [{status: "READY"}]}]));
  const semantic = (mode: Mode, iteration: number, passed: boolean): SemanticRow => ({suite: "test", case: "sample", turn: 1, mode, iteration, passed});
  const good = Array.from({length: 3}, (_, index) => [semantic("baseline", index + 1, true), semantic("compact", index + 1, true)]).flat();
  assert(evaluateSemanticGates(good, 3).passed);
  assert(!evaluateSemanticGates(good.map(row => row.mode === "compact" && row.iteration <= 2 ? {...row, passed: false} : row), 3).passed);
  assert(!evaluateSemanticGates(good.slice(1), 3).coverage_complete);
  assert(!evaluateSemanticGates(good.slice(0, 2), 1).enough_repetitions);
  const sample = (mode: Mode, tokens: number | null, visible: number): CompactTurnReport => ({suite: "query-intent", case: "sample", group: "test", iteration: 1,
    turn: 1, mode, compact_turn_args: mode === "compact", expected: {queryCount: 1}, passed: true, errors: [], elapsed_ms: 10_000,
    first_visible_ms: visible, first_model_output_tokens: tokens, first_model_usage_known: tokens !== null});
  const performance = evaluateQueryPerformance([sample("baseline", 100, 5_000), sample("compact", 70, 3_500)]);
  assert(performance.passed);
  const missing = evaluateQueryPerformance([sample("baseline", null, 5_000), sample("compact", 70, 3_500)]);
  assert(!missing.passed);
  assert.equal(missing.first_call_output_tokens.baseline_median, null);
  assert.equal(missing.first_call_output_tokens.missing_pairs, 1);

  const items = ["a", "b", "c", "d", "e"];
  const seen = new Set<string>();
  const doneByIteration = new Map<number, number>();
  const modesByPair = new Map<string, Mode[]>();
  let active = 0;
  let peak = 0;
  await runPairedIterations(items, 3, 3, async (item, iteration, mode) => {
    if (iteration > 1) assert.equal(doneByIteration.get(iteration - 1), items.length * 2, "iteration barrier");
    const key = `${iteration}:${item}:${mode}`;
    assert(!seen.has(key), "each mode runs exactly once");
    seen.add(key);
    const pair = `${iteration}:${item}`;
    const previous = modesByPair.get(pair) ?? [];
    assert.equal(mode, modesFor(iteration)[previous.length], "paired modes remain sequential and alternate");
    active += 1;
    peak = Math.max(peak, active);
    assert(active <= 3, "concurrency is bounded");
    await Promise.resolve();
    await Promise.resolve();
    active -= 1;
    modesByPair.set(pair, [...previous, mode]);
    doneByIteration.set(iteration, (doneByIteration.get(iteration) ?? 0) + 1);
  });
  assert.equal(seen.size, items.length * 3 * 2);
  assert.equal(peak, 3);
  const single: Mode[] = [];
  await runPairedIterations(["single"], 1, 1, async (_item, _iteration, mode) => {single.push(mode);});
  assert.deepEqual(single, ["baseline", "compact"]);
  let siblingFinished = false;
  await assert.rejects(runPairedIterations(["fail", "sibling"], 1, 2, async item => {
    if (item === "fail") throw new Error("expected_self_check_failure");
    await Promise.resolve();
    siblingFinished = true;
  }), AggregateError);
  assert(siblingFinished, "failed iteration still waits for siblings");

  const dir = await mkdtemp(join(tmpdir(), "compact-runner-self-check-"));
  try {
    const path = join(dir, "report.json");
    const writer = createReportWriter(path);
    const mutable = {sequence: 1};
    const firstWrite = writer.write(mutable);
    mutable.sequence = 99;
    await firstWrite;
    assert.equal(JSON.parse(await readFile(path, "utf8")).sequence, 1, "save captures caller snapshot");
    const writes = [2, 3, 4].map(sequence => writer.write({sequence}).then(async () => {
      const observed = JSON.parse(await readFile(path, "utf8")) as {sequence: number};
      assert(observed.sequence >= sequence && observed.sequence <= 4, "concurrent readers receive complete reports");
    }));
    await Promise.all(writes);
    await writer.flush();
    assert.equal(JSON.parse(await readFile(path, "utf8")).sequence, 4, "final waits for every queued write");
  } finally {await rm(dir, {recursive: true, force: true});}
  console.log(JSON.stringify({status: "comparison_gate_self_check_passed", model_called: false, database_called: false}));
}

const runFile = promisify(execFile);
function reportRows(suite: string, report: unknown, mode: Mode, iteration: number): SemanticRow[] {
  const value = report as {reports?: unknown[]; report?: unknown[]};
  const values = Array.isArray(report) ? report : value?.reports ?? value?.report ?? [];
  return values.map((item, index) => {
    const row = item as Record<string, unknown>;
    // 各旧探针的场景键不同；保留稳定业务键，数组位置只作为最后回退。
    const key = row.name ?? row.variant ?? row.metric ?? row.input ?? row.reply ?? row.question ?? row.turn ?? index + 1;
    return {suite, case: `${index + 1}:${String(key)}`, turn: 1, mode, iteration, passed: row.passed === true};
  });
}
async function runSupplementary(script: (typeof supplementaryScripts)[number], mode: Mode, iteration: number, dir: string): Promise<SupplementaryRun> {
  const suite = script.replace(/^check-|\.ts$/g, "");
  const log = join(dir, `${suite}-${mode}-${iteration}.log`);
  const result = await runFile(process.execPath, ["--import", "tsx", resolve(import.meta.dirname, script), "--live"],
    {cwd: resolve(import.meta.dirname, ".."), maxBuffer: 32 * 1024 * 1024,
      env: {...process.env, AGENT_COMPACT_TURN_ARGS: String(mode === "compact"), AGENT_ANSWER_STREAMING: "true"}})
    .then(value => ({...value, exitCode: 0}))
    .catch((error: unknown) => {
      const value = error as {stdout?: string; stderr?: string; code?: number};
      return {stdout: value.stdout ?? "", stderr: value.stderr ?? "", exitCode: typeof value.code === "number" ? value.code : null};
    });
  await writeFile(log, `${result.stdout}\n${result.stderr}`);
  let reportPath: string | null = null;
  for (const line of result.stdout.split("\n")) {
    try {const row = JSON.parse(line) as {report?: unknown}; if (typeof row.report === "string") reportPath = row.report;} catch {}
  }
  if (!reportPath) return {suite, iteration, mode, exit_code: result.exitCode, report: null, log, rows: [], error: "report_not_produced"};
  try {
    const rows = reportRows(suite, JSON.parse(await readFile(reportPath, "utf8")), mode, iteration);
    return {suite, iteration, mode, exit_code: result.exitCode, report: reportPath, log, rows,
      error: rows.length === supplementaryCaseCounts[script] ? null : "report_case_count_incomplete"};
  } catch {return {suite, iteration, mode, exit_code: result.exitCode, report: reportPath, log, rows: [], error: "report_unreadable"};}
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name: string): string | undefined => {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    const value = args[index + 1];
    assert(value && !value.startsWith("--"), `Missing value for ${name}`);
    return value;
  };
  if (args.includes("--self-check")) {await selfCheck(); return;}
  const repeat = Number(option("--repeat") ?? 3);
  assert(Number.isSafeInteger(repeat) && repeat >= 1 && repeat <= 20, "--repeat must be 1..20");
  const concurrency = Number(option("--concurrency") ?? 1);
  assert(Number.isSafeInteger(concurrency) && concurrency >= 1 && concurrency <= 3, "--concurrency must be 1..3");
  const order = "sequential_modes_per_case_alternating_each_iteration_parallel_cases_with_iteration_barriers";
  const filter = option("--case")?.split(",");
  const selected = filter ? cases.filter(test => filter.includes(test.id)) : cases;
  assert(selected.length && (!filter || filter.every(id => selected.some(test => test.id === id))), "Unknown/empty case selection");
  const includeSupplementary = args.includes("--supplementary");
  if (!args.includes("--live")) {
    console.log(JSON.stringify({status: "comparison_plan", model_called: false, database_called: false, repeat, concurrency, order,
      cases: selected.map(test => test.id), turns_per_mode: selected.reduce((count, test) => count + test.turns.length, 0) * repeat,
      answer_streaming: true, compact_turn_args: [false, true], supplementary: includeSupplementary ? supplementaryScripts : [],
      limitation: "Requires --live; tool-governance with real database/browser remains unverified"}));
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "compact-turn-args-"));
  const reportPath = resolve(option("--report") ?? join(dir, "report.json"));
  await mkdir(dirname(reportPath), {recursive: true});
  // 两种参数格式共享 60 秒输出空闲时限，首响保持环境配置，避免改变首响对照条件。
  const config = {...loadConfig(), answerStreaming: true, modelStreamIdleTimeoutMs: 60_000};
  const skills = await loadBusinessSkills();
  const runtimes = (["baseline", "compact"] as const).map(mode => {
    const current = {...config, compactTurnArgs: mode === "compact", dataDir: join(dir, mode)};
    const store = new NativeSessionStore(current.dataDir);
    const host = new HarnessHost(current, authorize => createAskMetricModels(current, authorize), store,
      [...createAskMetricTools({compactTurnArgs: current.compactTurnArgs}), createBusinessSkillReadTool(skills)], {skills});
    return {mode, host, store};
  });
  const reports: CompactTurnReport[] = [];
  const supplementary: SupplementaryRun[] = [];
  const writer = createReportWriter(reportPath);
  const save = async (complete = false) => {
    const semantic = evaluateSemanticGates(reports, repeat);
    const performance = evaluateQueryPerformance(reports);
    const supplementaryGate = evaluateSemanticGates(supplementary.flatMap(run => run.rows), repeat);
    const supplementaryComplete = includeSupplementary && supplementary.length === supplementaryScripts.length * repeat * 2
      && supplementary.every(run => !run.error) && supplementaryGate.coverage_complete;
    const measuredPassed = complete && reports.length === selected.reduce((count, test) => count + test.turns.length, 0) * repeat * 2
      && semantic.passed && performance.passed && (!includeSupplementary || supplementaryComplete && supplementaryGate.passed);
    const output = {environment: "configured_real_model_synthetic_backend_real_python_resolvers", model_name: config.model.name,
      model_stream_idle_timeout_ms: config.modelStreamIdleTimeoutMs, model_first_response_timeout_ms: config.modelFirstResponseTimeoutMs,
      model_called: true, production_backend_called: false, sql_executed: false, reference_date: "2026-09-22",
      answer_streaming: true, repeats: repeat, order, concurrency,
      selected_cases: selected.map(test => test.id), data_dir: dir, complete,
      gates: {semantic, performance, measured_gates_passed: measuredPassed, full_gate_passed: false,
        supplementary: {status: supplementaryComplete ? "verified" : includeSupplementary ? "incomplete" : "not_run", ...supplementaryGate},
        tool_governance: {status: "not_verified", reason: "Legacy assertions need Frame adaptation; real database/browser acceptance not performed"}},
      reports, supplementary};
    await writer.write(output);
    return output;
  };
  await save();
  try {
    // 两个宿主只有模型可见格式不同；同一用例成对串行，其他用例共享相同并发上限。
    await runPairedIterations(selected, repeat, concurrency, async (test, iteration, mode) => {
      const runtime = runtimes.find(item => item.mode === mode)!;
      console.log(JSON.stringify({status: "case_started", case: test.id, iteration, mode}));
      try {
        await runQueryIntentCase(runtime.host, test, iteration, {answerStreaming: true, onReport: async report => {
          reports.push({...report, suite: "query-intent", mode, compact_turn_args: mode === "compact"});
          await save();
        }});
      } catch {
        for (const [index, turn] of test.turns.entries()) if (!reports.some(row => row.mode === mode && row.case === test.id
          && row.iteration === iteration && row.turn === index + 1)) reports.push({suite: "query-intent", mode, compact_turn_args: mode === "compact",
          case: test.id, group: test.group, iteration, turn: index + 1, expected: turn.expect, passed: false, errors: ["case_runner_failed"],
          elapsed_ms: 0, first_visible_ms: null, first_model_output_tokens: null, first_model_usage_known: false});
        await save();
      }
    });
    if (includeSupplementary) {
      const supplementaryDir = join(dir, "supplementary");
      await mkdir(supplementaryDir);
      await runPairedIterations(supplementaryScripts, repeat, concurrency, async (script, iteration, mode) => {
        console.log(JSON.stringify({status: "supplementary_started", script, iteration, mode}));
        supplementary.push(await runSupplementary(script, mode, iteration, supplementaryDir));
        await save();
      });
    }
    const output = await save(true);
    await writer.flush();
    console.log(JSON.stringify({report: reportPath, semantic: output.gates.semantic, performance: output.gates.performance,
      measured_gates_passed: output.gates.measured_gates_passed, full_gate_passed: false,
      unverified: ["tool-governance", ...(includeSupplementary ? [] : ["supplementary-model-suites"])]}));
    if (!output.gates.measured_gates_passed) process.exitCode = 1;
  } finally {
    for (const runtime of runtimes) {await runtime.host.close(); await runtime.store.close();}
    await writer.flush();
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
