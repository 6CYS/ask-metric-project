/** 可选真实模型探针：仅虚构机构、指标和后端桩，不连接业务数据库。 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { createAskMetricModels } from "../src/models.js";
import { HarnessHost } from "../src/harnessHost.js";
import { NativeSessionStore } from "../src/nativeSessions.js";
import { createAskMetricTools } from "../src/tools/index.js";
import type { BackendClient, BackendUser } from "../src/backendClient.js";

const dataDir = await mkdtemp(join(tmpdir(), "composed-model-probe-"));
const config = { ...loadConfig(), dataDir };
const actor: BackendUser = {id: "synthetic", username: "synthetic", display_name: "合成测试", org_code: "A", org_name: "虚构甲机构", role_code: "tester"};
const host = new HarnessHost(config, authorize => createAskMetricModels(config, authorize), new NativeSessionStore(dataDir), createAskMetricTools());
const report: unknown[] = [];
try {
  for (const question of ["这个指标还有哪些月份有数据？", "最早哪天开始有？", "那虚构乙机构去年的呢？", "加上虚构乙机构，并换成四月份", "换成演示指标乙看看"]) {
    let count = 0;
    const submissions: unknown[][] = [];
    const row = {metric_code: "M1", metric_name: "演示指标甲", org_code: "A", org_name: "虚构甲机构", stat_date: "2026-01-31", metric_value: "0", unit: "个"};
    const backend = {
      submitQuestion: async (...args: unknown[]) => { submissions.push(args); count++; return {task_id: `synthetic-${count}`, conversation_id: "synthetic-conversation", version: 0, status: "RUNNING"}; },
      analyzeTask: async () => ({task_id: `synthetic-${count}`, version: 1, status: "RUNNING"}),
      executeTask: async () => ({task_id: `synthetic-${count}`, status: "succeeded", query_shape: "metric_value", rows: [row], columns: Object.keys(row), row_count: 1, evidence: {
        logical_dsl: {time: {start: "2026-01-01", end: "2026-01-31"}, metrics: ["M1"], orgs: ["A"], ops: []},
        catalog: {metrics: [{code: "M1", name: "演示指标甲"}], organizations: [{code: "A", name: "虚构甲机构"}]},
      }}),
      getTask: async () => ({task_id: `synthetic-${count}`, version: 3, status: "SUCCEEDED", result: {result_id: `synthetic-result-${count}`}}),
    } as unknown as BackendClient;
    const hosted = await host.createSession(actor);
    await host.runPrompt(hosted, {protocol_version: 3, request_id: "prime", message: "虚构甲机构2026年1月演示指标甲是多少", send_as: "new_question"}, {actor, backend});
    await host.runPrompt(hosted, {protocol_version: 3, request_id: "followup", message: question}, {actor, backend});
    const ref = submissions.at(-1)?.[3] as {change_field?: string; task_id?: string} | undefined;
    const item = {question, submitted: submissions.length, reference: ref, passed: submissions.length === 2 && ref?.task_id === "synthetic-1" && ref?.change_field === "compose"};
    report.push(item);
    console.log(JSON.stringify(item));
  }
} finally {
  await host.close();
  await writeFile(join(dataDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({report: join(dataDir, "report.json")}));
}
if (report.some(item => !(item as {passed: boolean}).passed)) process.exitCode = 1;
