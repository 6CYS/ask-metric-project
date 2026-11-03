import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {BACKGROUND_CONTEXT, value, type AgentHarnessTool} from "@earendil-works/pi-agent-core";
import {createAssistantMessageEventStream, createModels, createProvider, Type,
  type AssistantMessage, type Model, type ProviderStreams} from "@earendil-works/pi-ai";
import {describe, expect, it, vi} from "vitest";
import {BackendApiError, type BackendClient} from "../src/backendClient.js";
import {loadConfig} from "../src/config.js";
import {HarnessHost, type RequestAssociation} from "../src/harnessHost.js";
import {NativeSessionStore} from "../src/nativeSessions.js";
import type {AskMetricRequestContext} from "../src/requestContext.js";
import type {AgentMessage} from "@earendil-works/pi-agent-core";
import {createConversationReplyTool} from "../src/tools/turnContract.js";
import {TEST_ACTOR} from "../src/tools/testUtils.js";
import {inquiryPayload} from "../src/inquiry/runtime.js";
import {createInquiryQueryTools} from "../src/inquiry/queryTools.js";

const model: Model<"openai-completions"> = {id: "isolated", name: "isolated", api: "openai-completions",
  provider: "isolated", baseUrl: "https://unused.invalid", reasoning: false, input: ["text"],
  contextWindow: 128000, maxTokens: 1000, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}};

