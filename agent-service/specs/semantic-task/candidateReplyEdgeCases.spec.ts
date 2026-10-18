import {describe, expect, it} from "vitest";
import {selectSavedCandidates, SemanticConflict} from "../../src/semantic-task/service.js";
import type {SemanticTarget} from "../../src/semantic-task/store.js";

/**
 * semantic_v2 用户回复待确认候选的边界说法（P0 基线，见 docs/澄清问题单重构设计-2026-10-16.md）。
 * 断言写的是期望行为；①②⑤依赖结构化回答（设计文档 P2），暂用 it.fails 标记，修复后改回 it。
 */
type Candidate = {value: string; code: string; preferred?: boolean; score?: number; metadata?: Record<string, unknown>};
const A = {value: "无锡农商行", code: "O1"}, B = {value: "江阴农商行", code: "O2"}, C = {value: "苏州农商行", code: "O3"};
const target = (candidates: Candidate[]): SemanticTarget => ({ref: "t1", status: "draft", pending: {organizations: "请选择机构"},
  fields: {organizations: {source: "explicit", resolutionStatus: "needs_confirmation", rawValue: "农商行", candidates} as never}});
const turn = (originalMessage: string) => ({originalMessage, operationId: "op-reply"}) as never;
const request = {backend: {}} as never;
async function pick(candidates: Candidate[], reply: string): Promise<string[] | "REJECTED"> {
  try {
    return (await selectSavedCandidates(target(candidates), "organizations", turn(reply), request)).map(c => String(c.code));
  } catch (error) {
    if (error instanceof SemanticConflict) return "REJECTED";
    throw error;
  }
}
const three = [A, B, C], single = [A];

describe("v2 对照：现有规则应正确处理", () => {
  it("“第二个”选中第 2 项", async () => expect(await pick(three, "第二个")).toEqual(["O2"]));
  it("“江阴农商行”按名称选中", async () => expect(await pick(three, "江阴农商行")).toEqual(["O2"]));
  it("单一提案“是”确认", async () => expect(await pick(single, "是")).toEqual(["O1"]));
  it("单一提案“不是”不确认", async () => expect(await pick(single, "不是")).toBe("REJECTED"));
  it("“不要江阴农商行”不确认江阴", async () => expect(await pick(three, "不要江阴农商行")).toBe("REJECTED"));
});

describe("v2 边界：期望行为", () => {
  it("①“不是第一个，是第二个”应选中第 2 项", async () => expect(await pick(three, "不是第一个，是第二个")).toEqual(["O2"]));
  it("①b“不是无锡的，是江阴农商行”应选中江阴", async () => expect(await pick(three, "不是无锡的，是江阴农商行")).toEqual(["O2"]));
  it.fails("②单一提案“没错，不要改日期”应确认", async () => expect(await pick(single, "没错，不要改日期")).toEqual(["O1"]));
  it("④“改成10月3号”不应选中第 3 项", async () => expect(await pick(three, "改成10月3号")).toBe("REJECTED"));
  for (const reply of ["行", "嗯", "OK", "没问题", "对"]) {
    it.fails(`⑤单一提案口语肯定“${reply}”应确认`, async () => expect(await pick(single, reply)).toEqual(["O1"]));
  }
  it("⑥首推重排后，“第1个”应选中展示在第 1 位的首推项", async () =>
    expect(await pick([A, {...B, preferred: true}, C], "第1个")).toEqual(["O2"]));
  it("⑥b首推重排后，“第2个”应选中展示在第 2 位的无锡", async () =>
    expect(await pick([A, {...B, preferred: true}, C], "第2个")).toEqual(["O1"]));
});

