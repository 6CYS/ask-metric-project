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

describe("回答完整片段", () => {
  it("普通句子不等空行，末尾分片引用仍等待，最终正文不用补空行", () => {
    expect(completeAnswerPrefix("余额{{e1.v1}}。\n\n结构{{e1.", false)).toBe("余额{{e1.v1}}。");
    expect(completeAnswerPrefix("余额{{e1.v1}}。", false)).toBe("余额{{e1.v1}}。");
    expect(completeAnswerPrefix("余额{{e1.v1}}。\n", false)).toBe("余额{{e1.v1}}。");
    expect(completeAnswerPrefix("余额{{e1.v1}}。", true)).toBe("余额{{e1.v1}}。");
    expect(completeAnswerPrefix("余额{{e1.\n\n", false)).toBe("");
  });

  it.each(["。", "！", "？"])("普通段落在 %s 后交付完整句子，保留原有空格和软换行", (ending) => {
    const first = `余额{{e1.v1}}${ending}`;
    expect(completeAnswerPrefix(first + "后文尚未完成", false)).toBe(first);
    expect(completeAnswerPrefix(first + "  后文已确认。更多说明", false)).toBe(
      first + "  后文已确认。",
    );
    expect(completeAnswerPrefix(first + "\n后文已确认。更多说明", false)).toBe(
      first + "\n后文已确认。",
    );
  });

  it("不拆开引用、小数或未完成数值，已完成的前句仍可交付", () => {
    expect(completeAnswerPrefix("{{e1.v1}}为已确认结果。后续说明", false)).toBe(
      "{{e1.v1}}为已确认结果。",
    );
    expect(completeAnswerPrefix("余额为1.25", false)).toBe("");
    expect(completeAnswerPrefix("余额{{e1.v1", false)).toBe("");
    expect(completeAnswerPrefix("余额{{e1.v1|date=2026。", false)).toBe("");
    expect(completeAnswerPrefix("余额{{e1.v1}}。明细{{e2.v1|cite", false)).toBe("余额{{e1.v1}}。");
    expect(completeAnswerPrefix("已取得结果。余额-1.25万", false)).toBe("已取得结果。");
  });

  it.each([
    "**余额{{e1.v1}}。**后续说明",
    "余额`{{e1.v1}}。`后续说明",
    "[余额。](https://example.invalid)后续说明",
    "余额（{{e1.v1}}。后续说明",
    "“余额{{e1.v1}}。”后续说明",
    "# 余额{{e1.v1}}。后续说明",
    "余额说明。\n===",
    "余额说明。\n---",
    "> 余额{{e1.v1}}。后续说明",
    "    余额{{e1.v1}}。后续说明",
    "\t余额{{e1.v1}}。后续说明",
    "指标。 | 数值\n--- | ---\n余额 | {{e1.v1}}",
    "| 指标 | 数值 |\n|---|---|\n|余额。|{{e1.v1}}|",
  ])("复杂 Markdown 继续等待原有完整块边界：%s", (body) => {
    expect(completeAnswerPrefix(body, false)).toBe("");
    expect(completeAnswerPrefix(body + "\n\n", false)).toBe(body);
  });

  it("等待整个表格和代码围栏，代码内空行不能当段落结束", () => {
    expect(completeAnswerPrefix("结论\n\n|机构|值|\n|---|---|\n|甲|{{e1.v1}}|", false)).toBe(
      "结论",
    );
    expect(completeAnswerPrefix("结论\n\n```text\nA\n\nB", false)).toBe("结论");
    expect(completeAnswerPrefix("结论\n\n```text\nA\n\nB\n```\n\n", false)).toContain("B\n```");
    expect(completeAnswerPrefix("结论\\n\\n明细", false)).toBe("结论");
  });

  it.each(["-", "+", "*", "1.", "1)"])("%s 列表下一项开始时交付上一完整项", (marker) => {
    const first = `${marker} 同比变化{{e1.v1}}。`;
    expect(completeAnswerPrefix(`${first}\n`, false)).toBe("");
    expect(completeAnswerPrefix(`${first}\n${marker} 环比还在生成`, false)).toBe(first);
  });

  it("保留列表续行与子列表，等同级下一项，不拆开表格或代码", () => {
    const first = "- 费用{{e1.v1}}\n  口径补充说明\n  - 其中一项{{e1.v2}}";
    expect(completeAnswerPrefix(first + "\n  - 子项尚在生成", false)).toBe("");
    expect(completeAnswerPrefix(first + "\n- 收入正在生成", false)).toBe(first);
    expect(completeAnswerPrefix("```text\n- 甲\n- 乙", false)).toBe("");
    expect(completeAnswerPrefix("    - 甲\n    - 乙", false)).toBe("");
    expect(completeAnswerPrefix("|项目|值|\n|---|---|\n|- 甲|10|\n|- 乙|", false)).toBe("");
    expect(completeAnswerPrefix("- 未闭合{{e1.\n- 下一项", false)).toBe("");
  });
});

