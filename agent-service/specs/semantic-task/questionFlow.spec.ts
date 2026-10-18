import {afterEach, describe, expect, it, vi} from "vitest";
import {SemanticTaskService} from "../../src/semantic-task/service.js";
import {SemanticPlanService} from "../../src/semantic-task/planService.js";
import type {ClickAnswerInput, ModelAnswerInput, PendingQuestion} from "../../src/semantic-task/questions.js";
import {complete, fixture, proposal} from "./fixtures.js";
import {runTool} from "../../src/tools/testUtils.js";
import {createSemanticExecuteTool, createSemanticResolveTool} from "../../src/semantic-task/tools.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0)) await close(); vi.restoreAllMocks();});
async function setup() {const f = await fixture(); cleanup.push(f.close); return f;}
const metricPending = () => complete().map(operation => operation.field === "metrics" ? {...operation, value: "待定指标"} : operation);
const select = (question: PendingQuestion, ...optionIds: string[]): ClickAnswerInput => ({question_id: question.question_id,
  version: question.version, choice: {type: "select", option_ids: optionIds as [string, ...string[]]}});
const model = (question: PendingQuestion, optionId: string, excerpt: string): ModelAnswerInput => ({...select(question, optionId), evidence: {excerpt}});
const noneOfThese = (question: PendingQuestion, excerpt: string): ModelAnswerInput => ({question_id: question.question_id,
  version: question.version, choice: {type: "none_of_these"}, evidence: {excerpt}});
const publish = async () => true;

it("越界序号被模型误报为都不是时保留已发布候选，补答后按原题查询", async () => {
  const f = await setup(), resolve = f.backend.resolveBusinessField.getMockImplementation()!;
  const candidates = ["甲", "乙", "丙", "丁", "戊"].map((name, index) => ({code: `O${index + 1}`, value: `合成机构${name}`}));
  f.backend.resolveBusinessField.mockImplementation(async (entity, raw, ...args) => entity === "organization" && raw.includes("待定机构")
    ? {status: "needs_confirmation", candidates} : resolve(entity, raw, ...args));
  const firstRequest = f.request("ordinal-base", "查待定机构2025年末的合成指标甲");
  const first = await new SemanticPlanService(firstRequest).resolve(proposal(complete().map(operation =>
    operation.field === "organizations" ? {...operation, value: "待定机构"} : operation)));
  expect(first.status).toBe("needs_user");
  const question = first.pending_questions![0]!;
  expect(question.options).toHaveLength(4);
  const wrongRequest = f.request("ordinal-outside", "选第五个"); wrongRequest.questionPublicationProof = publish;
  const wrong = proposal([], {kind: "current"}); wrong.answers = [noneOfThese(question, "选第五个")];
  const declined = (await runTool(createSemanticResolveTool(), wrong, wrongRequest)).details as import("../../src/semantic-task/feedback.js").SemanticFeedback;
  expect(declined.status).toBe("needs_user");
  expect(declined.issues).toContainEqual(expect.objectContaining({code: "ANSWER_SELECTION_MISMATCH", remediation: "user"}));
  expect((await wrongRequest.semanticTasks!.question(question.question_id))!.question).toEqual(question);
  expect(f.backend.basicQueries).not.toHaveBeenCalled();

  const validRequest = f.request("ordinal-valid", "第二个"); validRequest.questionPublicationProof = publish;
  const valid = proposal([], {kind: "current"}); valid.answers = [model(question, question.options[1]!.option_id, "第二个")];
  const ready = await new SemanticPlanService(validRequest).resolve(valid);
  expect(ready.status, JSON.stringify(ready.issues)).toBe("ready");
  await runTool(createSemanticExecuteTool(), {task_ref: ready.state.task_ref, target_ref: ready.state.targets[0]!.target_ref}, validRequest);
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  expect(f.backend.basicQueries.mock.calls[0]![0]).toMatchObject({org_codes: ["O2"], metric_codes: ["M1"], time: {start: "2025-12-31", end: "2025-12-31"}});
});

