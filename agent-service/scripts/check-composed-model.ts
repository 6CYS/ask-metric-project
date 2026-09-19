/** 可选真实模型探针：仅虚构机构、指标和后端桩，不连接业务数据库。 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
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
const filter = process.argv.find(value => value.startsWith("--contains="))?.slice("--contains=".length) ?? "";
async function failureCode(session: Awaited<ReturnType<HarnessHost["createSession"]>>) {
  const entries = await session.lane.findEntries({order:"oldestFirst"}, BACKGROUND_CONTEXT);
  return entries.some(entry => entry.type === "message" && entry.message.role === "assistant"
    && entry.message.errorMessage?.includes("429")) ? "MODEL_RATE_LIMITED" : "PROBE_FAILED";
}
try {
  for (const question of process.argv.includes("--pending-only") ? [] : ["这个指标还有哪些月份有数据？", "最早哪天开始有？", "那虚构乙机构去年的呢？", "加上虚构乙机构，并换成四月份", "换成演示指标乙看看", "乙机构四月份的呢？", "四月换乙机构", "乙机构，4月份"]) {
    if (filter && !question.includes(filter)) continue;
    let count = 0;
    const submissions: unknown[][] = [];
    const row = {metric_code: "M1", metric_name: "演示指标甲", org_code: "A", org_name: "虚构甲机构", stat_date: "2026-01-31", metric_value: "0", unit: "个"};
    const backend = {
      searchOrganizations: async (keyword:string) => {
        const items=[{org_code:"A",org_name:"虚构甲机构",aliases:["甲机构"],score:1,match_type:"exact"},{org_code:"B",org_name:"虚构乙机构",aliases:["乙机构"],score:1,match_type:"exact"}].filter(item=>item.org_name.includes(keyword)||keyword.includes(item.org_name)||item.aliases.some(alias=>keyword.includes(alias)));
        return {total:items.length,items};
      },
      searchMetrics: async (keyword:string) => {
        const items=[{metric_code:"M1",metric_name:"演示指标甲",score:1,match_type:"exact"},{metric_code:"M2",metric_name:"演示指标乙",score:1,match_type:"exact"}].filter(item=>item.metric_name.includes(keyword)||keyword.includes(item.metric_name));
        return {total:items.length,items,semantic_suggestions:[]};
      },
      submitQuestion: async (...args: unknown[]) => { submissions.push(args); count++; return {task_id: `synthetic-${count}`, conversation_id: "synthetic-conversation", version: 0, status: "RUNNING"}; },
      analyzeTask: async () => ({task_id: `synthetic-${count}`, version: 1, status: "RUNNING"}),
      executeTask: async () => ({task_id: `synthetic-${count}`, status: "succeeded", query_shape: "metric_value", rows: [row], columns: Object.keys(row), row_count: 1, evidence: {
        logical_dsl: {time: {start: "2026-01-01", end: "2026-01-31"}, metrics: ["M1"], orgs: ["A"], ops: []},
        catalog: {metrics: [{code: "M1", name: "演示指标甲"}], organizations: [{code: "A", name: "虚构甲机构"}]},
      }}),
      getTask: async () => ({task_id: `synthetic-${count}`, version: 3, status: "SUCCEEDED", result: {result_id: `synthetic-result-${count}`}}),
    } as unknown as BackendClient;
    const hosted = await host.createSession(actor);
    const prime = await host.runPrompt(hosted, {protocol_version: 3, request_id: "prime", message: "虚构甲机构2026年1月演示指标甲是多少"}, {actor, backend});
    if (!prime.ok || submissions.length !== 1) {
      const item={question,passed:false,phase:"prime",error_code:await failureCode(hosted)};
      report.push(item);console.log(JSON.stringify(item));continue;
    }
    await host.runPrompt(hosted, {protocol_version: 3, request_id: "followup", message: question}, {actor, backend});
    const ref = submissions.at(-1)?.[3] as {change_field?: string; task_id?: string} | undefined;
    const item = {question, submitted: submissions.length, reference: ref, passed: submissions.length === 2 && ref?.task_id === "synthetic-1" && ref?.change_field === "compose"};
    report.push(item);
    console.log(JSON.stringify(item));
  }
  // 待澄清期间既允许自然补充，也允许自然切换，不依赖任何客户端路由开关。
  for (const [question, expected] of [["演示指标甲", "clarify"], ["改查虚构乙机构2026年5月演示指标乙", "new"]]) {
    if (filter && !question!.includes(filter)) continue;
    let submitted = 0, clarified = 0;
    const clarification = {id:"synthetic-clarification",type:"semantic_slots",missing:["metrics"],prompt:"请补充指标",fields:[{type:"metric",message:"请补充指标"}],understood:{orgs:["虚构甲机构"],time:"2026年4月"}};
    const pending = {task_id:"synthetic-pending",conversation_id:"synthetic-conversation",version:1,status:"WAITING_USER",clarification};
    const backend = {
      submitQuestion:async()=>{submitted++;return submitted===1?pending:{task_id:"synthetic-new",version:1,status:"RUNNING",current_stage:"LOGICAL_DSL"};},
      submitClarification:async()=>{clarified++;return {...pending,status:"RUNNING",current_stage:"LOGICAL_DSL",version:2};},
      executeTask:async()=>({task_id:submitted>1?"synthetic-new":"synthetic-pending",status:"succeeded",columns:[],rows:[],row_count:0}),
      getTask:async()=>submitted===1&&!clarified?pending:{task_id:submitted>1?"synthetic-new":"synthetic-pending",version:3,status:"SUCCEEDED",result:{result_id:"synthetic-result"}},
      searchMetrics:async()=>({total:1,items:[{metric_code:"M2",metric_name:"演示指标乙",score:1,match_type:"exact"}],semantic_suggestions:[]}),
      searchOrganizations:async()=>({total:1,items:[{org_code:"B",org_name:"虚构乙机构",score:1,match_type:"exact"}]}),
    } as unknown as BackendClient;
    const session=await host.createSession(actor);
    const prime=await host.runPrompt(session,{protocol_version:3,request_id:"pending-prime",message:"虚构甲机构2026年4月"},{actor,backend});
    if (!prime.ok || submitted !== 1) {
      const item={question,passed:false,phase:"prime",error_code:await failureCode(session)};
      report.push(item);console.log(JSON.stringify(item));continue;
    }
    await host.runPrompt(session,{protocol_version:3,request_id:"natural-reply",message:question!},{actor,backend});
    const item={question,expected,submitted,clarified,passed:expected==="clarify"?submitted===1&&clarified===1:submitted===2&&clarified===0};
    report.push(item);console.log(JSON.stringify(item));
  }

} finally {
  await host.close();
  await writeFile(join(dataDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({report: join(dataDir, "report.json")}));
}
if (report.some(item => !(item as {passed: boolean}).passed)) process.exitCode = 1;
