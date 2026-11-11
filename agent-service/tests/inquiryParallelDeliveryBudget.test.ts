import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { BackendClient } from "../src/backendClient.js";
import {
  inquiryAfterTool,
  inquiryAnswerAttempts,
  inquiryBudgetExhausted,
  inquiryPayload,
  inquiryResponse,
  inquiryToolAdmission,
} from "../src/inquiry/runtime.js";
import { CONVERSATION_REPLY } from "../src/tools/turnContract.js";
import { MemoryCommandBridge, testRequestContext } from "../src/tools/testUtils.js";

type Call = { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

function assistant(calls: Call[]) {
  return {
    role: "assistant" as const,
    content: calls,
    api: "openai-completions" as const,
    provider: "isolated",
    model: "isolated",
    stopReason: "toolUse" as const,
    timestamp: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function receipt(call: Call, details?: unknown, failed = false): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [],
    timestamp: 0,
    isError: failed,
    details,
  };
}

const request = testRequestContext(
  new BackendClient("https://unused.invalid", "unused", 1000),
  new MemoryCommandBridge(),
);
const draft = (id: string) => ({
  type: "toolCall" as const,
  id,
  name: "analysis_answer",
  arguments: { body: "本期值为{{e1.v1}}。" },
});

// 隔离回执重放：真实预算、响应和交付钩子执行，不调用模型或业务服务。
function investigationWithParallelTail() {
  const messages: AgentMessage[] = [];
  for (const name of ["business_skill_read", "topic_query", "analysis_read"]) {
    const call: Call = { type: "toolCall", id: name, name, arguments: {} };
    messages.push(
      assistant([call]),
      receipt(call, {
        kind: name === "business_skill_read" ? "business_skill_read" : "analysis_evidence",
        status: "succeeded",
        run_ref: "run-1",
        execution_turn_id: request.operationId,
      }),
    );
  }
  const calls: Call[] = Array.from({ length: 15 }, (_, index) => ({
    type: "toolCall",
    id: `calculate-${index}`,
    name: "analysis_calculate",
    arguments: { current_ref: `e1.v${index + 1}`, base_ref: `e2.v${index + 1}` },
  }));
  messages.push(assistant(calls));
  const allowed: string[] = [];
  const blocked: string[] = [];
  for (const call of calls) {
    const admission = inquiryToolAdmission(messages, call.name, call.arguments);
    if (admission) {
      expect(admission).toMatchObject({ block: { terminate: false } });
      blocked.push(call.id);
      messages.push(receipt(call, undefined, true));
    } else {
      allowed.push(call.id);
      messages.push(receipt(call, { kind: "metric_calculate", status: "succeeded" }));
    }
  }
  expect(allowed).toHaveLength(13);
  expect(blocked).toEqual(["calculate-13", "calculate-14"]);
  return messages;
}

describe("并行调查尾部拒绝与正文交付预算分开", () => {
  it("16次调查及2条尾部拒绝后，保留首次生成的正文工具调用", () => {
    const messages = investigationWithParallelTail();
    const answer = draft("first-answer");
    expect(inquiryResponse(assistant([answer]), request, messages)).toEqual(assistant([answer]));
    expect(inquiryToolAdmission(messages, "analysis_calculate", {})).toMatchObject({
      block: { terminate: false },
    });
    const tools = ["analysis_calculate", "analysis_answer", CONVERSATION_REPLY].map((name) => ({
      name,
    }));
    expect(inquiryPayload({ tools }, messages).tools).toEqual([tools[1]]);
    expect(inquiryToolAdmission(messages, answer.name, answer.arguments)).toBeUndefined();
  });

  it("首次正文局部错误仍可修正一次，成功交付不被尾部回执改写", () => {
    const messages = investigationWithParallelTail();
    const first = draft("first-answer");
    const details = {
      kind: "analysis_answer",
      status: "ARGUMENT_ERROR",
      retryable: true,
      error_code: "ANALYSIS_REPORT_NUMBER",
    };
    expect(
      inquiryAfterTool(
        {
          toolName: first.name,
          toolCallId: first.id,
          args: first.arguments,
          content: [],
          isError: false,
          details,
        },
        request,
        messages,
      ),
    ).toEqual({ isError: true });
    messages.push(assistant([first]), receipt(first, details, true));
    const second = draft("corrected-answer");
    expect(inquiryAnswerAttempts(messages)).toBe(1);
    expect(inquiryToolAdmission(messages, second.name, second.arguments)).toBeUndefined();
    expect(inquiryResponse(assistant([second]), request, messages)).toEqual(assistant([second]));
    expect(
      inquiryAfterTool(
        {
          toolName: second.name,
          toolCallId: second.id,
          args: second.arguments,
          content: [],
          isError: false,
          details: { kind: "business_report", status: "succeeded" },
        },
        request,
        messages,
      ),
    ).toBeUndefined();
  });

  it("第二次真实正文失败仍明确结束，不开放第三次尝试", () => {
    const messages = investigationWithParallelTail();
    const details = {
      kind: "analysis_answer",
      status: "ARGUMENT_ERROR",
      retryable: true,
      error_code: "ANALYSIS_REPORT_FORMAT",
    };
    const first = draft("first-answer");
    messages.push(assistant([first]), receipt(first, details, true));
    const second = draft("second-answer");
    expect(
      inquiryAfterTool(
        {
          toolName: second.name,
          toolCallId: second.id,
          args: second.arguments,
          content: [],
          isError: false,
          details,
        },
        request,
        messages,
      ),
    ).toMatchObject({
      terminate: true,
      details: { kind: "runtime_delivery", outcome: "incomplete" },
    });
    messages.push(assistant([second]), receipt(second, details, true));
    expect(
      inquiryToolAdmission(messages, "analysis_answer", draft("third").arguments),
    ).toMatchObject({
      block: { terminate: true },
    });
  });

  it("关闭阶段SDK参数失败和不同的前置拒绝共用两次交付尝试，不无限变换参数", () => {
    const messages = investigationWithParallelTail();
    const first = { ...draft("schema-failure"), arguments: { body: "" } };
    messages.push(assistant([first]), receipt(first, undefined, true));
    expect(inquiryBudgetExhausted(messages)).toBe(false);
    const second = draft("prerequisite-failure");
    messages.push(
      assistant([second]),
      receipt(
        second,
        {
          kind: "analysis_answer",
          status: "ARGUMENT_ERROR",
          validation_stage: "prerequisite",
          error_code: "ANALYSIS_REPORT_EVIDENCE",
        },
        true,
      ),
    );
    expect(inquiryAnswerAttempts(messages)).toBe(0);
    expect(inquiryBudgetExhausted(messages)).toBe(true);
    expect(
      inquiryResponse(assistant([draft("third-answer")]), request, messages).content,
    ).toMatchObject([
      {
        type: "toolCall",
        name: CONVERSATION_REPLY,
        arguments: { answer: "本次未能完成回答，请稍后重试。" },
      },
    ]);
  });

  it("未达到调查边界时，重复交付无进展仍在两批后收敛", () => {
    const messages: AgentMessage[] = [];
    for (const id of ["schema-1", "schema-2"]) {
      const call = { ...draft(id), arguments: { body: "" } };
      messages.push(assistant([call]), receipt(call, undefined, true));
    }
    expect(inquiryAnswerAttempts(messages)).toBe(0);
    expect(inquiryBudgetExhausted(messages)).toBe(true);
  });
});
