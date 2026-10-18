import {describe, expect, it} from "vitest";
import {replyOrdinals, selectOptions, type ClarificationGroup} from "../../src/business-context/clarificationOptions.js";

/**
 * 用户回复待确认候选时的边界说法。断言写的是“期望行为”，
 * 失败即说明当前关键词/正则规则与用户真实意图不一致。
 */
const option = (no: number, code: string, label: string) => ({
  no, id: `organizations:0:code:${code}`, field: "organizations", item: 0, label,
  candidate: {value: label, code},
});
const three: ClarificationGroup[] = [{field: "organizations", item: 0, title: "「农商行」对应多个机构，请选择：",
  options: [option(1, "O1", "无锡农商行"), option(2, "O2", "江阴农商行"), option(3, "O3", "苏州农商行")]}];
const single: ClarificationGroup[] = [{field: "organizations", item: 0, title: "请确认「锡商」对应的机构：",
  options: [option(1, "O1", "无锡农商行")]}];
const codes = (groups: ClarificationGroup[], reply: string, extra: object = {}) =>
  selectOptions(groups, {reply, ...extra}).map(chosen => chosen.candidate.code);

describe("对照：现有规则能正确处理的说法", () => {
  it("“第二个”选中第 2 项", () => expect(codes(three, "第二个")).toEqual(["O2"]));
  it("单一提案回复“是”确认", () => expect(codes(single, "是")).toEqual(["O1"]));
  it("单一提案回复“不是”不确认", () => expect(codes(single, "不是")).toEqual([]));
});

describe("边界：期望行为", () => {
  it.fails("①“不是第一个，是第二个”应选中第 2 项", () => expect(codes(three, "不是第一个，是第二个")).toEqual(["O2"]));
  it.fails("②单一提案“没错，不要改日期”应确认", () => expect(codes(single, "没错，不要改日期")).toEqual(["O1"]));
  it.fails("③模型判定同意（依据“可以”锚定原文）时，原句含“不要”不应否决", () =>
    expect(codes(single, "可以，不要改日期", {affirmation: {decision: "accept", sourceText: "可以"}})).toEqual(["O1"]));
  it.fails("④“改成10月3号”不应被当成选第 3 项", () => {
    expect(replyOrdinals("改成10月3号")).toEqual([]);
    expect(codes(three, "改成10月3号")).toEqual([]);
  });
  for (const reply of ["行", "嗯", "OK", "没问题"]) {
    it.fails(`⑤单一提案口语肯定“${reply}”应确认`, () => expect(codes(single, reply)).toEqual(["O1"]));
  }
});
