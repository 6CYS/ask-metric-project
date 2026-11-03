import { describe, expect, it, vi } from "vitest";
import { createSessionEvaluationClient } from "../src/evaluation/sessionClient.js";
import type { EvaluationRequest } from "../src/evaluation/types.js";

const user = { role: "user", entry_id: "u1", text: "存款多少", timestamp: 1 };
const assistant = {
  role: "assistant",
  entry_id: "a1",
  text: "已确认的回答",
  tools: [],
  timestamp: 2,
};
function event(type: string, data: unknown): string {
  return `event: ${type}\r\ndata: ${JSON.stringify({ session_id: "s1", request_id: "r1", operation_id: "op1", ...(data as Record<string, unknown>) })}\r\n\r\n`;
}
function stream(body: string): Response {
  const bytes = new TextEncoder().encode(body);
  return new Response(
    new ReadableStream({
      start(controller) {
        // 故意跨 UTF-8 字符和事件边界分块，验证实际协议解码。
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
const input = () => ({
  token: "test-token",
  sessionId: "s1",
  requestId: "r1",
  question: "存款多少",
  signal: new AbortController().signal,
});

describe("测评会话协议适配", () => {
  it.each(["completed", "aborted"])("识别 %s 终态中的现有 403 权限回执", async (runStatus) => {
    const request = vi.fn<EvaluationRequest>().mockResolvedValue(
      stream(
        event("accepted", { snapshot: { messages: [user], running: true } }) +
          event("snapshot", {
            messages: [
              user,
              {
                role: "tool",
                entry_id: "denied",
                tool: "metric_query",
                tool_call_id: "call-1",
                is_error: false,
                timestamp: 2,
                details: {
                  kind: "runtime_delivery",
                  version: 1,
                  status: "delivered",
                  outcome: "incomplete",
                  error_code: "INQUIRY_FORBIDDEN",
                },
              },
              { ...assistant, text: "当前账号无权访问本次所需的数据。" },
            ],
            running: false,
          }) +
          event("run_terminal", {
            run_status: runStatus,
            answer_status: runStatus === "completed" ? "ok" : "failed",
          }),
      ),
    );
    expect(await createSessionEvaluationClient(request).executeTurn(input())).toMatchObject({
      status: "failed",
      error_code: "INQUIRY_FORBIDDEN",
    });
  });

  it("在正式终态前交付已接纳的稳定身份供持久化", async () => {
    const onIdentity = vi.fn();
    const request = vi
      .fn<EvaluationRequest>()
      .mockResolvedValue(
        stream(
          event("accepted", { snapshot: { messages: [user], running: true } }) +
            event("snapshot", { messages: [user, assistant], running: false }) +
            event("run_terminal", { run_status: "completed", answer_status: "ok" }),
        ),
      );
    await createSessionEvaluationClient(request).executeTurn({ ...input(), onIdentity });
    expect(onIdentity).toHaveBeenCalledWith({ operation_id: "op1", user_entry_id: "u1" });
    expect(onIdentity).toHaveBeenCalledTimes(1);
  });

  it("接纳身份保存失败时先停止原操作，再传播存储失败", async () => {
    const failure = new Error("isolated persistence failure");
    const paths: string[] = [];
    const request: EvaluationRequest = (path) => {
      paths.push(path);
      return Promise.resolve(
        path.endsWith("/prompt")
          ? stream(event("accepted", { snapshot: { messages: [user], running: true } }))
          : path.endsWith("/cancel")
            ? new Response(null, { status: 204 })
            : Response.json({ running: false, messages: [user] }),
      );
    };
    await expect(
      createSessionEvaluationClient(request).executeTurn({
        ...input(),
        onIdentity: () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(paths).toEqual([
      "/sessions/s1/prompt",
      "/sessions/s1/cancel",
      "/sessions/s1?resume=false",
    ]);
  });

  it("同一请求中的终态操作身份必须与接纳身份一致", async () => {
    const request: EvaluationRequest = (path) =>
      Promise.resolve(
        path.endsWith("/prompt")
          ? stream(
              event("accepted", {
                operation_id: "op1",
                snapshot: { messages: [user], running: true },
              }) +
                event("snapshot", {
                  operation_id: null,
                  messages: [user, assistant],
                  running: false,
                }) +
                event("run_terminal", {
                  operation_id: "op2",
                  run_status: "completed",
                  answer_status: "ok",
                }),
            )
          : path.endsWith("/cancel")
            ? new Response(null, { status: 204 })
            : Response.json({ running: false, messages: [] }),
      );
    expect((await createSessionEvaluationClient(request).executeTurn(input())).status).toBe(
      "failed",
    );
  });
  it("原生执行完成仍要识别本轮工具的登录失效回执", async () => {
    const request = vi.fn<EvaluationRequest>().mockResolvedValue(
      stream(
        event("accepted", {
          operation_id: "op1",
          snapshot: { messages: [user], running: true },
        }) +
          event("snapshot", {
            messages: [
              user,
              {
                role: "tool",
                entry_id: "t1",
                tool: "query",
                tool_call_id: "tool1",
                is_error: true,
                timestamp: 1,
                details: { http_status: 401, error_code: "AUTH_TOKEN_EXPIRED" },
              },
              assistant,
            ],
            running: false,
          }) +
          event("run_terminal", { run_status: "completed", answer_status: "ok" }),
      ),
    );
    expect(await createSessionEvaluationClient(request).executeTurn(input())).toMatchObject({
      status: "failed",
      error_code: "AUTHENTICATION_REQUIRED",
    });
  });

  it("缺少accepted操作身份时不能当作成功", async () => {
    const request = vi
      .fn<EvaluationRequest>()
      .mockResolvedValue(
        stream(
          event("snapshot", { messages: [user, assistant], running: false }) +
            event("run_terminal", { run_status: "completed", answer_status: "ok" }),
        ),
      );
    expect((await createSessionEvaluationClient(request).executeTurn(input())).status).toBe(
      "failed",
    );
  });

  it("同一句追问的不同请求保留不同条目，拒收其它请求的事件", async () => {
    const request: EvaluationRequest = (path) =>
      Promise.resolve(
        path.endsWith("/prompt")
          ? stream(
              event("accepted", {
                operation_id: "other-op",
                request_id: "other-request",
                snapshot: { messages: [user], running: true },
              }) +
                event("snapshot", { messages: [user, assistant], running: false }) +
                event("run_terminal", { run_status: "completed", answer_status: "ok" }),
            )
          : path.endsWith("/cancel")
            ? new Response(null, { status: 204 })
            : Response.json({ running: false, messages: [] }),
      );
    expect((await createSessionEvaluationClient(request).executeTurn(input())).status).toBe(
      "failed",
    );
  });
  it("只把终态快照作为最终结果，并保存当前轮稳定身份与耗时数组", async () => {
    const request = vi.fn<EvaluationRequest>().mockResolvedValue(
      stream(
        event("accepted", {
          operation_id: "op1",
          request_id: "r1",
          snapshot: { messages: [user], running: true },
        }) +
          event("answer_delta", { text: "预览不能当作最终回答" }) +
          event("snapshot", { messages: [user, assistant], running: false }) +
          event("run_terminal", {
            run_status: "completed",
            answer_status: "ok",
            timings_ms: { model_ms: [10, 20], total_ms: 40 },
          }),
      ),
    );
    const result = await createSessionEvaluationClient(request).executeTurn(input());
    expect(result).toMatchObject({
      status: "completed",
      run_status: "completed",
      user_entry_id: "u1",
      operation_id: "op1",
      timings_ms: { model_ms: [10, 20], total_ms: 40 },
    });
    const requestBody = request.mock.calls[0]?.[1]?.body;
    if (typeof requestBody !== "string") throw new Error("缺少 JSON 请求体");
    const body: unknown = JSON.parse(requestBody);
    expect(body).toEqual({ protocol_version: 3, request_id: "r1", message: "存款多少" });
  });

  it("没有终止事件时不能凭有正文宣布成功，并显式取消遗留请求", async () => {
    const paths: string[] = [];
    const request: EvaluationRequest = (path) => {
      paths.push(path);
      if (path.endsWith("/prompt"))
        return Promise.resolve(
          stream(event("snapshot", { messages: [user, assistant], running: false })),
        );
      if (path.endsWith("/cancel")) return Promise.resolve(new Response(null, { status: 204 }));
      return Promise.resolve(Response.json({ running: false, messages: [user, assistant] }));
    };
    const result = await createSessionEvaluationClient(request).executeTurn(input());
    expect(result.status).toBe("failed");
    expect(result.error_code).toBe("EVALUATION_STREAM_INCOMPLETE");
    expect(paths).toContain("/sessions/s1/cancel");
  });

  it("取消会调用指定请求取消并确认会话停止，而非仅断开流", async () => {
    const abort = new AbortController();
    const paths: string[] = [];
    const request: EvaluationRequest = (path) => {
      paths.push(path);
      if (path.endsWith("/prompt")) {
        queueMicrotask(() => abort.abort());
        return Promise.resolve(new Response(new ReadableStream()));
      }
      if (path.endsWith("/cancel")) return Promise.resolve(new Response(null, { status: 204 }));
      return Promise.resolve(Response.json({ running: false, messages: [user] }));
    };
    const result = await createSessionEvaluationClient(request, {
      cancelTimeoutMs: 100,
    }).executeTurn({ ...input(), signal: abort.signal });
    expect(result.status).toBe("cancelled");
    expect(paths).toContain("/sessions/s1/cancel");
    expect(paths).toContain("/sessions/s1?resume=false");
  });

  it("仍在运行时明确报告取消未确认，不伪造已停止", async () => {
    const request: EvaluationRequest = (path) =>
      Promise.resolve(
        path.endsWith("/cancel")
          ? new Response(null, { status: 204 })
          : Response.json({ running: true, messages: [] }),
      );
    await expect(
      createSessionEvaluationClient(request, { cancelTimeoutMs: 15 }).cancelTurn(
        "token",
        "s1",
        "r1",
      ),
    ).rejects.toMatchObject({ code: "EVALUATION_CANCEL_UNCONFIRMED" });
  });

  it("详情只取指定条目所属轮次并使用禁止恢复的历史接口", async () => {
    const request = vi.fn<EvaluationRequest>().mockResolvedValue(
      Response.json({
        running: false,
        messages: [
          user,
          assistant,
          { ...user, entry_id: "u2", text: "另一家呢" },
          { ...assistant, entry_id: "a2", text: "第二轮" },
        ],
      }),
    );
    const detail = await createSessionEvaluationClient(request).readTurn("token", "s1", "u1");
    expect(detail.map((message) => message.entry_id)).toEqual(["u1", "a1"]);
    expect(request.mock.calls[0]?.[0]).toBe("/sessions/s1?resume=false");
  });

  it("身份失效传播401，不重新登录也不改用管理员", async () => {
    const request = vi
      .fn<EvaluationRequest>()
      .mockResolvedValue(Response.json({ detail: "expired" }, { status: 401 }));
    await expect(createSessionEvaluationClient(request).executeTurn(input())).rejects.toMatchObject(
      { status: 401 },
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("终态缺少有效最终正文不能当作执行成功", async () => {
    const request = vi
      .fn<EvaluationRequest>()
      .mockResolvedValue(
        stream(
          event("snapshot", { messages: [user], running: false }) +
            event("run_terminal", { run_status: "completed", answer_status: "ok" }),
        ),
      );
    expect((await createSessionEvaluationClient(request).executeTurn(input())).status).toBe(
      "failed",
    );
  });
});