describe("结构化字段问题真实应用链", () => {
  it("复用相同业务依据的 opaque 快照，发布证明后应用模型回答并幂等重放", async () => {
    const f = await setup(), initialRequest = f.request("initial", "查合成机构甲2025年末的待定指标");
    const service = new SemanticTaskService(initialRequest), input = proposal(metricPending());
    const first = await service.resolve(input), question = first.task!.questionSnapshots![0]!;
    expect(question.options.every(option => option.option_id.startsWith("opt_"))).toBe(true);
    const repeated = await service.resolve(input);
    expect(repeated.task!.questionSnapshots![0]).toMatchObject({question_id: question.question_id, version: 1,
      options: question.options.map(option => ({option_id: option.option_id}))});

    const request = f.request("answer", "用第二个");
    request.questionPublicationProof = publish;
    const answerInput = proposal([], {kind: "current"});
    answerInput.answers = [model(question, question.options[1]!.option_id, "用第二个")];
    const answered = await new SemanticTaskService(request).resolve(answerInput);
    expect(answered.status).toBe("ready");
    expect(answered.task!.target.fields.metrics!.resolvedValue).toMatchObject({codes: ["M2"]});
    expect(answered.task!.answerReceipts).toEqual([expect.objectContaining({question_id: question.question_id, outcome: "applied",
      selected_options: [expect.objectContaining({option_id: question.options[1]!.option_id})]})]);
    expect((await request.semanticTasks!.question(question.question_id))!.question.status).toBe("answered");

    const calls = f.backend.resolveBusinessField.mock.calls.length;
    const replayed = await new SemanticTaskService(request).resolve(answerInput);
    expect(replayed.task!.answerReceipts).toEqual(answered.task!.answerReceipts);
    expect(f.backend.resolveBusinessField.mock.calls).toHaveLength(calls);

    const crossRequest = f.request("cross", "用第二个");
    crossRequest.questionPublicationProof = publish;
    const cross = await new SemanticTaskService(crossRequest).resolve(answerInput);
    expect(cross.task!.answerReceipts).toEqual([expect.objectContaining({outcome: "already_applied", code: "ANSWER_ALREADY_APPLIED"})]);
    expect(f.backend.resolveBusinessField.mock.calls).toHaveLength(calls);
  });

  it("没有发布证明、同轮自确认、伪造 excerpt 和字段操作冲突均不应用", async () => {
    const f = await setup(), initialRequest = f.request("initial", "查合成机构甲2025年末的待定指标");
    const first = await new SemanticTaskService(initialRequest).resolve(proposal(metricPending()));
    const question = first.task!.questionSnapshots![0]!;
    const answerInput = proposal([], {kind: "current"});
    answerInput.answers = [model(question, question.options[0]!.option_id, "用第一个")];

    await expect(new SemanticTaskService(f.request("no-proof", "用第一个")).resolve(answerInput)).rejects.toThrow("QUESTION_NOT_PUBLISHED");
    initialRequest.questionPublicationProof = publish;
    const selfInput = proposal([], {kind: "current"});
    selfInput.answers = [model(question, question.options[0]!.option_id, "待定指标")];
    await expect(new SemanticTaskService(initialRequest).resolve(selfInput)).rejects.toThrow("QUESTION_NOT_PUBLISHED");

    const badExcerpt = f.request("bad-excerpt", "用第一个");
    badExcerpt.questionPublicationProof = publish;
    const badInput = proposal([], {kind: "current"});
    badInput.answers = [model(question, question.options[0]!.option_id, "第二个")];
    await expect(new SemanticTaskService(badExcerpt).resolve(badInput)).rejects.toThrow("ANSWER_EXCERPT_UNGROUNDED");

    const conflict = f.request("conflict", "用第一个");
    conflict.questionPublicationProof = publish;
    const conflictInput = proposal([{action: "set", field: "metrics", value: "合成指标甲"}], {kind: "current"});
    conflictInput.answers = [model(question, question.options[0]!.option_id, "用第一个")];
    await expect(new SemanticTaskService(conflict).resolve(conflictInput)).rejects.toThrow("ANSWER_OPERATION_CONFLICT");
    expect((await conflict.semanticTasks!.question(question.question_id))!.binding.receipts).toEqual([]);
  });

  it("派生任务已有发布问题时旧 confirm 只交 Pi 修正，不再进入旧口语选择器", async () => {
    const f = await setup();
    await new SemanticPlanService(f.request("initial", "查合成机构甲2025年末的待定指标")).resolve(proposal(metricPending()));
    const request = f.request("legacy-confirm", "就这个");
    request.questionPublicationProof = publish;
    const result = await new SemanticPlanService(request).resolve(proposal([{action: "confirm", field: "metrics", value: "合成指标乙"}], {kind: "current"}));
    expect(result.status).toBe("needs_interpretation");
    expect(result.issues.map(issue => issue.code)).toContain("ANSWER_REQUIRED");
    expect(result.issues.map(issue => issue.code)).not.toContain("CONFIRMATION_NOT_ESTABLISHED");
  });

  it("同题点击与模型冲突且模型摘录无依据时保留点击，不重复验证模型复述", async () => {
    const f = await setup();
    const first = await new SemanticTaskService(f.request("initial", "查合成机构甲2025年末的待定指标")).resolve(proposal(metricPending()));
    const question = first.task!.questionSnapshots![0]!;
    const request = f.request("click", "选第一项");
    request.questionPublicationProof = publish;
    request.trustedAnswers = [select(question, question.options[0]!.option_id)];
    const input = proposal([], {kind: "current"});
    input.answers = [model(question, question.options[1]!.option_id, "模型自行复述的点击")];
    const result = await new SemanticTaskService(request).resolve(input);
    expect(result.task!.target.fields.metrics!.resolvedValue).toMatchObject({codes: ["M1"]});
    const saved = await request.semanticTasks!.question(question.question_id);
    expect(saved!.binding.receipts[0]!.answer.source.channel).toBe("click");
    expect((await request.semanticTasks!.turn(request.operationId))!.discardedAnswers).toHaveLength(1);
  });

  it("同字段多个问题基于同一冻结快照分别回答，指标仍逐题单选", async () => {
    const f = await setup(), originalMatch = f.backend.matchMetricQuestion.getMockImplementation()!;
    f.backend.matchMetricQuestion.mockImplementation(async (question: string) => {
      if (!question.includes("待定指标和待定指标")) return originalMatch(question);
      const firstIndex = question.indexOf("待定指标"), secondIndex = question.indexOf("待定指标", firstIndex + 4);
      return {mentions: [firstIndex, secondIndex].map(start => ({text: "待定指标", start, end: start + 4,
        resolution: {status: "needs_confirmation" as const, candidates: [
          {code: "M1", value: "合成指标甲"}, {code: "M2", value: "合成指标乙"}, {code: "M3", value: "合成指标丙"},
        ]}}))};
    });
    const operations = complete().map(operation => operation.field === "metrics" ? {...operation, value: "待定指标和待定指标"} : operation);
    const first = await new SemanticTaskService(f.request("initial", "查合成机构甲2025年末的待定指标和待定指标")).resolve(proposal(operations));
    const questions = first.task!.questionSnapshots!;
    expect(questions).toHaveLength(2);
    expect(questions.every(question => question.selection_mode === "single")).toBe(true);

    const request = f.request("answers", "第一个选甲，第二个选乙");
    request.questionPublicationProof = publish;
    const input = proposal([], {kind: "current"});
    input.answers = [model(questions[0]!, questions[0]!.options[0]!.option_id, "第一个选甲"),
      model(questions[1]!, questions[1]!.options[1]!.option_id, "第二个选乙")];
    const result = await new SemanticTaskService(request).resolve(input);
    expect(result.task!.answerReceipts).toHaveLength(2);
    expect(result.task!.target.fields.metrics!.resolvedValue).toMatchObject({codes: ["M1", "M2"]});
  });

  it("基础指标选择已受理但仍缺口径时签发下一层问题而不给执行许可", async () => {
    const f = await setup(), originalResolve = f.backend.resolveBusinessField.getMockImplementation()!;
    const originalMatch = f.backend.matchMetricQuestion.getMockImplementation()!;
    f.backend.matchMetricQuestion.mockImplementation(async (source: string) => {
      if (!source.includes("待定指标")) return originalMatch(source);
      const start = source.indexOf("待定指标");
      return {mentions: [{text: "待定指标", start, end: start + 4, resolution: {status: "needs_confirmation" as const, candidates: [
        {code: "B1", value: "基础指标", metadata: {kind: "base", source_metric_code: "B1"}},
      ]}}]};
    });
    f.backend.resolveBusinessField.mockImplementation(async (entity, raw, options, year, source, modelValue) => {
      if (entity === "metric" && raw.includes("待定指标")) return {status: "needs_confirmation" as const, candidates: [
        {code: "B1", value: "基础指标", metadata: {kind: "base", source_metric_code: "B1"}},
      ]};
      if (entity === "metric" && raw.includes("B1")) return {status: "needs_confirmation" as const, candidates: [
        {code: "F1", value: "基础指标（当日）"}, {code: "F2", value: "基础指标（月均）"},
      ]};
      return originalResolve(entity, raw, options, year, source, modelValue);
    });
    const first = await new SemanticTaskService(f.request("initial", "查合成机构甲2025年末的待定指标")).resolve(proposal(metricPending()));
    const question = first.task!.questionSnapshots![0]!;
    const request = f.request("base", "选择基础指标");
    request.questionPublicationProof = publish;
    const input = proposal([], {kind: "current"});
    input.answers = [model(question, question.options[0]!.option_id, "选择基础指标")];
    const result = await new SemanticTaskService(request).resolve(input);
    expect(result.status).toBe("needs_user");
    expect(result.task!.permit).toBeUndefined();
    expect(result.task!.answerReceipts).toEqual([expect.objectContaining({outcome: "applied"})]);
    expect(result.task!.questionSnapshots).toHaveLength(1);
    expect(result.task!.questionSnapshots![0]!.options.map(option => option.label)).toEqual(["基础指标（当日）", "基础指标（月均）"]);
    expect((await request.semanticTasks!.question(question.question_id, question.version))!.question.status).toBe("answered");
  });
});

