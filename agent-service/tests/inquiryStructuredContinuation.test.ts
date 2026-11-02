import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentHarness, BACKGROUND_CONTEXT, value } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  Type,
  type AssistantMessage,
  type Model,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { BackendApiError, type BackendClient } from "../src/backendClient.js";
import { loadConfig } from "../src/config.js";
import { HarnessHost, type HostedSession, type PromptInput } from "../src/harnessHost.js";
import { NativeSessionStore } from "../src/nativeSessions.js";
import { NativeSemanticTaskStore, type SemanticTask } from "../src/semantic-task/store.js";
import type { PendingQuestion, QuestionBinding } from "../src/semantic-task/questions.js";
import { semanticFeedback } from "../src/semantic-task/feedback.js";
import { stopLegacyOperation } from "../src/inquiry/legacyRecovery.js";
import { projectEntries } from "../src/sessionProjection.js";
import { createAskMetricTools } from "../src/tools/index.js";
import { TEST_ACTOR } from "../src/tools/testUtils.js";
import { CONVERSATION_REPLY } from "../src/tools/turnContract.js";

const model: Model<"openai-completions"> = {
  id: "isolated",
  name: "isolated",
  api: "openai-completions",
  provider: "isolated",
  baseUrl: "https://unused.invalid",
  reasoning: false,
  input: ["text"],
  contextWindow: 128000,
  maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const answer = (question: string): PromptInput => ({
  protocol_version: 3,
  request_id: question,
  message: "",
  answers: [
    {
      question_id: question,
      version: 1,
      choice: { type: "select", option_ids: [`${question}-option`] },
    },
  ],
});

async function cards(hosted: Pick<HostedSession, "session">, operationId: string) {
  const task: SemanticTask = {
    ref: "old-task",
    owner: TEST_ACTOR.id,
    revision: 1,
    originalMessage: "乙行8月末存款余额",
    status: "waiting_input",
    completion: "unmet",
    issues: [],
    target: {
      ref: "old-target",
      status: "blocked",
      pending: { metrics: "待确认指标", organizations: "待确认机构" },
      fields: {
        metrics: { source: "explicit", resolutionStatus: "ambiguous" },
        organizations: { source: "explicit", resolutionStatus: "ambiguous" },
        time: {
          source: "explicit",
          resolutionStatus: "resolved",
          resolvedValue: { start: "2026-08-31", end: "2026-08-31" },
        },
      },
    },
  };
  const questions: PendingQuestion[] = [];
  for (const field of ["metrics", "organizations"] as const) {
    const id = `q-${field}`;
    const question: PendingQuestion = {
      question_id: id,
      version: 1,
      kind: "choice",
      status: "open",
      issued_operation_id: operationId,
      scope: { task_ref: "old-plan", target_ref: task.target.ref, field, item_ref: id },
      prompt: "请选择",
      selection_mode: "single",
      options: [
        { option_id: `${id}-option`, no: 1, label: field === "metrics" ? "正式存款余额" : "乙行" },
      ],
    };
    const binding: QuestionBinding = {
      question_id: id,
      version: 1,
      reason: "candidate_choice",
      planRef: "old-plan",
      taskRef: task.ref,
      targetRef: task.target.ref,
      item_ref: id,
      sourceQuestion: task.originalMessage,
      options: [
        {
          option_id: `${id}-option`,
          candidateKey: id,
          candidate: { code: field === "metrics" ? "M1" : "O2", value: question.options[0]!.label },
        },
      ],
      resolutionBasis: {},
      businessBasis: {
        field,
        kind: "choice",
        prompt: "请选择",
        selection_mode: "single",
        options: [{ key: id, label: question.options[0]!.label }],
      },
      receipts: [],
    };
    await hosted.session.setValue(
      value("askmetric.semantic.v2", `questions/${id}/1`),
      { owner: TEST_ACTOR.id, itemKey: id, question, binding, revision: 0, status: "open" },
      BACKGROUND_CONTEXT,
    );
    await hosted.session.setValue(
      value("askmetric.semantic.v2", `questions/current/${id}`),
      { question_id: id, version: 1, itemKey: id },
      BACKGROUND_CONTEXT,
    );
    questions.push(question);
  }
  await hosted.session.setValue(
    value("askmetric.semantic.v2", `task/${task.ref}`),
    task,
    BACKGROUND_CONTEXT,
  );
  await hosted.session.setValue(
    value("askmetric.semantic.v2", `questions/task/${task.ref}`),
    questions.map((q) => ({ question_id: q.question_id, version: q.version })),
    BACKGROUND_CONTEXT,
  );
  return {
    task,
    feedback: { ...semanticFeedback(task, "needs_user"), pending_questions: questions },
  };
}

describe("同一旧目标的分轮卡片确认", () => {
  it.each(["continued", "stale", "revoked"] as const)(
    "后续卡片累积仍有效的确认，保留换版与撤权保护（%s）",
    async (scenario) => {
      const directory = await mkdtemp(join(tmpdir(), "inquiry-card-continuation-"));
      const store = new NativeSessionStore(directory);
      const log = vi.spyOn(console, "info").mockImplementation(() => {});
      const descriptor = { code: "M1", name: "正式存款余额", unit: "元", binding_ref: "signed:M1" };
      const backend = {
        resolveBusinessField: vi.fn(() =>
          Promise.resolve({ status: "resolved", value: { codes: ["O2"], names: ["乙行"] } }),
        ),
        analysisCatalog: vi.fn(() => Promise.resolve({ items: [descriptor] })),
        createAgentQueryContext: vi.fn(() => Promise.resolve({ conversation_id: "new-context" })),
        analysisExecute: vi.fn((payload: Record<string, unknown>) =>
          Promise.resolve({
            kind: "analysis_evidence",
            status: "succeeded",
            run_ref: "confirmed-run",
            conversation_id: payload.conversation_id,
            analysis_date: "2026-08-31",
            org_codes: ["O2"],
            tasks: [],
            rows: [],
            metric_descriptors: [descriptor],
            plan: payload.plan,
            evidence_items: [
              {
                ref: "confirmed-run.f1",
                type: "fact",
                metric_code: "M1",
                metric_name: descriptor.name,
                org_code: "O2",
                org_name: "乙行",
                date: "2026-08-31",
                unit: "元",
                value: "100",
                display: "100元",
              },
            ],
          }),
        ),
        analysisReport: vi.fn(() =>
          Promise.resolve({
            kind: "business_report",
            status: "succeeded",
            delivery: "business_evidence_v1",
            answer_policy: "verified_report_v1",
            org_codes: ["O2"],
            tasks: [],
            public_answer: "乙行8月末存款余额为100元。",
            report: {
              summary: "乙行8月末存款余额为100元。",
              sections: [],
              body_evidence: [{ paragraph: 1, evidence_refs: ["confirmed-run.f1"] }],
            },
          }),
        ),
      };
      let modelCalls = 0,
        publishing = true;
      const stream: ProviderStreams["streamSimple"] = () => {
        if (!publishing) modelCalls++;
        if (modelCalls > 3) throw new Error("CONTINUATION_RETRY_LOOP");
        const querying = publishing || modelCalls === 2;
        const stopReason = querying || modelCalls === 1 ? "toolUse" : "stop";
        const message: AssistantMessage = {
          role: "assistant",
          content: publishing
            ? [
                {
                  type: "toolCall",
                  id: "old-publication",
                  name: "resolve_business_turn",
                  arguments: {},
                },
              ]
            : querying
              ? [
                  {
                    type: "toolCall",
                    id: "query-confirmed",
                    name: "metric_query",
                    arguments: {
                      purpose: "查询已确认条件",
                      metric_refs: ["wrong"],
                      scope: "named",
                      org_names: ["wrong"],
                      date: "2026-07-31",
                      method: "observe",
                    },
                  },
                ]
              : modelCalls === 1
                ? [
                    {
                      type: "toolCall",
                      id: "clarification",
                      name: CONVERSATION_REPLY,
                      arguments: { answer: "请继续确认机构。" },
                    },
                  ]
                : [
                    {
                      type: "text",
                      text: "乙行8月末存款余额为{{e1.v1}}。",
                    },
                  ],
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          stopReason,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        const result = createAssistantMessageEventStream();
        result.push({ type: "start", partial: message });
        result.push({ type: "done", reason: stopReason, message });
        result.end(message);
        return result;
      };
      const models = createModels();
      models.setProvider(
        createProvider({
          id: model.provider,
          name: model.name,
          models: [model],
          auth: {
            apiKey: {
              name: "isolated",
              resolve: () => Promise.resolve({ auth: { apiKey: "unused" } }),
            },
          },
          api: { stream, streamSimple: stream },
        }),
      );
      const config = loadConfig({
        AGENT_MODEL_API_KEY: "unused",
        AGENT_MODEL_BASE_URL: model.baseUrl,
        AGENT_MODEL_NAME: model.id,
        AGENT_DATA_DIR: directory,
        AGENT_COMPACTION_ENABLED: "false",
        AGENT_MODEL_RETRY_ENABLED: "false",
      });
      const host = new HarnessHost(
        config,
        () => ({ models, model }),
        store,
        createAskMetricTools(),
      );
      const deps = { actor: TEST_ACTOR, backend: backend as unknown as BackendClient };
      try {
        const native = await store.create(TEST_ACTOR.id);
        await native.setValue(value("askmetric", "owner"), TEST_ACTOR.id, BACKGROUND_CONTEXT);
        await native.setValue(
          value("askmetric", "businessProtocol"),
          "semantic_v2",
          BACKGROUND_CONTEXT,
        );
        const { task: originalTask, feedback } = await cards(
          { session: native },
          "old-publication",
        );
        const old = await AgentHarness.create(
          {
            session: native,
            models,
            model,
            tools: [
              {
                name: "resolve_business_turn",
                label: "隔离旧卡片发布",
                description: "只发布测试卡片",
                parameters: Type.Object({}),
                execute: () => Promise.resolve({ content: [], details: feedback, terminate: true }),
              },
            ],
            compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 1000 },
          },
          BACKGROUND_CONTEXT,
        );
        const lane = await old.harness.lane("main", { createAt: null }, BACKGROUND_CONTEXT);
        expect(
          await lane.accept(
            {
              kind: "prompt",
              operationId: "old-publication",
              prompt: originalTask.originalMessage,
            },
            BACKGROUND_CONTEXT,
          ),
        ).toMatchObject({ ok: true });
        expect(
          await lane.drive({ operationId: "old-publication" }, BACKGROUND_CONTEXT),
        ).toMatchObject({ ok: true, value: { kind: "settled" } });
        await old.harness.close(BACKGROUND_CONTEXT);
        await store.release(TEST_ACTOR.id, native.metadata.id);
        publishing = false;
        const session = await host.openSession(TEST_ACTOR, native.metadata.id);
        if (!session) throw new Error("不能重开隔离旧会话");
        const semantic = new NativeSemanticTaskStore(session.session);
        const first = await host.admitPrompt(session, answer("q-metrics"), deps);
        if (!first.ok) throw new Error(first.message);
        expect(first.request.inquiryAdmission?.targets[0]).toMatchObject({
          metrics: { codes: ["M1"] },
          pending: [{ field: "organizations" }],
        });
        expect(await host.drivePrompt(session, first)).toMatchObject({ ok: true });
        expect(backend.analysisExecute).not.toHaveBeenCalled();
        expect(
          await host.admitPrompt(
            session,
            { ...answer("q-metrics"), request_id: "repeat-choice" },
            deps,
          ),
        ).toMatchObject({ ok: false, code: "ANSWER_ALREADY_APPLIED" });
        if (scenario === "stale") {
          const prior = await semantic.question("q-metrics", 1);
          if (!prior) throw new Error("缺少旧题目");
          await session.session.setValue(
            value("askmetric.semantic.v2", "questions/q-metrics/2"),
            {
              owner: TEST_ACTOR.id,
              ...prior,
              question: { ...prior.question, version: 2 },
              binding: { ...prior.binding, version: 2 },
              status: "open",
            },
            BACKGROUND_CONTEXT,
          );
          await session.session.setValue(
            value("askmetric.semantic.v2", "questions/current/q-metrics"),
            { question_id: "q-metrics", version: 2, itemKey: "q-metrics" },
            BACKGROUND_CONTEXT,
          );
          await session.session.setValue(
            value("askmetric.semantic.v2", "questions/task/old-task"),
            [
              { question_id: "q-metrics", version: 2 },
              { question_id: "q-organizations", version: 1 },
            ],
            BACKGROUND_CONTEXT,
          );
        }
        const second = await host.admitPrompt(session, answer("q-organizations"), deps);
        if (!second.ok) throw new Error(second.message);
        if (scenario === "stale") {
          expect(second.request.inquiryAdmission?.targets[0]).toMatchObject({
            pending: [{ field: "metrics" }],
          });
          expect(second.request.inquiryAdmission?.targets[0]?.metrics).toBeUndefined();
          await stopLegacyOperation(session.lane, second.operationId, second.context);
        } else {
          expect(second.request.inquiryAdmission?.targets[0]).toMatchObject({
            metrics: { codes: ["M1"] },
            organizations: { codes: ["O2"] },
            time: { start: "2026-08-31", end: "2026-08-31" },
            pending: [],
          });
          expect(
            second.request.inquiryAdmission?.answerReceipts.map((item) => item.question_id),
          ).toEqual(["q-metrics", "q-organizations"]);
          if (scenario === "revoked")
            backend.resolveBusinessField.mockRejectedValue(
              new BackendApiError(403, "机构权限已撤销", "FORBIDDEN"),
            );
          expect(await host.drivePrompt(session, second)).toMatchObject({
            ok: true,
            outcome: { kind: "settled" },
          });
          expect(backend.analysisExecute).toHaveBeenCalledTimes(scenario === "revoked" ? 0 : 1);
          const messages = projectEntries(
            await session.lane.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT),
          );
          if (scenario === "revoked") {
            expect(
              messages.some(
                (message) => message.role === "assistant" && message.text.includes("无权访问"),
              ),
            ).toBe(true);
            expect(backend.analysisReport).not.toHaveBeenCalled();
          } else {
            expect(backend.analysisExecute.mock.calls[0]![0]).toMatchObject({
              org_codes: ["O2"],
              start: "2026-08-31",
              end: "2026-08-31",
              plan: { steps: [{ metric_refs: ["signed:M1"] }] },
            });
            expect(
              messages.some(
                (message) =>
                  message.role === "assistant" && message.text === "乙行8月末存款余额为100元。",
              ),
            ).toBe(true);
            expect(
              await host.admitPrompt(
                session,
                { ...answer("q-metrics"), request_id: "repeat-after-continuation" },
                deps,
              ),
            ).toMatchObject({ ok: false, code: "ANSWER_ALREADY_APPLIED" });
          }
        }
        expect(await semantic.get(originalTask.ref)).toEqual(originalTask);
        expect((await semantic.question("q-metrics", 1))?.question.status).toBe("open");
        expect((await semantic.question("q-organizations", 1))?.question.status).toBe("open");
      } finally {
        await host.close();
        await store.close();
        log.mockRestore();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
