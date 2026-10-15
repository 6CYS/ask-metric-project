import {describe, expect, it} from "vitest";
import {metricCoverageSource} from "../../src/business-context/adapters.js";
import type {MentionResolution} from "../../src/business-context/types.js";

function mention(question: string, text: string, code = "A"): MentionResolution {
  const start = Array.from(question.slice(0, question.indexOf(text))).length;
  return {text, start, end: start + Array.from(text).length, status: "resolved",
    value: {codes: [code], names: ["相同的正式名称"]}};
}

describe("Frame 指标覆盖率原句与身份绑定", () => {
  it("同名双码保留所选编码和用户别名，不把别名改写成歧义正式名称", () => {
    const question = "查询资产总额和总资产";
    const mentions = [mention(question, "资产总额", "TEST"), mention(question, "总资产", "FORMAL")];
    const source = metricCoverageSource(question, mentions, []);
    expect(source).toEqual({source_question: question, source_metric_bindings: [
      {start: 2, end: 6, text: "资产总额", codes: ["TEST"]},
      {start: 7, end: 10, text: "总资产", codes: ["FORMAL"]},
    ]});
    expect(source.source_question).not.toContain("相同的正式名称");
  });

  it("非 BMP 字符和明确放弃片段前后都保留原始 Unicode 码点偏移", () => {
    const question = "😀旧余额、📊资产总额、净利";
    const removed = {...mention(question, "旧余额"), status: "removed"};
    const source = metricCoverageSource(question,
      [mention(question, "资产总额", "ASSET"), mention(question, "净利", "PROFIT")], [removed]);
    expect(source).toEqual({source_question: question, source_metric_bindings: [
      {start: 6, end: 10, text: "资产总额", codes: ["ASSET"]},
      {start: 11, end: 13, text: "净利", codes: ["PROFIT"]},
    ], source_metric_exclusions: [{start: 1, end: 4, text: "旧余额"}]});
    for (const binding of source.source_metric_bindings) {
      expect(Array.from(source.source_question).slice(binding.start, binding.end).join("")).toBe(binding.text);
    }
  });

  it("放弃首个口径仍保留共用基础名，剩余省略口径沿用原始片段绑定", () => {
    const question = "贷款余额当日数和较上月增幅";
    const source = metricCoverageSource(question, [mention(question, "较上月增幅", "LOAN:GROWTH")],
      [{...mention(question, "贷款余额当日数", "LOAN:CURRENT"), status: "removed"}]);
    expect(source).toEqual({source_question: question,
      source_metric_bindings: [{start: 8, end: 13, text: "较上月增幅", codes: ["LOAN:GROWTH"]}],
      source_metric_exclusions: [{start: 0, end: 7, text: "贷款余额当日数"}]});
  });

  it("没有绑定的目标仍留在完整覆盖原句，不因只选择一项而消失", () => {
    const question = "查询资产总额和净利润";
    expect(metricCoverageSource(question, [mention(question, "资产总额")], []))
      .toEqual({source_question: question, source_metric_bindings: [{start: 2, end: 6, text: "资产总额", codes: ["A"]}]});
  });

  it("同一片段的多个已确认编码完整保留", () => {
    const question = "资产总额";
    const resolved = mention(question, question);
    resolved.value = {codes: ["A", "B"], names: ["甲", "乙"]};
    expect(metricCoverageSource(question, [resolved], []).source_metric_bindings[0]?.codes).toEqual(["A", "B"]);
  });

  it.each([
    {status: "needs_confirmation"},
    {value: {codes: [], names: []}},
    {value: {codes: [" "], names: ["甲"]}},
    {value: {codes: ["A", "A"], names: ["甲", "甲"]}},
    {start: -1}, {start: 0.5}, {end: 99}, {end: 0}, {text: "另外的名称"},
  ])("未决、无编码或非法片段快照拒绝执行：%j", override => {
    expect(() => metricCoverageSource("资产总额", [{...mention("资产总额", "资产总额"), ...override}], []))
      .toThrow("INVALID_METRIC_COVERAGE_SNAPSHOT");
  });

  it("保留片段与放弃片段重叠时拒绝，不能静默跳过片段", () => {
    const question = "资产总额";
    const resolved = mention(question, question);
    expect(() => metricCoverageSource(question, [resolved], [{...resolved, status: "removed"}]))
      .toThrow("INVALID_METRIC_COVERAGE_SNAPSHOT");
    expect(() => metricCoverageSource(question, [resolved, resolved], []))
      .toThrow("INVALID_METRIC_COVERAGE_SNAPSHOT");
  });

  it("未明确放弃或无剩余目标时拒绝缩减覆盖原句", () => {
    const question = "资产总额和净利润";
    expect(() => metricCoverageSource(question, [mention(question, "资产总额")], [mention(question, "净利润")]))
      .toThrow("INVALID_METRIC_COVERAGE_SNAPSHOT");
    expect(() => metricCoverageSource(question, [], [])).toThrow("INVALID_METRIC_COVERAGE_SNAPSHOT");
  });

  it("损坏的持久化快照返回明确错误，不生成虚假的绑定", () => {
    expect(() => metricCoverageSource("资产总额", [null] as unknown as MentionResolution[], []))
      .toThrow("INVALID_METRIC_COVERAGE_SNAPSHOT");
    const resolved = mention("资产总额", "资产总额");
    resolved.value = {codes: "A" as unknown as string[], names: []};
    expect(() => metricCoverageSource("资产总额", [resolved], [])).toThrow("INVALID_METRIC_COVERAGE_SNAPSHOT");
  });
});