describe("计划层可信点击与机构来源", () => {
  it("纯点击保留原步骤和 intent，机构多选生成 host-only org_answers 且不向事实接口发送空串", async () => {
    const f = await setup(), originalResolve = f.backend.resolveBusinessField.getMockImplementation()!;
    f.backend.resolveBusinessField.mockImplementation(async (entity, raw, options, year, source, modelValue) => {
      if (entity === "organization" && raw.some(value => value.includes("待定机构"))) return {status: "needs_confirmation" as const, candidates: [
        {code: "O1", value: "合成机构甲", metadata: {rawValueIndex: 0}},
        {code: "O2", value: "合成机构乙", metadata: {rawValueIndex: 0}},
      ]};
      return originalResolve(entity, raw, options, year, source, modelValue);
    });
    const operations = complete().map(operation => operation.field === "organizations" ? {...operation, value: "待定机构"} : operation);
    const first = await new SemanticPlanService(f.request("initial", "查待定机构2025年末的合成指标甲")).resolve(proposal(operations));
    const question = first.pending_questions[0]!;
    expect(question.selection_mode).toBe("multiple");

    const request = f.request("click", "");
    request.questionPublicationProof = publish;
    request.trustedAnswers = [select(question, question.options[1]!.option_id, question.options[0]!.option_id)];
    const result = await new SemanticPlanService(request).resolve(proposal([], {kind: "current"}));
    expect(result.status).toBe("ready");
    expect(result.answer_receipts[0]).toMatchObject({outcome: "applied", selected_options: [
      {option_id: question.options[0]!.option_id}, {option_id: question.options[1]!.option_id},
    ]});
    expect(f.backend.inspectBusinessGoal.mock.calls.every(([question]) => typeof question === "string" && question.length > 0)).toBe(true);

    const repeatedRequest = f.request("repeat", "");
    repeatedRequest.questionPublicationProof = publish;
    repeatedRequest.trustedAnswers = request.trustedAnswers;
    const repeated = await new SemanticPlanService(repeatedRequest).resolve(proposal([], {kind: "current"}));
    expect(repeated.status).toBe("reused");
    expect(repeated.answer_receipts[0]).toMatchObject({outcome: "already_applied", code: "ANSWER_ALREADY_APPLIED"});

    const mixedRequest = f.request("mixed", "日期改成2024年末");
    mixedRequest.questionPublicationProof = publish;
    mixedRequest.trustedAnswers = request.trustedAnswers;
    await expect(new SemanticPlanService(mixedRequest).resolve(proposal([{action: "set", field: "time", value: "2024年末"}], {kind: "current"})))
      .rejects.toThrow("ANSWER_OPERATION_CONFLICT");
  });

  // 绑定层在采纳 suggestion/model_inferred 机构结论时首发 source_confirmation 来源确认题；
  // continueSourceConstraints/prepareSourceAnswers 承接续发与应答。
  it("已 resolved 机构建议签发来源确认题，accept 只补来源且完整机构集合保留", async () => {
    const f = await setup();
    const suggested = vi.fn(async (_entity: string, _suggestions: unknown, _options: unknown, _source: string, raw: string[]) => ({
      status: "resolved" as const, value: {codes: ["O1", "O2"], names: ["合成机构甲", "合成机构乙"]},
      metadata: {resolution_source: "model_inferred", source_codes: ["O1", "O2"], extractedRawValues: raw, hint_source_bound: true},
    }));
    Object.assign(f.backend, {resolveBusinessFieldSuggestion: suggested});
    const operations = complete().map(operation => operation.field === "organizations" ? {...operation,
      value: "合成机构甲、合成机构乙", suggestion: {name: "合成机构甲", excerpt: "合成机构甲"}} : operation);
    const first = await new SemanticPlanService(f.request("initial-source", "查合成机构甲、合成机构乙2025年末的合成指标甲")).resolve(proposal(operations));
    expect(first.status, JSON.stringify({issues: first.issues, pending: first.pending_questions})).toBe("needs_user");
    const question = first.pending_questions.find(item => item.kind === "confirm")!;
    expect(question.options[0]!.label).toBe("合成机构甲、合成机构乙");

    const request = f.request("accept-source", "是");
    request.questionPublicationProof = publish;
    const input = proposal([], {kind: "current"});
    input.answers = [{question_id: question.question_id, version: question.version, choice: {type: "accept"}, evidence: {excerpt: "是"}}];
    const result = await new SemanticPlanService(request).resolve(input);
    expect(result.status, JSON.stringify(result.issues)).toBe("ready");
    expect(result.answer_receipts).toEqual([expect.objectContaining({question_id: question.question_id, outcome: "applied"})]);
    const plan = await request.semanticTasks!.plan(result.state.task_ref!);
    const task = await request.semanticTasks!.get(plan!.steps[0]!.taskRef!);
    expect(task!.target.fields.organizations!.resolvedValue).toMatchObject({codes: ["O1", "O2"]});
  });
});

