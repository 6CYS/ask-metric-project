import { describe, expect, it, vi } from "vitest";
import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { BackendApiError, BackendClient } from "../src/backendClient.js";
import { createInquiryQueryTools } from "../src/inquiry/queryTools.js";
import { createTopicQueryTool } from "../src/inquiry/topics/tool.js";
import { loadTopicRegistry } from "../src/inquiry/topics/registry.js";
import {
  inquiryAnswerAttempts,
  inquiryBudgetExhausted,
  inquiryPayload,
  inquiryRecoveryAvailable,
  inquiryResponse,
  inquirySystemPrompt,
  inquiryToolAdmission,
} from "../src/inquiry/runtime.js";
import { CONVERSATION_REPLY } from "../src/tools/turnContract.js";
import { createPartialAnalysisTool, PARTIAL_ANALYSIS } from "../src/tools/partialAnalysis.js";
import { MemoryCommandBridge, runTool, testRequestContext } from "../src/tools/testUtils.js";

describe("正文交付通道提示", () => {
  it("默认及关闭流式时保留自然 assistant 正文契约", () => {
    const prompt = inquirySystemPrompt("2026-10-28");
    expect(prompt).toBe(inquirySystemPrompt("2026-10-28", false, false));
    expect(prompt).toContain("直接写正常assistant正文，不把全文封装成工具参数");
  });

  it.each([false, true])(
    "流式开启后正文明确进入工具 body，目标协议开关仍独立：%s",
    (targetContext) => {
      const prompt = inquirySystemPrompt("2026-10-28", targetContext, true);
      expect(prompt).toContain("直接调用analysis_answer，将最终业务正文放入body");
      expect(prompt).toContain("charts");
      expect(prompt).not.toContain("不把全文封装成工具参数");
      expect(prompt.includes("普通问数参考资料中的current_target")).toBe(targetContext);
      expect(prompt).toContain("问候、口径澄清和通用解释可用respond_without_business_action");
    },
  );
});

describe("流式正文的模型输出协议", () => {
  it.each([false, true])("SSE=%s 保持可用动作不变，只约束输出通道", (streaming) => {
    const tools = [
      ...["metric_query", "analysis_chart", "analysis_answer", CONVERSATION_REPLY].map((name) => ({
        function: { name },
      })),
    ];
    const evidence: AgentMessage = {
      role: "toolResult",
      toolCallId: "query",
      toolName: "metric_query",
      content: [],
      timestamp: 0,
      isError: false,
      details: { kind: "analysis_evidence", status: "succeeded" },
    };
    expect(inquiryPayload({ tools }, [], streaming)).toMatchObject({
      tool_choice: streaming ? "required" : "auto",
      tools: [tools[0], tools[1], tools[3]],
    });
    expect(inquiryPayload({ tools }, [evidence], streaming)).toMatchObject({
      tool_choice: streaming ? "required" : "auto",
      tools: tools.slice(0, 3),
    });
    const closing = Array.from({ length: 16 }, () => evidence);
    expect(inquiryPayload({ tools }, closing, streaming)).toMatchObject({
      tool_choice: streaming ? "required" : "auto",
      tools: [tools[2]],
    });
  });
  it("没有可用工具时不向模型发送无法满足的必选工具约束", () => {
    expect(inquiryPayload({ tools: [] }, [], true)).toMatchObject({
      tools: [],
      tool_choice: "auto",
    });
  });
});

describe("计算工具按已有事实提供", () => {
  const tools = ["metric_query", "analysis_read", "analysis_calculate", "analysis_answer"].map(name => ({name}));
  const fact = (ref: string, overrides: Record<string, unknown> = {}) => ({
    ref, type: "fact", fact_id: `fact:${ref}`, metric_code: "M1", org_code: "A",
    date: "2026-07-31", value: "100", unit: "元", ...overrides,
  });
  const source = (facts: unknown[], overrides: Record<string, unknown> = {}) => ({
    kind: "analysis_evidence", status: "succeeded", run_ref: "run-1", execution_turn_id: "op-1",
    metric_descriptors: [{code: "M1", binding_ref: "signed:M1:v1", unit: "元"}],
    evidence_items: facts, ...overrides,
  });
  const receipt = (details: unknown, toolName = "metric_query"): AgentMessage => ({
    role: "toolResult", toolCallId: `${toolName}-result`, toolName, content: [],
    details, isError: false, timestamp: 0,
  });
  const visible = (messages: AgentMessage[]) => inquiryPayload({tools}, messages).tools;

  it("没有事实或只有不同正式指标的单点时隐藏计算，查询与读取仍开放", () => {
    expect(visible([])).toEqual(tools.slice(0, 2));
    const one = source([fact("a")]);
    const other = source([fact("b", {metric_code: "M2"})], {
      run_ref: "run-2", metric_descriptors: [{code: "M2", binding_ref: "signed:M2:v1", unit: "元"}],
    });
    expect(visible([receipt(one), receipt(other)])).toEqual([tools[0], tools[1], tools[3]]);
    expect(visible([receipt(source([], {row_count: 0}))])).toEqual([tools[0], tools[1], tools[3]]);
  });

  it.each([
    {label: "同机构两期", change: {date: "2026-06-30"}},
    {label: "同日跨机构", change: {org_code: "B"}},
    {label: "同机构同日两条事实", change: {}},
  ])("$label仍提供计算，不扩大后端前置条件", ({change}) => {
    expect(visible([receipt(source([fact("a"), fact("b", change)]))])).toEqual(tools);
  });

  it("机构日期同时变化没有可比对，后续成功取数补齐后恢复", () => {
    const messages = [receipt(source([fact("a"), fact("b", {org_code: "B", date: "2026-06-30"})]))];
    expect(visible(messages)).toEqual([tools[0], tools[1], tools[3]]);
    messages.push(receipt(source([fact("c", {date: "2026-06-30"})], {run_ref: "run-2"})));
    expect(visible(messages)).toEqual(tools);
  });

  it("本轮鉴权读取的旧事实可以计算，新用户回合不会自动继承", () => {
    const old = receipt(source([fact("a"), fact("b", {date: "2026-06-30"})], {
      execution_turn_id: "old-op", result_reused: true,
    }), "analysis_read");
    expect(visible([old])).toEqual(tools);
    expect(visible([old, {role: "user", content: "下一问", timestamp: 1}])).toEqual(tools.slice(0, 2));
  });

  it("混合批次按各来源完整事实判断，不因失败分项或不适用指标关闭合法计算", () => {
    const details = {kind: "semantic_results", status: "partial", results: [
      {kind: "inquiry_query_error", status: "error"},
      source([fact("a"), fact("b", {date: "2026-06-30"})]),
      source([fact("ratio", {metric_code: "M2", unit: "%"})], {
        run_ref: "run-2", metric_descriptors: [{code: "M2", binding_ref: "signed:M2:v1", unit: "%", value_encoding: null}],
      }),
    ]};
    expect(visible([receipt(details)])).toEqual(tools);
  });

  it("口径版本不同的同代码事实不能组成一对，匹配版本补齐后恢复", () => {
    const messages = [receipt(source([fact("a")])), receipt(source([fact("b", {date: "2026-06-30"})], {
      run_ref: "run-2", metric_descriptors: [{code: "M1", binding_ref: "signed:M1:v2", unit: "元"}],
    }))];
    expect(visible(messages)).toEqual([tools[0], tools[1], tools[3]]);
    messages.push(receipt(source([fact("c", {org_code: "B"})], {run_ref: "run-3"})));
    expect(visible(messages)).toEqual(tools);
  });

  it("明确未确认百分比编码不能提供计算，已确认编码的事实仍可计算", () => {
    const ratioFacts = [fact("a", {unit: "%"}), fact("b", {unit: "%", date: "2026-06-30"})];
    const descriptors = [{code: "M1", binding_ref: "signed:M1:v1", unit: "%", value_encoding: null}];
    expect(visible([receipt(source(ratioFacts, {metric_descriptors: descriptors}))])).toEqual([tools[0], tools[1], tools[3]]);
    expect(visible([receipt(source(ratioFacts, {metric_descriptors: [{...descriptors[0], value_encoding: "ratio"}]}))])).toEqual(tools);
  });

  it("重复回执和派生计算不能增加原始事实数量", () => {
    const one = source([fact("a"), fact("calc", {type: "calculation"})]);
    expect(visible([receipt(one), receipt(one, "analysis_read")])).toEqual([tools[0], tools[1], tools[3]]);
  });

  it.each([
    {kind: "analysis_evidence", status: "succeeded"},
    source([{ref: "old.fact", type: "fact"}], {metric_descriptors: []}),
  ])("旧回执缺少事实身份时保守保留计算，后端仍最终校验", details => {
    expect(visible([receipt(details, "analysis_read")])).toEqual(tools);
  });

  it("未来查询未回执时不猜测已有事实，完成后自然恢复", () => {
    const pending: AgentMessage = {
      role: "assistant", content: [{type: "toolCall", id: "pending", name: "metric_query", arguments: {}}],
      api: "openai-completions", provider: "test", model: "test", stopReason: "toolUse", timestamp: 0,
      usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}},
    };
    expect(visible([pending])).toEqual(tools.slice(0, 2));
    expect(visible([pending, receipt(source([fact("a"), fact("b", {date: "2026-06-30"})]))])).toEqual(tools);
  });
});

