import {expect, it} from "vitest";
import {createBusinessTopicReadTool, overviewMonthRange} from "./businessOverview.js";
import {testRequestContext, MemoryCommandBridge, runTool} from "./testUtils.js";
import type {BackendClient} from "../backendClient.js";
import {hasTurnAction, topicExplanationAnswer} from "./turnContract.js";
import {assertOverviewMonthSource, recentOverviewExpression, overviewTimeExpression} from "../business-context/overviewPolicy.js";
import {createFieldResolvers} from "../business-context/resolvers.js";
import {createCapabilities} from "../business-context/capabilities.js";
import {catalogBindingView, resolveCatalogBindings, restoreAnalysisDiscovery} from "../analysis/bindings.js";

it("本月概览扩展到日历月末，不改变基础日期解析结果", () => {
  const range = {start: "2026-10-01", end: "2026-10-12"};
  expect(overviewMonthRange("本月", range)).toEqual({start: "2026-10-01", end: "2026-10-31"});
  expect(range.end).toBe("2026-10-12");
});
it("主题读取提供正式通用引用，后续目录与恢复不重排短引用", async () => {
  const backend = {businessTopic: async () => ({version: "synthetic", method: "business-overview-v1", metrics: []}),
    analysisCatalog: async () => ({items: [{code: "ORG_SYNTH_LOAN", name: "合成贷款", binding_ref: "signed-topic"}]})} as unknown as BackendClient;
  const request = testRequestContext(backend, new MemoryCommandBridge());
  const result = await runTool(createBusinessTopicReadTool(), {topic: "loan", content: "topic"}, request);
  expect(JSON.parse(result.content[0]!.type === "text" ? result.content[0]!.text : "{}").analysis_directory.items[0].binding_ref).toBe("k1");
  expect(catalogBindingView(request, {binding_ref: "signed-profit"})).toMatchObject({binding_ref: "k2"});
  const recovered = testRequestContext(backend, new MemoryCommandBridge());
  restoreAnalysisDiscovery(recovered, [result.details]);
  const plan = {objective: "隔离验证", scope_notice: "隔离样本", requirements: [{id: "q", question: "合成贷款"}],
    steps: [{id: "read", method: "observe" as const, metric_refs: ["ORG_SYNTH_LOAN"], answers: ["q"], rationale: "正式主题绑定"}]};
  expect(resolveCatalogBindings(recovered, plan).steps[0]?.metric_refs).toEqual(["signed-topic"]);
  expect(() => resolveCatalogBindings(recovered, {...plan, steps: [{...plan.steps[0]!, metric_refs: ["ORG_UNKNOWN"]}]})).toThrow("ANALYSIS_BINDING_INVALID");
});
it("闰年月份和明确日期不混淆", () => {
  expect(overviewMonthRange("本月", {start: "2028-02-01", end: "2028-02-12"})?.end).toBe("2028-02-29");
  const explicit = {start: "2026-10-01", end: "2026-10-12"};
  expect(overviewMonthRange("2026年10月1日至12日", explicit)).toBe(explicit);
  expect(overviewMonthRange("本月", {start: "2026-10-12", end: "2026-10-12"})?.end).toBe("2026-10-12");
});
it("读取主题和方法仍属于规划，不能被当作已经完成用户分析", () => {
  expect(hasTurnAction([{role: "toolResult", toolName: "business_topic_read", toolCallId: "topic",
    content: [], timestamp: 1, isError: false, details: {status: "ok"}}])).toBe(false);
  expect(hasTurnAction([{role: "toolResult", toolName: "resolve_business_turn", toolCallId: "execute",
    content: [], timestamp: 1, isError: false, details: {kind: "business_overview", status: "succeeded"}}])).toBe(true);
});

