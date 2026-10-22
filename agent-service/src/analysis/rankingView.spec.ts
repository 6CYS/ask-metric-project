import {expect, it} from "vitest";
import {rankingModelView} from "./rankingView.js";
import {analysisEvidenceAliases} from "./verifiedFindings.js";

it.each([2, 10, 20, 61])("%i家排名的模型视图不重复整张表，判断仍绑定完整证据", count => {
  const facts = Array.from({length: count}, (_, i) => ({ref: `f${i}`, type: "fact", fact_id: `fact${i}`,
    display: `${i}元`, org_code: `O${i}`, org_name: `合成行${i}`, date: "2026-08-31"}));
  const judgment = {ref: "j1", type: "observation", judgment_kind: "ranking", display: "合成已核验排序",
    input_refs: facts.map(item => item.ref), date: "2026-08-31", org_code: "O0"};
  const result = {plan: {steps: [{method: "ranking"}]}, evidence_items: [...facts, judgment],
    observations: [{type: "ranking", fact_refs: ["fact0"]}], rows: facts};
  const before = JSON.stringify(result), view = rankingModelView(result, analysisEvidenceAliases("e1", result.evidence_items))!;
  expect(view.verified_findings.items[0]).toMatchObject({ref: "e1.j1", evidence_count: count});
  expect(view.evidence_items).toHaveLength(1);
  expect(view.evidence_items[0]?.ref).toBe("e1.v1");
  expect(JSON.stringify(result)).toBe(before);
  expect(view.observations).toBeUndefined();
});

it("混合分析保留原始模型视图，不能用排名压缩规则删去比较或其他目标", () => {
  expect(rankingModelView({plan: {steps: [{method: "ranking"}, {method: "compare"}]}}, new Map())).toBeUndefined();
});

it("机构家数差异和缺数证据随榜单保留，不能只给模型赢家数值", () => {
  const result = {plan: {steps: [{method: "ranking"}]}, observations: [], evidence_items: [
    {ref: "scope", type: "scope", display: "原文61家，实际60家"},
    {ref: "gap", type: "gap", display: "7家缺数"},
  ]};
  expect(rankingModelView(result, analysisEvidenceAliases("e1", result.evidence_items))?.evidence_items)
    .toHaveLength(2);
});
