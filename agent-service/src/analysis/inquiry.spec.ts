import {expect, it} from "vitest";
import type {EvidenceReference} from "../answerEvidence.js";
import {inquiryProblem, inquiryReview, type AnalysisInquiry} from "./inquiry.js";

// 隔离合成证据；只验证本轮引用、补查元数据和去重，不代表真实查询库效果。
const receipt = (ref: string, items: unknown[], kind = "analysis_evidence") => ({ref,
  evidence: {kind, status: "succeeded", evidence_items: items}} as EvidenceReference);
const fact = {ref: "raw.first", type: "fact", metric_code: "isolated", org_code: "O1", date: "2026-08-27", value: "10", display: "合成值"};
const first = receipt("e1", [{ref: "gap", type: "gap"}, fact]);
const inquiry: AnalysisInquiry = {question: "总量变化与分类是否一致？", prior_judgment: "总量不能代表各类别。",
  basis_refs: ["e1.v2"], expected_change: "对照分类变化，限定总量判断的适用范围。"};

it("首批不要求补查说明；有事实后的补查必须有具体疑问与真实引用", () => {
  expect(inquiryProblem(undefined, [])).toBeUndefined();
  expect(inquiryProblem(undefined, [first])).toContain("缺少inquiry");
  expect(inquiryProblem(inquiry, [first])).toBeUndefined();
  for (const ref of ["e1", "e1.v1", "e2.v1", "k1", "invented"])
    expect(inquiryProblem({...inquiry, basis_refs: [ref]}, [first])).toContain("此前取得");
  expect(inquiryProblem({...inquiry, basis_refs: ["raw.first"]}, [first])).toBeUndefined();
});

it("模型得到真正新增的原子引用，不把换了运行编号的同一事实当成新证据", () => {
  const same = {...fact, ref: "raw.changed-run"};
  const result = inquiryReview(inquiry, [first], receipt("e2", [same, {ref: "new.gap", type: "gap"},
    {...fact, ref: "raw.new", metric_code: "another"}]));
  expect(result).toMatchObject({outcome: "evidence_added", new_evidence_refs: ["e2.v3"], question: inquiry.question});
  expect(inquiryReview(inquiry, [first], receipt("e2", [same]))).toMatchObject({outcome: "no_new_evidence", new_evidence_refs: []});
});

it("专项主题引用沿用原子名，空回执不伪造分析结论", () => {
  const source = receipt("e1", [{...fact, ref: "total.current"}], "business_overview");
  expect(inquiryProblem({...inquiry, basis_refs: ["total.current"]}, [source])).toBeUndefined();
  expect(inquiryReview(inquiry, [source], receipt("e2", [{...fact, ref: "personal.current", metric_code: "personal"}], "business_overview")))
    .toMatchObject({new_evidence_refs: ["personal.current"]});
  expect(inquiryReview(inquiry, [source], receipt("e2", []))).toMatchObject({outcome: "no_new_evidence"});
  expect(inquiryReview(undefined, [], first)).toBeUndefined();
});

it("补查允许已核验判断触发，拒绝无事实依据的观察或损坏判断", () => {
  const valid = {ref: "judgment", type: "observation", judgment_kind: "comparison_direction", input_refs: [fact.ref]};
  const data = receipt("e1", [fact, valid, {ref: "observation", type: "observation"},
    {...valid, ref: "broken", input_refs: ["not-present"]}]);
  for (const ref of ["e1.j1", "judgment"]) expect(inquiryProblem({...inquiry, basis_refs: [ref]}, [data])).toBeUndefined();
  for (const ref of ["e1.j2", "broken", "observation"]) expect(inquiryProblem({...inquiry, basis_refs: [ref]}, [data])).toContain("此前取得");
});
