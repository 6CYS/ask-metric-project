import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  inquiryAnswerAttempts,
  inquiryBudgetExhausted,
  inquiryPayload,
  inquiryRecoveryAvailable,
  inquirySystemPrompt,
  inquiryToolAdmission,
} from "../src/inquiry/runtime.js";
import { CONVERSATION_REPLY } from "../src/tools/turnContract.js";

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
      expect(prompt).toContain("chart结构");
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
    results: Array<{ name?: string; failed?: boolean; details?: unknown; args?: Record<string, unknown> }>,
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

  it("相同失败连续两个完成批次后收敛，新的用户回合重新计算", () => {
    const messages = [...batch("first", [{}]), ...batch("second", [{}, {}])];
    expect(inquiryToolAdmission(messages, "metric_query")).toMatchObject({
      block: { terminate: false },
    });
    expect(
      inquiryToolAdmission(
        [...messages, { role: "user", content: "新问题", timestamp: 1 }],
        "metric_query",
      ),
    ).toBeUndefined();
  });

  it("调查停滞只保留正文工具，可靠事实尚未耗尽交付预算", () => {
    const failed = {
      name: "analysis_calculate",
      details: {
        kind: "metric_calculate",
        status: "error",
        error_code: "ANALYSIS_CALCULATION_SOURCE",
      },
    };
    const messages = [
      ...batch("query", [
        { failed: false, details: { kind: "analysis_evidence", status: "succeeded" } },
      ]),
      ...batch("first", [failed]),
      ...batch("second", [failed]),
    ];
    expect(inquiryBudgetExhausted(messages)).toBe(false);
    expect(
      inquiryPayload(
        {
          tools: [
            { name: "metric_query" },
            { name: "analysis_calculate" },
            { name: "analysis_answer" },
            { name: CONVERSATION_REPLY },
          ],
        },
        messages,
      ).tools,
    ).toEqual([{ name: "analysis_answer" }]);
    expect(inquiryToolAdmission(messages, "analysis_answer")).toBeUndefined();
    expect(inquiryToolAdmission(messages, "metric_query")).toHaveProperty("block");
    expect(inquiryToolAdmission(messages, "analysis_calculate")).toHaveProperty("block");
  });

  it("同批多个参数失败或仍待返回的调用不能耗尽多轮修正机会", () => {
    expect(inquiryToolAdmission(batch("parallel", [{}, {}, {}]), "metric_query")).toBeUndefined();
    expect(
      inquiryToolAdmission(
        [...batch("first", [{}]), ...batch("pending", [{}, {}, {}], 1)],
        "metric_query",
      ),
    ).toBeUndefined();
  });

  it("同类计算错误但输入已经修正时，仍允许补查及后续计算", () => {
    const details = {kind: "metric_calculate", status: "error", error_code: "ANALYSIS_CALCULATION_METRIC_MISMATCH", retryable: false};
    const messages = [...batch("first", [{name: "analysis_calculate", args: {current_ref: "e1.v2", base_ref: "e1.v1"}, details}]),
      ...batch("second", [{name: "analysis_calculate", args: {current_ref: "e1.v5", base_ref: "e1.v4"}, details}])];
    expect(inquiryToolAdmission(messages, "metric_query")).toBeUndefined();
    expect(inquiryToolAdmission(messages, "analysis_calculate", {current_ref: "e2.v1", base_ref: "e2.v2"})).toBeUndefined();
    expect(inquiryPayload({tools: [{name: "metric_query"}, {name: "analysis_calculate"}]}, messages).tools)
      .toEqual([{name: "metric_query"}, {name: "analysis_calculate"}]);
  });

  it("原生参数校验拒绝 null 后仍允许补查和修正计算输入", () => {
    const messages = batch("invalid-null", [{name: "analysis_calculate"}]);
    const assistant = messages[0];
    if (assistant?.role !== "assistant") throw new Error("缺少原始工具调用");
    const call = assistant.content.find(block => block.type === "toolCall");
    if (!call) throw new Error("缺少计算调用");
    // Pi 会保留模型提交的原始 null 参数及对应的校验失败回执。
    Object.assign(call, {arguments: null});
    expect(inquiryToolAdmission(messages, "metric_query")).toBeUndefined();
    expect(inquiryToolAdmission(messages, "analysis_calculate", {current_ref: "e1.v1", base_ref: "e1.v2"})).toBeUndefined();
    expect(inquiryPayload({tools: [{name: "metric_query"}, {name: "analysis_calculate"}]}, messages).tools)
      .toEqual([{name: "metric_query"}, {name: "analysis_calculate"}]);
  });

  it("只是调换参数字段顺序的重复失败仍然收敛", () => {
    const details = {kind: "metric_calculate", status: "error", error_code: "ANALYSIS_CALCULATION_METRIC_MISMATCH", retryable: false};
    const messages = [...batch("first", [{name: "analysis_calculate", args: {current_ref: "e1.v2", base_ref: "e1.v1"}, details}]),
      ...batch("second", [{name: "analysis_calculate", args: {base_ref: "e1.v1", current_ref: "e1.v2"}, details}])];
    expect(inquiryToolAdmission(messages, "analysis_calculate")).toHaveProperty("block");
  });

  it("同批有成功补证据时解除连续失败，下一次错误仍允许修正", () => {
    const messages = [
      ...batch("first", [{}]),
      ...batch("progress", [
        {},
        { failed: false, details: { kind: "analysis_evidence", status: "succeeded" } },
        {},
      ]),
      ...batch("retry", [{}]),
    ];
    expect(inquiryToolAdmission(messages, "metric_query")).toBeUndefined();
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
});
