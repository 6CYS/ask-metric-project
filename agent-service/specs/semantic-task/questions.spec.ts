import {describe, expect, it} from "vitest";
import type {FieldCandidate} from "../../src/business-context/types.js";
import {candidateIdentity, candidateOptionGroups, DISPLAYED_CANDIDATE_LIMIT, uniqueCandidates} from "../../src/semantic-task/candidateOptions.js";
import {prepareSemanticArguments} from "../../src/semantic-task/protocol.js";
import {mergeAnswers, newOpaquePublicId, normalizeAnswerForQuestion, normalizeAnswerInput, publishQuestionSnapshot,
  sameAnswerChoiceForQuestion, sameQuestionBusinessBasis, validateAnswer} from "../../src/semantic-task/questions.js";
import type {AnswerChoice, ClickAnswerInput, PendingQuestion, QuestionBusinessBasis, QuestionField,
  QuestionSnapshotDraft} from "../../src/semantic-task/questions.js";

const candidate = (code: string, rawValueIndex = 0, metadata: Record<string, unknown> = {}, preferred = false): FieldCandidate =>
  ({code, value: `名称-${code}`, ...(preferred ? {preferred: true} : {}), metadata: {rawValueIndex, ...metadata}});
const scope = (field: QuestionField = "organizations") => ({task_ref: "task_1", target_ref: "target_1", field, item_ref: "item_1"});
const options = [{option_id: "opt_1", no: 1, label: "机构甲"}, {option_id: "opt_2", no: 2, label: "机构乙"},
  {option_id: "opt_3", no: 3, label: "机构丙"}];
function question(field: QuestionField = "organizations", selectionMode: "single" | "multiple" = "single"): PendingQuestion {
  return {question_id: "q_1", version: 1, scope: scope(field), prompt: "请选择", selection_mode: selectionMode,
    options: structuredClone(options), status: "open", issued_operation_id: "op_issue", kind: "choice"};
}
const confirmQuestion = (): PendingQuestion => ({...question(), kind: "confirm", confirmation_option_id: "opt_2"});
const click = (choice: AnswerChoice, version = 1): ClickAnswerInput => ({question_id: "q_1", version, choice});
const clickSource = {channel: "click", operation_id: "op_answer"} as const;
const modelSource = {channel: "model", operation_id: "op_answer"} as const;
const select = (...optionIds: string[]): AnswerChoice => ({type: "select", option_ids: optionIds as [string, ...string[]]});
const modelAnswer = (choice: AnswerChoice = select("opt_1")) => ({question_id: "q_1", version: 1, choice, evidence: {excerpt: "选第一项"}});
const semanticRequest = (answers: unknown[]) => ({protocol_version: 2, intent: "query", answers,
  targets: [{source: {kind: "new"}, operations: []}]});

describe("待确认项候选唯一清单", () => {
  it("按 rawValueIndex 分组、组内去重并保持唯一首推置顶和组内连续编号", () => {
    const groups = candidateOptionGroups([candidate("O1"), candidate("O2", 0, {}, true), candidate("O1"),
      candidate("O3", 1), candidate("O1", 1)], "organizations");
    expect(groups).toHaveLength(2);
    expect(groups[0]!.options.map(option => [option.no, option.candidate.code])).toEqual([[1, "O2"], [2, "O1"]]);
    expect(groups[1]!.options.map(option => [option.no, option.candidate.code])).toEqual([[1, "O3"], [2, "O1"]]);
  });
  it("semanticSpan 区分相同数组位置上的不同真实片段", () => {
    const groups = candidateOptionGroups([candidate("M1", 0, {semanticSpan: "span-a"}),
      candidate("M2", 0, {semanticSpan: "span-b"})]);
    expect(groups.map(group => group.semanticSpan)).toEqual(["span-a", "span-b"]);
  });
  it("保留基础指标、正式口径和日历身份差异，只归并同身份副本", () => {
    const list = [
      candidate("M1:当日", 0, {kind: "base", source_metric_code: "M1"}),
      candidate("M1:月均", 0, {kind: "base", source_metric_code: "M1"}),
      candidate("M1:当日", 0, {kind: "formal", source_metric_code: "M1"}),
      candidate("M1:月均", 0, {kind: "formal", source_metric_code: "M1"}),
      candidate("T1", 0, {calendar: {start: "2025-01-01", end: "2025-12-31"}}),
      candidate("T1", 0, {calendar: {end: "2025-12-31", start: "2025-01-01"}}),
      candidate("T1", 0, {calendar: {start: "2024-01-01", end: "2024-12-31"}}),
    ];
    // 身份去重在完整目录上进行（uniqueCandidates），发布清单另按展示上限收敛（displayedCandidates）。
    const identities = uniqueCandidates(list).map(candidate => candidateIdentity(candidate));
    expect(identities.filter(identity => identity.startsWith("base:"))).toEqual(["base:M1"]);
    expect(identities.filter(identity => identity.startsWith("code:M1:"))).toEqual(["code:M1:当日", "code:M1:月均"]);
    expect(identities.filter(identity => identity.startsWith("code:T1:calendar:"))).toHaveLength(2);
    expect(candidateOptionGroups(list)[0]!.options).toHaveLength(DISPLAYED_CANDIDATE_LIMIT);
  });
});

