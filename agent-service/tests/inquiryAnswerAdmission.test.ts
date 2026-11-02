import { describe, expect, it } from "vitest";
import { inquiryResponse } from "../src/inquiry/runtime.js";
import { MemoryCommandBridge, testRequestContext } from "../src/tools/testUtils.js";
import type { BackendClient } from "../src/backendClient.js";
import { CONVERSATION_REPLY } from "../src/tools/turnContract.js";

const request = testRequestContext({} as BackendClient, new MemoryCommandBridge());
function answer(text: string): Parameters<typeof inquiryResponse>[0] {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "isolated",
    model: "isolated",
    timestamp: 0,
    stopReason: "stop",
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

describe("自然正文与普通回复的交付选择", () => {
  it.each(["两家余额分别为100元和200元，相差100元。", "两家情况相近。"])(
    "没有当前来源不等同于普通对话，直接正文仍交给报告入口：%s",
    (body) => {
      const result = inquiryResponse(answer(body), request, []);
      expect(result.content).toEqual([
        {
          type: "toolCall",
          id: "inquiry-answer-op-1-0",
          name: "analysis_answer",
          arguments: { body },
        },
      ]);
    },
  );
  it("显式普通回复仍使用原生工具调用，不根据措辞重新判断语义", () => {
    const message = answer("");
    message.content = [
      {
        type: "toolCall",
        id: "reply",
        name: CONVERSATION_REPLY,
        arguments: { answer: "统计日期是指标对应的业务日期。" },
      },
    ];
    message.stopReason = "toolUse";
    expect(inquiryResponse(message, request, [])).toBe(message);
  });
});
