import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, value, type Session } from "@earendil-works/pi-agent-core";
import { NativeSessionStore } from "../src/nativeSessions.js";
import { NativeSemanticTaskStore, type SemanticTask } from "../src/semantic-task/store.js";
import { NativeFrameStore } from "../src/business-context/store.js";
import type {
  BusinessFrame,
  FieldCandidate,
  ResolvedField,
} from "../src/business-context/types.js";
import type { PendingQuestion, QuestionBinding } from "../src/semantic-task/questions.js";
import { QuestionAnswerError } from "../src/semantic-task/questions.js";
import { admitInquiryInput, type InquiryAdmissionDependencies } from "../src/inquiry/admission.js";

describe("inquiry 的可信澄清入场", () => {
  let directory: string, sessions: NativeSessionStore, session: Session;
  let deps: InquiryAdmissionDependencies;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "inquiry-admission-"));
    sessions = new NativeSessionStore(directory);
    session = await sessions.create("owner");
    deps = {
      actorId: "owner",
      sessionId: session.metadata.id,
      operationId: "new-operation",
      semanticTasks: new NativeSemanticTaskStore(session),
      frames: new NativeFrameStore(session),
      questionPublicationProof: (question) =>
        Promise.resolve(question.issued_operation_id === "published-operation"),
      framePublicationProof: (frame) => Promise.resolve(frame.turnId === "published-operation"),
    };
  });
  afterEach(async () => {
    await sessions.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function seed(
    id = "q1",
    options: {
      owner?: string;
      status?: string;
      version?: number;
      candidate?: FieldCandidate;
      field?: "metrics" | "organizations";
      target?: string;
      sourceConfirmation?: boolean;
    } = {},
  ) {
    const field = options.field ?? "metrics",
      target = options.target ?? "target-1",
      version = options.version ?? 1;
    const task: SemanticTask = {
      ref: `task-${target}`,
      owner: options.owner ?? "owner",
      revision: 1,
      originalMessage: "测试乙行2026年8月末余额",
      status: "waiting_input",
      completion: "unmet",
      issues: [],
      target: {
        ref: target,
        status: "blocked",
        pending: { [field]: "待确认" },
        fields: {
          metrics: {
            source: "explicit",
            resolutionStatus: field === "metrics" ? "ambiguous" : "resolved",
            ...(field === "metrics"
              ? {}
              : { resolvedValue: { codes: ["M9"], names: ["已确认指标"] } }),
          },
          organizations: {
            source: "explicit",
            resolutionStatus: field === "organizations" ? "ambiguous" : "resolved",
            ...(field === "organizations"
              ? {}
              : { resolvedValue: { codes: ["O2"], names: ["测试乙行"] } }),
          },
          time: {
            source: "explicit",
            resolutionStatus: "resolved",
            resolvedValue: { start: "2026-08-31", end: "2026-08-31" },
          },
        },
      },
    };
    const question: PendingQuestion = {
      question_id: id,
      version,
      kind: options.sourceConfirmation ? "confirm" : "choice",
      ...(options.sourceConfirmation ? { confirmation_option_id: `${id}-option` } : {}),
      scope: { task_ref: "plan", target_ref: target, field, item_ref: id },
      prompt: "请选择",
      selection_mode: "single",
      options: [{ option_id: `${id}-option`, no: 1, label: "测试候选" }],
      status: "open",
      issued_operation_id: "published-operation",
    } as PendingQuestion;
    const binding: QuestionBinding = {
      question_id: id,
      version,
      reason: options.sourceConfirmation ? "source_confirmation" : "candidate_choice",
      planRef: "plan",
      taskRef: task.ref,
      targetRef: target,
      item_ref: id,
      sourceQuestion: task.originalMessage,
      options: [
        {
          option_id: `${id}-option`,
          candidateKey: "candidate",
          candidate: options.candidate ?? { code: "M1", value: "正式余额" },
        },
      ],
      ...(options.sourceConfirmation
        ? {
            sourceConfirmation: {
              option_id: `${id}-option`,
              organizationCondition: { codes: ["O3", "O4"], names: ["测试丙行", "测试丁行"] },
            },
          }
        : {}),
      resolutionBasis: {},
      businessBasis: {
        field,
        kind: "choice",
        prompt: "请选择",
        selection_mode: "single",
        options: [{ key: "candidate", label: "测试候选" }],
      },
      receipts: [],
    };
    if (options.sourceConfirmation)
      task.target.fields[field] = {
        source: "resolved",
        resolutionStatus: "resolved",
        resolvedValue: { codes: ["O3", "O4"], names: ["测试丙行", "测试丁行"] },
      };
    await session.setValue(
      value("askmetric.semantic.v2", `task/${task.ref}`),
      task,
      BACKGROUND_CONTEXT,
    );
    await session.setValue(
      value("askmetric.semantic.v2", `questions/${id}/${version}`),
      {
        owner: task.owner,
        itemKey: id,
        question,
        binding,
        revision: 0,
        status: options.status ?? "open",
      },
      BACKGROUND_CONTEXT,
    );
    await session.setValue(
      value("askmetric.semantic.v2", `questions/current/${id}`),
      { question_id: id, version, itemKey: id },
      BACKGROUND_CONTEXT,
    );
    await session.setValue(
      value("askmetric.semantic.v2", `questions/task/${task.ref}`),
      [{ question_id: id, version }],
      BACKGROUND_CONTEXT,
    );
    return { task, question };
  }
  const answer = (id = "q1") => ({
    question_id: id,
    version: 1,
    choice: { type: "select" as const, option_ids: [`${id}-option`] as [string] },
  });

  async function admitStoredFields(
    source: "semantic" | "frame",
    fields: Record<string, ResolvedField>,
  ) {
    const { task } = await seed();
    task.target.fields = { ...task.target.fields, ...fields };
    if (source === "semantic") {
      await session.setValue(
        value("askmetric.semantic.v2", `task/${task.ref}`),
        task,
        BACKGROUND_CONTEXT,
      );
      return admitInquiryInput({ answers: [answer()] }, deps);
    }
    task.target.fields.metrics!.candidates = [{ code: "M1", value: "正式余额" }];
    const frame: BusinessFrame = {
      frameId: "frame-selection",
      operationFrameId: "frame-operation",
      sessionId: deps.sessionId,
      requestId: "old-request",
      turnId: "published-operation",
      capability: "metric_query",
      createdAt: "2026-01-01",
      status: "clarifying",
      issues: [],
      delta: { capabilityHint: "metric_query", fieldChanges: [], executionMode: "resolve_more" },
      fields: task.target.fields,
    };
    await session.setValue(
      value("askmetric.business.v1", `frame/${frame.frameId}`),
      frame,
      BACKGROUND_CONTEXT,
    );
    await session.setValue(
      value("askmetric.business.v1", "state"),
      {
        sessionId: deps.sessionId,
        version: 1,
        frameOrder: [frame.frameId],
        operations: { [frame.operationFrameId]: frame.frameId },
      },
      BACKGROUND_CONTEXT,
    );
    return admitInquiryInput(
      {
        clarification_selection: {
          frame_id: frame.frameId,
          option_ids: ["metrics:0:code:M1"],
        },
      },
      deps,
    );
  }

  for (const source of ["semantic", "frame"] as const) {
    it.each([
      {
        selection: "latest_in_range",
        time: { start: "2026-08-01", end: "2026-08-31" },
        recordSelection: "latest_in_range",
      },
      {
        selection: "all_in_range",
        time: { start: "2026-08-01", end: "2026-08-31" },
        recordSelection: "all_in_range",
      },
      {
        selection: "exact",
        time: { start: "2026-08-31", end: "2026-08-31" },
        recordSelection: "exact",
      },
      { selection: "latest", time: { preset: "latest" }, recordSelection: "latest_snapshot" },
    ])(
      `${source} 选择指标后保留独立存储的已确认期间策略 $selection`,
      async ({ selection, time, recordSelection }) => {
        const result = await admitStoredFields(source, {
          time: {
            source: "explicit",
            resolutionStatus: "resolved",
            resolvedValue: time,
          },
          selection: { source: "explicit", resolutionStatus: "resolved", resolvedValue: selection },
        });
        expect(result?.targets[0]).toMatchObject({
          time: { ...time, record_selection: recordSelection },
          pending: [],
        });
      },
    );
    it.each([
      { kind: "value" },
      { kind: "ranking", position: "bottom", top_n: 5 },
      { kind: "rank_position" },
    ])(`${source} 保留原任务的已确认查询操作 %j`, async (operation) => {
      const result = await admitStoredFields(source, {
        operation: { source: "explicit", resolutionStatus: "resolved", resolvedValue: operation },
      });
      expect(result?.targets[0]).toMatchObject({ operation, pending: [] });
    });
    it.each([
      { time: { preset: "latest" }, selection: "exact" },
      { time: { preset: "latest" }, selection: "all_in_range" },
      { time: { start: "2026-08-01", end: "2026-08-31" }, selection: "latest" },
    ])(`${source} 最新日期与选择策略矛盾时保留未决 %j`, async ({ time, selection }) => {
      const result = await admitStoredFields(source, {
        time: { source: "explicit", resolutionStatus: "resolved", resolvedValue: time },
        selection: { source: "explicit", resolutionStatus: "resolved", resolvedValue: selection },
      });
      expect(result?.targets[0]?.pending).toContainEqual({
        field: "selection",
        reason: "unresolved",
      });
      expect(result?.targets[0]?.time).not.toHaveProperty("record_selection");
    });
    it.each(["unresolved", "invalid"])(
      `${source} %s 的期间选择或排名不能降为默认操作`,
      async (state) => {
        const result = await admitStoredFields(source, {
          selection: {
            source: "explicit",
            resolutionStatus: state === "unresolved" ? "ambiguous" : "resolved",
            resolvedValue: state === "unresolved" ? "latest_in_range" : "unknown_selection",
          },
          operation: {
            source: "explicit",
            resolutionStatus: state === "unresolved" ? "missing" : "resolved",
            resolvedValue: {
              kind: "ranking",
              position: "bottom",
              top_n: state === "unresolved" ? 5 : 0,
            },
          },
        });
        expect(result?.targets[0]?.pending).toEqual([
          { field: "selection", reason: "unresolved" },
          { field: "operation", reason: "unresolved" },
        ]);
        expect(result?.targets[0]).not.toHaveProperty("operation");
        expect(result?.targets[0]?.time).not.toHaveProperty("record_selection");
      },
    );
  }

  it("将已发布选择与原机构期间冻结在同一目标，且不写旧语义账本", async () => {
    const { task } = await seed();
    const result = await admitInquiryInput({ answers: [answer()] }, deps);
    expect(result?.targets).toEqual([
      expect.objectContaining({
        targetRef: "target-1",
        metrics: { codes: ["M1"], names: ["正式余额"] },
        organizations: { codes: ["O2"], names: ["测试乙行"] },
        time: { start: "2026-08-31", end: "2026-08-31" },
        pending: [],
      }),
    ]);
    expect(result?.answerReceipts[0]?.outcome).toBe("applied");
    expect(await deps.semanticTasks!.get(task.ref)).toEqual(task);
    expect((await deps.semanticTasks!.question("q1"))?.question.status).toBe("open");
    expect(await new NativeSemanticTaskStore(session).turn(deps.operationId)).toBeUndefined();
  });
  it.each(["owner", "unpublished", "version", "option", "same-operation"])(
    "拒绝 %s 不可信选择",
    async (scenario) => {
      await seed("q1", scenario === "owner" ? { owner: "another-owner" } : {});
      if (scenario === "unpublished") deps.questionPublicationProof = () => Promise.resolve(false);
      if (scenario === "same-operation") deps.operationId = "published-operation";
      const input = answer();
      if (scenario === "version") input.version = 2;
      if (scenario === "option") input.choice.option_ids = ["invented"];
      await expect(admitInquiryInput({ answers: [input] }, deps)).rejects.toBeInstanceOf(
        QuestionAnswerError,
      );
    },
  );
  it("多目标选择不把不同机构与指标合成一个查询范围", async () => {
    await seed("q1");
    await seed("q2", { target: "target-2", candidate: { code: "M2", value: "另一指标" } });
    const result = await admitInquiryInput({ answers: [answer(), answer("q2")] }, deps);
    expect(result?.targets.map((target) => [target.targetRef, target.metrics?.codes])).toEqual([
      ["target-1", ["M1"]],
      ["target-2", ["M2"]],
    ]);
  });
  it("拒绝候选时保留未决字段，不生成默认指标或机构", async () => {
    await seed("q1", { field: "organizations", candidate: { code: "O5", value: "测试戊行" } });
    const result = await admitInquiryInput(
      { answers: [{ ...answer(), choice: { type: "none_of_these" } }] },
      deps,
    );
    expect(result?.targets[0]?.organizations).toBeUndefined();
    expect(result?.targets[0]?.pending).toContainEqual({
      field: "organizations",
      reason: "declined",
    });
    expect(result?.answerReceipts[0]?.outcome).toBe("declined");
  });
  it("基础指标选择保留口径未决，不能拿 source_metric_code 充当正式指标", async () => {
    await seed("q1", {
      candidate: {
        value: "基础余额",
        metadata: { kind: "base_only", source_metric_code: "BASE1" },
      },
    });
    const result = await admitInquiryInput({ answers: [answer()] }, deps);
    expect(result?.targets[0]?.metrics).toBeUndefined();
    expect(result?.targets[0]?.pending).toContainEqual({
      field: "metrics",
      reason: "unresolved",
      selectedBases: [{ name: "基础余额", sourceMetricCode: "BASE1" }],
    });
  });
  it("来源确认使用服务端绑定的完整机构集合", async () => {
    await seed("q1", {
      field: "organizations",
      sourceConfirmation: true,
      candidate: { value: "机构集合" },
    });
    const result = await admitInquiryInput(
      { answers: [{ ...answer(), choice: { type: "accept" } }] },
      deps,
    );
    expect(result?.targets[0]?.organizations?.codes).toEqual(["O3", "O4"]);
  });
  it("来源确认对应的机构全集改变后不能应用旧选择", async () => {
    const { task } = await seed("q1", {
      field: "organizations",
      sourceConfirmation: true,
      candidate: { value: "机构集合" },
    });
    task.target.fields.organizations!.resolvedValue = { codes: ["O3"], names: ["测试丙行"] };
    await session.setValue(
      value("askmetric.semantic.v2", `task/${task.ref}`),
      task,
      BACKGROUND_CONTEXT,
    );
    await expect(
      admitInquiryInput({ answers: [{ ...answer(), choice: { type: "accept" } }] }, deps),
    ).rejects.toMatchObject({ code: "QUESTION_SUPERSEDED" });
  });
  it("已确认的机构集合语义随旧目标迁移，不降成静态名单", async () => {
    const { task } = await seed();
    task.target.fields.organizations!.resolvedValue = {
      codes: ["O2"],
      names: ["测试乙行"],
      scope: { kind: "authorized_cohort", cohort: "rural_commercial_banks" },
      scope_fingerprint: "stored-fingerprint",
    };
    await session.setValue(
      value("askmetric.semantic.v2", `task/${task.ref}`),
      task,
      BACKGROUND_CONTEXT,
    );
    const result = await admitInquiryInput({ answers: [answer()] }, deps);
    expect(result?.targets[0]?.organizations?.scope).toEqual({
      kind: "authorized_cohort",
      cohort: "rural_commercial_banks",
    });
    expect(result?.targets[0]?.organizations?.scope_fingerprint).toBeUndefined();
  });
  it("未回答的同目标机构来源确认仍阻止直接执行", async () => {
    const { task } = await seed("q1");
    await seed("q-org", { field: "organizations", sourceConfirmation: true });
    await session.setValue(
      value("askmetric.semantic.v2", `task/${task.ref}`),
      task,
      BACKGROUND_CONTEXT,
    );
    await session.setValue(
      value("askmetric.semantic.v2", `questions/task/${task.ref}`),
      [
        { question_id: "q1", version: 1 },
        { question_id: "q-org", version: 1 },
      ],
      BACKGROUND_CONTEXT,
    );
    const result = await admitInquiryInput({ answers: [answer()] }, deps);
    expect(result?.targets[0]?.pending).toContainEqual({
      field: "organizations",
      reason: "unresolved",
    });
  });
  it("目标缺失字段即使没有字段快照也不能被默认化", async () => {
    const { task } = await seed();
    delete task.target.fields.organizations;
    task.target.pending.organizations = "机构未确定";
    await session.setValue(
      value("askmetric.semantic.v2", `task/${task.ref}`),
      task,
      BACKGROUND_CONTEXT,
    );
    const result = await admitInquiryInput({ answers: [answer()] }, deps);
    expect(result?.targets[0]?.pending).toContainEqual({
      field: "organizations",
      reason: "unresolved",
    });
  });
  it("基础指标经目录唯一解析后使用正式取值编码", async () => {
    await seed("q1", {
      candidate: {
        value: "基础余额",
        metadata: { kind: "base_only", source_metric_code: "BASE1" },
      },
    });
    deps.resolveMetric = (values) =>
      Promise.resolve({
        status: "resolved",
        value: { codes: ["VALUE1"], names: [values[0] + "当日数"] },
      });
    const result = await admitInquiryInput({ answers: [answer()] }, deps);
    expect(result?.targets[0]).toMatchObject({
      metrics: { codes: ["VALUE1"], names: ["基础余额当日数"] },
      pending: [],
    });
  });
  it("同组基础指标选择保留完整口径及其他已确认指标", async () => {
    const candidate = {
      code: "M1",
      value: "余额当日数",
      metadata: { kind: "base", source_metric_code: "BASE1", rawValueIndex: 0 },
    };
    const { task } = await seed("q1", { candidate });
    task.target.fields.metrics!.metadata = {
      mentionResolutions: [
        { status: "ambiguous", group: { id: "group-1" }, candidates: [candidate] },
        {
          status: "ambiguous",
          group: { id: "group-1" },
          candidates: [
            { code: "M2", value: "余额较上月", metadata: { source_metric_code: "BASE1" } },
          ],
        },
        { status: "resolved", value: { codes: ["M9"], names: ["已确认收入"] } },
      ],
    };
    await session.setValue(
      value("askmetric.semantic.v2", `task/${task.ref}`),
      task,
      BACKGROUND_CONTEXT,
    );
    const result = await admitInquiryInput({ answers: [answer()] }, deps);
    expect(result?.targets[0]?.metrics).toEqual({
      codes: ["M9", "M1", "M2"],
      names: ["已确认收入", "余额当日数", "余额较上月"],
    });
    expect(result?.targets[0]?.pending).toEqual([]);
  });
  it("同一题不能在一次入场提交两个不同选择", async () => {
    await seed();
    await expect(
      admitInquiryInput(
        { answers: [answer(), { ...answer(), choice: { type: "none_of_these" } }] },
        deps,
      ),
    ).rejects.toMatchObject({ code: "ANSWER_OPERATION_CONFLICT" });
  });
  it("旧后端澄清提交返回可识别兼容错误，不静默当作普通文本", async () => {
    await expect(
      admitInquiryInput(
        {
          clarification_target: {
            task_id: "backend-task",
            version: 1,
            clarification_id: "old-card",
          },
          selected_answers: { set: { metrics: [{ code: "M1" }] } },
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: "LEGACY_CLARIFICATION_UNSUPPORTED" });
  });
  it("旧 composer 目录选择以已发布任务及后端目录重绑定，保留原机构期间", async () => {
    deps.taskPublicationProof = (target) => Promise.resolve(target.task_id === "backend-task");
    deps.getTask = () =>
      Promise.resolve({
        task_id: "backend-task",
        conversation_id: "conversation",
        version: 4,
        status: "WAITING_USER",
        resolved_question: "测试乙行8月末余额",
        clarification: {
          id: "old-card",
          type: "semantic_slots",
          fields: [{ type: "metric" }],
          understood: { orgs: ["测试乙行"], time: "2026年8月末" },
        },
      });
    deps.resolveMetric = (codes) =>
      Promise.resolve({
        status: "resolved",
        value: { codes, names: ["正式余额"] },
      });
    deps.resolveOrganization = () =>
      Promise.resolve({
        status: "resolved",
        value: { codes: ["O2"], names: ["测试乙行"] },
      });
    deps.resolveDate = () =>
      Promise.resolve({
        status: "resolved",
        value: { start: "2026-08-31", end: "2026-08-31" },
      });
    const input = {
      clarification_target: { task_id: "backend-task", version: 4, clarification_id: "old-card" },
      selected_answers: {
        set: { metrics: [{ code: "M1", name: "不可信显示名称" }] },
        add_ops: [],
        remove_ops: [],
        text: "",
        catalog_selection_mode: "append",
      },
    };
    const result = await admitInquiryInput(input, deps);
    expect(result?.targets[0]).toMatchObject({
      source: { kind: "backend_task", taskId: "backend-task" },
      metrics: { codes: ["M1"], names: ["正式余额"] },
      organizations: { codes: ["O2"], names: ["测试乙行"] },
      time: { start: "2026-08-31", end: "2026-08-31" },
      pending: [],
    });
    await expect(
      admitInquiryInput(
        { ...input, clarification_target: { ...input.clarification_target, version: 3 } },
        deps,
      ),
    ).rejects.toMatchObject({ code: "QUESTION_SUPERSEDED" });
  });
  it("旧 frame 点选核对当前快照与发布证明后转换为相同目标条件", async () => {
    const frame: BusinessFrame = {
      frameId: "frame1",
      operationFrameId: "op-frame",
      sessionId: deps.sessionId,
      requestId: "old-request",
      turnId: "published-operation",
      capability: "metric_query",
      createdAt: "2026-01-01",
      status: "clarifying",
      issues: [],
      delta: { capabilityHint: "metric_query", fieldChanges: [], executionMode: "resolve_more" },
      fields: {
        metrics: {
          source: "explicit",
          resolutionStatus: "ambiguous",
          candidates: [{ code: "M1", value: "正式余额" }],
        },
        organizations: {
          source: "explicit",
          resolutionStatus: "resolved",
          resolvedValue: { codes: ["O2"], names: ["测试乙行"] },
        },
      },
    };
    await session.setValue(
      value("askmetric.business.v1", "frame/frame1"),
      frame,
      BACKGROUND_CONTEXT,
    );
    await session.setValue(
      value("askmetric.business.v1", "state"),
      {
        sessionId: deps.sessionId,
        version: 1,
        frameOrder: ["frame1"],
        operations: { "op-frame": "frame1" },
      },
      BACKGROUND_CONTEXT,
    );
    const input = {
      clarification_selection: { frame_id: "frame1", option_ids: ["metrics:0:code:M1"] },
    };
    const result = await admitInquiryInput(input, deps);
    expect(result?.targets[0]).toMatchObject({
      targetRef: "frame1",
      metrics: { codes: ["M1"], names: ["正式余额"] },
      pending: [],
    });
    deps.framePublicationProof = () => Promise.resolve(false);
    await expect(admitInquiryInput(input, deps)).rejects.toMatchObject({
      code: "QUESTION_NOT_PUBLISHED",
    });
  });
});
