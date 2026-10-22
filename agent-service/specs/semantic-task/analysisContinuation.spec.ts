import {expect, it, vi} from "vitest";
import {normalizeRankingContinuation} from "../../src/semantic-task/analysisContinuation.js";
import type {AskMetricRequestContext} from "../../src/requestContext.js";
import type {SemanticRequest} from "../../src/semantic-task/protocol.js";
import type {AnalysisPlan} from "../../src/analysis/contracts.js";
import type {SemanticPlan} from "../../src/semantic-task/store.js";

it.each(["metric", "organization", "time", "multiple-sources", "multiple-metrics", "mixed-analysis", "foreign-owner", "resolved-query-metric", "invalid-reference"])(
  "排名续接不扩大到不明确或无权的历史目标：%s", async mode => {
    const analysis: AnalysisPlan = {objective: "合成指标排名", scope_notice: "隔离合成范围",
      requirements: [{id: "q", question: "最高机构"}], steps: [{id: "s", method: "ranking", metric_refs: ["signed-synthetic"],
        answers: ["q"], rationale: "合成范围排序", position: "top", top_n: 1}]};
    if (mode === "multiple-metrics") analysis.steps[0]!.metric_refs.push("another-signed");
    if (mode === "mixed-analysis") analysis.steps.push({...analysis.steps[0]!, id: "s2", method: "observe"});
    const parent = {ref: "prior-plan", owner: mode === "foreign-owner" ? "another-actor" : "actor", steps: [
      {targetRef: "prior-target", taskRef: "prior-task"}, ...(mode === "multiple-sources" ? [{targetRef: "other-target", taskRef: "other-task"}] : []),
    ]} as SemanticPlan;
    const get = vi.fn(async () => ({owner: "actor", capability: mode === "resolved-query-metric" ? "metric_query" : "business_analysis",
      target: {fields: {plan: {resolutionStatus: "resolved", resolvedValue: analysis},
        ...(mode === "resolved-query-metric" ? {metrics: {resolutionStatus: "resolved", resolvedValue: {codes: ["NEW_METRIC"]}}} : {})}}}));
    const request = {actor: {id: "actor"}, originalMessage: "那最低呢？", semanticTasks: {
      get, plan: vi.fn(async () => parent), planReference: vi.fn(async () => undefined),
    }} as unknown as AskMetricRequestContext;
    const input = {protocol_version: 2, intent: "query", targets: [{source: mode === "invalid-reference"
      ? {kind: "reference", task_ref: "prior-plan", target_ref: "prior-target"} : {kind: "current"},
    operations: [{action: "set", field: "operation", value: "后1名", queryOperation: {kind: "ranking", position: "bottom", top_n: 1}}]}]} as SemanticRequest;
    const facts = {fragments: [{mentions: mode === "metric" ? [{}] : [], organizations: mode === "organization" ? ["O1"] : [],
      calendar: {ranges: mode === "time" ? [{}] : [], unresolved: []}}]} as unknown as Parameters<typeof normalizeRankingContinuation>[3];
    const before = structuredClone(analysis);
    expect(await normalizeRankingContinuation(request, input, parent, facts)).toBe(input);
    expect(analysis).toEqual(before);
  });