describe("调查交付边界", () => {
  it("执行前置条件未完成不消耗正文修正机会，总调用预算仍有限", () => {
    const missing: AgentMessage = {
      role: "toolResult",
      toolName: "analysis_answer",
      toolCallId: "target-missing",
      content: [],
      timestamp: 0,
      isError: true,
      details: {
        kind: "analysis_answer",
        status: "ARGUMENT_ERROR",
        validation_stage: "prerequisite",
        error_code: "INQUIRY_TARGET_INCOMPLETE",
      },
    };
    const invalid: AgentMessage = {
      ...missing,
      details: {
        kind: "analysis_answer",
        status: "ARGUMENT_ERROR",
        error_code: "ANALYSIS_REPORT_NUMBER",
      },
    };
    expect(inquiryAnswerAttempts([missing, missing])).toBe(0);
    expect(inquiryAnswerAttempts([missing, invalid, missing])).toBe(1);
    expect(inquiryToolAdmission([missing, missing], "metric_query")).toBeUndefined();
    expect(
      inquiryToolAdmission(
        Array.from({ length: 18 }, () => missing),
        "metric_query",
      )?.block.terminate,
    ).toBe(true);
  });

  it.each([
    "ANALYSIS_REPORT_EVIDENCE",
    "ANALYSIS_REPORT_REFERENCE",
    "ANALYSIS_REPORT_SCOPE",
    "ANALYSIS_FORBIDDEN",
  ])("首次取证只解除缺来源前置错误，其他证据错误继续阻止恢复：%s", (code) => {
    const failed: AgentMessage = {
      role: "toolResult",
      toolName: "analysis_answer",
      toolCallId: "failed",
      content: [],
      timestamp: 0,
      isError: true,
      details: { kind: "analysis_answer", status: "ARGUMENT_ERROR", error_code: code },
    };
    const read: AgentMessage = {
      role: "toolResult",
      toolName: "metric_query",
      toolCallId: "read",
      content: [],
      timestamp: 1,
      isError: false,
      details: { kind: "analysis_evidence", status: "succeeded", execution_turn_id: "op-1" },
    };
    expect(inquiryRecoveryAvailable([failed, read], "op-1")).toBe(
      code === "ANALYSIS_REPORT_EVIDENCE",
    );
    expect(inquiryRecoveryAvailable([read, failed, read], "op-1")).toBe(false);
    expect(inquiryRecoveryAvailable([failed, read], "op-2")).toBe(false);
  });

  it("缺证据后真正取得来源才解除该前置错误，正文失败和重复读取不会清零", () => {
    const missing: AgentMessage = {
      role: "toolResult",
      toolName: "analysis_answer",
      toolCallId: "missing",
      content: [],
      timestamp: 0,
      isError: true,
      details: {
        kind: "analysis_answer",
        status: "ARGUMENT_ERROR",
        error_code: "ANALYSIS_REPORT_EVIDENCE",
      },
    };
    const read: AgentMessage = {
      role: "toolResult",
      toolName: "analysis_read",
      toolCallId: "read",
      content: [],
      timestamp: 1,
      isError: false,
      details: { kind: "analysis_evidence", status: "succeeded" },
    };
    const number: AgentMessage = {
      ...missing,
      toolCallId: "number",
      details: {
        kind: "analysis_answer",
        status: "ARGUMENT_ERROR",
        error_code: "ANALYSIS_REPORT_NUMBER",
      },
    };
    expect(inquiryAnswerAttempts([missing, missing])).toBe(2);
    expect(inquiryAnswerAttempts([missing, read])).toBe(0);
    expect(inquiryAnswerAttempts([missing, read, number, read])).toBe(1);
    expect(inquiryAnswerAttempts([missing, read, number, read, number])).toBe(2);
  });

  it("普通回复和报告共享当前回合交付次数，旧回合不占用修正预算", () => {
    const attempt = (toolName: string): AgentMessage => ({
      role: "toolResult",
      toolName,
      toolCallId: toolName,
      content: [],
      timestamp: 0,
      isError: true,
      details: {
        kind: toolName === CONVERSATION_REPLY ? "conversation_reply" : "analysis_answer",
        status: "ARGUMENT_ERROR",
      },
    });
    const messages: AgentMessage[] = [
      attempt(CONVERSATION_REPLY),
      { role: "user", content: "当前问题", timestamp: 1 },
      attempt(CONVERSATION_REPLY),
      attempt("analysis_answer"),
    ];
    expect(inquiryAnswerAttempts(messages)).toBe(2);
    expect(
      inquiryAnswerAttempts([...messages, { role: "user", content: "下一问", timestamp: 2 }]),
    ).toBe(0);
  });

  it("交付预算耗尽后只能交付固定失败说明，不能借普通回复输出未核验正文", () => {
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolName: "metric_query",
        toolCallId: "query",
        content: [],
        isError: false,
        timestamp: 0,
        details: { kind: "analysis_evidence", status: "succeeded" },
      },
      ...Array.from({ length: 2 }, (_, index): AgentMessage => ({
        role: "toolResult",
        toolName: "analysis_answer",
        toolCallId: `failed-${index}`,
        content: [],
        timestamp: index + 1,
        isError: true,
        details: { kind: "analysis_answer", status: "ARGUMENT_ERROR" },
      })),
    ];
    expect(
      inquiryToolAdmission(messages, CONVERSATION_REPLY, { answer: "余额为238亿元。" }),
    ).toMatchObject({ block: { terminate: true } });
    expect(inquiryToolAdmission(messages, "metric_query")).toMatchObject({
      block: { terminate: true },
    });
    expect(
      inquiryToolAdmission(messages, CONVERSATION_REPLY, {
        answer: "本次未能完成回答，请稍后重试。",
      }),
    ).toBeUndefined();
  });

  it("回答修正期间保留预算内的补查和图表工具", () => {
    const tools = [
      { name: "metric_query" },
      { name: "metric_availability" },
      { name: "analysis_chart" },
      { name: "analysis_answer" },
      { name: CONVERSATION_REPLY },
    ];
    expect(inquiryPayload({ tools }, []).tools).toEqual([...tools.slice(0, 3), tools[4]]);
    expect(inquiryToolAdmission([], "metric_availability")).toBeUndefined();
    const queried: AgentMessage = {
      role: "toolResult",
      toolName: "metric_query",
      toolCallId: "query",
      content: [],
      timestamp: 0,
      isError: false,
      details: { kind: "analysis_evidence", status: "succeeded" },
    };
    expect(inquiryPayload({ tools }, [queried]).tools).toEqual(tools.slice(0, 4));
    const attempted: AgentMessage[] = [
      queried,
      {
        role: "toolResult",
        toolName: "analysis_answer",
        toolCallId: "attempt",
        content: [],
        details: { kind: "analysis_answer", status: "ARGUMENT_ERROR" },
        timestamp: 0,
        isError: false,
      },
    ];
    expect(inquiryPayload({ tools }, attempted).tools).toEqual(tools.slice(0, 4));
    for (const tool of ["metric_availability", "metric_query", "analysis_read", "analysis_chart"])
      expect(inquiryToolAdmission(attempted, tool)).toBeUndefined();
  });
  it("取数后被拒绝的普通出口不占用首次报告的修正机会", () => {
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolName: "metric_query",
        toolCallId: "query",
        content: [],
        timestamp: 0,
        isError: false,
        details: { kind: "analysis_evidence", status: "succeeded" },
      },
      {
        role: "toolResult",
        toolName: CONVERSATION_REPLY,
        toolCallId: "wrong-exit",
        content: [],
        timestamp: 1,
        isError: true,
      },
      {
        role: "toolResult",
        toolName: "analysis_answer",
        toolCallId: "first-report",
        content: [],
        timestamp: 2,
        isError: false,
        details: {
          kind: "analysis_answer",
          status: "ARGUMENT_ERROR",
          error_code: "ANALYSIS_REPORT_NUMBER",
        },
      },
    ];
    expect(inquiryAnswerAttempts(messages.slice(0, 2))).toBe(0);
    expect(inquiryAnswerAttempts(messages)).toBe(1);
    expect(inquiryToolAdmission(messages, "analysis_answer")).toBeUndefined();
    expect(inquiryToolAdmission(messages, CONVERSATION_REPLY)).toMatchObject({
      block: { terminate: false },
    });
  });
  it("SDK 参数失败不挤占正文修正机会，缺少原生批次时不臆测重试轮数", () => {
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolName: "analysis_read",
        toolCallId: "read",
        content: [],
        timestamp: 0,
        isError: false,
        details: { kind: "analysis_evidence", status: "succeeded" },
      },
      {
        role: "toolResult",
        toolName: CONVERSATION_REPLY,
        toolCallId: "wrong-exit",
        content: [],
        timestamp: 1,
        isError: true,
      },
      ...Array.from({ length: 2 }, (_, index): AgentMessage => ({
        role: "toolResult",
        toolName: "analysis_answer",
        toolCallId: `schema-${index}`,
        content: [],
        timestamp: index + 2,
        isError: true,
      })),
    ];
    expect(inquiryAnswerAttempts(messages)).toBe(0);
    expect(inquiryToolAdmission(messages, "analysis_answer")).toBeUndefined();
  });
  it("取数前的普通回复失败不能被后续取数清零", () => {
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolName: CONVERSATION_REPLY,
        toolCallId: "first-reply",
        details: { kind: "conversation_reply", status: "ARGUMENT_ERROR" },
        content: [],
        timestamp: 0,
        isError: true,
      },
      {
        role: "toolResult",
        toolName: "metric_query",
        toolCallId: "query",
        content: [],
        timestamp: 1,
        isError: false,
        details: { kind: "analysis_evidence", status: "succeeded" },
      },
      {
        role: "toolResult",
        toolName: CONVERSATION_REPLY,
        toolCallId: "wrong-exit",
        content: [],
        timestamp: 2,
        isError: true,
      },
      {
        role: "toolResult",
        toolName: "analysis_answer",
        toolCallId: "first-report",
        details: { kind: "analysis_answer", status: "ARGUMENT_ERROR" },
        content: [],
        timestamp: 3,
        isError: true,
      },
    ];
    expect(inquiryAnswerAttempts(messages)).toBe(2);
    expect(inquiryToolAdmission(messages, "analysis_answer")).toMatchObject({
      block: { terminate: true },
    });
  });
  it("无证据回复失败后仍只提供普通出口，上一轮证据不能改变本轮收尾", () => {
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolName: "metric_query",
        toolCallId: "old-query",
        content: [],
        timestamp: 0,
        isError: false,
        details: { kind: "analysis_evidence", status: "succeeded" },
      },
      { role: "user", content: "解释一下统计口径", timestamp: 1 },
      {
        role: "toolResult",
        toolName: CONVERSATION_REPLY,
        toolCallId: "first-reply",
        details: { kind: "conversation_reply", status: "ARGUMENT_ERROR" },
        content: [],
        timestamp: 2,
        isError: true,
      },
    ];
    const tools = [
      { function: { name: "analysis_answer" } },
      { function: { name: CONVERSATION_REPLY } },
    ];
    expect(inquiryAnswerAttempts(messages)).toBe(1);
    expect(inquiryPayload({ tools }, messages).tools).toEqual([tools[1]]);
  });
  it("总工具预算用尽后仅允许收尾，新的用户回合重新计算预算", () => {
    const exhausted: AgentMessage[] = Array.from({ length: 16 }, (_, index) => ({
      role: "toolResult",
      toolName: "metric_query",
      toolCallId: `query-${index}`,
      content: [],
      timestamp: 0,
      isError: false,
      details: { kind: "analysis_evidence", status: "succeeded" },
    }));
    const tools = [{ name: "metric_query" }, { name: "analysis_answer" }];
    expect(inquiryPayload({ tools }, exhausted).tools).toEqual([{ name: "analysis_answer" }]);
    expect(inquiryToolAdmission(exhausted, "metric_query")).toMatchObject({
      block: { terminate: false },
    });
    expect(inquiryToolAdmission(exhausted, "analysis_answer")).toBeUndefined();
    expect(
      inquiryToolAdmission(
        [...exhausted, { role: "user", content: "换一家机构", timestamp: 1 }],
        "metric_query",
      ),
    ).toBeUndefined();
  });
  it("被拒绝的错误出口仍占总工具预算，不形成无上限重试", () => {
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolName: "metric_query",
        toolCallId: "query",
        content: [],
        timestamp: 0,
        isError: false,
        details: { kind: "analysis_evidence", status: "succeeded" },
      },
      ...Array.from({ length: 15 }, (_, index): AgentMessage => ({
        role: "toolResult",
        toolName: CONVERSATION_REPLY,
        toolCallId: `wrong-exit-${index}`,
        content: [],
        timestamp: index + 1,
        isError: true,
      })),
    ];
    const tools = [
      { name: "metric_query" },
      { name: "analysis_answer" },
      { name: CONVERSATION_REPLY },
    ];
    expect(inquiryAnswerAttempts(messages)).toBe(0);
    expect(inquiryPayload({ tools }, messages).tools).toEqual([{ name: "analysis_answer" }]);
    expect(inquiryToolAdmission(messages, "metric_query")).toMatchObject({
      block: { terminate: false },
    });
    expect(inquiryToolAdmission(messages, "analysis_answer")).toBeUndefined();
  });
  it.each([
    "请确认截至2026年8月27日的客户统计口径。",
    "是近30天活跃客户数，还是个人有效贷款客户数？",
    "1. 个人贷款客户；2. 收单商户。请确认您指哪一种。",
  ])("日期、指标名称数字和编号不能阻断澄清：%s", (answer) => {
    expect(inquiryToolAdmission([], CONVERSATION_REPLY, { answer })).toBeUndefined();
  });
  it("只有目录检索时，预算耗尽仍提供澄清出口而不强行要求数值证据", () => {
    const exhausted: AgentMessage[] = Array.from({ length: 16 }, (_, index) => ({
      role: "toolResult",
      toolName: "metric_search",
      toolCallId: `search-${index}`,
      content: [],
      timestamp: 0,
      isError: false,
      details: { kind: "analysis_catalog", status: "succeeded" },
    }));
    const tools = [
      { name: "metric_query" },
      { name: "analysis_answer" },
      { name: CONVERSATION_REPLY },
    ];
    expect(inquiryPayload({ tools }, exhausted).tools).toEqual([{ name: CONVERSATION_REPLY }]);
    expect(inquiryToolAdmission(exhausted, CONVERSATION_REPLY)).toBeUndefined();
    expect(inquiryToolAdmission(exhausted, "metric_query")).toMatchObject({
      block: { terminate: false },
    });
  });
  it("已有真实取数结果时，不能改用普通回复绕过事实交付", () => {
    const queried: AgentMessage[] = [
      {
        role: "toolResult",
        toolName: "metric_query",
        toolCallId: "query",
        content: [],
        isError: false,
        timestamp: 0,
        details: { kind: "analysis_evidence", status: "succeeded" },
      },
    ];
    expect(
      inquiryToolAdmission(queried, CONVERSATION_REPLY, { answer: "余额为未经核验的值。" }),
    ).toMatchObject({ block: { terminate: false } });
  });
  it("普通说明允许没有业务数值的编号步骤", () => {
    expect(
      inquiryToolAdmission([], CONVERSATION_REPLY, {
        answer: "1. 请说明机构。\n2. 请说明统计期。",
      }),
    ).toBeUndefined();
  });
  it.each(["metric_query", "analysis_answer", CONVERSATION_REPLY])(
    "终态后阻止同批尾随工具：%s",
    (name) => {
      const messages: AgentMessage[] = [
        {
          role: "toolResult",
          toolName: "analysis_answer",
          toolCallId: "done",
          content: [],
          details: { kind: "business_report", status: "succeeded" },
          timestamp: 0,
          isError: false,
        },
      ];
      expect(inquiryToolAdmission(messages, name)).toMatchObject({ block: { terminate: true } });
    },
  );
});