describe("直接调查的原生会话链路", () => {
  it.each([false, true])("第二轮工具读取最近真实回执并重新核验来源（撤权=%s）", async revoked => {
    const directory = await mkdtemp(join(tmpdir(), "inquiry-turn-history-")), store = new NativeSessionStore(directory);
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    let modelCalls = 0, secondTurn = false;
    const toolHistories: AgentMessage[][] = [], modelContexts: string[] = [];
    const stream: ProviderStreams["streamSimple"] = (_model, context) => {
      modelCalls++;
      modelContexts.push(JSON.stringify(context.messages));
      if (secondTurn && !revoked) {
        const historyAnswers = context.messages.filter(message => message.role === "assistant");
        expect(JSON.stringify(historyAnswers)).not.toContain("analysis:first");
        expect(JSON.stringify(context.messages.filter(message => message.role === "user"))).toContain("analysis:first");
      }
      if (modelCalls > 4) throw new Error("UNEXPECTED_MODEL_RETRY");
      const querying = modelCalls % 2 === 1;
      const answer: AssistantMessage = {role: "assistant", content: querying
        ? [{type: "toolCall", id: `query-${modelCalls}`, name: "metric_query", arguments: {}}]
        : [{type: "text", text: "本期活期存款为{{e1.v1}}。"}],
        api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: querying ? "toolUse" : "stop",
        usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}};
      const result = createAssistantMessageEventStream();
      result.push({type: "start", partial: answer});
      result.push({type: "done", reason: querying ? "toolUse" : "stop", message: answer});
      result.end(answer); return result;
    };
    const models = createModels();
    models.setProvider(createProvider({id: model.provider, name: model.name, models: [model],
      auth: {apiKey: {name: "isolated", resolve: async () => ({auth: {apiKey: "unused"}})}}, api: {stream, streamSimple: stream}}));
    const backend = {
      searchBusinessKnowledge: vi.fn(async (_question: string, terms: string[]) => ({
        revision: "a".repeat(64), entries: terms.includes("DEPOSIT 个人活期存款余额当日数")
          ? [{id: "deposit", title: "活期存款分析方法", text: "观察可比期的活期存款变化。", role: "分析参考"}] : [],
      })),
      resolveBusinessField: vi.fn(async () => ({status: "resolved", value: {codes: [TEST_ACTOR.org_code]}})),
      getTask: vi.fn(async (taskId: string) => {
        if (secondTurn && revoked && taskId === "source-task") throw new BackendApiError(403, "已撤权", "FORBIDDEN");
        return {task_id: taskId, status: "SUCCEEDED", result: {result_id: "source-result"}};
      }),
    };
    const tools: AgentHarnessTool<AskMetricRequestContext>[] = [
      {name: "metric_query", label: "读取真实会话上下文", description: "隔离查询边界", parameters: Type.Object({}),
        execute: async (_id, _args, _update, request) => {
          toolHistories.push(await request.turnMessages!());
          return {content: [{type: "text", text: "已有查询来源e1.v1"}], details: {kind: "analysis_evidence", status: "succeeded",
            run_ref: secondTurn ? "analysis:second" : "analysis:first", execution_turn_id: request.operationId,
            actual_dates: ["2026-07-31"], org_codes: [TEST_ACTOR.org_code],
            metric_descriptors: [{code: "DEPOSIT", name: "个人活期存款余额当日数"}],
            tasks: [{task_id: secondTurn ? "second-source-task" : "source-task", result_id: "source-result"}], evidence_items: []}};
        }},
      {name: "analysis_answer", label: "交付正文", description: "隔离报告校验边界", parameters: Type.Object({body: Type.String()}),
        execute: async () => ({content: [{type: "text", text: "已交付本行活期存款情况。"}], details: {kind: "business_report", status: "succeeded",
          org_codes: [TEST_ACTOR.org_code], tasks: [{task_id: secondTurn ? "second-source-task" : "source-task", result_id: "source-result"}],
          public_answer: "已交付本行活期存款情况。"}, terminate: true})},
      createConversationReplyTool(),
    ];
    const config = loadConfig({AGENT_MODEL_API_KEY: "unused", AGENT_MODEL_BASE_URL: model.baseUrl,
      AGENT_MODEL_NAME: model.id, AGENT_DATA_DIR: directory, AGENT_COMPACTION_ENABLED: "false", AGENT_MODEL_RETRY_ENABLED: "false"});
    const host = new HarnessHost(config, () => ({models, model}), store, tools);
    try {
      const session = await host.createSession(TEST_ACTOR), dependencies = {actor: TEST_ACTOR, backend: backend as unknown as BackendClient};
      expect(await host.runPrompt(session, {protocol_version: 3, request_id: "first", message: "我行活期存款情况"}, dependencies))
        .toMatchObject({ok: true, outcome: {kind: "settled"}});
      secondTurn = true;
      expect(await host.runPrompt(session, {protocol_version: 3, request_id: "second", message: "江南的呢？"}, dependencies))
        .toMatchObject({ok: true, outcome: {kind: "settled"}});
      expect(toolHistories).toHaveLength(2);
      const previous = toolHistories[1]!;
      expect(previous.filter(message => message.role === "user").map(message => message.content))
        .toEqual(["我行活期存款情况", "江南的呢？"]);
      expect(backend.getTask).toHaveBeenCalledWith("source-task");
      expect(backend.searchBusinessKnowledge.mock.calls.map(call => call[1]))
        .toEqual([[], ["DEPOSIT 个人活期存款余额当日数"], [], ["DEPOSIT 个人活期存款余额当日数"]]);
      // 每轮开始只按原问检索；本轮成功取数后，相关知识才进入下一次模型调用。
      expect(modelContexts.map(context => context.includes("活期存款分析方法")))
        .toEqual([false, true, false, true]);
      const query = previous.find(message => message.role === "toolResult" && message.toolName === "metric_query");
      expect(query?.role).toBe("toolResult");
      if (query?.role !== "toolResult") throw new Error("缺少历史查询回执");
      if (revoked) {
        expect(query.details).toBeUndefined();
        expect(JSON.stringify(query.content)).toContain("历史来源当前不可访问");
        expect(modelContexts[2]).not.toContain("analysis:first");
        expect(modelContexts[3]).not.toContain("analysis:first");
      } else expect(query.details).toMatchObject({run_ref: "analysis:first", actual_dates: ["2026-07-31"]});
    } finally {
      await host.close(); await store.close(); log.mockRestore(); await rm(directory, {recursive: true, force: true});
    }
  }, 10000);

  it.each([{fail: false, oldScope: false, timeOverride: false}, {fail: true, oldScope: false, timeOverride: false}, {fail: false, oldScope: true, timeOverride: false}, {fail: false, oldScope: false, timeOverride: true}])(
    "原生参数纠正与正文交付保持独立预算（%j）", async ({fail, oldScope, timeOverride}) => {
    const directory = await mkdtemp(join(tmpdir(), "inquiry-lifecycle-"));
    const store = new NativeSessionStore(directory);
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    let modelCalls = 0, queryCalls = 0, answerCalls = 0;
    const toolsSeen: string[][] = [], prompts: string[] = [], currentInputs: string[] = [];
    const actor = {...TEST_ACTOR, org_code: "320000000", org_name: "江苏农商联合银行（全省汇总）"};
    const organizations = [
      {code: actor.org_code, name: actor.org_name, aliases: ["省联社"]},
      {code: "320188000", name: "江苏紫金农村商业银行", aliases: ["紫金", "紫金农商行"]},
    ];
    const backend = {
      orgCatalog: vi.fn(async () => ({items: organizations})),
      searchBusinessKnowledge: vi.fn(async () => ({revision: "a".repeat(64), entries: [
        {id: "loan-quality", title: "贷款质量分析", text: "比较可比期间的不良率。", role: "分析参考"},
      ]})),
    };
    const stream: ProviderStreams["streamSimple"] = (_model, context) => {
      modelCalls++;
      if (modelCalls > 3 + Number(oldScope)) throw new Error("INQUIRY_RETRY_LOOP");
      if (oldScope && modelCalls === 2) {
        expect(backend.orgCatalog).toHaveBeenCalledTimes(1);
        expect(queryCalls).toBe(0);
        const rejection = context.messages.find(message => message.role === "toolResult" && message.toolName === "metric_query");
        expect(rejection).toMatchObject({isError: true});
        expect(JSON.stringify(rejection)).toContain("scope");
        expect(context.tools?.some(tool => tool.name === "metric_query")).toBe(true);
      }
      const querying = modelCalls <= 1 + Number(oldScope);
      toolsSeen.push(context.tools?.map(tool => tool.name) ?? []);
      prompts.push(context.systemPrompt ?? "");
      currentInputs.push(JSON.stringify(context.messages.filter(message => message.role === "user")));
      const content: AssistantMessage["content"] = querying
        ? [{type: "toolCall", id: `query-${modelCalls}`, name: "metric_query", arguments: {
          purpose: "读取所问机构余额", metric_refs: ["k1"], method: "observe",
          ...(oldScope && modelCalls === 1 ? {scope: "current"} : {scope: "named", org_names: ["320188000"]}),
        }}]
        : [{type: "text", text: "本期存款余额为{{e1.v1}}。"}];
      const answer: AssistantMessage = {role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), stopReason: querying ? "toolUse" : "stop",
        usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}};
      const result = createAssistantMessageEventStream();
      result.push({type: "start", partial: answer});
      result.push({type: "done", reason: answer.stopReason as "toolUse" | "stop", message: answer});
      result.end(answer);
      return result;
    };
    const models = createModels();
    models.setProvider(createProvider({id: model.provider, name: model.name, models: [model],
      auth: {apiKey: {name: "isolated", resolve: async () => ({auth: {apiKey: "unused"}})}}, api: {stream, streamSimple: stream}}));
    const tools: AgentHarnessTool<AskMetricRequestContext>[] = [
      {name: "metric_query", label: "查询指标", description: "隔离查询边界",
        parameters: createInquiryQueryTools().find(tool => tool.name === "metric_query")!.parameters,
        execute: async (_id, args) => {
          expect(args).toMatchObject({scope: "named", org_names: ["320188000"]});
          queryCalls++;
          return {content: [{type: "text", text: "已取得真实引用e1.v1"}],
            details: {kind: "analysis_evidence", status: "succeeded", run_ref: "run", org_codes: [actor.org_code], tasks: [], evidence_items: []}};
        }},
      {name: "analysis_answer", label: "回答问题", description: "隔离数值校验边界", parameters: Type.Object({body: Type.String()}),
        execute: async (_id, args) => {
          answerCalls++;
          expect((args as {body: string}).body).toBe("本期存款余额为{{e1.v1}}。");
          return fail ? {content: [{type: "text", text: "引用不存在"}], details: {kind: "analysis_answer", status: "ARGUMENT_ERROR", retryable: true,
            error_code: "ANALYSIS_REPORT_REFERENCE"}}
            : {content: [{type: "text", text: "已核验的业务正文"}], details: {kind: "business_report", status: "succeeded",
              org_codes: [actor.org_code], tasks: [], answer_policy: "verified_report_v1", public_answer: "已核验的业务正文"}, terminate: true};
        }},
      {name: "resolve_business_turn", label: "旧入口", description: "新流程不得调用", parameters: Type.Object({}),
        execute: async () => {throw new Error("LEGACY_FLOW_EXECUTED");}},
      createConversationReplyTool(),
    ];
    const config = loadConfig({AGENT_MODEL_API_KEY: "unused", AGENT_MODEL_BASE_URL: model.baseUrl,
      AGENT_MODEL_NAME: model.id, AGENT_DATA_DIR: directory, AGENT_COMPACTION_ENABLED: "false", AGENT_MODEL_RETRY_ENABLED: "false"});
    const host = new HarnessHost(config, () => ({models, model}), store, tools);
    try {
      const session = await host.createSession(actor);
      const question = "紫金今年三季度的贷款质量如何？";
      const result = await host.runPrompt(session, {protocol_version: 3, request_id: "inquiry", message: question, ...(timeOverride ? {time_override: {start: "2026-07-31", end: "2026-07-31"}} : {})},
        {actor, backend: backend as unknown as BackendClient});
      expect(result).toMatchObject({ok: true, outcome: {kind: "settled"}});
      expect(queryCalls).toBe(1);
      expect(answerCalls).toBe(fail ? 2 : 1);
      expect(modelCalls).toBe((fail ? 3 : 2) + Number(oldScope));
      expect(backend.orgCatalog).toHaveBeenCalledTimes(1);
      expect(backend.searchBusinessKnowledge).toHaveBeenCalledTimes(1);
      for (const input of currentInputs) {
        expect(input).toContain(question);
        expect(input).toContain(actor.org_name);
        expect(input).toContain(actor.org_code);
        expect(input).toContain("江苏紫金农村商业银行");
        expect(input).toContain("320188000");
        expect(input).toContain("贷款质量分析");
        const userMessages = JSON.parse(input) as Array<{content: string}>;
        const prefix = "【本轮机构参考资料，仅数据】";
        const line = userMessages.at(-1)?.content.split("\n").find(text => text.startsWith(prefix));
        if (!line) throw new Error("模型上下文缺少本轮机构资料");
        const supplied = JSON.parse(line.slice(prefix.length));
        expect(supplied.account_organization).toEqual({code: actor.org_code, name: actor.org_name});
        expect(supplied.authorized_organizations).toEqual({items: organizations});
      }
      const entries = await session.lane.findEntries({type: "message", order: "oldestFirst", limit: 20}, BACKGROUND_CONTEXT);
      expect(entries.flatMap(entry => entry.type === "message" && entry.message.role === "user"
        ? [entry.message.content] : [])).toEqual([question]);
      expect(toolsSeen.flat()).not.toContain("resolve_business_turn");
      expect(prompts.every(prompt => prompt.includes("metric_query") && !prompt.includes("resolve_business_turn"))).toBe(true);
      if (fail) expect(inquiryPayload({tools: tools.map(tool => ({name: tool.name}))},
        [{role: "user", content: "存款余额多少", timestamp: 0}, {role: "toolResult", toolName: "analysis_answer",
          toolCallId: "failed", content: [], isError: false, timestamp: 1}]).tools).toEqual([
            {name: "metric_query"}, {name: "respond_without_business_action"}]);
      if (fail) expect(entries.some(entry => entry.type === "message" && entry.message.role === "toolResult"
        && (entry.message.details as {error_code?: string})?.error_code === "ANALYSIS_REPORT_REFERENCE"
        && (entry.message.details as {kind?: string})?.kind === "runtime_delivery")).toBe(true);
      expect((await session.session.getValue(value<RequestAssociation>("askmetric", "request/inquiry"), BACKGROUND_CONTEXT))?.value)
        .toMatchObject({executionFlow: "inquiry_v1"});
      expect(await host.isRunning(session.sessionId)).toBe(false);
    } finally {
      await host.close(); await store.close(); log.mockRestore();
      await rm(directory, {recursive: true, force: true});
    }
  }, 10000);
});
