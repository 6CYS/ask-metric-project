import {expect, it} from "vitest";
import type {BackendClient} from "../backendClient.js";
import {MemoryCommandBridge, testRequestContext} from "../tools/testUtils.js";
import {analysisCandidates, analysisDiscoveryRounds, catalogBindingState, catalogBindingView, inheritAnalysisState, registerAnalysisDiscovery, resolveCatalogBindings, restoreAnalysisDiscovery} from "./bindings.js";
import {analysisCoverageReview} from "./coverage.js";
import {analysisInterpretationBrief} from "./interpretation.js";
import type {AnalysisEvidence} from "./tools.js";

// 以下均为隔离合成样本，只验证分化提示和补查行为，不代表业务库记录。
function sample() {
  const request = testRequestContext({} as BackendClient, new MemoryCommandBridge(), {originalMessage: "最近经营情况怎么样"});
  const items = [
    ["total", "scale", "total", null], ["personal", "structure", "personal", null], ["quality", "quality", "quality", null],
    ["total_m", "growth", "total", "mom"], ["personal_m", "growth", "personal", "mom"],
    ["personal_y", "growth", "personal", "yoy"], ["quality_m", "growth", "quality", "mom"], ["quality_y", "growth", "quality", "yoy"],
  ].map(([code, section, metric_id, comparison]) => ({code: code!, name: `合成${code}`, binding_ref: `signed-${code}`,
    analysis_hint: {topic: "sample", topic_name: "隔离主题", section, metric_id, comparison,
      ...(comparison ? {comparison_role: "difference"} : {}), default_sections: ["scale", "structure", "quality"]}}));
  catalogBindingView(request, {items});
  const source = {kind: "analysis_evidence", status: "succeeded", run_ref: "sample", org_codes: ["org1"], metric_descriptors: [],
    plan: {objective: "合成样本", scope_notice: "隔离测试", requirements: [{id: "q1", question: "情况"}], steps: []},
    evidence_items: []} as unknown as AnalysisEvidence;
  const fact = (metric_code: string, value: string, date = "2026-08-27", org_code = "org1") => ({ref: `raw.${metric_code}`,
    type: "fact", metric_code, value, date, org_code});
  return {request, items, source, fact};
}

it("有分项和质量当前值仍提示正式比较，已查空值不重复要求", () => {
  const {request, source, fact} = sample();
  source.metric_descriptors = ["total", "personal", "quality"].map(code => ({code, binding_ref: `signed-${code}`}));
  source.evidence_items = [fact("personal", "100"), fact("quality", "1")];
  const review = analysisCoverageReview(request, [source]);
  expect(review.filter(item => item.aspect.endsWith("变化")).flatMap(item => item.candidates).map(item => item.name))
    .toEqual(["合成personal_m", "合成personal_y", "合成quality_m", "合成quality_y"]);
  source.metric_descriptors.push(...["personal_m", "personal_y", "quality_m", "quality_y"].map(code => ({code, binding_ref: `signed-${code}`})));
  expect(analysisCoverageReview(request, [source]).filter(item => item.aspect.endsWith("变化"))).toEqual([]);
});

it("聚焦质量不扩展存款构成；compare已尝试基期不再要求正式比较", () => {
  const {request, source, fact} = sample();
  request.originalMessage = "最近质量情况怎么样";
  source.metric_descriptors = ["quality"].map(code => ({code, binding_ref: `signed-${code}`}));
  source.evidence_items = [fact("quality", "1")];
  source.plan.steps = [{id: "check", method: "compare", metric_refs: ["signed-quality"], comparisons: ["mom", "yoy"], answers: ["q1"], rationale: "检查比较"}];
  expect(analysisCoverageReview(request, [source])).toEqual([]);
  request.originalMessage = "这个指标是多少";
  expect(analysisCoverageReview(request, [])).toEqual([]);
});

it("分化线索只连接同机构同日同周期，引用逐项对应原子位置", () => {
  const {request, source, fact} = sample();
  source.evidence_items = [{ref: "observation", type: "observation"}, {ref: "gap", type: "gap"},
    fact("total_m", "2.0"), fact("personal_m", "-1.0"), fact("personal_y", "3.0")];
  const result = analysisInterpretationBrief(request, [{ref: "e3", evidence: source}]);
  expect(result.signals.map(item => item.kind)).toEqual(["same_period_divergence", "baseline_divergence"]);
  expect(result.signals[0]?.evidence_refs).toEqual(["e3.v2", "e3.v3"]);
  expect(result.signals[1]?.evidence_refs).toEqual(["e3.v3", "e3.v4"]);
  source.evidence_items = [fact("total_m", "2.0"), fact("personal_m", "-1.0", "2026-07-31"), fact("personal_y", "3.0", "2026-07-31", "org2")];
  expect(analysisInterpretationBrief(request, [{ref: "e1", evidence: source}]).signals).toEqual([]);
});

