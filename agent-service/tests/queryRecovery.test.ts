import {describe, expect, it} from "vitest";
import type {BackendClient} from "../src/backendClient.js";
import {analysisCandidates, catalogBindingState, catalogBindingView, inheritAnalysisState, restoreAnalysisDiscovery} from "../src/analysis/bindings.js";
import {MemoryCommandBridge, testRequestContext} from "../src/tools/testUtils.js";

const request = (backend = {} as BackendClient) => testRequestContext(backend, new MemoryCommandBridge());
describe("目录发现与正式身份分离", () => {
  it("模型目录保留源指标族和已有口径，正式指标仍使用各自短引用", () => {
    const context = request();
    const source = {items: [
      {code: "M1", name: "测试金额当日数", source_metric_code: "BASE1", base_name: "测试金额", value_basis: "当日数",
        unit: "元", semantic_source: "正式指标目录", semantic_status: "catalog_only", binding_ref: "signed-current",
        metadata_version: "private-version"},
      {code: "M2", name: "测试金额较同期", source_metric_code: "BASE1", base_name: "测试金额", value_basis: "较同期",
        unit: "元", semantic_source: "正式指标目录", semantic_status: "catalog_only", binding_ref: "signed-difference"},
    ]};
    const before = structuredClone(source), view = catalogBindingView(context, source) as {items: Array<Record<string, unknown>>};
    expect(view.items).toMatchObject([
      {code: "M1", source_metric_code: "BASE1", base_name: "测试金额", value_basis: "当日数",
        semantic_source: "正式指标目录", semantic_status: "catalog_only", binding_ref: "k1"},
      {code: "M2", source_metric_code: "BASE1", base_name: "测试金额", value_basis: "较同期",
        semantic_source: "正式指标目录", semantic_status: "catalog_only", binding_ref: "k2"},
    ]);
    expect(JSON.stringify(view)).not.toMatch(/signed-current|signed-difference|private-version/);
    expect(source).toEqual(before);
  });

  it("旧目录缺少来源和审核信息时不补造", () => {
    const view = catalogBindingView(request(), {items: [{code: "M1", name: "测试金额较同期", binding_ref: "signed-ref"}]}) as {
      items: Array<Record<string, unknown>>};
    expect(view.items).toEqual([{code: "M1", name: "测试金额较同期", binding_ref: "k1"}]);
  });

  it.each([undefined, "", "incorrect-signed-ref"])("近似推荐保留定义但不注册引用：%s", binding_ref => {
    const context = request();
    const suggestion = {code: "M1", name: "测试户数", explanation: "测试业务含义", description: "测试口径",
      match_type: "semantic", score: 0.8, ...(binding_ref === undefined ? {} : {binding_ref})};
    const view = catalogBindingView(context, {items: [], semantic_suggestions: [suggestion]}) as {
      semantic_suggestions: Array<Record<string, unknown>>};
    expect(view.semantic_suggestions[0]).toMatchObject({explanation: "测试业务含义", description: "测试口径", score: 0.8});
    expect(view.semantic_suggestions[0]).not.toHaveProperty("binding_ref");
    expect(analysisCandidates(context)).toEqual([]);
    expect(catalogBindingState(context)).toEqual({});
  });

  it("恢复原生回执不将语义推荐升级为正式候选", () => {
    const context = request();
    restoreAnalysisDiscovery(context, [{kind: "analysis_catalog", status: "succeeded",
      binding_map: {"code:M1": "bad-ref", k1: "bad-ref", "code:M2": "good-ref", k2: "good-ref"},
      candidate_map: [{code: "M1", name: "近似", binding_ref: "k1", match_type: "semantic"},
        {code: "M2", name: "正式", binding_ref: "k2", match_type: "exact"}]}]);
    expect(analysisCandidates(context)).toMatchObject([{code: "M2"}]);
    expect(catalogBindingState(context)).toEqual({"code:M2": "good-ref", k2: "good-ref"});
  });

  it("恢复来源随正式回执和子任务传递，不作为模型可填写的目录字段", () => {
    const context = request(), source = {operation_id: "op", plan_ref: "plan", step_id: "step", target_ref: "target",
      original_message: "存款有多少", metric_expression: "存款"};
    const view = catalogBindingView(context, {items: [{code: "M1", name: "测试存款余额", match_type: "contains",
      binding_ref: "signed-ref"}]}, source) as {items: Array<Record<string, unknown>>};
    expect(view.items[0]).not.toHaveProperty("query_recovery");
    const restored = request();
    restoreAnalysisDiscovery(restored, [{kind: "analysis_catalog", status: "succeeded",
      candidate_map: analysisCandidates(context), binding_map: catalogBindingState(context)}]);
    const child = {...restored, operationId: "op:step"};
    inheritAnalysisState(restored, child);
    expect(analysisCandidates(child)).toMatchObject([{code: "M1", query_recovery: source}]);
    expect(catalogBindingState(child)).toEqual({"code:M1": "signed-ref", k1: "signed-ref"});
  });
});