describe("问题快照和业务依据", () => {
  const basis: QuestionBusinessBasis = {field: "organizations", kind: "choice", prompt: "请选择机构", selection_mode: "single",
    rawValue: "农商行", resolutionInput: {text: "农商行"}, catalog: {revision: 3}, permission: {codes: ["O1", "O2"]},
    options: [{key: "internal:O1", label: "同名机构", description: "上级：甲"}, {key: "internal:O2", label: "同名机构", description: "上级：乙"}]};
  const draft: QuestionSnapshotDraft = {version: 1, scope: scope(), prompt: basis.prompt, selection_mode: "single", kind: "choice",
    issued_operation_id: "op_issue", businessBasis: basis,
    options: basis.options.map((option, index) => ({...option, no: index + 1, binding: {code: `O${index + 1}`}}))};
  it("签发不透明公共 ID，冻结同名差异说明和私有绑定，不拼接内部编码", () => {
    let sequence = 0;
    const published = publishQuestionSnapshot(draft, kind => kind === "question" ? "q_public" : `opt_public_${++sequence}`);
    expect(published.question.options).toEqual([
      {option_id: "opt_public_1", no: 1, label: "同名机构", description: "上级：甲"},
      {option_id: "opt_public_2", no: 2, label: "同名机构", description: "上级：乙"},
    ]);
    expect(published.question.options.map(option => option.option_id)).not.toContain("internal:O1");
    expect(published.optionBindings.map(binding => binding.key)).toEqual(["internal:O1", "internal:O2"]);
    expect(newOpaquePublicId("option")).toMatch(/^opt_[0-9a-f-]{36}$/);
  });
  it("confirm 发布固定确认对象，指标多选问题拒绝发布", () => {
    let sequence = 0;
    const published = publishQuestionSnapshot({...draft, kind: "confirm", confirmation_key: "internal:O2",
      businessBasis: {...basis, kind: "confirm", confirmation_key: "internal:O2"}},
    kind => kind === "question" ? "q_confirm" : `opt_${++sequence}`);
    expect(published.question.kind).toBe("confirm");
    expect(published.question.confirmation_option_id).toBe("opt_2");
    expect(() => publishQuestionSnapshot({...draft, scope: scope("metrics"), selection_mode: "multiple"})).toThrow("ANSWER_SELECTION_INVALID");
  });
  it("业务依据比较忽略对象键序，但识别权限、候选顺序和确认对象变化", () => {
    expect(sameQuestionBusinessBasis(basis, {...basis, permission: {codes: ["O1", "O2"]}})).toBe(true);
    expect(sameQuestionBusinessBasis({...basis, catalog: {a: 1, b: 2}}, {...basis, catalog: {b: 2, a: 1}})).toBe(true);
    expect(sameQuestionBusinessBasis(basis, {...basis, permission: {codes: ["O1"]}})).toBe(false);
    expect(sameQuestionBusinessBasis(basis, {...basis, options: [...basis.options].reverse()})).toBe(false);
    expect(sameQuestionBusinessBasis({...basis, kind: "confirm", confirmation_key: "internal:O1"},
      {...basis, kind: "confirm", confirmation_key: "internal:O2"})).toBe(false);
  });
  it("旧式整字段布局和技术操作不触发逐题升版，本题原表达变化仍升版", () => {
    const {resolutionInput: _resolutionInput, catalog: _catalog, ...itemBasis} = basis;
    const legacy = {...itemBasis, resolutionInput: {rawValue: "整字段", pendingRawValues: [["甲", "乙"], "丙"], semanticOperations: "[]"},
      catalog: {candidate_count: 99}};
    expect(sameQuestionBusinessBasis(legacy, itemBasis)).toBe(true);
    expect(sameQuestionBusinessBasis(legacy, {...itemBasis, rawValue: "另一家机构"})).toBe(false);
  });
});