it.each(["含协定和不含协定的活期存款占比有什么差别？", "含协定的活期比例口径是什么？"])("已禁用口径解释直接交付映射缺口，不要求日期：%s", async question => {
  const backend = {businessTopic: async () => ({version: "isolated-v1", method: "business-overview-v1",
    metrics: [{id: "disabled", label: "隔离合成口径", disabled_reason: "隔离样本映射冲突", question_terms: ["含协定", "活期"]}]})} as unknown as BackendClient;
  const result = await runTool(createBusinessTopicReadTool(), {topic: "deposit", content: "topic"}, testRequestContext(backend, new MemoryCommandBridge(), {originalMessage: question}));
  expect(result.terminate).toBe(true);
  expect(result.details).toMatchObject({kind: "business_topic_explanation", status: "unsupported", delivery: "business_evidence_v1"});
  expect(JSON.stringify(result.content)).toContain("本次未执行数值查询");
  const messages = [{role: "toolResult" as const, toolName: "business_topic_read", toolCallId: "topic",
    content: [], timestamp: 1, isError: false, details: result.details}];
  expect(hasTurnAction(messages)).toBe(true);
  expect(topicExplanationAnswer(messages)).toBe(result.details.public_answer);
});
it("普通取值问题仍进入规划和查询，不因包含禁用名称提前结束", async () => {
  const backend = {businessTopic: async () => ({version: "isolated-v1", method: "business-overview-v1", metrics: [{label: "隔离合成口径", disabled_reason: "映射冲突",
    question_terms: ["含协定", "活期"]}]})} as unknown as BackendClient;
  const result = await runTool(createBusinessTopicReadTool(), {topic: "deposit", content: "topic"},
    testRequestContext(backend, new MemoryCommandBridge(), {originalMessage: "含协定活期占比最近是多少？"}));
  expect(result.terminate).not.toBe(true);
  expect(result.details.kind).toBe("business_topic_read");
});
it("明确月份不能省略或继承错误月份，月和月末在本方法中等价", () => {
  const fields = {time: {rawValue: "2026年7月末", source: "explicit" as const, resolutionStatus: "resolved" as const}};
  expect(() => assertOverviewMonthSource("2026年7月贷款情况", fields)).not.toThrow();
  expect(() => assertOverviewMonthSource("改看2026年8月", fields)).toThrow("OVERVIEW_DATE_SOURCE_MISMATCH");
  expect(() => assertOverviewMonthSource("2026年7月贷款情况", {})).toThrow("OVERVIEW_DATE_SOURCE_MISMATCH");
  expect(() => assertOverviewMonthSource("贷款情况怎么样", {})).not.toThrow();
});
it.each(["最近", "近期", "最新", "近来", "这段时间", "这阵子"])("%s按原文选择最新快照，不调用日历日期解析", async expression => {
  const schema = createCapabilities().get("business_overview").fields.time!;
  const resolveCatalog = async () => {throw new Error("不应把最近送到日历解析器");};
  const result = await createFieldResolvers().getResolver(schema).resolve(expression, schema,
    {originalMessage: `${expression}贷款情况怎么样？`, currentDate: "2026-10-13", turnId: "recent", resolveCatalog});
  expect(result).toMatchObject({status: "resolved", value: {date_selection: "latest_snapshot"}});
  expect(() => assertOverviewMonthSource(`${expression}贷款情况怎么样？`, {
    time: {rawValue: expression, source: "explicit", resolutionStatus: "resolved"}})).not.toThrow();
  expect(() => assertOverviewMonthSource(`${expression}贷款情况怎么样？`, {})).toThrow("OVERVIEW_DATE_SOURCE_MISMATCH");
});
it("最近不能保留旧月份，有界期间与明确日期不被替换", () => {
  const latest = {time: {rawValue: "最近", source: "explicit" as const, resolutionStatus: "resolved" as const}};
  const old = {time: {rawValue: "2026年7月", source: "inherited" as const, resolutionStatus: "resolved" as const}};
  expect(() => assertOverviewMonthSource("最近贷款情况怎么样？", old)).toThrow("OVERVIEW_DATE_SOURCE_MISMATCH");
  expect(() => assertOverviewMonthSource("最近看一下2026年7月贷款情况", latest)).toThrow("OVERVIEW_DATE_SOURCE_MISMATCH");
  expect(recentOverviewExpression("最近三个月贷款表现如何？")).toBeUndefined();
  expect(recentOverviewExpression("最近30天贷款表现如何？")).toBeUndefined();
});
it.each(["最近三个月", "最近30天"])("模型从%s截取‘最近’时服务端仍按完整期间解析", async period => {
  const schema = createCapabilities().get("business_overview").fields.time!;
  const result = await createFieldResolvers().getResolver(schema).resolve("最近", schema,
    {originalMessage: `${period}贷款表现如何？`, currentDate: "2026-10-13", turnId: "bounded",
      resolveCatalog: async (_entity, values) => {
        expect(values).toEqual([period]);
        return {status: "resolved" as const, value: {start: "2026-08-01", end: "2026-10-13"}};
      }});
  expect(result).toMatchObject({value: {start: "2026-08-01"}, metadata: {sourceExpression: period}});
});
it.each(["今年五月份到十月份", "5月至10月", "2026年5月到2026年10月", "最近三个月", "去年上半年"])("自动识别完整时间：%s", expression => {
  expect(overviewTimeExpression(`紫金农商行${expression}期间贷款情况`)).toBe(expression);
});
it("日期不需要模型逐字抄写，服务端以真实原文为准", async () => {
  const schema = createCapabilities().get("business_overview").fields.time!;
  const result = await createFieldResolvers().getResolver(schema).resolve("2026年5月至10月", schema,
    {originalMessage: "紫金农商行今年五月份到十月份期间贷款情况", currentDate: "2026-10-13", turnId: "range",
      resolveCatalog: async (_entity, values) => {
        expect(values).toEqual(["今年五月份到十月份"]);
        return {status: "resolved" as const, value: {start: "2026-05-01", end: "2026-10-31"}};
      }});
  expect(result.status).toBe("resolved");
});

it("存款概览按存款主题验证章节，不要求贷款质量指标", async () => {
  const schema = createCapabilities().get("business_overview").fields.plan!;
  const resolver = createFieldResolvers().getResolver(schema);
  const context = {originalMessage: "最近存款怎么样？", currentDate: "2026-10-14", turnId: "deposit",
    resolveCatalog: async () => ({status: "resolved" as const})};
  const plan = {topic: "deposit", goal: "overview", sections: ["scale", "growth", "structure"]};
  expect(await resolver.resolve(plan, schema, context)).toMatchObject({status: "resolved", value: plan});
  await expect(resolver.resolve({...plan, topic: "loan"}, schema, context)).rejects.toThrow("ANALYSIS_PLAN_INCOMPLETE");
});
