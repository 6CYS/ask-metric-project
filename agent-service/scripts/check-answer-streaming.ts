/** 真实模型开关对照；仅用隔离合成后端，不访问真实业务数据库。须显式 --live。 */
import assert from "node:assert/strict";
import {mkdtemp, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {BACKGROUND_CONTEXT} from "@earendil-works/pi-agent-core";
import {loadConfig} from "../src/config.js";
import {createAskMetricModels} from "../src/models.js";
import {HarnessHost} from "../src/harnessHost.js";
import {NativeSessionStore} from "../src/nativeSessions.js";
import {createAskMetricTools} from "../src/tools/index.js";
import {createBusinessSkillReadTool, loadBusinessSkills} from "../src/businessSkills.js";
import {AnswerStreamProjector} from "../src/answerStream.js";
import {projectEntries} from "../src/sessionProjection.js";
import type {BackendUser} from "../src/backendClient.js";
import {cases, type AcceptanceCase} from "./query-intent-v2-cases.js";
import {syntheticBackend, checkExpectation} from "./check-query-intent-v2.js";
import {NativeFrameStore} from "../src/business-context/store.js";

assert(process.argv.includes("--live"), "须显式 --live 才调用已配置模型");
const reportIndex = process.argv.indexOf("--report");
const reportPath = reportIndex >= 0 ? process.argv[reportIndex + 1]! : join(tmpdir(), "answer-streaming-live.json");
const dir = await mkdtemp(join(tmpdir(), "answer-streaming-live-"));
const config = {...loadConfig(), dataDir: dir};
const store = new NativeSessionStore(dir);
const skills = await loadBusinessSkills();
const host = new HarnessHost(config, authorize => createAskMetricModels(config, authorize), store,
  [...createAskMetricTools(), createBusinessSkillReadTool(skills)], {skills});
const actor: BackendUser = {id: "streaming-synthetic", username: "synthetic", display_name: "隔离流式测试",
  org_code: "O1", org_name: "合成甲农商行", role_code: "USER"};
const greetings = ["你好", "谢谢你", "早上好", "你能做什么？", "给我介绍一下你能帮忙的事情。",
  "你好，请简短介绍自己。", "谢谢，辛苦了。", "什么是同比？请解释概念，不用查数据。", "请解释环比的含义，不需要具体数据。", "你好，很高兴见到你。"];
const queryIds = ["original", "authorized", "within_access", "top_chinese", "scope_value", "shared_prefix_metrics",
  "shared_prefix_four_confirm", "change_date_keep_rank"];
assert(queryIds.every(id => cases.some(item => item.id === id)));
const jobs = [...greetings.map((text, index) => ({kind: "reply", test: {id: `greeting-${index + 1}`, group: "reply",
  turns: [{text, expect: {queryCount: 0}}]} as AcceptanceCase})),
  ...queryIds.map(id => ({kind: "query", test: cases.find(item => item.id === id)!}))];
const samplesIndex = process.argv.indexOf("--samples");
const samples = samplesIndex >= 0 ? process.argv[samplesIndex + 1]!.split(",") : undefined;
const selectedJobs = samples ? jobs.filter(job => samples.includes(job.test.id)) : jobs;
assert(selectedJobs.length && (!samples || samples.every(id => selectedJobs.some(job => job.test.id === id))), "Unknown sample");
const reports: Array<Record<string, unknown>> = [];
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

async function run(test: AcceptanceCase, kind: string, enabled: boolean) {
  const session = await host.createSession(actor);
  const {backend, queries, trace} = syntheticBackend(test);
  try {
    for (const [index, turn] of test.turns.entries()) {
      const queryStart = queries.length;
      const traceStart = trace.length;
      const admitted = await host.admitPrompt(session, {protocol_version: 3, request_id: `${test.id}-${enabled}-${index}`, message: turn.text}, {actor, backend});
      assert(admitted.ok);
      const start = performance.now();
      if (admitted.request.timings) {admitted.request.timings.receivedAt = start; admitted.request.timings.reportAtSnapshot = true;}
      let firstVisible: number | undefined;
      let provisional = "";
      let lastDelta = "";
      const streamedCalls = new Set<number>();
      let resets = 0;
      const resetEvents: unknown[] = [];
      const projector = new AnswerStreamProjector((type, data) => {
        if (type === "answer_delta" && "text" in data) {
          firstVisible ??= performance.now();
          if (admitted.request.timings) admitted.request.timings.firstVisibleAt ??= firstVisible;
          provisional = lastDelta = data.text;
          streamedCalls.add(data.call_seq);
        } else {provisional = ""; resets += 1; resetEvents.push(data);}
      });
      admitted.request.reportAnswerRetry = callSeq => projector.retry(callSeq);
      const watch = await host.watch(session);
      watch.start(event => {if (enabled) projector.onWatchEvent(event, admitted.request.answerStream);});
      const result = await host.drivePrompt(session, admitted).finally(() => {projector.close(); watch.unsubscribe();});
      const messages = projectEntries(await session.lane.findEntries({order: "oldestFirst"}, BACKGROUND_CONTEXT));
      const answer = messages.filter(message => message.role === "assistant" && message.text).at(-1)?.text ?? "";
      if (answer.trim()) firstVisible ??= performance.now();
      if (admitted.request.timings && firstVisible !== undefined) admitted.request.timings.firstVisibleAt ??= firstVisible;
      await host.recordRequestTiming(session, admitted.request);
      const record = result.ok && result.outcome.kind === "settled" ? result.outcome.outcome : undefined;
      const errors: string[] = [];
      if (!answer.trim() || record?.status !== "completed") errors.push("回答未成功完成");
      if (queries.length - queryStart !== turn.expect.queryCount) errors.push("执行次数不符合合成用例预期");
      if (kind === "query") {
        const frames = new NativeFrameStore(session.session);
        const state = await frames.state();
        const frame = state.focusFrameId ? await frames.get(state.focusFrameId) : undefined;
        try {checkExpectation(turn.expect, queries.slice(queryStart), frame, trace.slice(traceStart));}
        catch (error) {errors.push(error instanceof assert.AssertionError ? error.message : "合成语义验证失败");}
      }
      if (enabled && provisional && provisional !== answer) errors.push("流式正文与最终快照不一致");
      const row = {case: test.id, kind, enabled, turn: index + 1, question: turn.text, answer,
        first_visible_ms: firstVisible === undefined ? null : Math.round(firstVisible - start),
        total_ms: Math.round(performance.now() - start), model_first_token_ms: admitted.request.timings?.modelFirstTokenMs,
        model_calls: admitted.request.timings?.model_ms.length, streamed_calls: streamedCalls.size, resets,
        reset_events: resetEvents, session_id: session.sessionId, last_delta: lastDelta, final_stream_matches: !provisional || provisional === answer,
        basic_queries: queries.slice(queryStart), query_count: queries.length - queryStart, passed: !errors.length, errors};
      reports.push(row);
      await writeFile(reportPath, JSON.stringify({model: config.model.name, backend: "synthetic_only", reports}, null, 2));
      console.log(JSON.stringify({case: row.case, enabled, turn: row.turn, first_visible_ms: row.first_visible_ms,
        total_ms: row.total_ms, passed: row.passed, errors}));
    }
  } finally {await host.closeSession(session.sessionId);}
}

try {
  // 相邻成对、交替顺序，控制网关负载随时间变化带来的偏差。
  for (const [index, job] of selectedJobs.entries()) for (const enabled of index % 2 ? [true, false] : [false, true]) await run(job.test, job.kind, enabled);
  const summary = Object.fromEntries(["reply", "query"].map(kind => [kind, Object.fromEntries([false, true].map(enabled => {
    const rows = reports.filter(row => row.kind === kind && row.enabled === enabled);
    const successful = rows.filter(row => row.passed && row.first_visible_ms !== null);
    return [enabled ? "streaming" : "baseline", {rounds: rows.length, passed: rows.filter(row => row.passed).length,
      first_visible_median_ms: successful.length ? median(successful.map(row => Number(row.first_visible_ms))) : null,
      total_median_ms: successful.length ? median(successful.map(row => Number(row.total_ms))) : null}];
  }))]));
  const streamed = reports.reduce((n, row) => n + Number(row.streamed_calls), 0);
  const resets = reports.reduce((n, row) => n + Number(row.resets), 0);
  const output = {model: config.model.name, backend: "synthetic_only", summary, streamed_calls: streamed,
    resets, reset_ratio: streamed ? resets / streamed : 0, passed: reports.every(row => row.passed), reports};
  await writeFile(reportPath, JSON.stringify(output, null, 2));
  console.log(JSON.stringify({report: reportPath, summary, resets, streamed_calls: streamed, passed: output.passed}));
  if (!output.passed) process.exitCode = 1;
} finally {await host.close(); await store.close();}
