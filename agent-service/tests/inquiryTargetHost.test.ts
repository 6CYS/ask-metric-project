import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BACKGROUND_CONTEXT,
  branchTip,
  insertEntry,
  setValue,
  value,
  type AgentHarnessTool,
  type AgentMessage,
  type AgentToolResult,
} from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  Type,
  type AssistantMessage,
  type Message,
  type Model,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HarnessHost,
  type HostedSession,
  type PromptInput,
  type RequestAssociation,
} from "../src/harnessHost.js";
import { NativeSessionStore } from "../src/nativeSessions.js";
import { loadConfig } from "../src/config.js";
import { BackendApiError, type BackendClient } from "../src/backendClient.js";
import { withRequestContext, type AskMetricRequestContext } from "../src/requestContext.js";
import {
  runTool,
  TEST_ACTOR,
  testRequestContext,
  MemoryCommandBridge,
} from "../src/tools/testUtils.js";
import { CONVERSATION_REPLY } from "../src/tools/turnContract.js";
import { withInquiryAuthorization } from "../src/inquiry/authorization.js";
import { withBackendAuthentication } from "../src/runtime/authentication.js";

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
const target = (ref: string, codes = ["O2"], operationId = `operation-${ref}`) => ({
  version: 1 as const,
  ref,
  operationId,
  sourceQuestion: "乙行的个人存款",
  topic: "个人存款",
  organizations: { codes, names: codes.map((code) => `机构${code}`) },
  time: { date_selection: "exact", start: "2026-07-31", end: "2026-07-31" },
});

