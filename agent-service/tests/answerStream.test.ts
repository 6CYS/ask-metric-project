import { describe, expect, it, vi } from "vitest";
import { BackendApiError } from "../src/backendClient.js";
import type { HarnessEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AnswerStreamProjector,
  completeAnswerPrefix,
  type AnswerStreamData,
} from "../src/answerStream.js";

function update(text: string, end = false, calls: AssistantMessage["content"] = []): HarnessEvent {
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text }, ...calls],
    api: "openai-completions",
    provider: "isolated",
    model: "isolated",
    timestamp: 0,
    stopReason: calls.length ? "toolUse" : "stop",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  return end
    ? { type: "message_end", lane: "main", message }
    : {
        type: "message_update",
        lane: "main",
        runId: "run",
        message,
        event: { type: "text_delta", contentIndex: 0, delta: text, partial: message },
      };
}

function draft(body: string, end = false): HarnessEvent {
  return update("", end, [
    { type: "toolCall", id: "answer", name: "analysis_answer", arguments: { body } },
  ]);
}

const mode = { callSeq: 1, mode: "text" as const };
const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("回答完整段落", () => {
  it("只取完整段落，末尾分片引用仍等待，最终正文不用补空行", () => {
    expect(completeAnswerPrefix("余额{{e1.v1}}。\n\n结构{{e1.", false)).toBe("余额{{e1.v1}}。");
    expect(completeAnswerPrefix("余额{{e1.v1}}。", false)).toBe("");
    expect(completeAnswerPrefix("余额{{e1.v1}}。\n", false)).toBe("");
    expect(completeAnswerPrefix("余额{{e1.v1}}。", true)).toBe("余额{{e1.v1}}。");
    expect(completeAnswerPrefix("余额{{e1.\n\n", false)).toBe("");
  });

  it("等待整个表格和代码围栏，代码内空行不能当段落结束", () => {
    expect(completeAnswerPrefix("结论\n\n|机构|值|\n|---|---|\n|甲|{{e1.v1}}|", false)).toBe(
      "结论",
    );
    expect(completeAnswerPrefix("结论\n\n```text\nA\n\nB", false)).toBe("结论");
    expect(completeAnswerPrefix("结论\n\n```text\nA\n\nB\n```\n\n", false)).toContain("B\n```");
    expect(completeAnswerPrefix("结论\\n\\n明细", false)).toBe("结论");
  });
});