describe("按冻结问题校验回答", () => {
  it("choice 拒绝 accept/reject，confirm 接受固定提案并允许拒绝", () => {
    expect(() => normalizeAnswerForQuestion(click({type: "accept"}), question(), clickSource)).toThrow("ANSWER_SELECTION_INVALID");
    expect(() => normalizeAnswerForQuestion(click({type: "reject"}), question(), clickSource)).toThrow("ANSWER_SELECTION_INVALID");
    const answer = normalizeAnswerForQuestion(click({type: "accept"}), confirmQuestion(), clickSource);
    expect(answer.choice).toEqual({type: "accept"});
    expect(normalizeAnswerForQuestion(click({type: "reject"}), confirmQuestion(), clickSource).choice).toEqual({type: "reject"});
  });
  it("仅来源确认把恰好选择固定对象归为 accept，普通候选和其他选项保持真实 select", () => {
    const fixed = confirmQuestion();
    expect(normalizeAnswerForQuestion(click(select("opt_2")), fixed, clickSource, "source_confirmation").choice).toEqual({type: "accept"});
    expect(normalizeAnswerForQuestion(click(select("opt_2")), fixed, clickSource, "candidate_choice").choice).toEqual(select("opt_2"));
    expect(normalizeAnswerForQuestion(click(select("opt_1")), fixed, clickSource, "source_confirmation").choice).toEqual(select("opt_1"));
    expect(sameAnswerChoiceForQuestion(fixed, "source_confirmation", select("opt_2"), {type: "accept"})).toBe(true);
    expect(sameAnswerChoiceForQuestion(fixed, "source_confirmation", select("opt_1"), {type: "accept"})).toBe(false);
  });
  it("single 只能一项，机构 multiple 保留多选并按发布顺序规范化", () => {
    expect(() => normalizeAnswerForQuestion(click(select("opt_1", "opt_2")), question(), clickSource)).toThrow("ANSWER_SELECTION_INVALID");
    const answer = normalizeAnswerForQuestion(click(select("opt_3", "opt_1")), question("organizations", "multiple"), clickSource);
    expect(answer.choice).toEqual(select("opt_1", "opt_3"));
    const comparison = normalizeAnswerForQuestion(click(select("opt_2", "opt_1")), question("comparison_organizations", "multiple"), clickSource);
    expect(comparison.choice).toEqual(select("opt_1", "opt_2"));
  });
  it("指标只能一个，即使伪造题面为 multiple 也不能提交多选", () => {
    expect(() => normalizeAnswerForQuestion(click(select("opt_1", "opt_2")), question("metrics", "multiple"), clickSource))
      .toThrow("ANSWER_SELECTION_INVALID");
  });
  it("拒绝重复选项、清单外选项、非法版本和过期版本", () => {
    expect(() => normalizeAnswerForQuestion(click(select("opt_1", "opt_1")), question(), clickSource)).toThrow("ANSWER_INPUT_SHAPE_INVALID");
    expect(() => normalizeAnswerForQuestion(click(select("opt_unknown")), question(), clickSource)).toThrow("ANSWER_OPTION_INVALID");
    expect(() => normalizeAnswerForQuestion(click(select("opt_1"), 0), question(), clickSource)).toThrow("ANSWER_INPUT_SHAPE_INVALID");
    expect(() => normalizeAnswerForQuestion(click(select("opt_1"), 2), question(), clickSource)).toThrow("QUESTION_SUPERSEDED");
    expect(() => validateAnswer({...question(), status: "answered"}, click(select("opt_1")))).toThrow("QUESTION_SUPERSEDED");
  });
  it("同题相同选择归并，版本或选择矛盾拒绝", () => {
    const first = normalizeAnswerInput(click(select("opt_2", "opt_1")), clickSource);
    const reordered = normalizeAnswerInput(click(select("opt_1", "opt_2")), clickSource);
    expect(mergeAnswers([first, reordered])).toHaveLength(1);
    expect(() => mergeAnswers([first, normalizeAnswerInput(click(select("opt_1")), clickSource)])).toThrow("ANSWER_OPERATION_CONFLICT");
    expect(() => mergeAnswers([first, normalizeAnswerInput(click(select("opt_2", "opt_1"), 2), clickSource)])).toThrow("ANSWER_OPERATION_CONFLICT");
  });
});