describe("八类问题修复回归", () => {
  it("跨组文字与点击保留剩余候选和旧题身份，并按冻结布局换算压平位置", async () => {
    const f = await setup(), originalResolve = f.backend.resolveBusinessField.getMockImplementation()!;
    const names: Record<string, string> = {O1: "合成机构甲", O2: "合成机构乙", O3: "合成机构丙"};
    f.backend.resolveBusinessField.mockImplementation((async (entity: string, raw: string[], options?: unknown, year?: number,
      source?: {source_question: string}, modelValue?: {start: string; end: string; dates?: string[]}) => {
      if (entity === "organization") {
        if (raw.length && raw.every(value => /^O[123]$/u.test(value))) return {status: "resolved" as const,
          value: {codes: raw, names: raw.map(value => names[value]!)}, metadata: {source_codes: raw}};
        if (raw.some(value => value.includes("待定机构"))) {
          const answeredFirst = raw.some(value => value === "O1" || value === "O2");
          return {status: "needs_confirmation" as const, candidates: [
            ...(!answeredFirst ? [
              {code: "O1", value: "合成机构甲", preferred: true, metadata: {rawValueIndex: 0}},
              {code: "O2", value: "合成机构乙", metadata: {rawValueIndex: 0}},
            ] : []),
            {code: "O3", value: "合成机构丙", metadata: {rawValueIndex: answeredFirst ? 2 : 1}},
          ], metadata: {pendingRawValues: answeredFirst ? ["O1", "O2", "待定机构乙"]
            : [["待定机构甲", "机构甲别名"], "待定机构乙"]}};
        }
      }
      return originalResolve(entity, raw, options, year, source, modelValue);
    }) as unknown as typeof originalResolve);
    const operations = complete().map(operation => operation.field === "organizations"
      ? {...operation, value: "待定机构甲、待定机构乙"} : operation);
    const first = await new SemanticPlanService(f.request("groups-initial", "查待定机构甲、待定机构乙2025年末的合成指标甲")).resolve(proposal(operations));
    expect(first.pending_questions).toHaveLength(2);
    const [firstQuestion, secondQuestion] = first.pending_questions;
    expect(firstQuestion!.selection_mode).toBe("multiple");
    expect(firstQuestion!.kind).toBe("confirm");

    const firstAnswer = f.request("groups-first", "第一组选甲和乙");
    firstAnswer.questionPublicationProof = publish;
    const firstInput = proposal([], {kind: "current"});
    firstInput.answers = [{...select(firstQuestion!, ...firstQuestion!.options.map(option => option.option_id)), evidence: {excerpt: "第一组选甲和乙"}}];
    const partial = await new SemanticPlanService(firstAnswer).resolve(firstInput);
    expect(partial.status, JSON.stringify(partial.issues)).toBe("needs_user");
    expect(partial.pending_questions).toHaveLength(1);
    expect(partial.pending_questions[0]).toMatchObject({question_id: secondQuestion!.question_id, version: secondQuestion!.version,
      options: secondQuestion!.options.map(option => ({option_id: option.option_id}))});
    const partialPlan = await firstAnswer.semanticTasks!.plan(partial.state.task_ref!);
    const partialTask = await firstAnswer.semanticTasks!.get(partialPlan!.steps[0]!.taskRef!);
    expect(partialTask!.target.fields.organizations!.candidates?.map(candidate => candidate.code)).toEqual(["O3"]);
    expect(f.backend.basicQueries).not.toHaveBeenCalled();

    const secondAnswer = f.request("groups-second", "");
    secondAnswer.questionPublicationProof = publish;
    secondAnswer.trustedAnswers = [select(secondQuestion!, secondQuestion!.options[0]!.option_id)];
    const completed = await new SemanticPlanService(secondAnswer).resolve(proposal([], {kind: "current"}));
    expect(completed.status, JSON.stringify(completed.issues)).toBe("ready");
    const plan = await secondAnswer.semanticTasks!.plan(completed.state.task_ref!);
    const task = await secondAnswer.semanticTasks!.get(plan!.steps[0]!.taskRef!);
    expect(task!.target.fields.organizations!.resolvedValue).toMatchObject({codes: ["O1", "O2", "O3"]});
    expect(f.backend.basicQueries).not.toHaveBeenCalled();
    const executed = await runTool(createSemanticExecuteTool(), {task_ref: plan!.ref, target_ref: plan!.steps[0]!.targetRef}, secondAnswer);
    expect(executed.details.status).toBe("succeeded");
    expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
    const replayRequest = f.request("groups-second-replay", "");
    replayRequest.questionPublicationProof = publish;
    replayRequest.trustedAnswers = secondAnswer.trustedAnswers;
    const replay = await new SemanticPlanService(replayRequest).resolve(proposal([], {kind: "current"}));
    expect(replay.status).toBe("reused");
    expect(f.backend.basicQueries).toHaveBeenCalledTimes(1);
  });

  it("not_applied 后同 operation 可重试，终结后重放不重复应用且改选仍冲突", async () => {
    const f = await setup();
    const initial = await new SemanticTaskService(f.request("retry-initial", "查合成机构甲2025年末的待定指标")).resolve(proposal(metricPending()));
    const question = initial.task!.questionSnapshots![0]!;
    const originalResolve = f.backend.resolveBusinessField.getMockImplementation()!;
    let failOnce = true;
    f.backend.resolveBusinessField.mockImplementation(async (entity, raw, options, year, source, modelValue) => {
      if (entity === "metric" && raw.includes("M1") && failOnce) {
        failOnce = false;
        return {status: "temporary_error" as const};
      }
      return originalResolve(entity, raw, options, year, source, modelValue);
    });
    const request = f.request("retry-answer", "用第一个");
    request.questionPublicationProof = publish;
    const input = proposal([], {kind: "current"});
    input.answers = [model(question, question.options[0]!.option_id, "用第一个")];
    const failed = await new SemanticTaskService(request).resolve(input);
    expect(failed.task!.answerReceipts).toEqual([expect.objectContaining({outcome: "not_applied"})]);
    const recovered = await new SemanticTaskService(request).resolve(input);
    expect(recovered.status, JSON.stringify(recovered.task!.issues)).toBe("ready");
    expect(recovered.task!.answerReceipts).toEqual([expect.objectContaining({outcome: "applied"})]);
    const calls = f.backend.resolveBusinessField.mock.calls.length;
    const replayed = await new SemanticTaskService(request).resolve(input);
    expect(replayed.task!.answerReceipts).toEqual(recovered.task!.answerReceipts);
    expect(f.backend.resolveBusinessField.mock.calls).toHaveLength(calls);
    const saved = await request.semanticTasks!.question(question.question_id, question.version);
    expect(saved!.binding.receipts.filter(receipt => receipt.outcome === "applied")).toHaveLength(1);
    const changed = proposal([], {kind: "current"});
    changed.answers = [model(question, question.options[1]!.option_id, "用第一个")];
    await expect(new SemanticTaskService(request).resolve(changed)).rejects.toThrow("ANSWER_OPERATION_CONFLICT");
  });

  it("固定来源选项与 accept 跨请求等价，完整集合只应用一次", async () => {
    const {f, question} = await sourceConfirmationCase("fixed-select-initial");
    const request = f.request("fixed-select", "");
    request.questionPublicationProof = publish;
    request.trustedAnswers = [select(question, question.options[0]!.option_id)];
    const result = await new SemanticPlanService(request).resolve(proposal([], {kind: "current"}));
    expect(result.status, JSON.stringify(result.issues)).toBe("ready");
    expect(result.answer_receipts).toEqual([expect.objectContaining({outcome: "applied"})]);
    const plan = await request.semanticTasks!.plan(result.state.task_ref!);
    const task = await request.semanticTasks!.get(plan!.steps[0]!.taskRef!);
    expect(task!.target.fields.organizations!.resolvedValue).toMatchObject({codes: ["O1", "O2"]});

    const cross = f.request("fixed-accept-cross", "是");
    cross.questionPublicationProof = publish;
    const input = proposal([], {kind: "current"});
    input.answers = [{question_id: question.question_id, version: question.version, choice: {type: "accept"}, evidence: {excerpt: "是"}}];
    const replay = await new SemanticPlanService(cross).resolve(input);
    expect(replay.status).toBe("reused");
    expect(replay.answer_receipts).toEqual([expect.objectContaining({outcome: "already_applied", code: "ANSWER_ALREADY_APPLIED"})]);
  });

  it("拒绝旧建议持续约束无新表达，明确新机构后不再回跳旧拒绝", async () => {
    const {f, question} = await sourceConfirmationCase("reject-source-initial");
    const rejectRequest = f.request("reject-source", "不是这个建议");
    rejectRequest.questionPublicationProof = publish;
    const rejectInput = proposal([], {kind: "current"});
    rejectInput.answers = [{question_id: question.question_id, version: question.version, choice: {type: "reject"}, evidence: {excerpt: "不是"}}];
    const rejected = await new SemanticPlanService(rejectRequest).resolve(rejectInput);
    expect(rejected.status).toBe("needs_user");
    expect(rejected.answer_receipts).toEqual([expect.objectContaining({outcome: "declined"})]);
    expect((await rejectRequest.semanticTasks!.question(question.question_id, question.version))!.question.status).toBe("rejected");

    for (const [id, message, value] of [["reject-date-one", "日期改成2024年末", "2024年末"], ["reject-date-two", "日期改成2025年末", "2025年末"]] as const) {
      const request = f.request(id, message);
      const result = await new SemanticPlanService(request).resolve(proposal([{action: "set", field: "time", value}], {kind: "current"}));
      expect(result.status, JSON.stringify(result.issues)).toBe("needs_user");
      expect(result.issues.map(issue => issue.code)).toContain("SOURCE_CONFIRMATION_REQUIRED");
      const projected = await request.semanticTasks!.admissionContext(request.operationId);
      const organizations = projected?.targets[0]?.conditions.organizations as {confirmed?: unknown; expression?: string} | undefined;
      expect(organizations?.confirmed).toBeUndefined();
      expect(organizations?.expression).toContain("合成机构");
    }

    const replacement = f.request("replace-source", "改成合成机构甲");
    const replaced = await new SemanticPlanService(replacement).resolve(proposal([{action: "set", field: "organizations", value: "合成机构甲"}], {kind: "current"}));
    expect(replaced.status, JSON.stringify(replaced.issues)).toBe("ready");
    expect(replaced.issues.map(issue => issue.code)).not.toContain("SOURCE_CONFIRMATION_REQUIRED");
    expect((await replacement.semanticTasks!.question(question.question_id, question.version))!.question.status).toBe("rejected");
    const plan = await replacement.semanticTasks!.plan(replaced.state.task_ref!);
    const task = await replacement.semanticTasks!.get(plan!.steps[0]!.taskRef!);
    expect(task!.target.fields.organizations!.resolvedValue).toMatchObject({codes: ["O1"]});

    const later = f.request("replace-source-date", "日期改成2024年末");
    const continued = await new SemanticPlanService(later).resolve(proposal([{action: "set", field: "time", value: "2024年末"}], {kind: "current"}));
    expect(continued.status, JSON.stringify(continued.issues)).toBe("ready");
    expect(continued.issues.map(issue => issue.code)).not.toContain("SOURCE_CONFIRMATION_REQUIRED");
    expect(f.backend.basicQueries).not.toHaveBeenCalled();
  });

  it("拒绝旧候选并改填新机构时保留新条件，整批准入二次受理不清空已解析机构", async () => {
    const f = await setup(), original = f.backend.resolveBusinessField.getMockImplementation()!;
    f.backend.resolveBusinessField.mockImplementation(async (entity: string, raw: string[], ...rest: unknown[]) => {
      if (entity === "organization" && raw.includes("模糊机构")) return {status: "needs_confirmation",
        candidates: [{code: "O1", value: "合成机构甲"}, {code: "O2", value: "合成机构乙"}],
        metadata: {issues: [{rawValue: "模糊机构", rawValueIndex: 0, reason: "ambiguous"}], pendingRawValues: ["模糊机构"]}} as never;
      return original(entity, raw, ...rest as []);
    });
    const first = await new SemanticTaskService(f.request("initial", "查模糊机构2025年末的合成指标甲")).resolve(proposal([
      {action: "set", field: "organizations", value: "模糊机构"},
      {action: "set", field: "metrics", value: "合成指标甲"},
      {action: "set", field: "time", value: "2025年末"},
    ]));
    expect(first.status).toBe("needs_user");
    const question = first.task!.questionSnapshots![0]!;
    expect(question.scope.field).toBe("organizations");

    const request = f.request("redirect", "都不是，改成合成机构乙，其他条件不变。");
    request.questionPublicationProof = publish;
    const answerInput = proposal([{action: "set", field: "organizations", value: "合成机构乙"}], {kind: "current"});
    answerInput.answers = [noneOfThese(question, "都不是，改成合成机构乙")];
    const redirect = await new SemanticTaskService(request).resolve(answerInput);
    expect(redirect.status, JSON.stringify(redirect.issues)).toBe("ready");
    expect(redirect.task!.target.fields.organizations!.resolvedValue).toMatchObject({codes: ["O2"]});

    // 同轮整批准入回执会以相同 operationId、空operations 再次受理：reject/none_of_these
    // 不能进入字段集合，否则已解析的机构会被空操作覆盖成原缺项。
    const receipt = await new SemanticTaskService(request).resolve(proposal([], {kind: "current"}));
    expect(receipt.status, JSON.stringify(receipt.issues)).toBe("ready");
    expect(receipt.task!.target.fields.organizations!.resolvedValue).toMatchObject({codes: ["O2"]});
    expect((receipt.issues ?? []).map(issue => issue.code)).not.toContain("PROPOSAL_FIELD_OMITTED");
  });
  it("模型预纠错字时按后端回记的原文槽位重新解析并保留纠正留痕", async () => {
    const f = await setup(), original = f.backend.resolveBusinessField.getMockImplementation()!;
    f.backend.resolveBusinessField.mockImplementation(async (entity: string, raw: string[], ...rest: unknown[]) => {
      if (entity === "organization" && JSON.stringify(raw) === JSON.stringify(["启动"])) return {status: "resolved",
        value: {codes: ["O2"], names: ["合成机构乙"]},
        metadata: {resolution_source: "corrected", source_codes: ["O2"],
          corrections: [{raw: "启动", corrected_name: "合成机构乙", corrected_code: "O2"}]}} as never;
      return original(entity, raw, ...rest as []);
    });
    const suggestion = vi.fn(async () => ({status: "resolved" as const,
      value: {codes: ["O2"], names: ["合成机构乙"]},
      metadata: {resolution_source: "corrected", source_codes: ["O2"], hint_source_bound: true,
        extractedRawValues: ["启动"], rawExcerpt: "启动",
        corrections: [{raw: "启动", corrected_name: "合成机构乙", corrected_code: "O2"}]}}));
    Object.assign(f.backend, {resolveBusinessFieldSuggestion: suggestion});
    const origin = await new SemanticTaskService(f.request("typo-origin", "查合成机构甲2025年末的合成指标甲")).resolve(proposal(complete()));
    expect(origin.status).toBe("ready");
    const request = f.request("typo-slot", "只看启动");
    const result = await new SemanticTaskService(request).resolve(proposal([
      {action: "set", field: "organizations", value: "启东", suggestion: {name: "合成机构乙", excerpt: "启东"}}], {kind: "current"}));
    expect(result.status, JSON.stringify(result.issues)).toBe("ready");
    expect(result.task!.target.fields.organizations!.resolvedValue).toMatchObject({codes: ["O2"]});
    // 解析、纠正留痕和准入共用回记的原文槽位“启动”，而不是模型的预纠结果。
    expect(f.backend.resolveBusinessField.mock.calls.some(call => JSON.stringify(call[1]) === JSON.stringify(["启动"]))).toBe(true);
    expect(result.task!.target.fields.organizations!.metadata?.corrections).toEqual([
      {raw: "启动", corrected_name: "合成机构乙", corrected_code: "O2"}]);
  });
  it("无suggestion的预纠机构值同样回记原文槽位重新解析", async () => {
    const f = await setup(), original = f.backend.resolveBusinessField.getMockImplementation()!;
    f.backend.resolveBusinessField.mockImplementation(async (entity: string, raw: string[], ...rest: unknown[]) => {
      if (entity === "organization" && JSON.stringify(raw) === JSON.stringify(["启动"])) return {status: "resolved",
        value: {codes: ["O2"], names: ["合成机构乙"]},
        metadata: {resolution_source: "corrected", source_codes: ["O2"],
          corrections: [{raw: "启动", corrected_name: "合成机构乙", corrected_code: "O2"}]}} as never;
      if (entity === "organization" && JSON.stringify(raw) === JSON.stringify(["启东"])) return {status: "resolved",
        value: {codes: ["O2"], names: ["合成机构乙"]},
        metadata: {resolution_source: "corrected", source_codes: ["O2"], hint_source_bound: true,
          extractedRawValues: ["启动"], rawExcerpt: "启动",
          corrections: [{raw: "启动", corrected_name: "合成机构乙", corrected_code: "O2"}]}} as never;
      return original(entity, raw, ...rest as []);
    });
    const origin = await new SemanticTaskService(f.request("typo-plain-origin", "查合成机构甲2025年末的合成指标甲")).resolve(proposal(complete()));
    expect(origin.status).toBe("ready");
    const result = await new SemanticTaskService(f.request("typo-plain", "只看启动")).resolve(proposal([
      {action: "set", field: "organizations", value: "启东"}], {kind: "current"}));
    expect(result.status, JSON.stringify(result.task!.issues)).toBe("ready");
    expect(result.task!.target.fields.organizations!.resolvedValue).toMatchObject({codes: ["O2"]});
    expect(result.task!.target.fields.organizations!.rawValue).toBe("启动");
  });
  it("同一基础指标按本轮明确口径切换，不要求完整指标名再次出现在原句", async () => {
    const f = await setup(), original = f.backend.resolveBusinessField.getMockImplementation()!;
    f.backend.resolveBusinessField.mockImplementation(async (entity: string, raw: string[], ...rest: unknown[]) => {
      if (entity === "metric" && raw.includes("合成指标甲较上月")) return {status: "resolved",
        value: {codes: ["M4"], names: ["合成指标甲较上月"]},
        metadata: {metrics: [{code: "M4", name: "合成指标甲较上月", base_name: "合成指标甲", value_basis: "较上月"}]}} as never;
      if (entity === "metric" && (raw.includes("合成指标甲") || raw.includes("M1"))) return {status: "resolved",
        value: {codes: ["M1"], names: ["合成指标甲"]},
        metadata: {metrics: [{code: "M1", name: "合成指标甲", base_name: "合成指标甲", value_basis: "当日数"}]}} as never;
      return original(entity, raw, ...rest as []);
    });
    const origin = await new SemanticTaskService(f.request("basis-origin", "查合成机构甲2025年末的合成指标甲")).resolve(proposal(complete()));
    expect(origin.status).toBe("ready");
    const result = await new SemanticTaskService(f.request("basis-change", "改成较上月，其他条件不变。")).resolve(proposal([
      {action: "set", field: "metrics", value: "合成指标甲较上月"}], {kind: "current"}));
    expect(result.status, JSON.stringify(result.issues)).toBe("ready");
    expect(result.task!.target.fields.metrics!.resolvedValue).toMatchObject({codes: ["M4"]});
    expect(result.task!.target.fields.time!.resolvedValue).toMatchObject({start: "2025-12-31", end: "2025-12-31"});
  });
  it("模型把口径词写进time时按目录口径处理并保留原日期", async () => {
    const f = await setup(), original = f.backend.resolveBusinessField.getMockImplementation()!;
    f.backend.resolveBusinessField.mockImplementation(async (entity: string, raw: string[], ...rest: unknown[]) => {
      if (entity === "date" && raw[0] === "较上月") return {status: "invalid", metadata: {reason: "unsupported_expression"}} as never;
      if (entity === "metric" && raw.includes("合成指标甲较上月")) return {status: "resolved",
        value: {codes: ["M4"], names: ["合成指标甲较上月"]},
        metadata: {metrics: [{code: "M4", name: "合成指标甲较上月", base_name: "合成指标甲", value_basis: "较上月"}]}} as never;
      if (entity === "metric" && (raw.includes("合成指标甲") || raw.includes("M1"))) return {status: "resolved",
        value: {codes: ["M1"], names: ["合成指标甲"]},
        metadata: {metrics: [{code: "M1", name: "合成指标甲", base_name: "合成指标甲", value_basis: "当日数"}]}} as never;
      return original(entity, raw, ...rest as []);
    });
    Object.assign(f.backend, {searchMetrics: vi.fn(async (keyword: string) => ({total: keyword === "合成指标甲较上月" ? 1 : 0,
      items: keyword === "合成指标甲较上月" ? [{metric_code: "M4", metric_name: "合成指标甲较上月", score: 1, match_type: "exact" as const}] : [],
      semantic_suggestions: []}))});
    const origin = await new SemanticTaskService(f.request("basis-time-origin", "查合成机构甲2025年末的合成指标甲")).resolve(proposal(complete()));
    expect(origin.status).toBe("ready");
    const result = await new SemanticTaskService(f.request("basis-time", "改成较上月，其他条件不变。")).resolve(proposal([
      {action: "set", field: "time", value: "较上月", modelCalendar: {start: "2025-11-01", end: "2025-11-30"}}], {kind: "current"}));
    expect(result.status, JSON.stringify(result.task!.issues)).toBe("ready");
    expect(result.task!.target.fields.metrics!.resolvedValue).toMatchObject({codes: ["M4"]});
    // 默认口径不改变查询日期：仍是原 2025-12-31，而不是“上月”范围。
    expect(result.task!.target.fields.time!.resolvedValue).toMatchObject({start: "2025-12-31", end: "2025-12-31"});
  });
  it("口径词被误当日期时不改日期，要求只切换指标口径", async () => {
    const f = await setup(), original = f.backend.resolveBusinessField.getMockImplementation()!;
    f.backend.resolveBusinessField.mockImplementation(async (entity: string, raw: string[], ...rest: unknown[]) => {
      if (entity === "metric" && raw.includes("合成指标甲较上月")) return {status: "resolved",
        value: {codes: ["M4"], names: ["合成指标甲较上月"]},
        metadata: {metrics: [{code: "M4", name: "合成指标甲较上月", base_name: "合成指标甲", value_basis: "较上月"}]}} as never;
      if (entity === "metric" && (raw.includes("合成指标甲") || raw.includes("M1"))) return {status: "resolved",
        value: {codes: ["M1"], names: ["合成指标甲"]},
        metadata: {metrics: [{code: "M1", name: "合成指标甲", base_name: "合成指标甲", value_basis: "当日数"}]}} as never;
      return original(entity, raw, ...rest as []);
    });
    const origin = await new SemanticTaskService(f.request("basis-date-origin", "查合成机构甲2025年末的合成指标甲")).resolve(proposal(complete()));
    expect(origin.status).toBe("ready");
    const result = await new SemanticTaskService(f.request("basis-date", "改成较上月")).resolve(proposal([
      {action: "set", field: "metrics", value: "合成指标甲较上月"},
      {action: "set", field: "time", value: "较上月", modelCalendar: {start: "2025-11-01", end: "2025-11-30"}},
    ], {kind: "current"}));
    expect(result.status).toBe("needs_interpretation");
    expect(result.task!.issues.map(issue => issue.code)).toContain("TIME_EXPRESSION_IS_METRIC_BASIS");
  });
  it("泛指更换指标而未给出名称或口径时追问，不采用模型自选口径", async () => {
    const f = await setup(), original = f.backend.resolveBusinessField.getMockImplementation()!;
    f.backend.resolveBusinessField.mockImplementation(async (entity: string, raw: string[], ...rest: unknown[]) => {
      if (entity === "metric" && raw.includes("合成指标甲较上月")) return {status: "resolved",
        value: {codes: ["M4"], names: ["合成指标甲较上月"]},
        metadata: {metrics: [{code: "M4", name: "合成指标甲较上月", base_name: "合成指标甲", value_basis: "较上月"}]}} as never;
      if (entity === "metric" && (raw.includes("合成指标甲") || raw.includes("M1"))) return {status: "resolved",
        value: {codes: ["M1"], names: ["合成指标甲"]},
        metadata: {metrics: [{code: "M1", name: "合成指标甲", base_name: "合成指标甲", value_basis: "当日数"}]}} as never;
      return original(entity, raw, ...rest as []);
    });
    const origin = await new SemanticTaskService(f.request("basis-missing-origin", "查合成机构甲2025年末的合成指标甲")).resolve(proposal(complete()));
    expect(origin.status).toBe("ready");
    const result = await new SemanticTaskService(f.request("basis-missing", "换一个指标看看")).resolve(proposal([
      {action: "set", field: "metrics", value: "合成指标甲较上月"}], {kind: "current"}));
    expect(result.status).toBe("needs_user");
    expect(result.task!.issues).toContainEqual(expect.objectContaining({code: "FIELD_REQUIRED", field: "metrics", remediation: "user"}));
    expect(result.task!.permit).toBeUndefined();
  });
});

