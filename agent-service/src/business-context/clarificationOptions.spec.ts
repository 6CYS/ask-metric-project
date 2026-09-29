import {describe, expect, it} from "vitest";
import {clarificationOptions, renderClarificationOptions, replyOrdinals, selectOptions} from "./clarificationOptions.js";
import type {BusinessFrame, FieldCandidate, ResolvedField} from "./types.js";

const LABELS = {metrics: "指标", organizations: "机构"};
const basis = (name: string, value: string, item = 0): FieldCandidate =>
  ({value: `${name}${value}`, code: `${name}:${value}`, metadata: {rawValueIndex: item, value_basis: value}});
const pending = (candidates: FieldCandidate[], extra: Partial<ResolvedField> = {}): ResolvedField =>
  ({resolutionStatus: "needs_confirmation", source: "explicit", candidates, ...extra});
const frame = (fields: Record<string, ResolvedField>) => ({frameId: "f1", turnId: "t1", fields} as unknown as BusinessFrame);

// 候选按编码保存：“全省均值”在“当日数”之前，与模型可能的展示顺序无关。
const deposit = frame({metrics: pending(["全省均值", "当日数", "当日数排名", "较同期", "较同期增幅"].map(value => basis("对公日均存款余额", value)),
  {metadata: {mentionResolutions: [{text: "对公日均存款余额", start: 0, end: 8, status: "needs_confirmation"}]}})});

describe("规范候选清单", () => {
  it("按保存顺序全局编号，展示与对应使用同一份清单", () => {
    const groups = clarificationOptions(deposit, LABELS);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.title).toBe("请选择「对公日均存款余额」的口径：");
    expect(groups[0]!.options.map(option => [option.no, option.label])).toEqual([
      [1, "对公日均存款余额全省均值"], [2, "对公日均存款余额当日数"], [3, "对公日均存款余额当日数排名"],
      [4, "对公日均存款余额较同期"], [5, "对公日均存款余额较同期增幅"]]);
    expect(renderClarificationOptions(groups)).toContain("2. 对公日均存款余额当日数");
    expect(renderClarificationOptions(groups, true)).toMatch(/^未能从回复中确定/);
  });

  it("多个字段、多个待确认项连续编号，基础指标候选展示基础名称", () => {
    const groups = clarificationOptions(frame({
      metrics: pending([
        {value: "对公日均存款余额当日数", code: "C:当日数", metadata: {rawValueIndex: 0, kind: "base", source_metric_code: "C", base_name: "对公日均存款余额"}},
        {value: "各项存款余额当日数", code: "T:当日数", metadata: {rawValueIndex: 0, kind: "base", source_metric_code: "T", base_name: "各项存款余额"}},
      ], {metadata: {mentionResolutions: [{text: "对公日均存钱余额当日数", start: 0, end: 11, status: "needs_confirmation"}]}}),
      organizations: pending([{value: "合成农商行", code: "O1", metadata: {rawValueIndex: 0}}, {value: "合成农商行", code: "O2", metadata: {rawValueIndex: 0}}],
        {rawValue: ["合成农商行"]}),
    }), LABELS);
    expect(groups.map(group => group.title)).toEqual(["您说的「对公日均存钱余额当日数」是指哪个指标？", "「合成农商行」对应多个机构，请选择："]);
    expect(groups.flatMap(group => group.options.map(option => `${option.no}.${option.label}`)))
      .toEqual(["1.对公日均存款余额", "2.各项存款余额", "3.合成农商行", "4.合成农商行"]);
  });
});

describe("用户回复对应候选", () => {
  const groups = clarificationOptions(deposit, LABELS);
  const pick = (reply: string, extra: {codes?: string[]; optionIds?: string[]} = {}) =>
    selectOptions(groups, {reply, ...extra}).map(option => option.candidate.code);

  it.each([
    ["对公日均存款余额当日数", ["对公日均存款余额:当日数"]],
    ["当日数", ["对公日均存款余额:当日数"]],
    // 最长依据优先：“当日数排名”不会被当成“当日数”。
    ["要当日数排名", ["对公日均存款余额:当日数排名"]],
    ["较同期增幅吧", ["对公日均存款余额:较同期增幅"]],
    ["第二个", ["对公日均存款余额:当日数"]],
    ["2", ["对公日均存款余额:当日数"]],
    ["选5", ["对公日均存款余额:较同期增幅"]],
  ])("%s", (reply, expected) => expect(pick(reply)).toEqual(expected));

  it("目录识别编码与点选同样是依据", () => {
    expect(pick("嗯", {codes: ["对公日均存款余额:较同期"]})).toEqual(["对公日均存款余额:较同期"]);
    expect(pick("这个", {optionIds: [groups[0]!.options[2]!.id]})).toEqual(["对公日均存款余额:当日数排名"]);
  });

  it("依据互相矛盾或没有依据时不猜", () => {
    expect(pick("第一个，当日数")).toEqual([]);
    expect(pick("好的")).toEqual([]);
    expect(pick("2026年4月末的数据")).toEqual([]);
  });

  it("同名候选只能靠编号或点选区分；多个待确认项可在一次回复中分别确定", () => {
    const multi = clarificationOptions(frame({
      metrics: pending([basis("甲", "当日数", 0), basis("甲", "较同期", 0), basis("乙", "当日数", 1), basis("乙", "较同期", 1)],
        {metadata: {mentionResolutions: [{text: "甲", start: 0, end: 1, status: "needs_confirmation"}, {text: "乙", start: 2, end: 3, status: "needs_confirmation"}]}}),
      organizations: pending([{value: "合成农商行", code: "O1", metadata: {rawValueIndex: 0}}, {value: "合成农商行", code: "O2", metadata: {rawValueIndex: 0}}]),
    }), LABELS);
    expect(selectOptions(multi, {reply: "1和4"}).map(option => option.candidate.code)).toEqual(["甲:当日数", "乙:较同期"]);
    expect(selectOptions(multi, {reply: "合成农商行"}).filter(option => option.field === "organizations")).toEqual([]);
    expect(selectOptions(multi, {reply: "第6个"}).map(option => option.candidate.code)).toEqual(["O2"]);
  });
});

describe("序号解析", () => {
  it.each([
    ["2", [2]], ["第二个", [2]], ["就是第十二项", [12]], ["1和3", [1, 3]], ["选2", [2]], ["3号", [3]], ["２", [2]],
    ["2026年4月末", []], ["100万以下贷款余额当日数", []], ["对公日均存款余额当日数", []],
  ])("%s", (reply, expected) => expect(replyOrdinals(reply)).toEqual(expected));
});
