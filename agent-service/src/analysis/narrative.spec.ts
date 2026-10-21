import {expect, it} from "vitest";
import {narrativeEvidenceRefs, narrativeParagraphEvidence, normalizeReportNarrative, normalizeReportParagraphs, reviewNarrativeDensity} from "./narrative.js";

it("自由正文原样进入事实校验，历史格式仍可用且不得混用", () => {
  const body = "值得关注的是分项分化。\n\n- 证据为{{e1.v1}}。\n- 仍需核验具体动因。";
  expect(normalizeReportNarrative({body})).toEqual({summary: body, sections: []});
  const legacy = {summary: "合成判断", sections: [{title: "合成观察", text: "{{e1.v1}}", evidence_refs: ["e1.v1"]}]};
  expect(normalizeReportNarrative(legacy)).toEqual(legacy);
  expect(() => normalizeReportNarrative({body, ...legacy})).toThrow("不能与body混用");
  expect(() => normalizeReportNarrative({body: " "})).toThrow();
  expect(() => normalizeReportNarrative({summary: "只有旧摘要"})).toThrow();
});

it("正文段落在引用校验前修复，原始输入及数值、日期、非法引用均不改写", () => {
  const input = {body: String.raw`## 隔离样本\n\n截至2026-07-31，证据{{e1.v1}}。\n\n仍需核查{{missing|invented}}。`};
  const before = JSON.stringify(input);
  const {summary} = normalizeReportNarrative(input);
  expect(summary).toBe("## 隔离样本\n\n截至2026-07-31，证据{{e1.v1}}。\n\n仍需核查{{missing|invented}}。");
  expect(narrativeParagraphEvidence(summary)).toEqual([
    {paragraph: 2, evidence_refs: ["e1.v1"]}, {paragraph: 3, evidence_refs: ["missing|invented"]},
  ]);
  expect(JSON.stringify(input)).toBe(before);
  expect(normalizeReportParagraphs(summary)).toBe(summary);
  const legacy = {summary: String.raw`旧摘要\n\n补充`, sections: [{title: "观察", text: String.raw`证据\r\n\r\n{{e1.v1}}`, evidence_refs: ["e1.v1"]}]};
  const legacyBefore = JSON.stringify(legacy);
  expect(normalizeReportNarrative(legacy)).toEqual({summary: "旧摘要\n\n补充",
    sections: [{title: "观察", text: "证据\n\n{{e1.v1}}", evidence_refs: ["e1.v1"]}]});
  expect(JSON.stringify(legacy)).toBe(legacyBefore);
});

it.each([
  String.raw`路径 C:\new\notes，正则 \n，双重转义 \\n\\n 均不解码。`,
  "示例 `" + String.raw`\n\n` + "` 与 ``含 ` 的代码 " + String.raw`\n\n` + "``。",
  "````text\n```\n" + String.raw`代码\n\n仍为字面量` + "\n````",
  "~~~~text\n" + String.raw`代码\n\n仍为字面量` + "\n~~~\n~~~~",
  "```text\n" + String.raw`未闭合代码\n\n仍需原样保留`,
  "普通真实换行。\r\n\r\n第二段。",
])("段落修复保护代码、路径及已正常的文本：%s", source => {
  expect(normalizeReportParagraphs(source)).toBe(source);
});

it("不显示数值的证据引用独立保留，不按抄表计数且不吞掉非法后缀", () => {
  const body = "重点为{{e1.v1}}。\n\n其他比较已有依据{{e1.v2|cite}}{{e1.v3|cite}}。";
  expect(narrativeEvidenceRefs(body)).toEqual(["e1.v1", "e1.v2", "e1.v3"]);
  expect(narrativeParagraphEvidence(body)[1]).toEqual({paragraph: 2, evidence_refs: ["e1.v2", "e1.v3"]});
  expect(narrativeEvidenceRefs("{{missing|invented}}")).toEqual(["missing|invented"]);
  const atoms = Array.from({length: 10}, (_, i) => ({ref: `sample.f${i}`, type: "fact"}));
  expect(reviewNarrativeDensity({originalMessage: "最近情况"}, atoms.map(atom => `{{${atom.ref}|cite}}`).join(""), atoms)).toBeUndefined();
});

it("明显整表复述只提醒一次，简洁表达、缺口、未知引用及明确明细请求不触发", () => {
  const atoms = Array.from({length: 10}, (_, i) => ({ref: `sample.f${i}`, type: "fact"}));
  const body = atoms.slice(0, 8).map(atom => `{{${atom.ref}}}`).join("、");
  const request = {originalMessage: "最近经营情况怎么样"};
  expect(reviewNarrativeDensity(request, body, atoms)?.details.status).toBe("needs_revision");
  expect(reviewNarrativeDensity(request, body, atoms)).toBeUndefined();
  expect(reviewNarrativeDensity({originalMessage: "请列出全部明细"}, body, atoms)).toBeUndefined();
  expect(reviewNarrativeDensity({originalMessage: "最近情况如何"}, body, atoms.map(atom => ({...atom, type: "gap"})))).toBeUndefined();
  expect(reviewNarrativeDensity({originalMessage: "最近情况如何"}, body, Array.from({length: 20}, (_, i) => ({ref: `sample.f${i}`, type: "fact"})))).toBeUndefined();
  expect(reviewNarrativeDensity({originalMessage: "最近情况如何"}, "关键差异{{sample.f1}}。", atoms)).toBeUndefined();
});