/**
 * 绑定层在采纳建议通道的机构结论时首发 source_confirmation 来源确认题（见上方用例）。
 * 这里直接取首发题目，验证保留的续发与应答机制
 * （continueSourceConstraints 续发、prepareSourceAnswers accept/reject、拒绝持续约束）。
 */
async function sourceConfirmationCase(id: string) {
  const f = await setup();
  const suggested = vi.fn(async (_entity: string, _suggestions: unknown, _options: unknown, _source: string, raw: string[]) => ({
    status: "resolved" as const, value: {codes: ["O1", "O2"], names: ["合成机构甲", "合成机构乙"]},
    metadata: {resolution_source: "model_inferred", source_codes: ["O1", "O2"], extractedRawValues: raw, hint_source_bound: true},
  }));
  Object.assign(f.backend, {resolveBusinessFieldSuggestion: suggested});
  const operations = complete().map(operation => operation.field === "organizations" ? {...operation,
    value: "合成机构甲、合成机构乙", suggestion: {name: "合成机构甲", excerpt: "合成机构甲"}} : operation);
  const request = f.request(id, "查合成机构甲、合成机构乙2025年末的合成指标甲");
  const first = await new SemanticPlanService(request).resolve(proposal(operations));
  expect(first.status, JSON.stringify(first.issues)).toBe("needs_user");
  const store = request.semanticTasks!, plan = (await store.plan(first.state.task_ref!))!;
  const step = plan.steps[0]!, task = (await store.get(step.taskRef!))!;
  expect(task.target.fields.organizations!.resolvedValue).toMatchObject({codes: ["O1", "O2"]});
  const question = (await store.questionsForPlan(plan.ref))[0]!.question;
  expect(question.status).toBe("open");
  return {f, question};
}