describe("核验后回答投影", () => {
  it("普通文本即使数字有效也不能作为报告预览，避免流出查询计划", async () => {
    const render = vi.fn(() => Promise.resolve("内部计划"));
    const send = vi.fn();
    const projector = new AnswerStreamProjector(send, render);
    projector.onWatchEvent(update("已有数据{{e1.v1}}。\n\n接下来继续查询"), mode);
    projector.onWatchEvent(update("已有数据{{e1.v1}}。", true), mode);
    await tick();
    expect(render).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    projector.close();
  });
  it("正文结束前交付核验结果，绝不发送原始引用", async () => {
    const send = vi.fn<(type: string, data: AnswerStreamData) => void>(),
      render = vi.fn(() => Promise.resolve("余额10亿元。"));
    const projector = new AnswerStreamProjector(send, render);
    projector.onWatchEvent(draft("余额{{e1.v1}}。\n\n结构"), mode);
    await tick();
    expect(render).toHaveBeenCalledWith("余额{{e1.v1}}。", expect.any(AbortSignal));
    expect(send).toHaveBeenCalledWith("answer_delta", {
      call_seq: 1,
      mode: "text",
      text: "余额10亿元。",
    });
    projector.close();
  });

  it("单请求在途，合并等待期间的累计正文且不重复发送", async () => {
    const send = vi.fn<(type: string, data: AnswerStreamData) => void>();
    let complete!: (value: string) => void;
    const render = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            complete = resolve;
          }),
      )
      .mockResolvedValue("甲\n\n乙\n\n丙");
    const projector = new AnswerStreamProjector(send, render);
    projector.onWatchEvent(draft("甲\n\n"), mode);
    projector.onWatchEvent(draft("甲\n\n乙\n\n"), mode);
    projector.onWatchEvent(draft("甲\n\n乙\n\n丙\n\n"), mode);
    expect(render).toHaveBeenCalledTimes(1);
    complete("甲");
    await tick();
    await tick();
    expect(render).toHaveBeenCalledTimes(2);
    expect(render.mock.calls[1]?.[0]).toBe("甲\n\n乙\n\n丙");
    projector.onWatchEvent(draft("甲\n\n乙\n\n丙\n\n"), mode);
    await tick();
    expect(render).toHaveBeenCalledTimes(2);
    projector.close();
  });

  it.each(["close", "retry", "tool", "new_call"])("%s 后晚到的预览不得发布", async (action) => {
    const send = vi.fn<(type: string, data: AnswerStreamData) => void>();
    let complete!: (value: string) => void;
    const render = vi.fn<(text: string, signal: AbortSignal) => Promise<string>>(
      () =>
        new Promise<string>((resolve) => {
          complete = resolve;
        }),
    );
    const projector = new AnswerStreamProjector(send, render);
    projector.onWatchEvent(draft("旧正文\n\n"), mode);
    const signal = render.mock.calls[0]![1];
    if (action === "close") projector.close();
    if (action === "retry")
      projector.onWatchEvent(
        { type: "retry_start", lane: "main", runId: "run", step: "assistant", attempt: 2 },
        mode,
      );
    if (action === "tool")
      projector.onWatchEvent(
        {
          type: "tool_start",
          lane: "main",
          runId: "run",
          turnId: "t",
          toolCallId: "c",
          toolName: "analysis_answer",
          args: {},
        },
        mode,
      );
    if (action === "new_call") projector.onWatchEvent(draft("新内容"), { ...mode, callSeq: 2 });
    expect(signal.aborted).toBe(true);
    complete("旧正文");
    await tick();
    expect(send).not.toHaveBeenCalled();
    projector.close();
  });

  it("确定失败的前缀不会因为追加段落重复校验", async () => {
    const send = vi.fn<(type: string, data: AnswerStreamData) => void>(),
      render = vi
        .fn()
        .mockResolvedValueOnce("甲")
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce("甲\n\n乙\n\n丙");
    const projector = new AnswerStreamProjector(send, render);
    for (const text of ["甲\n\n", "甲\n\n乙\n\n", "甲\n\n乙\n\n丙\n\n"]) {
      projector.onWatchEvent(draft(text), mode);
      await tick();
    }
    expect(send.mock.calls.map((call) => call[0])).toEqual(["answer_delta"]);
    expect(render).toHaveBeenCalledTimes(2);
    projector.close();
  });

  it("失权或服务异常撤回临时正文，最终交付仍由原流程处理", async () => {
    const send = vi.fn<(type: string, data: AnswerStreamData) => void>(),
      render = vi
        .fn()
        .mockResolvedValueOnce("甲")
        .mockRejectedValueOnce(new BackendApiError(403, "permission"));
    const projector = new AnswerStreamProjector(send, render);
    projector.onWatchEvent(draft("甲\n\n"), mode);
    await tick();
    projector.onWatchEvent(draft("甲\n\n乙\n\n"), mode);
    await tick();
    expect(send).toHaveBeenLastCalledWith("answer_reset", { call_seq: 1, reason: "error" });
    projector.close();
  });

  it("允许报告工具的正文参数逐段核验，查询参数与图表配置不进入正文", async () => {
    const send = vi.fn<(type: string, data: AnswerStreamData) => void>(),
      render = vi.fn((text: string) => Promise.resolve(text));
    const projector = new AnswerStreamProjector(send, render);
    projector.onWatchEvent(
      update("", false, [
        {
          type: "toolCall",
          id: "answer",
          name: "analysis_answer",
          arguments: { body: "正文\n\n", chart: { secret: "hidden" } },
        },
      ]),
      mode,
    );
    await tick();
    expect(send).toHaveBeenCalledWith("answer_delta", { call_seq: 1, mode: "text", text: "正文" });
    projector.onWatchEvent(
      update("", false, [
        {
          type: "toolCall",
          id: "query",
          name: "metric_query",
          arguments: { body: "内部参数\n\n" },
        },
      ]),
      mode,
    );
    expect(send).toHaveBeenLastCalledWith("answer_reset", { call_seq: 1, reason: "tool_call" });
    expect(render).toHaveBeenCalledTimes(1);
    projector.close();
  });

  it("mode none 不运行预览", async () => {
    const send = vi.fn<(type: string, data: AnswerStreamData) => void>(),
      render = vi.fn();
    const projector = new AnswerStreamProjector(send, render);
    projector.onWatchEvent(draft("内部材料\n\n"), { ...mode, mode: "none" });
    await tick();
    expect(render).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("预览失败恢复", () => {
  it("网络超时保留可靠前文，仅在新完整段落到达时有界重试", async () => {
    const send = vi.fn<(type: string, data: AnswerStreamData) => void>();
    const render = vi
      .fn()
      .mockResolvedValueOnce("甲")
      .mockRejectedValue(new DOMException("timeout", "AbortError"));
    const projector = new AnswerStreamProjector(send, render);
    for (const text of [
      "甲\n\n",
      "甲\n\n乙\n\n",
      "甲\n\n乙\n\n丙\n\n",
      "甲\n\n乙\n\n丙\n\n丁\n\n",
    ]) {
      projector.onWatchEvent(draft(text), mode);
      await tick();
    }
    expect(send.mock.calls.map(([type]) => type)).toEqual(["answer_delta"]);
    expect(render).toHaveBeenCalledTimes(3);
    projector.close();
  });
  it("拒绝段内补齐引用属于改写，允许重新核验", async () => {
    const send = vi.fn<(type: string, data: AnswerStreamData) => void>();
    const render = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce("余额10元。");
    const projector = new AnswerStreamProjector(send, render);
    projector.onWatchEvent(draft("余额10元。\n\n"), mode);
    await tick();
    projector.onWatchEvent(draft("余额10元。{{e1.v1|cite}}\n\n"), mode);
    await tick();
    expect(send).toHaveBeenCalledWith("answer_delta", {
      call_seq: 1,
      mode: "text",
      text: "余额10元。",
    });
    projector.close();
  });
  it("前文改写应撤回旧预览并重新核验", async () => {
    const send = vi.fn<(type: string, data: AnswerStreamData) => void>();
    const render = vi.fn((text: string) => Promise.resolve(text));
    const projector = new AnswerStreamProjector(send, render);
    projector.onWatchEvent(draft("原段\n\n"), mode);
    await tick();
    projector.onWatchEvent(draft("改写段\n\n"), mode);
    await tick();
    expect(send.mock.calls.map(([type]) => type)).toEqual([
      "answer_delta",
      "answer_reset",
      "answer_delta",
    ]);
    projector.close();
  });
});