describe("连续无进展的原生工具批次", () => {
  function batch(
    id: string,
    results: Array<{
      name?: string;
      failed?: boolean;
      details?: unknown;
      args?: Record<string, unknown>;
    }>,
    pending = 0,
  ): AgentMessage[] {
    const calls = results.map((result, index) => ({
      type: "toolCall" as const,
      id: `${id}-${index}`,
      name: result.name ?? "metric_query",
      arguments: result.args ?? {},
    }));
    return [
      {
        role: "assistant",
        content: calls,
        api: "openai-completions",
        provider: "isolated",
        model: "isolated",
        stopReason: "toolUse",
        timestamp: 0,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
      ...results.slice(0, results.length - pending).map((result, index): AgentMessage => ({
        role: "toolResult",
        toolCallId: `${id}-${index}`,
        toolName: result.name ?? "metric_query",
        content: [],
        timestamp: 0,
        isError: result.failed ?? true,
        details: result.details,
      })),
    ];
  }

  it("局部重复计算只拒绝原输入，正常取数及修正引用仍进入工具执行", () => {
    const args = { current_ref: "e1.v1", base_ref: "e1.v2" };
    const failure = {
      name: "analysis_calculate",
      args,
      details: {
        kind: "metric_calculate",
        status: "error",
        calculation_key: "old-key",
        error_code: "ANALYSIS_CALCULATION_METRIC_MISMATCH",
      },
    };
    const messages = [...batch("first", [failure]), ...batch("second", [failure])];
    expect(inquiryBudgetExhausted(messages)).toBe(false);
    expect(inquiryToolAdmission(messages, "analysis_calculate", args)).toMatchObject({
      block: { terminate: false },
    });
    expect(inquiryToolAdmission(messages, "metric_query", { metric_refs: ["k2"] })).toBeUndefined();
    expect(
      inquiryToolAdmission(messages, "analysis_calculate", { ...args, base_ref: "e2.v1" }),
    ).toBeUndefined();
    const tools = [{ name: "metric_query" }, { name: "analysis_calculate" }];
    expect(inquiryPayload({ tools }, messages).tools).toEqual([tools[0]]);
    const next = batch("next", [{ args: { metric_refs: ["k2"] } }])[0];
    if (next?.role !== "assistant") throw new Error("缺少下一次调用");
    expect(
      inquiryResponse(
        { ...next, stopReason: "toolUse" },
        testRequestContext({} as BackendClient, new MemoryCommandBridge()),
        messages,
      ),
    ).toEqual(next);
  });

  it("第三次原输入失败不结束整轮，预算内仍能换工具和修正参数", () => {
    const messages = [...batch("first", [{}]), ...batch("second", [{}])];
    const next = batch("third", [{}])[0];
    if (next?.role !== "assistant") throw new Error("缺少下一次调用");
    const request = testRequestContext({} as BackendClient, new MemoryCommandBridge());
    expect(inquiryResponse({ ...next, stopReason: "toolUse" }, request, messages)).toEqual(next);
    expect(inquiryToolAdmission(messages, "metric_query", {})).toMatchObject({ block: { terminate: false } });
    expect(inquiryToolAdmission(messages, "metric_search", { keywords: ["余额"] })).toBeUndefined();
    expect(inquiryToolAdmission(messages, "metric_query", { metric_refs: ["k1"] })).toBeUndefined();
  });

  it("SDK参数失败计入总预算，失败耗尽后不能用操作承诺标记回答成功", () => {
    const messages = Array.from({ length: 16 }, (_, index) => batch(`schema-${index}`, [{}])).flat();
    const next = batch("reply", [{ name: CONVERSATION_REPLY, args: { answer: "请稍等，我将为您执行查询。" } }])[0];
    if (next?.role !== "assistant") throw new Error("缺少下一次调用");
    const request = testRequestContext({} as BackendClient, new MemoryCommandBridge());
    expect(inquiryResponse({ ...next, stopReason: "toolUse" }, request, messages).content).toEqual([{
      type: "toolCall", id: `inquiry-recovery-${request.operationId}`,
      name: CONVERSATION_REPLY, arguments: { answer: "本次未能完成回答，请稍后重试。" },
    }]);
  });

  it.each(["ambiguous", "missing", "not_found", "needs_confirmation"])("预算结束时%s仍允许依据真实候选澄清", (resolution_status) => {
    const messages = Array.from({ length: 15 }, (_, index) => batch(`schema-${index}`, [{}])).flat();
    messages.push(...batch("resolve", [{ details: {
      kind: "inquiry_query_error", status: "error", code: "ANALYSIS_SCOPE_UNRESOLVED", resolution_status,
    } }]));
    const next = batch("reply", [{ name: CONVERSATION_REPLY, args: { answer: "请确认需要哪家机构。" } }])[0];
    if (next?.role !== "assistant") throw new Error("缺少下一次调用");
    const request = testRequestContext({} as BackendClient, new MemoryCommandBridge());
    expect(inquiryResponse({ ...next, stopReason: "toolUse" }, request, messages)).toEqual(next);
  });

  it("预算内格式失败仍可澄清，成功目录检索后仍能解释口径", () => {
    const next = batch("reply", [{ name: CONVERSATION_REPLY, args: { answer: "请确认需要期末余额还是日均余额。" } }])[0];
    if (next?.role !== "assistant") throw new Error("缺少下一次调用");
    const request = testRequestContext({} as BackendClient, new MemoryCommandBridge());
    const failed = batch("schema", [{}]);
    expect(inquiryResponse({ ...next, stopReason: "toolUse" }, request, failed)).toEqual(next);
    const catalog = Array.from({ length: 15 }, (_, index) => batch(`catalog-${index}`, [{
      name: "metric_search", failed: false, details: { kind: "analysis_catalog", status: "succeeded" },
    }])).flat();
    expect(inquiryResponse({ ...next, stopReason: "toolUse" }, request, [...failed, ...catalog])).toEqual(next);
  });

  it.each([false, true])("重复参数失败后保留修正输入，混合批=%s", (mixed) => {
    const messages = [...batch("first", [{}]), ...batch("second", [{}])];
    const next = batch("next", [...(mixed ? [{}] : []), { args: { metric_refs: ["k1"] } }])[0];
    if (next?.role !== "assistant") throw new Error("缺少下一次调用");
    expect(
      inquiryResponse(
        { ...next, stopReason: "toolUse" },
        testRequestContext({} as BackendClient, new MemoryCommandBridge()),
        messages,
      ),
    ).toEqual(next);
  });

  it.each([
    { name: "metric_search", args: { keywords: ["理财"], page: 1 }, kind: "analysis_catalog" },
    {
      name: "metric_availability",
      args: { metric_refs: ["k1"], start: "2026-01-01", end: "2026-06-30" },
      kind: "data_availability",
    },
  ])("局部重复成功回执只限制原请求：$name", ({ name, args, kind }) => {
    const result = {
      name,
      args,
      failed: false,
      details: { kind, status: "succeeded", no_new_evidence: true },
    };
    const messages = [...batch("first", [result]), ...batch("second", [result])];
    expect(inquiryToolAdmission(messages, name, args)).toMatchObject({
      block: { terminate: false },
    });
    expect(inquiryToolAdmission(messages, "metric_query", { metric_refs: ["k1"] })).toBeUndefined();
    expect(inquiryToolAdmission(messages, name, { ...args, page: 2 })).toBeUndefined();
  });

  it("局部重复不能用旧校验阶段遮住新日期换算和目标修正", () => {
    const args = { target_change: { mode: "new", topic: "理财", date: "这半年" } };
    const details = {
      kind: "inquiry_query_error",
      status: "error",
      code: "ANALYSIS_DATE_UNRESOLVED",
      correction_fields: [],
      validation_stage: "target_new:date,organizations",
      target_ref: "old",
    };
    const messages = [
      ...batch("first", [{ args, details }]),
      ...batch("second", [{ args, details }]),
    ];
    expect(inquiryToolAdmission(messages, "metric_query", args)).toHaveProperty("block");
    expect(
      inquiryToolAdmission(messages, "metric_query", {
        ...args,
        date_calendar: { start: "2026-05-01", end: "2026-10-31" },
      }),
    ).toBeUndefined();
    expect(
      inquiryToolAdmission(messages, "metric_query", {
        target_change: {
          ...args.target_change,
          organizations: { mode: "replace", scope: "named", names: ["紫金"] },
        },
      }),
    ).toBeUndefined();
  });

  it("同一输入在两个完成批次失败后局部拒绝，新的用户回合重新计算", () => {
    const args = { metric_refs: ["k1"], date: "2026-08-27" };
    const result = { args };
    const messages = [...batch("first", [result]), ...batch("second", [result, result])];
    expect(inquiryToolAdmission(messages, "metric_query", args)).toMatchObject({
      block: { terminate: false },
    });
    expect(
      inquiryToolAdmission(
        [...messages, { role: "user", content: "新问题", timestamp: 1 }],
        "metric_query",
        args,
      ),
    ).toBeUndefined();
    expect(inquiryToolAdmission(messages, "metric_query")).toBeUndefined();
  });

  it("同批重复与尚未完成的批次不算两次尝试", () => {
    const args = { metric_refs: ["k1"] },
      result = { args };
    expect(
      inquiryToolAdmission(batch("parallel", [result, result, result]), "metric_query", args),
    ).toBeUndefined();
    expect(
      inquiryToolAdmission(
        [...batch("first", [result]), ...batch("pending", [result, result], 1)],
        "metric_query",
        args,
      ),
    ).toBeUndefined();
    const orphaned = batch("orphaned", [result, result]).slice(1);
    expect(inquiryToolAdmission(orphaned, "metric_query", args)).toBeUndefined();
  });

  it("来源复用不跨工具或不同实际查询合并为整题停滞", () => {
    const details = {
      kind: "inquiry_query_reuse",
      status: "succeeded",
      no_new_evidence: true,
      run_ref: "run-1",
    };
    const args = { metric_refs: ["k1"], date: "latest" };
    const query = { args, failed: false, details };
    const read = { name: "analysis_read", args: { run_ref: "run-1" }, failed: false, details };
    const messages = [...batch("query", [query]), ...batch("read", [read])];
    expect(inquiryToolAdmission(messages, "metric_query", args)).toBeUndefined();
    const repeated = [...messages, ...batch("query-again", [query])];
    expect(inquiryToolAdmission(repeated, "metric_query", args)).toHaveProperty("block");
    expect(inquiryToolAdmission(repeated, "analysis_read", read.args)).toBeUndefined();
    expect(
      inquiryToolAdmission(repeated, "metric_query", { ...args, date: "2026-07-31" }),
    ).toBeUndefined();
  });

  it("多来源全部复用只限制原调用，缺少指标补回后解除旧计数", () => {
    const args = { metric_refs: ["k1", "k2"] };
    const result = {
      args,
      failed: false,
      details: {
        kind: "semantic_results",
        status: "succeeded",
        no_new_evidence: true,
        evidence_refs: ["e1", "e2"],
        query_progress: { requested_metric_codes: ["M1", "M2"] },
      },
    };
    const messages = [...batch("first", [result]), ...batch("repeat", [result])];
    expect(inquiryToolAdmission(messages, "metric_query", args)).toHaveProperty("block");
    expect(inquiryToolAdmission(messages, "metric_query", { metric_refs: ["k3"] })).toBeUndefined();
    const progress = batch("new-facts", [
      {
        failed: false,
        details: {
          kind: "semantic_results",
          status: "partial",
          results: [{ kind: "analysis_evidence", status: "succeeded", run_ref: "new" }],
        },
      },
    ]);
    expect(
      inquiryToolAdmission(
        [...messages, ...progress, ...batch("retry", [result])],
        "metric_query",
        args,
      ),
    ).toBeUndefined();
  });

  it.each(["analysis_catalog", "data_availability"])(
    "重复%s回执不重置失败计数，新查询成功才解除",
    (kind) => {
      const args = { current_ref: "e1.v1", base_ref: "e1.v2" };
      const failed = { name: "analysis_calculate", args };
      const reused = {
        name: kind === "analysis_catalog" ? "metric_search" : "metric_availability",
        args: {},
        failed: false,
        details: { kind, status: "succeeded", no_new_evidence: true },
      };
      const messages = [
        ...batch("first", [failed]),
        ...batch("reused", [reused]),
        ...batch("second", [failed]),
      ];
      expect(inquiryToolAdmission(messages, "analysis_calculate", args)).toHaveProperty("block");
      const progress = batch("progress", [
        { failed: false, details: { kind: "analysis_evidence", status: "succeeded" } },
      ]);
      expect(
        inquiryToolAdmission(
          [...messages, ...progress, ...batch("retry", [failed])],
          "analysis_calculate",
          args,
        ),
      ).toBeUndefined();
    },
  );

  it.each([
    { focus: { org_code: "A", metric_codes: ["M2"] } },
    { focus: { org_code: "B", metric_codes: ["M1"] } },
    { focus: { org_code: "A", metric_codes: ["M1"], offset: 50 } },
  ])("analysis_read保留focus实际变化，不用旧来源键遮住新页：%j", (changed) => {
    const args = { run_ref: "run-1", focus: { org_code: "A", metric_codes: ["M1"] } };
    const reused = {
      name: "analysis_read",
      args,
      failed: false,
      details: {
        kind: "inquiry_query_reuse",
        status: "succeeded",
        no_new_evidence: true,
        run_ref: "run-1",
      },
    };
    const messages = [...batch("first", [reused]), ...batch("second", [reused])];
    expect(inquiryToolAdmission(messages, "analysis_read", args)).toHaveProperty("block");
    expect(
      inquiryToolAdmission(messages, "analysis_read", { ...args, ...changed }),
    ).toBeUndefined();
  });

  it("首次focus回读的新增可见事实解除旧计数", () => {
    const args = { run_ref: "run-1" };
    const reuse = {
      name: "analysis_read",
      args,
      failed: false,
      details: { kind: "inquiry_query_reuse", status: "succeeded", no_new_evidence: true },
    };
    const messages = [
      ...batch("first", [reuse]),
      ...batch("second", [reuse]),
      ...batch("focus", [
        {
          ...reuse,
          args: { ...args, focus: { org_code: "A", metric_codes: ["M1"] } },
          details: { ...reuse.details, topic_slice_key: "new-slice" },
        },
      ]),
      ...batch("retry", [reuse]),
    ];
    expect(inquiryToolAdmission(messages, "analysis_read", args)).toBeUndefined();
  });

  it.each([
    { org_names: ["江南"] },
    { date: "2026-07-31" },
    { metric_refs: ["k2"] },
    { method: "compare", comparisons: ["yoy"] },
    { target_ref: "target-new" },
    { date_calendar: { start: "2026-01-01", end: "2026-06-30", dates: ["2026-06-30"] } },
  ])("查询实际条件改变先重新校验，不沿用旧错误阶段：%j", (changed) => {
    const args = {
      metric_refs: ["k1"],
      scope: "named",
      org_names: ["紫金"],
      date: "这半年",
      method: "observe",
    };
    const details = {
      kind: "inquiry_query_error",
      status: "error",
      code: "ANALYSIS_BINDING_INVALID",
      correction_fields: ["metric_refs"],
      target_ref: "old-target",
      validation_stage: "binding_resolution",
    };
    const messages = [
      ...batch("first", [{ args, details }]),
      ...batch("second", [{ args, details }]),
    ];
    expect(inquiryToolAdmission(messages, "metric_query", { ...args, ...changed })).toBeUndefined();
    expect(inquiryToolAdmission(messages, "metric_query", args)).toHaveProperty("block");
  });

  it.each([
    { topic: "贷款" },
    { mode: "update", base_ref: "other-target" },
    { date: "上个月" },
    { date_calendar: { start: "2026-05-01", end: "2026-10-31" } },
    { organizations: { mode: "add", scope: "named", names: ["江南"] } },
  ])("target_change完整参数变化仍可校验：%j", (changed) => {
    const target = {
      mode: "new",
      topic: "存款",
      date: "这半年",
      organizations: { mode: "replace", scope: "named", names: ["紫金"] },
    };
    const args = { target_change: target },
      details = {
        kind: "inquiry_query_error",
        status: "error",
        code: "INQUIRY_TARGET_INVALID",
        correction_fields: [],
        validation_stage: "target_new:date",
      };
    const messages = [
      ...batch("first", [{ args, details }]),
      ...batch("second", [{ args, details }]),
    ];
    expect(
      inquiryToolAdmission(messages, "metric_query", { target_change: { ...target, ...changed } }),
    ).toBeUndefined();
  });

  it("正式指标别名可归一，未知引用和重复次数不被错误折叠", () => {
    const details = {
      kind: "inquiry_query_error",
      status: "error",
      code: "ANALYSIS_BINDING_INVALID",
      binding_map: { k1: "binding-1", "code:M1": "binding-1", k2: "binding-2" },
    };
    const messages = [
      ...batch("first", [{ args: { metric_refs: ["k1", "k2"] }, details }]),
      ...batch("second", [{ args: { metric_refs: ["k2", "M1"] }, details }]),
    ];
    expect(
      inquiryToolAdmission(messages, "metric_query", { metric_refs: ["M1", "k2"] }),
    ).toHaveProperty("block");
    expect(
      inquiryToolAdmission(messages, "metric_query", { metric_refs: ["k1", "k1", "k2"] }),
    ).toBeUndefined();
    expect(
      inquiryToolAdmission(messages, "metric_query", { metric_refs: ["binding-1", "k2"] }),
    ).toBeUndefined();
    expect(
      inquiryToolAdmission(messages, "metric_query", { metric_refs: ["unknown", "k2"] }),
    ).toBeUndefined();
  });

  it("正式绑定版本变化后，旧失败不能拒绝新版本输入", () => {
    const args = { metric_refs: ["k1"] };
    const details = {
      kind: "inquiry_query_error",
      status: "error",
      binding_map: { k1: "version-1", "code:M1": "version-1" },
    };
    const messages = [
      ...batch("first", [{ args, details }]),
      ...batch("second", [{ args, details }]),
    ];
    expect(inquiryToolAdmission(messages, "metric_query", args)).toHaveProperty("block");
    const changed = { ...details, binding_map: { k1: "version-2", "code:M1": "version-2" } };
    expect(
      inquiryToolAdmission(
        [...messages, ...batch("new-version", [{ args, details: changed }])],
        "metric_query",
        args,
      ),
    ).toBeUndefined();
    const catalog = batch("catalog", [
      {
        name: "metric_search",
        failed: false,
        details: { ...changed, kind: "analysis_catalog", status: "succeeded" },
      },
    ]);
    expect(inquiryToolAdmission([...messages, ...catalog], "metric_query", args)).toBeUndefined();
  });

  it("未知参数变化先交执行器校验，参数键顺序不产生新请求", () => {
    const args = { current_ref: "e1.v1", base_ref: "e1.v2" };
    const result = { name: "analysis_calculate", args };
    const messages = [
      ...batch("first", [result]),
      ...batch("second", [{ ...result, args: { base_ref: "e1.v2", current_ref: "e1.v1" } }]),
    ];
    expect(inquiryToolAdmission(messages, "analysis_calculate", args)).toHaveProperty("block");
    expect(
      inquiryToolAdmission(messages, "analysis_calculate", { ...args, extra: true }),
    ).toBeUndefined();
    expect(inquiryToolAdmission(messages, "analysis_calculate", null)).toBeUndefined();
  });

  it("原生null参数失败不能阻断修正输入", () => {
    const messages = batch("invalid", [{ name: "analysis_calculate" }]);
    const assistant = messages[0];
    if (assistant?.role !== "assistant") throw new Error("缺少调用");
    const call = assistant.content.find((block) => block.type === "toolCall");
    if (!call) throw new Error("缺少调用");
    Object.assign(call, { arguments: null });
    expect(
      inquiryToolAdmission(messages, "analysis_calculate", {
        current_ref: "e1.v1",
        base_ref: "e1.v2",
      }),
    ).toBeUndefined();
  });

  it("同批有成功补查时解除旧失败，下一次失败仍可修正", () => {
    const args = { metric_refs: ["k1"] },
      failed = { args };
    const messages = [
      ...batch("first", [failed]),
      ...batch("progress", [
        failed,
        { failed: false, details: { kind: "analysis_evidence", status: "succeeded" } },
        failed,
      ]),
      ...batch("retry", [failed]),
    ];
    expect(inquiryToolAdmission(messages, "metric_query", args)).toBeUndefined();
  });

  it("主题真实绑定失败只限制已重复的实际请求，允许日期换算和其他主题重验", async () => {
    const registry = loadTopicRegistry(),
      [firstTopic, secondTopic] = registry.topics;
    const query = createInquiryQueryTools().find((tool) => tool.name === "metric_query");
    if (!firstTopic || !secondTopic || !query) throw new Error("缺少主题或工具");
    const backend = new BackendClient("https://backend.test.invalid", "test-token", 100);
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("禁止实际网络访问"));
    const binding = vi.spyOn(backend, "analysisBindMetrics").mockImplementation((codes) =>
      Promise.resolve({
        items: Object.values(registry.metrics)
          .filter((metric) => codes.includes(metric.code))
          .map((metric) => ({ ...metric, binding_ref: "duplicate-binding" })),
        missing_codes: [],
      }),
    );
    const messages: AgentMessage[] = [];
    const request = testRequestContext(backend, new MemoryCommandBridge(), {
      turnMessages: () => Promise.resolve(messages),
    });
    const topic = createTopicQueryTool(query, registry);
    const args = { topic_id: firstTopic.id, scope: "named", org_names: ["org-1"], date: "这半年" };
    try {
      for (const id of ["first", "second"]) {
        const result = (await runTool(topic, args, request)) as AgentToolResult<unknown>;
        expect(result).toMatchObject({
          isError: true,
          details: { code: "ANALYSIS_BINDING_INVALID" },
        });
        messages.push(...batch(id, [{ name: "topic_query", args, details: result.details }]));
      }
      expect(inquiryToolAdmission(messages, "topic_query", args)).toHaveProperty("block");
      expect(
        inquiryToolAdmission(messages, "topic_query", { ...args, topic_id: secondTopic.id }),
      ).toBeUndefined();
      expect(
        inquiryToolAdmission(messages, "topic_query", {
          ...args,
          date_calendar: { start: "2026-05-01", end: "2026-10-31" },
        }),
      ).toBeUndefined();
    } finally {
      binding.mockRestore();
      network.mockRestore();
    }
  });

  it("参数通过后转入正文校验属于有效修正，仍保留下一次正文机会", () => {
    const messages = [
      ...batch("schema", [{ name: "analysis_answer" }]),
      ...batch("body", [
        {
          name: "analysis_answer",
          details: {
            kind: "analysis_answer",
            status: "ARGUMENT_ERROR",
            error_code: "ANALYSIS_REPORT_NUMBER",
          },
        },
      ]),
    ];
    expect(inquiryAnswerAttempts(messages)).toBe(1);
    expect(inquiryToolAdmission(messages, "analysis_answer")).toBeUndefined();
  });

  it("同类前置错误连续重复也会收敛，但不伪装成正文修正已耗尽", () => {
    const result = {
      name: "analysis_answer",
      details: {
        kind: "analysis_answer",
        status: "ARGUMENT_ERROR",
        validation_stage: "prerequisite",
        error_code: "INQUIRY_TARGET_INCOMPLETE",
      },
    };
    const messages = [...batch("first", [result]), ...batch("second", [result])];
    expect(inquiryAnswerAttempts(messages)).toBe(0);
    expect(inquiryToolAdmission(messages, "analysis_answer")).toMatchObject({
      block: { terminate: true },
    });
  });

  it("交付失败批次调换顺序或增加同类调用不重置原有收敛保护", () => {
    const first = {
      name: "analysis_answer",
      details: {
        kind: "analysis_answer",
        status: "ARGUMENT_ERROR",
        validation_stage: "prerequisite",
        error_code: "INQUIRY_TARGET_INCOMPLETE",
      },
    };
    const second = {
      ...first,
      details: { ...first.details, error_code: "ANALYSIS_REPORT_EVIDENCE" },
    };
    const messages = [
      ...batch("first", [first, second]),
      ...batch("second", [second, first, first]),
    ];
    expect(inquiryAnswerAttempts(messages)).toBe(0);
    expect(inquiryToolAdmission(messages, "analysis_answer")).toMatchObject({
      block: { terminate: true },
    });
  });
});