describe("模型 Answer Schema 和宿主来源绑定", () => {
  it("接受合法模型回答并把 excerpt 绑定到宿主 model 来源", () => {
    const raw = modelAnswer();
    expect(() => prepareSemanticArguments(semanticRequest([raw]))).not.toThrow();
    const answer = normalizeAnswerInput(raw, modelSource);
    expect(answer.source).toEqual({channel: "model", operation_id: "op_answer", excerpt: "选第一项"});
  });
  it("拒绝伪造 click、编码、内部绑定及新增对象未知字段", () => {
    const raw = modelAnswer();
    for (const extra of [{source: {channel: "click"}}, {channel: "click"}, {code: "O1"}, {binding: {rawValueIndex: 0}}]) {
      expect(() => prepareSemanticArguments(semanticRequest([{...raw, ...extra}]))).toThrow("SEMANTIC_INPUT_SHAPE_INVALID");
      expect(() => normalizeAnswerInput({...raw, ...extra}, modelSource)).toThrow("ANSWER_INPUT_SHAPE_INVALID");
    }
    expect(() => prepareSemanticArguments(semanticRequest([{...raw, choice: {...raw.choice, code: "O1"}}]))).toThrow("SEMANTIC_INPUT_SHAPE_INVALID");
    expect(() => prepareSemanticArguments(semanticRequest([{...raw, evidence: {...raw.evidence, channel: "click"}}]))).toThrow("SEMANTIC_INPUT_SHAPE_INVALID");
    expect(() => normalizeAnswerInput(raw, clickSource)).toThrow("ANSWER_INPUT_SHAPE_INVALID");
  });
  it("Schema 拒绝非法版本、空或重复选项及超过 100 项", () => {
    for (const version of [0, -1, 1.5, "1"]) {
      expect(() => prepareSemanticArguments(semanticRequest([{...modelAnswer(), version}]))).toThrow("SEMANTIC_INPUT_SHAPE_INVALID");
    }
    for (const optionIds of [[], ["opt_1", "opt_1"], Array.from({length: 101}, (_, index) => `opt_${index}`)]) {
      expect(() => prepareSemanticArguments(semanticRequest([modelAnswer(select(...optionIds))]))).toThrow("SEMANTIC_INPUT_SHAPE_INVALID");
    }
    expect(() => prepareSemanticArguments(semanticRequest([modelAnswer(select(...Array.from({length: 100}, (_, index) => `opt_${index}`)))]))).not.toThrow();
  });
  it("excerpt 非空且最多 4000 字符，一轮最多 20 条回答", () => {
    for (const excerpt of ["", "x".repeat(4001)]) {
      expect(() => prepareSemanticArguments(semanticRequest([{...modelAnswer(), evidence: {excerpt}}]))).toThrow("SEMANTIC_INPUT_SHAPE_INVALID");
      expect(() => normalizeAnswerInput({...modelAnswer(), evidence: {excerpt}}, modelSource)).toThrow("ANSWER_INPUT_SHAPE_INVALID");
    }
    expect(() => prepareSemanticArguments(semanticRequest([{...modelAnswer(), evidence: {excerpt: "x".repeat(4000)}}]))).not.toThrow();
    expect(() => prepareSemanticArguments(semanticRequest(Array.from({length: 20}, () => modelAnswer())))).not.toThrow();
    expect(() => prepareSemanticArguments(semanticRequest(Array.from({length: 21}, () => modelAnswer())))).toThrow("SEMANTIC_INPUT_SHAPE_INVALID");
  });
});
