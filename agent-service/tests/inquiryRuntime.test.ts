import { describe, expect, it, vi } from "vitest";
import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import { BackendClient } from "../src/backendClient.js";
import { createInquiryQueryTools } from "../src/inquiry/queryTools.js";
import { createTopicQueryTool } from "../src/inquiry/topics/tool.js";
import { loadTopicRegistry } from "../src/inquiry/topics/registry.js";
import {
  inquiryAnswerAttempts,
  inquiryBudgetExhausted,
  inquiryPayload,
  inquiryRecoveryAvailable,
  inquirySystemPrompt,
  inquiryToolAdmission,
} from "../src/inquiry/runtime.js";
import { CONVERSATION_REPLY } from "../src/tools/turnContract.js";
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

  it("已完成主题的同一来源换指标子集仍无进展，其他来源不混算", () => {
    const details = {
      kind: "inquiry_query_reuse",
      status: "succeeded",
      no_new_evidence: true,
      run_ref: "topic-run-1",
      topic_execution: { completed: true, pending_metric_codes: [] },
    };
    const first = batch("first", [
      { failed: false, args: { metric_refs: ["k1"] }, details },
    ]);
    const changed = { failed: false, args: { metric_refs: ["k2"] }, details };
    expect(
      inquiryToolAdmission([...first, ...batch("subset", [changed])], "metric_query"),
    ).toHaveProperty("block");
    expect(
      inquiryToolAdmission(
        [...first, ...batch("other-source", [{
          ...changed, details: { ...details, run_ref: "topic-run-2" },
        }])],
        "metric_query",
      ),
    ).toBeUndefined();
  });

  it("主题 focus 真正补出省略事实后重置无进展，重复读取仍会收敛", () => {
    const reused = {
      name: "analysis_read",
      failed: false,
      args: { run_ref: "topic-run-1" },
      details: {
        kind: "inquiry_query_reuse",
        status: "succeeded",
        no_new_evidence: true,
        run_ref: "topic-run-1",
        topic_execution: { completed: true, pending_metric_codes: [] },
      },
    };
    const messages = [
      ...batch("reused", [reused]),
      ...batch("new-facts", [{
        name: "analysis_read",
        failed: false,
        args: { run_ref: "topic-run-1", focus: { org_code: "org-1", metric_codes: ["m1"] } },
        details: {
          kind: "inquiry_query_reuse",
          status: "succeeded",
          no_new_evidence: true,
          run_ref: "topic-run-1",
          topic_slice_key: '["topic-run-1","org-1",["m1"],0]',
        },
      }]),
      ...batch("after-progress", [reused]),
    ];
    expect(inquiryToolAdmission(messages, "analysis_read")).toBeUndefined();
    expect(
      inquiryToolAdmission([...messages, ...batch("unchanged", [reused])], "analysis_read"),
    ).toHaveProperty("block");
  });

  it.each([
    { topic_id: "deposit_structure" },
    { org_names: ["org-3"] },
    { date: "2026-07-31" },
  ])("主题实际执行条件修正保留补查，重复相同失败仍收敛：%j", (changed) => {
    const args = {
      topic_id: "profit",
      scope: "named",
      org_names: ["org-1", "org-2"],
      date: "2026-08-27",
    };
    const details = { kind: "inquiry_query_error", status: "error", code: "INQUIRY_QUERY_FAILED" };
    const first = batch("first", [{ name: "topic_query", args, details }]);
    const corrected = { name: "topic_query", args: { ...args, ...changed }, details };
    const messages = [...first, ...batch("corrected", [corrected])];
    expect(inquiryToolAdmission(messages, "topic_query")).toBeUndefined();
    expect(
      inquiryToolAdmission([...messages, ...batch("unchanged", [corrected])], "topic_query"),
    ).toHaveProperty("block");
    expect(
      inquiryToolAdmission([...first, ...batch("reordered", [{
        name: "topic_query", args: { ...args, org_names: ["org-2", "org-1"], title: "重试" }, details,
      }])], "topic_query"),
    ).toHaveProperty("block");
  });

  it("主题前置错误沿用校验阶段边界，改无关参数不能冒充纠错", () => {
    const args = { topic_id: "profit", scope: "named", org_names: ["org-1"], date: "inherit" };
    const details = {
      kind: "inquiry_query_error", status: "error", code: "INQUIRY_TARGET_INVALID",
      correction_fields: [], validation_stage: "target_new:date,organizations",
    };
    const first = batch("first", [{ name: "topic_query", args, details }]);
    const changed = { name: "topic_query", args: { ...args, topic_id: "deposit_structure" }, details };
    expect(inquiryToolAdmission([...first, ...batch("unrelated", [changed])], "topic_query"))
      .toHaveProperty("block");
    expect(inquiryToolAdmission([...first, ...batch("corrected", [{
      ...changed, details: { ...details, validation_stage: "target_new:date" },
    }])], "topic_query")).toBeUndefined();
  });

  it("主题透传指标绑定失败时，更换主题指标集可纠错但改日期不能", async () => {
    const registry = loadTopicRegistry();
    const [firstTopic, secondTopic] = registry.topics;
    const query = createInquiryQueryTools().find((tool) => tool.name === "metric_query");
    if (!firstTopic || !secondTopic || !query) throw new Error("缺少主题或查询工具");
    const backend = new BackendClient("https://backend.test.invalid", "test-token", 100);
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("禁止实际网络访问"));
    // 隔离目录异常触发真实查询校验；不伪造工具的失败回执。
    vi.spyOn(backend, "analysisBindMetrics").mockImplementation((codes) => Promise.resolve({
      items: Object.values(registry.metrics)
        .filter((metric) => codes.includes(metric.code))
        .map((metric) => ({ ...metric, binding_ref: "duplicate-binding" })),
      missing_codes: [],
    }));
    const messages: AgentMessage[] = [];
    const request = testRequestContext(backend, new MemoryCommandBridge(), {
      turnMessages: () => Promise.resolve(messages),
    });
    const topic = createTopicQueryTool(query, registry);
    const attempt = async (id: string, topicId: string, date = "2026-08-27") => {
      const args = { topic_id: topicId, scope: "named", org_names: ["org-1"], date };
      const result = (await runTool(topic, args, request)) as AgentToolResult<unknown>;
      expect(result).toMatchObject({
        isError: true,
        details: {
          code: "ANALYSIS_BINDING_INVALID",
          correction_fields: ["metric_refs"],
          validation_stage: "binding_duplicates",
        },
      });
      messages.push(...batch(id, [{ name: "topic_query", args, details: result.details }]));
    };
    try {
      await attempt("first", firstTopic.id);
      await attempt("unrelated-date", firstTopic.id, "2026-07-31");
      expect(inquiryToolAdmission(messages, "topic_query")).toHaveProperty("block");
      messages.splice(2);
      await attempt("different-metrics", secondTopic.id);
      expect(inquiryToolAdmission(messages, "topic_query")).toBeUndefined();
      await attempt("unchanged-metrics", secondTopic.id);
      expect(inquiryToolAdmission(messages, "topic_query")).toHaveProperty("block");
    } finally {
      network.mockRestore();
    }
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

  it.each([
    { org_names: ["江南农商行"] },
    { date: "2026-07-31" },
    { metric_refs: ["k2"] },
    { method: "compare", comparisons: ["yoy"] },
  ])("查询条件已调整、错误码相同时保留补查：%j", (changed) => {
    const args = {
      purpose: "核对利润",
      metric_refs: ["k1"],
      scope: "named",
      org_names: ["紫金农商行"],
      date: "2026-08-27",
      method: "observe",
    };
    const details = { kind: "inquiry_query_error", status: "error", code: "INQUIRY_QUERY_FAILED" };
    const messages = [
      ...batch("first", [{ args, details }]),
      ...batch("corrected", [{ args: { ...args, ...changed }, details }]),
    ];
    expect(inquiryToolAdmission(messages, "metric_query")).toBeUndefined();
    expect(
      inquiryPayload({ tools: [{ name: "metric_query" }, { name: CONVERSATION_REPLY }] }, messages)
        .tools,
    ).toContainEqual({ name: "metric_query" });
    expect(
      inquiryToolAdmission(
        [...messages, ...batch("unchanged", [{ args: { ...args, ...changed }, details }])],
        "metric_query",
      ),
    ).toHaveProperty("block");
  });

  it("改写目的、无关字段或条件集合顺序不产生查询进展", () => {
    const args = {
      purpose: "核对利润",
      metric_refs: ["k1", "k2"],
      scope: "named",
      org_names: ["紫金农商行", "江南农商行"],
      date: "2026-08-27",
      method: "observe",
    };
    const details = { kind: "inquiry_query_error", status: "error", code: "INQUIRY_QUERY_FAILED" };
    const messages = [
      ...batch("first", [{ args, details }]),
      ...batch("reworded", [
        {
          args: {
            ...args,
            purpose: "再确认经营情况",
            title: "新标题",
            metric_refs: ["k2", "k1"],
            org_names: ["江南农商行", "紫金农商行"],
          },
          details,
        },
      ]),
    ];
    expect(inquiryToolAdmission(messages, "metric_query")).toHaveProperty("block");
  });

  it("空参数只增加目的或未知字段仍停止，不扩大执行预算", () => {
    const messages = [
      ...batch("empty", [{}]),
      ...batch("unrelated", [
        {
          args: { purpose: "再试一次", title: "改写标题", extra: "new" },
        },
      ]),
    ];
    expect(inquiryToolAdmission(messages, "metric_query")).toHaveProperty("block");
    const changing = Array.from({ length: 16 }, (_, index) =>
      batch(`query-${index}`, [
        {
          args: { metric_refs: ["k1"], date: `2026-08-${String(index + 1).padStart(2, "0")}` },
        },
      ]),
    ).flat();
    expect(inquiryToolAdmission(changing, "metric_query")).toHaveProperty("block");
  });

  it("目录引用按正式绑定比较，别名写法和编造引用不构成进展", () => {
    const catalog = batch("catalog", [
      {
        name: "metric_search",
        failed: false,
        details: {
          kind: "analysis_catalog",
          status: "succeeded",
          binding_map: { k1: "binding-1", "code:METRIC_A": "binding-1", k2: "binding-2" },
        },
      },
    ]);
    const details = {
      kind: "inquiry_query_error",
      status: "error",
      code: "ANALYSIS_BINDING_INVALID", correction_fields: ["metric_refs"],
    };
    const failed = (id: string, refs: string[]) =>
      batch(id, [{ args: { metric_refs: refs }, details }]);
    expect(
      inquiryToolAdmission(
        [
          ...catalog,
          ...failed("first", ["k1", "unknown-1"]),
          ...failed("second", ["METRIC_A", "k1", "unknown-2"]),
        ],
        "metric_query",
      ),
    ).toHaveProperty("block");
    expect(
      inquiryToolAdmission(
        [
          ...catalog,
          ...failed("first", ["k1", "unknown-1"]),
          ...failed("second", ["k1", "k2", "unknown-2"]),
        ],
        "metric_query",
      ),
    ).toBeUndefined();
  });

  it.each([
    {name: "metric_query", code: "ANALYSIS_METHOD_INVALID", fields: ["method", "comparisons"],
      first: {method: "compare", date: "2026-08-27"}, unrelated: {date: "2026-07-31", org_names: ["江南"], relation_id: "unrelated"}, corrected: {method: "structure"}},
    {name: "metric_availability", code: "AVAILABILITY_DATE_REQUIRED", fields: ["start", "end"],
      first: {metric_refs: ["k1"], start: "2026-08-01"}, unrelated: {metric_refs: ["k2"]}, corrected: {start: "2026-07-01"}},
  ])("前置失败仅比较校验方声明的纠错字段：$code", ({name, code, fields, first, unrelated, corrected}) => {
    const details = {kind: "inquiry_query_error", status: "error", code, correction_fields: fields};
    const failed = batch("first", [{name, args: first, details}]);
    expect(inquiryToolAdmission([...failed, ...batch("unrelated", [{name,
      args: {...first, ...unrelated}, details}])], "metric_query")).toHaveProperty("block");
    expect(inquiryToolAdmission([...failed, ...batch("corrected", [{name,
      args: {...first, ...corrected}, details}])], "metric_query")).toBeUndefined();
  });

  it("自动知识的正式绑定随失败回执保留，部分引用纠正仍可继续", () => {
    const details = {kind: "inquiry_query_error", status: "error", code: "ANALYSIS_BINDING_INVALID", correction_fields: ["metric_refs"],
      binding_map: {"code:METRIC_A": "binding-1", "code:METRIC_B": "binding-2"}};
    const first = batch("first", [{args: {metric_refs: ["unknown-1", "unknown-2"]}, details}]);
    const corrected = batch("corrected", [{args: {metric_refs: ["METRIC_A", "unknown-2"]}, details}]);
    expect(inquiryToolAdmission([...first, ...corrected], "metric_query")).toBeUndefined();
    expect(inquiryToolAdmission([...first, ...corrected, ...batch("unchanged", [{
      args: {metric_refs: ["METRIC_A", "unknown-3"]}, details}])], "metric_query")).toHaveProperty("block");
  });

  it("引用错误未修复时，改日期、机构或增加未知引用不能延长补查", () => {
    const details = {kind: "inquiry_query_error", status: "error", code: "ANALYSIS_BINDING_INVALID", correction_fields: ["metric_refs"]};
    const messages = [...batch("first", [{args: {metric_refs: ["unknown-1"], date: "2026-08-27"}, details}]),
      ...batch("unrelated", [{args: {metric_refs: ["unknown-2", "unknown-3"], date: "2026-07-31",
        scope: "named", org_names: ["江南"], method: "observe"}, details}])];
    expect(inquiryToolAdmission(messages, "metric_query")).toHaveProperty("block");
  });

  it("主目标机构及期间调整保留纠错，主题改写不提供新机会", () => {
    const target = {
      mode: "update",
      base_ref: "current",
      organizations: { mode: "add", scope: "named", names: ["江南"] },
    };
    const details = { kind: "inquiry_query_error", status: "error", code: "INQUIRY_QUERY_FAILED" };
    const first = batch("first", [{ args: { target_change: target }, details }]);
    expect(
      inquiryToolAdmission(
        [
          ...first,
          ...batch("corrected", [
            {
              args: {
                target_change: { ...target, date: "2026-08-27" },
              },
              details,
            },
          ]),
        ],
        "metric_query",
      ),
    ).toBeUndefined();
    expect(
      inquiryToolAdmission(
        [
          ...first,
          ...batch("reworded", [
            {
              args: {
                target_change: { ...target, topic: "新的标题" },
              },
              details,
            },
          ]),
        ],
        "metric_query",
      ),
    ).toHaveProperty("block");
  });

  it.each([
    {
      name: "metric_availability",
      first: { metric_refs: ["k1"], start: "2026-07-01", end: "2026-07-31" },
      changed: { start: "2026-08-01", end: "2026-08-31" },
    },
    { name: "analysis_read", first: { run_ref: "run-1" }, changed: { run_ref: "run-2" } },
    {
      name: "analysis_chart",
      first: { type: "bar", evidence_refs: ["e1.v1", "e1.v2"] },
      changed: { evidence_refs: ["e2.v1", "e2.v2"] },
    },
  ])("其他调查工具按实际输入保留修正机会：$name", ({ name, first, changed }) => {
    const details = { status: "error", error_code: "INVALID_INPUT" };
    const messages = [
      ...batch("first", [{ name, args: first, details }]),
      ...batch("corrected", [{ name, args: { ...first, ...changed }, details }]),
    ];
    expect(inquiryToolAdmission(messages, name)).toBeUndefined();
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