describe("核验后回答投影", () => {
  it.each(["\n> 统计口径", "\n- 后续说明", "\n|项目|值|"])(
    "同段追加 Markdown 后候选变短仍保留已核验正文：%s",
    async (tail) => {
      const send = vi.fn<(type: string, data: AnswerStreamData) => void>();
      const render = vi.fn((body: string) =>
        Promise.resolve(body.replaceAll("{{e1.v1}}", "10亿元")),
      );
      const projector = new AnswerStreamProjector(send, render);
      const head = "已确认总览\n\n余额{{e1.v1}}。";
      const first = "已确认总览\n\n余额10亿元。";
      projector.onWatchEvent(draft(head), mode);
      await tick();
      projector.onWatchEvent(draft(head + tail), mode);
      await tick();
      expect(send.mock.calls).toEqual([
        ["answer_delta", { call_seq: 1, mode: "text", text: first }],
      ]);
      projector.onWatchEvent(draft(head + tail + "\n\n"), mode);
      await tick();
      expect(send.mock.calls).toEqual([
        ["answer_delta", { call_seq: 1, mode: "text", text: first }],
        ["answer_delta", { call_seq: 1, mode: "text", text: first + tail }],
      ]);
      projector.close();
    },
  );

  it.each(["已确认总览\n\n余额{{e2.", "已确认总览\n\n更正后的正文尚未完成"])(
    "真正改写即使没有完整句子也撤回旧正文：%s",
    async (replacement) => {
      const send = vi.fn<(type: string, data: AnswerStreamData) => void>();
      const render = vi.fn((body: string) =>
        Promise.resolve(body.replaceAll("{{e1.v1}}", "10亿元")),
      );
      const projector = new AnswerStreamProjector(send, render);
      projector.onWatchEvent(draft("已确认总览\n\n余额{{e1.v1}}。"), mode);
      await tick();
      projector.onWatchEvent(draft(replacement), mode);
      await tick();
      expect(send.mock.calls.map(([type]) => type)).toEqual([
        "answer_delta",
        "answer_reset",
        "answer_delta",
      ]);
      expect(send.mock.calls.at(-1)).toEqual([
        "answer_delta",
        { call_seq: 1, mode: "text", text: "已确认总览" },
      ]);
      projector.close();
    },
  );

  it("原文改写成未闭合引用且无完整前缀时撤回旧正文", async () => {
    const send = vi.fn<(type: string, data: AnswerStreamData) => void>();
    const projector = new AnswerStreamProjector(send, () => Promise.resolve("余额10亿元。"));
    projector.onWatchEvent(draft("余额{{e1.v1}}。"), mode);
    await tick();
    projector.onWatchEvent(draft("余额{{e2."), mode);
    await tick();
    expect(send.mock.calls.map(([type]) => type)).toEqual(["answer_delta", "answer_reset"]);
    projector.close();
  });

  it("同段连续句子经核验后累计交付，不撤回或重复拼接，结束时保持完整正文", async () => {
    const send = vi.fn<(type: string, data: AnswerStreamData) => void>();
    const render = vi.fn((body: string) => Promise.resolve(body.replaceAll("{{e1.v1}}", "10亿元")));
    const projector = new AnswerStreamProjector(send, render);
    const first = "余额{{e1.v1}}。";
    const body = first + "  后续说明已确认。\n统计口径相同";
    projector.onWatchEvent(draft(first + "  后续说明"), mode);
    await tick();
    expect(send.mock.calls).toEqual([
      ["answer_delta", { call_seq: 1, mode: "text", text: "余额10亿元。" }],
    ]);
    projector.onWatchEvent(draft(body), mode);
    await tick();
    projector.onWatchEvent(draft(body, true), mode);
    await tick();
    expect(send.mock.calls).toEqual([
      ["answer_delta", { call_seq: 1, mode: "text", text: "余额10亿元。" }],
      ["answer_delta", { call_seq: 1, mode: "text", text: "余额10亿元。  后续说明已确认。" }],
      [
        "answer_delta",
        { call_seq: 1, mode: "text", text: "余额10亿元。  后续说明已确认。\n统计口径相同" },
      ],
    ]);
    expect(render.mock.calls.map(([text]) => text)).toEqual([
      first,
      first + "  后续说明已确认。",
      body,
    ]);
    projector.close();
  });

  it("完整句子未通过核验不展示，同段补齐引用后仍重新核验", async () => {
    const send = vi.fn<(type: string, data: AnswerStreamData) => void>();
    const render = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce("余额10亿元。依据已确认。");
    const projector = new AnswerStreamProjector(send, render);
    projector.onWatchEvent(draft("余额10亿元。依据尚在生成"), mode);
    await tick();
    expect(render).toHaveBeenCalledWith("余额10亿元。", expect.any(AbortSignal));
    expect(send).not.toHaveBeenCalled();
    projector.onWatchEvent(draft("余额10亿元。依据{{e1.v1|cite}}已确认。更多说明"), mode);
    await tick();
    expect(send.mock.calls).toEqual([
      ["answer_delta", { call_seq: 1, mode: "text", text: "余额10亿元。依据已确认。" }],
    ]);
    projector.close();
  });

  it("标题等待历史依据时不封锁后续正文，在途的新前缀仍继续核验", async () => {
    let waitForEvidence!: (value: null) => void;
    const render = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<null>((resolve) => {
            waitForEvidence = resolve;
          }),
      )
      .mockResolvedValue("费用分析\n\n- 余额10亿元。");
    const send = vi.fn();
    const projector = new AnswerStreamProjector(send, render);
    projector.onWatchEvent(draft("费用分析\n\n- 余额还在生成"), mode);
    projector.onWatchEvent(draft("费用分析\n\n- 余额{{e1.v1}}。\n- 后续说明"), mode);
    waitForEvidence(null);
    await tick();
    await tick();
    expect(send.mock.calls).toEqual([
      [
        "answer_delta",
        {
          call_seq: 1,
          mode: "text",
          text: "费用分析\n\n- 余额10亿元。",
        },
      ],
    ]);
    projector.close();
  });

  it("列表后项补齐同段依据时重新核验累计正文，失败的前项不能提前发布", async () => {
    let rejectPrefix!: (value: undefined) => void;
    const render = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<undefined>((resolve) => {
            rejectPrefix = resolve;
          }),
      )
      .mockResolvedValue("- 余额10亿元。\n- 依据已确认。");
    const send = vi.fn();
    const projector = new AnswerStreamProjector(send, render);
    projector.onWatchEvent(draft("- 余额10亿元。\n- 依据尚在生成"), mode);
    projector.onWatchEvent(draft("- 余额10亿元。\n- 依据{{e1.v1|cite}}已确认。\n- 后续说明"), mode);
    expect(send).not.toHaveBeenCalled();
    rejectPrefix(undefined);
    await tick();
    await tick();
    expect(send.mock.calls).toEqual([
      [
        "answer_delta",
        {
          call_seq: 1,
          mode: "text",
          text: "- 余额10亿元。\n- 依据已确认。",
        },
      ],
    ]);
    projector.close();
  });

  it("列表逐项交付保持原始单换行，不撤回已核验项或重复拼接", async () => {
    const send = vi.fn<(type: string, data: AnswerStreamData) => void>();
    const render = vi.fn((body: string) => Promise.resolve(body.replaceAll("{{e1.v1}}", "10亿元")));
    const projector = new AnswerStreamProjector(send, render);
    projector.onWatchEvent(draft("- 费用{{e1.v1}}。\n- 收入还在生成"), mode);
    await tick();
    expect(send.mock.calls).toEqual([
      [
        "answer_delta",
        {
          call_seq: 1,
          mode: "text",
          text: "- 费用10亿元。",
        },
      ],
    ]);
    projector.onWatchEvent(draft("- 费用{{e1.v1}}。\n- 收入已取得。\n- 后续说明"), mode);
    await tick();
    expect(send.mock.calls).toEqual([
      ["answer_delta", { call_seq: 1, mode: "text", text: "- 费用10亿元。" }],
      ["answer_delta", { call_seq: 1, mode: "text", text: "- 费用10亿元。\n- 收入已取得。" }],
    ]);
    projector.close();
  });
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