describe("①候选收敛与文字追问", () => {
  it("歧义候选超过4项时展示收敛到4项，未展示项不能通过序号选中、完整合法名称可独立解析", async () => {
    const five = [A, B, C, {value: "南京农商行", code: "O4"}, {value: "南通农商行", code: "O5"}];
    const {displayedCandidates} = await import("../../src/semantic-task/candidateOptions.js");
    expect(displayedCandidates(five).map(candidate => candidate.code)).toEqual(["O1", "O2", "O3", "O4"]);
    expect(await pick(five, "第5个")).toBe("REJECTED");
    expect(await pick(five, "南通农商行")).toEqual(["O5"]);
  });
  it("展示按相似度降序、同分保持目录原序，不按编码截断", async () => {
    const {displayedCandidates} = await import("../../src/semantic-task/candidateOptions.js");
    const scored = [
      {value: "指标戊", code: "M9", score: 0.5},
      {value: "指标乙", code: "M1", score: 0.9},
      {value: "指标丙", code: "M2", score: 0.9},
      {value: "指标丁", code: "M3", score: 0.7},
      {value: "指标己", code: "M4", score: 0.1},
    ];
    expect(displayedCandidates(scored).map(candidate => candidate.code)).toEqual(["M1", "M2", "M3", "M9"]);
  });
  it("日期语境数字不作为选择序号", async () => {
    expect(await pick(three, "日期改成2026年4月30日")).toBe("REJECTED");
    expect(await pick(three, "是2026年4月30日")).toBe("REJECTED");
    expect(await pick(three, "10月3号")).toBe("REJECTED");
  });
  it("“当日数”等裸口径短语限定在本题候选内唯一命中，多基础同口径不替用户选择", async () => {
    const basis = [
      {value: "对公协定存款余额当日数", code: "B1", metadata: {value_basis: "当日数"}},
      {value: "对公协定存款余额较上月", code: "B2", metadata: {value_basis: "较上月"}},
      {value: "对公协定存款余额较同期", code: "B3", metadata: {value_basis: "较同期"}},
    ];
    expect(await pick(basis, "当日数")).toEqual(["B1"]);
    expect(await pick(basis, "用较上月")).toEqual(["B2"]);
    const twoBases = [...basis, {value: "个人活期存款余额当日数", code: "B4", metadata: {value_basis: "当日数"}}];
    expect(await pick(twoBases, "当日数")).toBe("REJECTED");
  });
});

describe("候选唯一编号清单", () => {
  it("唯一首推置顶，其余保持保存顺序；展示编号即宿主取值编号", async () => {
    const {candidateOptions, preferredOption} = await import("../../src/semantic-task/candidateOptions.js");
    const options = candidateOptions([A, {...B, preferred: true}, C], "organizations");
    expect(options.map(option => [option.no, option.label])).toEqual([[1, "江阴农商行"], [2, "无锡农商行"], [3, "苏州农商行"]]);
    expect(preferredOption(options)?.optionId).toBe("organizations:O2");
    for (const option of options) expect(await pick([A, {...B, preferred: true}, C], `第${option.no}个`)).toEqual([option.candidate.code]);
  });
  it("多个首推不置顶、不视为首推", async () => {
    const {candidateOptions, preferredOption} = await import("../../src/semantic-task/candidateOptions.js");
    const options = candidateOptions([{...A, preferred: true}, {...B, preferred: true}, C]);
    expect(options.map(option => option.candidate.code)).toEqual(["O1", "O2", "O3"]);
    expect(preferredOption(options)).toBeUndefined();
  });
});

describe("已发布问题的序号与回复一致性", () => {
  const question = {scope: {field: "organizations"} as never, options: [
    {option_id: "opt1", no: 1, label: "华宁农商行"}, {option_id: "opt2", no: 2, label: "华兴农商行"},
    {option_id: "opt3", no: 3, label: "华安农商行"}, {option_id: "opt4", no: 4, label: "华丰农商行"},
  ]} as never;
  const select = (...optionIds: string[]) => ({type: "select" as const, option_ids: optionIds as [string, ...string[]]});
  it("未展示序号不能借展示项选中", async () => {
    const {answerOrdinalConflict} = await import("../../src/semantic-task/planService.js");
    expect(answerOrdinalConflict(question, "选第五个", select("opt4"))).toBe(true);
    expect(answerOrdinalConflict(question, "第4个", select("opt4"))).toBe(false);
  });
  it("明确选择序号不能被模型改成拒绝候选，真实否定不当作选择", async () => {
    const {answerOrdinalConflict} = await import("../../src/semantic-task/planService.js");
    expect(answerOrdinalConflict(question, "选第五个", {type: "none_of_these"})).toBe(true);
    expect(answerOrdinalConflict(question, "第二个", {type: "reject"})).toBe(true);
    expect(answerOrdinalConflict(question, "这些都不是", {type: "none_of_these"})).toBe(false);
    expect(answerOrdinalConflict(question, "不是第五个", {type: "none_of_these"})).toBe(false);
    expect(answerOrdinalConflict(question, "日期改成2026年4月30日", {type: "none_of_these"})).toBe(false);
  });
  it("多项回复取最后明确序号，日期数字不作序号", async () => {
    const {answerOrdinalConflict} = await import("../../src/semantic-task/planService.js");
    expect(answerOrdinalConflict(question, "不是第一个，是第二个。", select("opt2"))).toBe(false);
    expect(answerOrdinalConflict(question, "不是第一个，是第二个。", select("opt1"))).toBe(true);
    expect(answerOrdinalConflict(question, "日期改成2026年4月30日", select("opt2"))).toBe(false);
  });
});