describe("调查预算关闭后的目标缺口恢复", () => {
  const source = {
    kind: "analysis_evidence",
    status: "succeeded",
    execution_turn_id: "op-1",
    run_ref: "run-current",
    org_codes: ["A"],
    tasks: [],
    evidence_items: [],
  };
  const receipt = (toolName: string, details: unknown, isError = false): AgentMessage => ({
    role: "toolResult",
    toolName,
    toolCallId: `${toolName}-receipt`,
    content: [],
    timestamp: 0,
    details,
    isError,
  });
  const missing = receipt(
    "analysis_answer",
    {
      kind: "analysis_answer",
      status: "ARGUMENT_ERROR",
      retryable: true,
      validation_stage: "prerequisite",
      error_code: "INQUIRY_TARGET_INCOMPLETE",
      target_coverage: { complete: false, covered_org_codes: ["A"], missing_org_codes: ["B"] },
    },
    true,
  );
  const queried = (count = 16): AgentMessage[] =>
    Array.from({ length: count }, (_, index) => ({
      ...receipt("metric_query", source),
      toolCallId: `query-${index}`,
    }));
  const answer: AssistantMessage & { stopReason: "toolUse" } = {
    role: "assistant",
    api: "openai-completions",
    provider: "isolated",
    model: "isolated",
    content: [
      {
        type: "toolCall",
        id: "next-answer",
        name: "analysis_answer",
        arguments: { body: "未经核验的归因。" },
      },
    ],
    timestamp: 0,
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
  const backend = () => new BackendClient("https://backend.test.invalid", "test-token", 100);
  const requestFor = (messages: AgentMessage[]) =>
    testRequestContext(backend(), new MemoryCommandBridge(), {
      executionFlow: "inquiry_v1",
      turnMessages: () => Promise.resolve(messages),
      answerEvidence: () => Promise.resolve([{ ref: "e1", evidence: source }]),
    });

  it("首次目标覆盖失败后转既有部分交付，不再重交必然失败的正文", async () => {
    const messages = [...queried(), missing];
    const request = requestFor(messages);
    const response = inquiryResponse(answer, request, messages);
    expect(response.content).toEqual([
      {
        type: "toolCall",
        id: "inquiry-recovery-op-1",
        name: PARTIAL_ANALYSIS,
        arguments: { reason: "action_incomplete" },
      },
    ]);
    const call = response.content[0];
    if (call?.type !== "toolCall") throw new Error("缺少部分交付调用");
    expect(
      inquiryToolAdmission(messages, call.name, call.arguments, {
        operationId: request.operationId,
        toolCallId: call.id,
      }),
    ).toBeUndefined();
    expect(
      inquiryToolAdmission(messages, call.name, call.arguments, {
        operationId: request.operationId,
        toolCallId: "untrusted-call",
      }),
    ).toHaveProperty("block");
    const report = vi.spyOn(request.backend, "analysisReport").mockResolvedValue({
      kind: "business_report",
      status: "succeeded",
      public_answer: "甲机构余额为 100 元。",
      report: { summary: "甲机构余额为 100 元。", sections: [] },
      gaps: ["乙机构该日暂无数据。"],
    });
    try {
      const result = (await runTool(
        createPartialAnalysisTool(),
        call.arguments,
        request,
      )) as AgentToolResult<Record<string, unknown>>;
      expect(report).toHaveBeenCalledWith(
        { run_refs: ["run-current"], summary: "", sections: [], fallback: true },
        { signal: undefined },
      );
      expect(result).toMatchObject({
        terminate: true,
        details: {
          status: "succeeded",
          partial_analysis: true,
          fallback_reason: "action_incomplete",
        },
      });
      expect(result.details.public_answer).toContain("100 元");
      expect(result.details.public_answer).toContain("乙机构该日暂无数据");
      expect(result.details.public_answer).toContain("原问题尚未完整分析");
      expect(result.details.public_answer).not.toContain("未经核验的归因");
      const delivered = [...messages, receipt(PARTIAL_ANALYSIS, result.details)];
      expect(inquiryRecoveryAvailable(delivered, request.operationId)).toBe(false);
    } finally {
      report.mockRestore();
    }
  });

  it("预算内的目标缺口仍允许定向补查", () => {
    const messages = [...queried(2), missing];
    const request = requestFor(messages);
    const query = {
      ...answer,
      content: [
        {
          type: "toolCall" as const,
          id: "fill-gap",
          name: "metric_query",
          arguments: { org_names: ["乙机构"], metric_refs: ["k1"] },
        },
      ],
    };
    expect(inquiryResponse(query, request, messages)).toEqual(query);
    expect(
      inquiryToolAdmission(messages, "metric_query", query.content[0]?.arguments),
    ).toBeUndefined();
  });

  it.each(["ANALYSIS_REPORT_REFERENCE", "ANALYSIS_REPORT_SCOPE", "ANALYSIS_FORBIDDEN"])(
    "已有%s未解决时不得借目标缺口恢复",
    (code) => {
      const messages = [
        ...queried(),
        receipt(
          "analysis_answer",
          {
            kind: "analysis_answer",
            status: "ARGUMENT_ERROR",
            error_code: code,
          },
          true,
        ),
        missing,
      ];
      const request = requestFor(messages);
      expect(inquiryResponse(answer, request, messages).content).not.toEqual([
        expect.objectContaining({ name: PARTIAL_ANALYSIS }),
      ]);
      expect(
        inquiryToolAdmission(
          messages,
          PARTIAL_ANALYSIS,
          { reason: "action_incomplete" },
          {
            operationId: request.operationId,
            toolCallId: "inquiry-recovery-op-1",
          },
        ),
      ).toHaveProperty("block");
    },
  );

  it("只有历史读取结果时不铺开旧分析；正文错误仍走原纠错通道", () => {
    const history = Array.from({ length: 16 }, () =>
      receipt("analysis_read", {
        ...source,
        execution_turn_id: "old-op",
        result_reused: true,
      }),
    );
    expect(inquiryResponse(answer, requestFor(history), [...history, missing])).toEqual(answer);
    const invalid = [
      ...queried(),
      receipt(
        "analysis_answer",
        {
          kind: "analysis_answer",
          status: "ARGUMENT_ERROR",
          error_code: "ANALYSIS_REPORT_NUMBER",
        },
        true,
      ),
    ];
    expect(inquiryResponse(answer, requestFor(invalid), invalid)).toEqual(answer);
  });

  it.each([401, 403])("部分交付仍重新鉴权，后端%s拒绝不会输出已有数值", async (status) => {
    const messages = [...queried(), missing];
    const request = requestFor(messages);
    const response = inquiryResponse(answer, request, messages);
    const call = response.content[0];
    expect(call).toMatchObject({ type: "toolCall", name: PARTIAL_ANALYSIS });
    if (call?.type !== "toolCall") throw new Error("缺少部分交付调用");
    const report = vi
      .spyOn(request.backend, "analysisReport")
      .mockRejectedValue(new BackendApiError(status, "无权读取该结果", "ANALYSIS_FORBIDDEN"));
    try {
      await expect(
        runTool(createPartialAnalysisTool(), call.arguments, request),
      ).rejects.toMatchObject({
        status,
        code: "ANALYSIS_FORBIDDEN",
      });
    } finally {
      report.mockRestore();
    }
  });
});