it("空值、未知值与负零不制造分化，不把比例水平当增减", () => {
  const {request, source, fact} = sample();
  source.evidence_items = [fact("total_m", "2.0"), fact("personal_m", "-0.00e-10"), fact("personal_y", "NaN"), fact("quality", "-1")];
  const signals = analysisInterpretationBrief(request, [{ref: "e1", evidence: source}]).signals;
  expect(signals.map(item => item.kind)).toEqual(["snapshot_without_comparison"]);
  expect(signals[0]?.evidence_refs).toEqual(["e1.v4"]);
});
it("未预制领域使用正式目录的比较标签提示分化，不把增幅或排名当差额", () => {
  const {request, source, fact} = sample();
  catalogBindingView(request, {items: [
    {code: "new_m", name: "合成新领域较上月", binding_ref: "signed-new-m", base_name: "合成新领域", value_basis: "较上月", unit: "元"},
    {code: "new_y", name: "合成新领域较同期", binding_ref: "signed-new-y", base_name: "合成新领域", value_basis: "较同期", unit: "元"},
    {code: "unknown", name: "合成新领域较年初增幅排名", binding_ref: "signed-unknown"},
  ]});
  source.evidence_items = [fact("new_m", "1"), fact("new_y", "-1"), fact("unknown", "5")];
  const signals = analysisInterpretationBrief(request, [{ref: "e1", evidence: source}]).signals;
  expect(signals).toHaveLength(1);
  expect(signals[0]).toMatchObject({kind: "baseline_divergence", evidence_refs: ["e1.v1", "e1.v2"]});
  catalogBindingView(request, {items: [
    {code: "new_m", name: "合成新领域较上月", binding_ref: "signed-new-m", unit: "元"},
    {code: "new_y", name: "合成新领域较同期", binding_ref: "signed-new-y", unit: "元"},
  ]});
  expect(analysisInterpretationBrief(request, [{ref: "e1", evidence: source}]).signals[0])
    .toMatchObject({kind: "baseline_divergence", evidence_refs: ["e1.v1", "e1.v2"]});
});
it("实际水平值触发可核对的变化疑问，已尝试或仅问取值时不要求补查", () => {
  const {request, source, fact} = sample();
  catalogBindingView(request, {items: [
    {code: "new", name: "合成新领域当日数", binding_ref: "signed-new", unit: "元"},
    {code: "new_m", name: "合成新领域较上月", binding_ref: "signed-new-m", unit: "元"},
    {code: "new_y", name: "合成新领域较同期", binding_ref: "signed-new-y", unit: "元"},
  ]});
  source.metric_descriptors = [{code: "new", binding_ref: "signed-new"}];
  source.evidence_items = [fact("new", "10")];
  const signal = analysisInterpretationBrief(request, [{ref: "e1", evidence: source}]).signals[0];
  expect(signal).toMatchObject({kind: "snapshot_without_comparison", evidence_refs: ["e1.v1"],
    check_metrics: [{binding_ref: "k10", name: "合成新领域较上月"}, {binding_ref: "k11", name: "合成新领域较同期"}]});
  source.metric_descriptors.push({code: "new_m", binding_ref: "signed-new-m"});
  expect(analysisInterpretationBrief(request, [{ref: "e1", evidence: source}]).signals).toEqual([]);
  source.metric_descriptors.pop(); request.originalMessage = "这个指标是多少";
  expect(analysisInterpretationBrief(request, [{ref: "e1", evidence: source}]).signals).toEqual([]);
  request.originalMessage = "近期表现如何";
  source.plan.steps = [{id: "compared", method: "compare", metric_refs: ["signed-new"], comparisons: ["mom", "yoy"], answers: ["q1"], rationale: "已核对"}];
  expect(analysisInterpretationBrief(request, [{ref: "e1", evidence: source}]).signals).toEqual([]);
});
it("总量比较与分类现值触发具体疑问，已取得分类比较或不同时点不制造补查要求", () => {
  const {request, source, fact} = sample();
  source.evidence_items = [fact("total_m", "2"), fact("personal", "100")];
  const signal = analysisInterpretationBrief(request, [{ref: "e1", evidence: source}]).signals[0];
  expect(signal).toMatchObject({kind: "unverified_category_change", evidence_refs: ["e1.v1", "e1.v2"]});
  expect(signal?.check_metrics).toEqual([{binding_ref: "k5", name: "合成personal_m"}]);
  expect(signal?.question).toContain("同一比较期间是否同向变化");
  source.evidence_items.push(fact("personal_m", "1"));
  expect(analysisInterpretationBrief(request, [{ref: "e1", evidence: source}]).signals).toEqual([]);
  source.evidence_items = [fact("total_m", "2"), fact("personal", "100", "2026-07-31")];
  expect(analysisInterpretationBrief(request, [{ref: "e1", evidence: source}]).signals).toEqual([]);
});

it("执行回执新增短引用可恢复且不占目录检索次数", () => {
  const {request, source} = sample();
  const recovered = testRequestContext({} as BackendClient, new MemoryCommandBridge());
  restoreAnalysisDiscovery(recovered, [{...source, binding_map: catalogBindingState(request)}]);
  expect(resolveCatalogBindings(recovered, {...source.plan, steps: [{id: "r", method: "observe", metric_refs: ["k8"], answers: ["q1"], rationale: "测试"}]}).steps[0]?.metric_refs)
    .toEqual(["signed-quality_y"]);
});

it("绑定Frame的请求副本保留目录，新增短引用不覆盖原始编号", () => {
  const {request, source} = sample();
  registerAnalysisDiscovery(request);
  const bound = {...request, businessExecutionFrame: "isolated-frame"};
  inheritAnalysisState(request, bound);
  expect(analysisCandidates(bound)).toEqual(analysisCandidates(request));
  expect(analysisDiscoveryRounds(bound)).toBe(1);
  expect(catalogBindingView(bound, {code: "extra", name: "合成补查", binding_ref: "signed-extra"})).toMatchObject({binding_ref: "k9"});
  expect(catalogBindingState(request).k1).toBe("signed-total");
  expect(catalogBindingState(request).k9).toBe("signed-extra");
  expect(resolveCatalogBindings(bound, {...source.plan, steps: [{id: "r", method: "observe", metric_refs: ["k1"], answers: ["q1"], rationale: "核对"}]}).steps[0]?.metric_refs)
    .toEqual(["signed-total"]);
});