describe("普通问数目标的原生分支与恢复", () => {
  let directory: string, store: NativeSessionStore, host: HarnessHost;
  let session: HostedSession;
  let config: ReturnType<typeof loadConfig>;
  let calls: number, issueCurrentTarget: boolean;
  let failModel: boolean;
  let modelGate: Promise<void> | undefined;
  let modelStarted: (() => void) | undefined;
  const prompts: Array<Record<string, unknown>> = [];
  const systemPrompts: string[] = [];
  const userTexts: string[] = [];
  const modelMessages: Message[][] = [];
  const requests: AskMetricRequestContext[] = [];
  const answerStreamSnapshots: AskMetricRequestContext["answerStream"][] = [];
  const modelRequests: Array<AskMetricRequestContext | undefined> = [];
  const toolRequests: Array<AskMetricRequestContext | undefined> = [];
  const resolveScope = vi.fn((_kind: string, codes: string[]) =>
    Promise.resolve({
      status: "resolved",
      value: { codes },
    }),
  );
  const backend = {
    resolveBusinessField: resolveScope,
    searchBusinessKnowledge: () => Promise.resolve({ revision: "a".repeat(64), entries: [] }),
  } as unknown as BackendClient;
  const deps = { actor: TEST_ACTOR, backend };

  beforeEach(async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    directory = await mkdtemp(join(tmpdir(), "inquiry-target-host-"));
    store = new NativeSessionStore(directory);
    prompts.length = 0;
    systemPrompts.length = 0;
    userTexts.length = 0;
    modelMessages.length = 0;
    requests.length = 0;
    answerStreamSnapshots.length = 0;
    modelRequests.length = 0;
    toolRequests.length = 0;
    calls = 0;
    issueCurrentTarget = false;
    failModel = false;
    modelGate = undefined;
    modelStarted = undefined;
    resolveScope.mockReset();
    resolveScope.mockImplementation((_kind, codes) =>
      Promise.resolve({
        status: "resolved",
        value: { codes },
      }),
    );
    const stream: ProviderStreams["streamSimple"] = (_model, context, options) => {
      if (calls > 4) throw new Error("UNEXPECTED_TARGET_TEST_LOOP");
      modelMessages.push(structuredClone(context.messages));
      modelRequests.push(session.activeRequest);
      systemPrompts.push(context.systemPrompt ?? "");
      const user = [...context.messages].reverse().find((message) => message.role === "user");
      const text =
        typeof user?.content === "string"
          ? user.content
          : (user?.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("\n") ?? "");
      const current = text.split("\n").find((line) => line.startsWith('{"current_target":'));
      userTexts.push(text);
      prompts.push(current ? (JSON.parse(current) as Record<string, unknown>) : {});
      const name = issueCurrentTarget && calls === 0 ? "metric_query" : CONVERSATION_REPLY;
      const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "toolCall", id: `call-${++calls}`, name, arguments: {} }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        stopReason: "toolUse",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const events = createAssistantMessageEventStream();
      // 与真实 provider 一样调用 payload 钩子，流式模式在此阶段绑定。
      void (async () => {
        await options?.onPayload?.(
          {
            messages: context.messages,
            tools: context.tools?.map((tool) => ({
              type: "function",
              function: { name: tool.name, parameters: tool.parameters },
            })),
          },
          model,
        );
        const answerStream = session.activeRequest?.answerStream;
        answerStreamSnapshots.push(answerStream ? { ...answerStream } : undefined);
        modelStarted?.();
        if (modelGate) await modelGate;
        if (failModel) {
          const failed: AssistantMessage = {
            ...message,
            content: [],
            stopReason: "error",
            errorMessage: "isolated model failure",
          };
          events.push({ type: "error", reason: "error", error: failed });
          events.end(failed);
          return;
        }
        events.push({ type: "start", partial: message });
        events.push({ type: "done", reason: "toolUse", message });
        events.end(message);
      })().catch((error: unknown) => {
        events.end({ ...message, stopReason: "error", errorMessage: String(error) });
      });
      return events;
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
    const tools: AgentHarnessTool<AskMetricRequestContext>[] = [
      {
        name: "metric_query",
        label: "隔离目标声明",
        description: "隔离业务接口",
        parameters: Type.Object({}),
        execute: (_id, _input, _update, request) =>
          Promise.resolve({
            content: [{ type: "text", text: "查询服务暂不可用。" }],
            isError: true,
            details: {
              status: "error",
              inquiry_target_snapshot: target("current", ["O3"], request.operationId),
            },
          }),
      },
      {
        name: CONVERSATION_REPLY,
        label: "隔离交付",
        description: "隔离模型出口",
        parameters: Type.Object({}),
        execute: (_id, _input, _update, request) => {
          requests.push(request);
          toolRequests.push(session.activeRequest);
          return Promise.resolve({
            content: [{ type: "text", text: "已了解。" }],
            terminate: true,
            details: {
              kind: "conversation_reply",
              status: "answered",
              answer: "已了解。",
              history_sources: { tasks: [], organizationScopes: [] },
            },
          });
        },
      },
    ];
    config = loadConfig({
      AGENT_MODEL_API_KEY: "unused",
      AGENT_MODEL_BASE_URL: model.baseUrl,
      AGENT_MODEL_NAME: model.id,
      AGENT_DATA_DIR: directory,
      AGENT_COMPACTION_ENABLED: "false",
      AGENT_MODEL_RETRY_ENABLED: "false",
    });
    host = new HarnessHost(config, () => ({ models, model }), store, tools);
    session = await host.createSession(TEST_ACTOR);
  });
  afterEach(async () => {
    await host.close();
    await store.close();
    await rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function appendTurn(
    snapshot?: ReturnType<typeof target>,
    extra: Record<string, unknown> = {},
    isError = false,
  ) {
    await session.lane.appendMessage(
      { role: "user", content: "先前问题", timestamp: 0, ...extra } as AgentMessage,
      BACKGROUND_CONTEXT,
    );
    const id = await session.lane.appendMessage(
      {
        role: "toolResult",
        toolName: "metric_query",
        toolCallId: "previous-query",
        content: [],
        isError,
        timestamp: 0,
        details: snapshot
          ? { status: isError ? "error" : "succeeded", inquiry_target_snapshot: snapshot }
          : {
              kind: "analysis_evidence",
              status: "succeeded",
              org_codes: ["O9"],
              metric_descriptors: [{ code: "M9" }],
              tasks: [],
              actual_dates: ["2026-08-31"],
            },
      },
      BACKGROUND_CONTEXT,
    );
    return id;
  }
  const input = (id = "next"): PromptInput => ({
    protocol_version: 3,
    request_id: id,
    message: "改为7月末",
  });
  async function admit(id = "next") {
    const result = await host.admitPrompt(session, input(id), deps);
    if (!result.ok) throw new Error(result.message);
    return result;
  }

  async function appendPermissionFailure(status: number) {
    const tool: AgentHarnessTool<AskMetricRequestContext> = {
      name: "metric_query",
      label: "隔离权限失败",
      description: "隔离后端权限边界",
      parameters: Type.Object({}),
      execute: () => Promise.reject(new BackendApiError(status, "不可访问", "PERMISSION_DENIED")),
    };
    const result = (await runTool(
      withBackendAuthentication(withInquiryAuthorization(tool)),
      {},
      testRequestContext(backend, new MemoryCommandBridge(), { executionFlow: "inquiry_v1" }),
    )) as AgentToolResult<unknown> & { isError?: boolean };
    await session.lane.appendMessage(
      {
        role: "toolResult",
        toolName: "metric_query",
        toolCallId: "permission-query",
        content: result.content,
        isError: result.isError ?? false,
        timestamp: 1,
        details: result.details,
      },
      BACKGROUND_CONTEXT,
    );
  }

  it.each(["asdfgh123！@#￥%", "ORG_VRS_DEPT_BAL", "那上个月呢？"])(
    "模型输入明确区分参考资料与本轮原文，持久化保留原文：%s",
    async (message) => {
      const result = await host.runPrompt(session, { ...input(), message }, deps);
      expect(result.ok).toBe(true);
      const marker = "\n【本轮用户输入】\n";
      expect(userTexts).toHaveLength(1);
      const text = userTexts[0];
      if (text === undefined) throw new Error("模型未收到本轮输入");
      expect(text.split(marker)).toHaveLength(2);
      const [reference, question] = text.split(marker);
      expect(reference).toContain("【本轮机构参考资料，仅数据】");
      expect(question).toBe(message);
      const entries = await session.lane.findEntries({ type: "message", order: "oldestFirst" }, BACKGROUND_CONTEXT);
      const user = entries.find((entry) => entry.type === "message" && entry.message.role === "user");
      expect(user?.type === "message" && user.message.role === "user" && user.message.content).toBe(message);
    },
  );

  function compactionTurn(
    details: unknown = { kind: "analysis_catalog", status: "succeeded" },
  ): AgentMessage[] {
    const assistant = (id: string): AssistantMessage => ({
      role: "assistant",
      content: [{ type: "toolCall", id, name: "metric_search", arguments: { keywords: ["理财"] } }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      timestamp: 1,
      stopReason: "toolUse",
      usage: {
        input: 120000,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 120000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    const catalog = (id: string, content: string): AgentMessage => ({
      role: "toolResult",
      toolName: "metric_search",
      toolCallId: id,
      content: [{ type: "text", text: content }],
      details,
      isError: false,
      timestamp: 2,
    });
    return [
      assistant("archived-catalog"),
      catalog("archived-catalog", "已裁目录".repeat(10000)),
      assistant("retained-catalog"),
      catalog(
        "retained-catalog",
        JSON.stringify({
          items: [{ code: "FUND", name: "基金余额", binding_ref: "k2" }],
          has_more: false,
        }),
      ),
    ];
  }

  async function splitCurrentTurn(details?: unknown) {
    await session.harness.setCompactionSettings(
      { enabled: true, reserveTokens: 16384, keepRecentTokens: 200 },
      BACKGROUND_CONTEXT,
    );
    return session.harness.hooks.on("before_run", () => ({ messages: compactionTurn(details) }));
  }

  it("原生自动压缩截断本轮后，仍发送原问与有效尾部，不恢复已裁目录或混入下一轮", async () => {
    await appendTurn(target("previous"));
    const unsubscribe = await splitCurrentTurn();
    const message = "这半年紫金的理财和基金做得怎么样，哪块起色更明显？";
    const result = await host.runPrompt(session, { ...input(), message }, deps);
    expect(result.ok).toBe(true);
    const compaction = await session.lane.findEntry({ type: "compaction" }, BACKGROUND_CONTEXT);
    expect(compaction?.type).toBe("compaction");
    if (compaction?.type !== "compaction") throw new Error("未经过原生压缩");
    expect(compaction.retainedTail.some((entry) => entry.role === "user")).toBe(false);
    expect(userTexts).toHaveLength(1);
    expect(userTexts[0]).toContain("【本轮用户输入】\n" + message);
    expect(modelMessages[0]?.map((entry) => entry.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
    ]);
    expect(JSON.stringify(modelMessages[0])).toContain("基金余额");
    expect(JSON.stringify(modelMessages[0])).toContain("k2");
    expect(JSON.stringify(modelMessages[0])).not.toContain("已裁目录");
    expect(JSON.stringify(modelMessages[0])).not.toContain("先前问题");
    unsubscribe();
    const next = await host.runPrompt(session, { ...input("later"), message: "改查贷款" }, deps);
    expect(next.ok).toBe(true);
    expect(userTexts).toHaveLength(2);
    expect(userTexts[1]).toContain("【本轮用户输入】\n改查贷款");
    expect(userTexts[1]).not.toContain(message);
    expect(modelMessages[1]?.filter((entry) => entry.role === "user")).toHaveLength(1);
  });

  it("压缩恢复原生多模态输入与发送后缀，持久化内容不被参考资料替换", async () => {
    config.model.userMessageSuffix = "\n/no_think";
    session = await host.createSession(TEST_ACTOR);
    await splitCurrentTurn();
    const question = "按附件比较理财和基金";
    const content = [
      { type: "text" as const, text: question },
      { type: "image" as const, data: "isolated-image", mimeType: "image/png" },
    ];
    const request = testRequestContext(backend, new MemoryCommandBridge(), {
      originalMessage: question,
      sessionId: session.sessionId,
      executionFlow: "inquiry_v1",
    });
    const context = withRequestContext(request, BACKGROUND_CONTEXT);
    const admitted = await session.lane.accept(
      {
        kind: "prompt",
        operationId: request.operationId,
        prompt: { role: "user", content, timestamp: 1 },
      },
      context,
    );
    expect(admitted.ok).toBe(true);
    const result = await host.drivePrompt(session, {
      ok: true,
      operationId: request.operationId,
      context,
      request,
    });
    expect(result.ok).toBe(true);
    const user = modelMessages[0]?.find((entry) => entry.role === "user");
    if (!Array.isArray(user?.content) || user.content[0]?.type !== "text")
      throw new Error("未保留多模态输入");
    expect(user.content[0].text).toContain("【本轮用户输入】\n");
    expect(user.content.slice(1)).toEqual([
      ...content,
      { type: "text", text: "\n/no_think" },
    ]);
    const original = await session.lane.findEntry(
      { type: "message", order: "oldestFirst" },
      BACKGROUND_CONTEXT,
    );
    expect(original?.type === "message" && original.message).toMatchObject({
      role: "user",
      content,
    });
  });

  it("压缩尾部缺少正式来源范围时仍撤销发送授权，不直接拼入恢复内容", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await splitCurrentTurn({
      kind: "analysis_evidence",
      status: "succeeded",
      org_codes: [],
      tasks: [],
    });
    await host.runPrompt(session, input(), deps);
    expect(host.isAuthorized(session.sessionId)).toBe(false);
    expect(modelMessages[0]).toEqual([]);
  });

  it("重开已落盘的压缩操作后，按原生操作关联恢复原问而非较早问题", async () => {
    await appendTurn();
    const admitted = await admit();
    let parentId = await session.lane.getTipId(BACKGROUND_CONTEXT);
    const messages = compactionTurn();
    const entries = messages.map((message) => {
      const entry = {
        type: "message" as const,
        id: session.session.idGenerator.next(),
        parentId,
        message,
      };
      parentId = entry.id;
      return entry;
    });
    const id = session.session.idGenerator.next();
    await session.session.mutate(
      (tx, context) =>
        tx.commit(
          [
            ...entries.map(insertEntry),
            insertEntry({
              type: "compaction",
              id,
              parentId,
              summary: "已归档",
              tokensBefore: 120000,
              retainedTail: messages.slice(-2),
              fromHook: true,
            }),
            setValue(branchTip(session.lane.name), id),
          ],
          context,
        ),
      BACKGROUND_CONTEXT,
    );
    await host.closeSession(session.sessionId);
    session = (await host.openSession(TEST_ACTOR, session.sessionId))!;
    await host.resumeOpenOperations(session, deps);
    expect(requests.at(-1)?.operationId).toBe(admitted.operationId);
    expect(userTexts[0]).toContain("【本轮用户输入】\n改为7月末");
    expect(userTexts[0]).not.toContain("先前问题");
    expect(modelMessages[0]?.map((entry) => entry.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
    ]);
    expect(JSON.stringify(modelMessages[0])).toContain("k2");
    expect(JSON.stringify(modelMessages[0])).not.toContain("已裁目录");
  });

  it("没有声明快照时不从历史查询或报告对象反推目标", async () => {
    await appendTurn();
    const result = await admit();
    expect(result.request.inquiryTargetContext).toEqual({ version: 1, time_contract: 2 });
    expect(result.request.inquiryTargetContext?.baseline).toBeUndefined();
  });

  it("已接纳声明即使查询失败也保留完整多机构与请求期间", async () => {
    await appendTurn(target("comparison", ["O1", "O2"]), {}, true);
    const result = await admit();
    expect(result.request.inquiryTargetContext).toEqual({
      version: 1,
      time_contract: 2,
      baseline: target("comparison", ["O1", "O2"]),
    });
    const saved = await session.session.getValue(
      value<RequestAssociation>("askmetric", "request/next"),
      BACKGROUND_CONTEXT,
    );
    expect(saved?.value).toMatchObject({
      inquiryTargetContext: { version: 1, baseline: target("comparison", ["O1", "O2"]) },
    });
  });

  it.each([false, true])(
    "可信输入轮是继承屏障，不能采用该轮快照或穿透更早目标（带快照=%s）",
    async (hasSnapshot) => {
      await appendTurn(target("older"));
      await appendTurn(hasSnapshot ? target("clicked") : undefined, {
        inquiryAdmission: { targets: [], answerReceipts: [] },
      });
      const result = await admit();
      expect(result.request.inquiryTargetContext).toEqual({ version: 1, time_contract: 2 });
      expect(result.request.inquiryTargetContext?.baseline).toBeUndefined();
    },
  );

  it("快照与可信输入屏障跨分页时仍不继承", async () => {
    await appendTurn(target("older"));
    await appendTurn(target("clicked"), { clickAnswers: [{ question_id: "q1", version: 1 }] });
    for (let index = 0; index < 33; index++)
      await session.lane.appendMessage(
        {
          role: "toolResult",
          toolName: "metric_search",
          toolCallId: `catalog-${index}`,
          content: [],
          isError: false,
          timestamp: index,
        },
        BACKGROUND_CONTEXT,
      );
    const result = await admit();
    expect(result.request.inquiryTargetContext).toEqual({ version: 1, time_contract: 2 });
  });

  it("独立来源与读取工具不能覆盖已声明目标，较早声明不受三轮窗口截断", async () => {
    await appendTurn(target("declared"));
    for (let index = 0; index < 4; index++) await appendTurn();
    await session.lane.appendMessage(
      {
        role: "toolResult",
        toolName: "analysis_read",
        toolCallId: "read-only",
        content: [],
        isError: false,
        timestamp: 1,
        details: { inquiry_target_snapshot: target("not-a-declaration", ["O9"]) },
      },
      BACKGROUND_CONTEXT,
    );
    const result = await admit();
    expect(result.request.inquiryTargetContext?.baseline?.ref).toBe("declared");
  });

  it("最新目标失权后不回退至更早有权目标", async () => {
    await appendTurn(target("older", ["O1"]));
    await appendTurn(target("revoked", ["O2"]));
    resolveScope.mockImplementation((_kind, codes) =>
      Promise.resolve({
        status: "resolved",
        value: { codes: codes.includes("O2") ? [] : codes },
      }),
    );
    const result = await admit();
    expect(result.request.inquiryTargetContext).toEqual({ version: 1, time_contract: 2 });
    expect(result.request.inquiryTargetContext?.baseline).toBeUndefined();
    expect(resolveScope.mock.calls.some(([, codes]) => codes.includes("O1"))).toBe(false);
  });

  it.each([401, 403])("本轮 %s 终态没有声明快照时重开后不能穿透到旧目标", async (status) => {
    await appendTurn(target("older", ["O1"]));
    await session.lane.appendMessage(
      { role: "user", content: "改查乙行", timestamp: 1 },
      BACKGROUND_CONTEXT,
    );
    await appendPermissionFailure(status);
    await host.closeSession(session.sessionId);
    session = (await host.openSession(TEST_ACTOR, session.sessionId))!;
    const result = await admit();
    expect(result.request.inquiryTargetContext).toEqual({ version: 1, time_contract: 2 });
    expect(resolveScope.mock.calls.some(([, codes]) => codes.includes("O1"))).toBe(false);
  });

  it("独立补查失权不覆盖同轮已声明且仍有权的核心目标", async () => {
    await appendTurn(target("older", ["O1"]));
    await appendTurn(target("current", ["O2"]));
    await appendPermissionFailure(403);
    const result = await admit();
    expect(result.request.inquiryTargetContext?.baseline).toEqual(target("current", ["O2"]));
  });

  it("权限服务异常不按无目标继续接纳", async () => {
    await appendTurn(target("prior"));
    resolveScope.mockRejectedValue(
      new BackendApiError(503, "暂不可用", "HISTORY_AUTHORIZATION_UNAVAILABLE"),
    );
    await expect(admit()).rejects.toThrow("暂不可用");
    expect(
      await session.session.getValue(value("askmetric", "request/next"), BACKGROUND_CONTEXT),
    ).toBeUndefined();
  });

  it("当前分支以外的更新声明不成为基线", async () => {
    const anchor = await appendTurn(target("branch-a", ["O1"]));
    await appendTurn(target("branch-b", ["O2"]));
    const navigation = await session.lane.accept(
      { kind: "navigation", targetId: anchor, options: { summarize: false } },
      BACKGROUND_CONTEXT,
    );
    if (!navigation.ok) throw new Error(navigation.error.message);
    await session.lane.drive({ operationId: navigation.value.operationId }, BACKGROUND_CONTEXT);
    const result = await admit();
    expect(result.request.inquiryTargetContext).toMatchObject({
      baseline: { ref: "branch-a", organizations: { codes: ["O1"] } },
    });
  });

  it("同请求重试沿用冻结基线，不重新选择本轮晚到快照", async () => {
    await appendTurn(target("prior"));
    const first = await admit();
    await session.lane.appendMessage(
      {
        role: "toolResult",
        toolName: "metric_query",
        toolCallId: "later",
        content: [],
        isError: true,
        timestamp: 1,
        details: {
          status: "error",
          inquiry_target_snapshot: target("late", ["O3"], first.operationId),
        },
      },
      BACKGROUND_CONTEXT,
    );
    const second = await admit();
    expect(second.operationId).toBe(first.operationId);
    expect(second.request.inquiryTargetContext).toMatchObject({ baseline: { ref: "prior" } });
  });

  it("旧冻结目标上下文重试不升级期间契约", async () => {
    await appendTurn(target("prior"));
    const first = await admit();
    expect(first.request.inquiryTargetContext?.time_contract).toBe(2);
    const address = value<RequestAssociation>("askmetric", "request/next");
    const saved = { ...(await session.session.getValue(address, BACKGROUND_CONTEXT))!.value };
    saved.inquiryTargetContext = { version: 1, baseline: target("prior") };
    await session.session.setValue(address, saved, BACKGROUND_CONTEXT);
    const retry = await admit();
    expect(retry.operationId).toBe(first.operationId);
    expect(retry.request.inquiryTargetContext).toEqual({ version: 1, baseline: target("prior") });
  });

  it("旧关联没有新字段时重试不升级目标协议", async () => {
    await appendTurn(target("prior"));
    const first = await admit();
    const address = value<RequestAssociation>("askmetric", "request/next");
    const saved = { ...(await session.session.getValue(address, BACKGROUND_CONTEXT))!.value };
    delete saved.inquiryTargetContext;
    await session.session.setValue(address, saved, BACKGROUND_CONTEXT);
    const retry = await admit();
    expect(retry.operationId).toBe(first.operationId);
    expect(retry.request.inquiryTargetContext).toBeUndefined();
  });

  it("本轮失败工具已提交的声明优先于冻结基线进入模型上下文", async () => {
    await appendTurn(target("prior"));
    issueCurrentTarget = true;
    const result = await host.runPrompt(session, input(), deps);
    expect(result.ok).toBe(true);
    expect(prompts[0]).toMatchObject({ current_target: { ref: "prior" } });
    expect(prompts[1]).toMatchObject({
      current_target: { ref: "current", organizations: { codes: ["O3"] } },
    });
  });

  it("本轮快照不可访问时模型收到空目标，不回退到冻结基线", async () => {
    await appendTurn(target("prior"));
    issueCurrentTarget = true;
    resolveScope.mockImplementation((_kind, codes) =>
      Promise.resolve({
        status: "resolved",
        value: { codes: codes.includes("O3") ? [] : codes },
      }),
    );
    await host.runPrompt(session, input(), deps);
    expect(prompts[0]).toMatchObject({ current_target: { ref: "prior" } });
    expect(prompts[1]).toEqual({ current_target: null, time_contract: 2 });
  });

  it("重开后恢复冻结上下文而不重选基线", async () => {
    await appendTurn(target("prior"));
    const admitted = await admit();
    await host.closeSession(session.sessionId);
    const reopened = await host.openSession(TEST_ACTOR, session.sessionId);
    expect(reopened).toBeDefined();
    session = reopened!;
    await host.resumeOpenOperations(session, deps);
    expect(requests.at(-1)?.operationId).toBe(admitted.operationId);
    expect(requests.at(-1)?.inquiryTargetContext).toMatchObject({ baseline: { ref: "prior" } });
    expect(prompts.at(-1)).toMatchObject({ current_target: { ref: "prior" } });
  });

  it("执行期间模型与工具观察同一活动上下文，正式结束后清理", async () => {
    const admitted = await admit();
    expect(session.activeRequest).toBeUndefined();
    await host.drivePrompt(session, admitted);
    expect(modelRequests).toHaveLength(1);
    expect(modelRequests[0]).toBeDefined();
    expect(modelRequests[0]).toBe(admitted.request);
    expect(toolRequests).toHaveLength(1);
    expect(toolRequests[0]).toBe(admitted.request);
    expect(requests[0]).toBe(admitted.request);
    expect(systemPrompts[0]).toContain("直接写正常assistant正文，不把全文封装成工具参数");
    expect(session.activeRequest).toBeUndefined();
  });

  it("重开恢复绑定新授权上下文供观察使用，结束后清理", async () => {
    const admitted = await admit();
    await host.closeSession(session.sessionId);
    session = (await host.openSession(TEST_ACTOR, session.sessionId))!;
    const currentBackend = { ...backend } as BackendClient;
    expect(session.activeRequest).toBeUndefined();
    await host.resumeOpenOperations(session, { actor: TEST_ACTOR, backend: currentBackend });
    const restored = requests.at(-1);
    expect(restored).toBeDefined();
    expect(restored).not.toBe(admitted.request);
    expect(restored?.operationId).toBe(admitted.operationId);
    expect(restored?.backend).toBe(currentBackend);
    expect(modelRequests[0]).toBeDefined();
    expect(modelRequests[0]).toBe(restored);
    expect(toolRequests[0]).toBe(restored);
    expect(session.activeRequest).toBeUndefined();
  });

  it("同一 operation 重复驱动不替换或提前清理实际执行的活动上下文", async () => {
    let release!: () => void;
    modelGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      modelStarted = resolve;
    });
    const admitted = await admit();
    const running = host.drivePrompt(session, admitted);
    let observing: ReturnType<HarnessHost["drivePrompt"]> | undefined;
    try {
      await started;
      const repeated = await admit();
      expect(repeated.operationId).toBe(admitted.operationId);
      expect(repeated.request).not.toBe(admitted.request);
      observing = host.drivePrompt(session, repeated);
      expect(session.activeRequest).toBe(admitted.request);
      // 给原生重复 drive 一个事件循环周期；无论立即返回还是等待原驱动，所有权都不变。
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(session.activeRequest).toBe(admitted.request);
    } finally {
      release();
      await Promise.all([running, observing]);
    }
    expect(calls).toBe(1);
    expect(toolRequests[0]).toBe(admitted.request);
    expect(session.activeRequest).toBeUndefined();
  });

  it("开启正文流式时普通模型轮提供 text 模式及调用序号", async () => {
    config.answerStreaming = true;
    const admitted = await admit();
    await host.drivePrompt(session, admitted);
    expect(answerStreamSnapshots[0]).toEqual({ callSeq: 1, mode: "text" });
    expect(requests[0]?.answerStream?.mode).toBe("none");
    expect(systemPrompts[0]).toContain("直接调用analysis_answer，将最终业务正文放入body");
    expect(calls).toBe(1);
  });

  it("模型失败结束后清理活动上下文，失败草稿不成为工具交付", async () => {
    failModel = true;
    const admitted = await admit();
    await host.drivePrompt(session, admitted);
    expect(modelRequests[0]).toBe(admitted.request);
    expect(toolRequests).toEqual([]);
    expect(session.activeRequest).toBeUndefined();
    expect(await host.isRunning(session.sessionId)).toBe(false);
    const entries = await session.lane.findEntries({ type: "message" }, BACKGROUND_CONTEXT);
    expect(
      entries.some(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "assistant" &&
          entry.message.stopReason === "error",
      ),
    ).toBe(true);
  });

  it("旧关联恢复时不自动接入自然目标", async () => {
    await appendTurn(target("prior"));
    const admitted = await admit();
    const address = value<RequestAssociation>("askmetric", "request/next");
    const saved = { ...(await session.session.getValue(address, BACKGROUND_CONTEXT))!.value };
    delete saved.inquiryTargetContext;
    await session.session.setValue(address, saved, BACKGROUND_CONTEXT);
    await host.closeSession(session.sessionId);
    session = (await host.openSession(TEST_ACTOR, session.sessionId))!;
    await host.resumeOpenOperations(session, deps);
    expect(requests.at(-1)?.operationId).toBe(admitted.operationId);
    expect(requests.at(-1)?.inquiryTargetContext).toBeUndefined();
    expect(prompts.at(-1)).toEqual({});
  });

  it("恢复时重验权限但保持原冻结快照", async () => {
    await appendTurn(target("prior"));
    await admit();
    await host.closeSession(session.sessionId);
    session = (await host.openSession(TEST_ACTOR, session.sessionId))!;
    resolveScope.mockImplementation(() =>
      Promise.resolve({ status: "resolved", value: { codes: [] } }),
    );
    await host.resumeOpenOperations(session, deps);
    expect(requests.at(-1)?.inquiryTargetContext?.baseline?.ref).toBe("prior");
    expect(prompts.at(-1)).toEqual({ current_target: null, time_contract: 2 });
    const stored = await session.session.getValue(
      value<RequestAssociation>("askmetric", "request/next"),
      BACKGROUND_CONTEXT,
    );
    expect(stored?.value.inquiryTargetContext?.baseline?.ref).toBe("prior");
  });
});
