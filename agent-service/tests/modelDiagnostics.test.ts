import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "node:http";
import { serve } from "@hono/node-server";
import { BackendClient } from "../src/backendClient.js";
import { loadConfig, type AgentServiceConfig } from "../src/config.js";
import { agentRuntimeImportDocument } from "../src/databaseAgentRuntime.js";
import type { HarnessHost } from "../src/harnessHost.js";
import type { NativeSessionStore } from "../src/nativeSessions.js";
import { createApp } from "../src/routes.js";
import { TEST_ACTOR } from "../src/tools/testUtils.js";

const headers = { Authorization: "Bearer application-token" };
const config = () =>
  loadConfig({
    AGENT_MODEL_API_KEY: "model-secret-not-public",
    AGENT_MODEL_BASE_URL: "https://gateway.test/private/v1",
    AGENT_MODEL_NAME: "current-model",
    AGENT_MODEL_AUTH_HEADER: "accessKey",
    AGENT_MODEL_AUTH_PREFIX: "",
    AGENT_MODEL_USER_MESSAGE_SUFFIX: "\n/no_think",
  });
function app(settings = config()) {
  // 诊断不应接触会话仓库或 Harness；仅替代这两个未使用的边界。
  return createApp(settings, {} as HarnessHost, {} as NativeSessionStore);
}
function chunk(delta: Record<string, unknown>, finish: string | null = null) {
  return `data: ${JSON.stringify({
    id: "probe",
    object: "chat.completion.chunk",
    created: 1,
    model: "current-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}
function answer(text = "诊断原始模型正文", finish: string | null = "stop") {
  return new Response(
    chunk({ content: text }) + (finish ? chunk({}, finish) : "") + "data: [DONE]\n\n",
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
function events(text: string) {
  return text.split(/\n\n/u).flatMap((frame) => {
    const event = /^event: (.+)$/mu.exec(frame)?.[1];
    const data = /^data: (.+)$/mu.exec(frame)?.[1];
    return event && data ? [{ event, data: JSON.parse(data) as Record<string, unknown> }] : [];
  });
}
async function diagnose(application: ReturnType<typeof app>) {
  const response = await application.request("/model-diagnostics", { method: "POST", headers });
  return { response, text: await response.text() };
}

beforeEach(() => {
  vi.spyOn(BackendClient.prototype, "getMe").mockResolvedValue({
    ...TEST_ACTOR,
    role_code: "SYSTEM_ADMIN",
  });
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("模型诊断鉴权与配置快照", () => {
  it.each(["GET", "POST"])("%s 复用登录鉴权并限制系统管理员", async (method) => {
    const application = app();
    expect((await application.request("/model-diagnostics", { method })).status).toBe(401);
    vi.spyOn(BackendClient.prototype, "getMe").mockResolvedValue(TEST_ACTOR);
    const denied = await application.request("/model-diagnostics", { method, headers });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "DIAGNOSTIC_ADMIN_REQUIRED" });
  });

  it("返回文件模式已生效摘要且不要求配置写权限", async () => {
    const write = vi
      .spyOn(BackendClient.prototype, "authorizeConfigWrite")
      .mockRejectedValue(new Error("不可写"));
    const response = await app().request("/model-diagnostics", { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      model: "current-model",
      configuration_source: "file",
      configuration_version: null,
      first_response_timeout_ms: 30000,
      stream_idle_timeout_ms: 30000,
      max_duration_ms: 60000,
      cooldown_ms: 10000,
    });
    expect(write).not.toHaveBeenCalled();
  });

  it("开始检测重新读取数据库版本，结果保留该次快照", async () => {
    const settings: AgentServiceConfig = { ...config(), businessConfigurationStorage: "database" };
    const document = agentRuntimeImportDocument(settings);
    const snapshot = vi
      .spyOn(BackendClient.prototype, "agentRuntimeSnapshot")
      .mockResolvedValueOnce({ version_id: "v1", document })
      .mockResolvedValueOnce({
        version_id: "v2",
        document: { ...document, model: { ...document.model, name: "new-model" } },
      });
    const requests: Request[] = [];
    vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requests.push(new Request(input, init));
      return Promise.resolve(answer());
    });
    const application = app(settings);
    expect(
      await (await application.request("/model-diagnostics", { headers })).json(),
    ).toMatchObject({ configuration_version: "v1" });
    const { text } = await diagnose(application);
    const output = events(text);
    expect(output[0]?.data.target).toMatchObject({
      model: "new-model",
      configuration_source: "database",
      configuration_version: "v2",
    });
    expect(output.at(-1)?.data).toMatchObject({
      status: "succeeded",
      target: output[0]?.data.target,
    });
    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(requests).toHaveLength(1);
    expect(await requests[0]?.json()).toMatchObject({ model: "new-model" });
    expect(text).not.toMatch(/model-secret|gateway\.test|private/u);
  });

  it("请求体不能覆盖有效配置或把诊断作为任意模型代理", async () => {
    const requests: Request[] = [];
    vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requests.push(new Request(input, init));
      return Promise.resolve(answer());
    });
    const response = await app().request("/model-diagnostics", {
      method: "POST",
      headers,
      body: JSON.stringify({ baseUrl: "https://attacker.test", apiKey: "untrusted" }),
    });
    expect(response.status).toBe(200);
    expect(events(await response.text()).at(-1)?.data).toMatchObject({ status: "succeeded" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://gateway.test/private/v1/chat/completions");
    expect(requests[0]?.headers.get("accessKey")).toBe("model-secret-not-public");
  });

  it("真实 Node 适配器的无正文 POST 能启动诊断", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(answer()));
    let ready = () => {};
    let failed: (error: Error) => void = () => {};
    const listening = new Promise<void>((resolve, reject) => {
      ready = resolve;
      failed = reject;
    });
    const server = serve({ fetch: app().fetch, hostname: "127.0.0.1", port: 0 }, ready);
    server.once("error", failed);
    try {
      await listening;
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("未取得监听端口");
      const result = await new Promise<{ status: number | undefined; text: string }>(
        (resolve, reject) => {
          const outgoing = request(
            {
              hostname: "127.0.0.1",
              port: address.port,
              path: "/model-diagnostics",
              method: "POST",
              headers: { ...headers, "Content-Length": "0" },
            },
            (incoming) => {
              let text = "";
              incoming.setEncoding("utf8");
              incoming.on("data", (value: string) => {
                text += value;
              });
              incoming.on("error", reject);
              incoming.on("end", () => resolve({ status: incoming.statusCode, text }));
            },
          );
          outgoing.on("error", reject);
          outgoing.end();
        },
      );
      expect(result.status).toBe(200);
      expect(events(result.text).at(-1)?.data).toMatchObject({ status: "succeeded" });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("配置不可读取时返回受控失败，不泄露异常正文", async () => {
    vi.spyOn(BackendClient.prototype, "agentRuntimeSnapshot").mockRejectedValue(
      new Error("secret https://internal.test"),
    );
    const response = await app({ ...config(), businessConfigurationStorage: "database" }).request(
      "/model-diagnostics",
      { headers },
    );
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).toContain("DIAGNOSTIC_CONFIGURATION_UNAVAILABLE");
    expect(text).not.toMatch(/secret|internal.test/u);
  });
});

describe("模型诊断实际 SDK 流式边界", () => {
  it("只发送一次固定短提示并保留真实鉴权、后缀和扩展参数，最多生成 512 token", async () => {
    const settings = config();
    settings.model.userMessageSuffix = "\n/no_think";
    settings.model.extraBody = {
      enable_thinking: false,
      max_completion_tokens: 99999,
      n: 3,
      messages: [{ role: "user", content: "不应带入的扩展消息" }],
      tools: [{ type: "function" }],
      stream: false,
    };
    const requests: Request[] = [];
    vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requests.push(new Request(input, init));
      return Promise.resolve(answer());
    });
    const { response, text } = await diagnose(app(settings));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const output = events(text);
    expect(output.map((item) => item.event)).toEqual(["started", "progress", "result"]);
    expect(output[1]?.data).toMatchObject({
      phase: "receiving",
    });
    expect(output.at(-1)?.data).toMatchObject({
      status: "succeeded",
      error_code: null,
      diagnostic_id: output[0]?.data.diagnostic_id,
      started_at: output[0]?.data.started_at,
    });
    expect(typeof output[1]?.data.first_output_ms).toBe("number");
    expect(typeof output.at(-1)?.data.first_output_ms).toBe("number");
    expect(typeof output.at(-1)?.data.duration_ms).toBe("number");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get("accessKey")).toBe("model-secret-not-public");
    const body: unknown = await requests[0]?.json();
    expect(body).toMatchObject({
      stream: true,
      enable_thinking: false,
      n: 1,
      max_completion_tokens: 512,
    });
    expect(body).not.toHaveProperty("tools");
    expect(JSON.stringify(body)).toContain("/no_think");
    expect(JSON.stringify(body)).not.toContain("不应带入的扩展消息");
    expect(text).not.toMatch(/model-secret|gateway.test/u);
  });

  it.each([
    [401, "MODEL_AUTHENTICATION_FAILED"],
    [429, "MODEL_RATE_LIMITED"],
    [503, "MODEL_SERVICE_UNAVAILABLE"],
  ])("模型 HTTP %s 返回失败终态且 SDK 不隐式重试", async (status, code) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              message: "model-secret-not-public https://private.test",
              type: "provider_error",
            },
          }),
          { status, headers: { "Content-Type": "application/json", "retry-after": "0" } },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    const { response, text } = await diagnose(app());
    expect(response.status).toBe(200);
    expect(events(text).at(-1)?.data).toMatchObject({ status: "failed", error_code: code });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(text).not.toMatch(/model-secret-not-public|private.test/u);
  });

  it.each([
    ["正文", "length", "MODEL_OUTPUT_TRUNCATED"],
    ["正文", null, "MODEL_STREAM_FAILED"],
    ["", "stop", "MODEL_RESPONSE_EMPTY"],
  ])("正文 %s、终态 %s 不能伪报成功", async (text, finish, code) => {
    vi.stubGlobal("fetch", () => Promise.resolve(answer(text, finish)));
    const result = await diagnose(app());
    expect(events(result.text).at(-1)?.data).toMatchObject({ status: "failed", error_code: code });
  });
});

describe("模型诊断受控返回正文", () => {
  it("返回成功正文与 HTTP 状态，不将正文写入诊断日志", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(answer("连接正常。\n第二行")));
    const { text } = await diagnose(app());
    expect(events(text).at(-1)?.data.model_response).toEqual({
      http_status: 200,
      content: "连接正常。\n第二行",
      error: "",
      error_source: null,
      truncated: false,
    });
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toMatch(
      /连接正常|第二行|model_response/u,
    );
  });

  it("429 保留网关 JSON 的 code、message 和状态，仍然只请求一次", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: "QuotaExceeded", message: "每分钟请求数超限", type: "rate_limit_error" },
          request_id: "gateway-request-1",
        }),
        { status: 429, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    const { text } = await diagnose(app());
    const returned = events(text).at(-1)?.data.model_response;
    expect(returned).toMatchObject({
      http_status: 429,
      content: "",
      error_source: "http",
      truncated: false,
    });
    expect(returned).toHaveProperty("error");
    expect(JSON.parse((returned as { error: string }).error)).toEqual({
      error: { code: "QuotaExceeded", message: "每分钟请求数超限", type: "rate_limit_error" },
      request_id: "gateway-request-1",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain("QuotaExceeded");
  });

  it("HTTP 200 JSON 错误仍保留实际网关正文，而不只显示 SDK 的流解析错误", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: { code: "UnsupportedStream", message: "当前模型不支持流式输出" },
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const { text } = await diagnose(app());
    const result = events(text).at(-1)?.data;
    expect(result).toMatchObject({
      status: "failed",
      model_response: { http_status: 200, content: "", error_source: "http" },
    });
    expect(JSON.parse((result?.model_response as { error: string }).error)).toEqual({
      error: { code: "UnsupportedStream", message: "当前模型不支持流式输出" },
    });
  });

  it("非 JSON 错误保持纯文本和换行", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response("upstream unavailable\ntry later", { status: 502 })),
    );
    const { text } = await diagnose(app());
    expect(events(text).at(-1)?.data.model_response).toEqual({
      http_status: 502,
      content: "",
      error: "upstream unavailable\ntry later",
      error_source: "http",
      truncated: false,
    });
  });

  it("部分输出后断流保留正文，客户端失败不冒称 HTTP 错误正文", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(answer("已收到的部分正文", null)));
    const { text } = await diagnose(app());
    expect(events(text).at(-1)?.data).toMatchObject({
      status: "failed",
      model_response: { http_status: 200, content: "已收到的部分正文", error_source: "client" },
    });
    expect(events(text).at(-1)?.data.model_response).toHaveProperty(
      "error",
      expect.stringContaining("Stream ended without finish_reason"),
    );
  });

  it("密钥片段尚未完整输出便断流时，正文不泄露已知凭据前缀", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(answer("model-secret-not-pub", null)));
    const { text } = await diagnose(app());
    expect(events(text).at(-1)?.data).toMatchObject({ status: "failed" });
    expect(text).not.toContain("model-secret");
    expect(text).toContain("已脱敏");
  });

  it("未收到 HTTP 响应时显示客户端错误且状态为空", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.reject(new Error("socket unavailable model-secret-not-public")),
    );
    const { text } = await diagnose(app());
    expect(events(text).at(-1)?.data.model_response).toMatchObject({
      http_status: null,
      content: "",
      error_source: "client",
    });
    expect(text).not.toContain("model-secret-not-public");
  });

  it("先脱敏已知凭据、配置地址和嵌套敏感字段，再限制错误长度", async () => {
    const settings = config();
    settings.model.baseUrl = "https://url-user:url-password@gateway.test/private/v1";
    const error = {
      error: {
        code: "InvalidRequest",
        message:
          "model-secret-not-public application-token https://url-user:url-password@gateway.test/private/v1 url-password",
        details: {
          api_key: "unknown-api-secret",
          accessToken: "unknown-token",
          Authorization: "Bearer unknown-auth",
          password: "unknown-password",
          cookie: "unknown-cookie",
        },
      },
      padding: "x".repeat(9000),
    };
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response(JSON.stringify(error), { status: 400 })),
    );
    const { text } = await diagnose(app(settings));
    const returned = events(text).at(-1)?.data.model_response as {
      error: string;
      truncated: boolean;
    };
    expect(returned).toMatchObject({ error_source: "http", truncated: true });
    expect(returned.error.length).toBeLessThanOrEqual(8192);
    expect(returned.error).toContain("InvalidRequest");
    expect(text).not.toMatch(
      /model-secret|application-token|gateway.test|url-user|url-password|unknown-api|unknown-token|unknown-auth|unknown-password|unknown-cookie/u,
    );
  });

  it.each([
    ['{"error":{"api_key":"unknown-leaked-value","padding":"' + "x".repeat(70000), true],
    ['Error body: {"api_key":"unknown-leaked-value","message":"denied"}', false],
    [
      JSON.stringify({ error: { message: "upstream credential api_key=unknown-leaked-value" } }),
      false,
    ],
    ['{"error":{"access_token":"unknown-leaked-value"', false],
    ['gateway says x-auth-value="unknown-leaked-value"', false],
  ])("不完整或包装后的错误也脱敏敏感字段（场景 %#）", async (body, truncated) => {
    const settings = config();
    settings.model.authHeader = "x-auth-value";
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(body, { status: 401 })));
    const { text } = await diagnose(app(settings));
    expect(events(text).at(-1)?.data.model_response).toMatchObject({
      http_status: 401,
      error_source: "http",
      truncated,
    });
    expect(text).not.toContain("unknown-leaked-value");
    expect(text).toContain("已脱敏");
  });

  it("不完整敏感容器的后续字段也不能泄露", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response('{"code":"Denied","credentials":["secret-a","secret-b"', { status: 403 }),
      ),
    );
    const { text } = await diagnose(app());
    expect(text).not.toMatch(/secret-a|secret-b/u);
    expect(text).toContain("Denied");
  });

  it("正文先脱敏再截断，显示边界处不泄露半截密钥", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(answer("a".repeat(8188) + "model-secret-not-public" + "z".repeat(100))),
    );
    const { text } = await diagnose(app());
    const returned = events(text).at(-1)?.data.model_response as {
      content: string;
      truncated: boolean;
    };
    expect(returned.truncated).toBe(true);
    expect(returned.content.length).toBeLessThanOrEqual(8192);
    expect(returned.content).not.toContain("mode");
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain("a".repeat(32));
  });

  it("超大 HTTP 错误读取有界，截取位置上的半截凭据也不得外泄", async () => {
    let pulls = 0;
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new TextEncoder().encode("model-secret-not-public ".repeat(5000)));
      },
      cancel: cancelled,
    });
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(body, { status: 429 })));
    const { text } = await diagnose(app());
    const returned = events(text).at(-1)?.data.model_response as {
      error: string;
      truncated: boolean;
    };
    expect(returned).toMatchObject({ http_status: 429, error_source: "http", truncated: true });
    expect(returned.error.length).toBeLessThanOrEqual(8192);
    expect(returned.error).not.toMatch(/model-secret|model-se/u);
    expect(pulls).toBeLessThan(5);
    expect(cancelled).toHaveBeenCalled();
  });

  it.each([false, true])(
    "HTTP 错误正文不结束时，停止或原超时仍能结束检测（超时=%s）",
    async (timeout) => {
      vi.useFakeTimers();
      let ready = () => {};
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const cancelled = vi.fn();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("partial gateway error"));
        },
        cancel: cancelled,
      });
      vi.stubGlobal("fetch", () => {
        ready();
        return Promise.resolve(new Response(body, { status: 503 }));
      });
      const controller = new AbortController();
      const response = await app().request("/model-diagnostics", {
        method: "POST",
        headers,
        signal: controller.signal,
      });
      const reading = response.text();
      await started;
      await vi.advanceTimersByTimeAsync(0);
      if (timeout) await vi.advanceTimersByTimeAsync(30001);
      else controller.abort();
      const result = events(await reading).at(-1)?.data;
      expect(result).toMatchObject({
        status: timeout ? "failed" : "cancelled",
        model_response: {
          http_status: 503,
          error_source: "http",
          error: "partial gateway error",
          truncated: true,
        },
      });
      expect(cancelled).toHaveBeenCalled();
    },
  );
});

describe("模型诊断时限、取消与实例限额", () => {
  function controlledTransport() {
    let feed: ReadableStreamDefaultController<Uint8Array> | undefined;
    let signal: AbortSignal | null | undefined;
    let resolveReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          feed = controller;
          signal?.addEventListener(
            "abort",
            () => controller.error(new DOMException("cancel", "AbortError")),
            { once: true },
          );
        },
      });
      resolveReady();
      return Promise.resolve(
        new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
      );
    });
    vi.stubGlobal("fetch", fetcher);
    return {
      ready,
      fetcher,
      signal: () => signal,
      send: (text: string) => feed?.enqueue(new TextEncoder().encode(text)),
      close: () => feed?.close(),
    };
  }

  it("HTTP 头和心跳不计首输出；真实思考增量计时并续期空闲时限", async () => {
    vi.useFakeTimers();
    const transport = controlledTransport();
    const running = diagnose(app());
    await transport.ready;
    await vi.advanceTimersByTimeAsync(5000);
    transport.send(chunk({ reasoning_content: "内部思考不能外泄" }));
    await vi.advanceTimersByTimeAsync(0);
    transport.send(chunk({ content: "内部正文" }) + chunk({}, "stop") + "data: [DONE]\n\n");
    transport.close();
    const { text } = await running;
    expect(text).toContain(": heartbeat");
    expect(events(text).find((item) => item.event === "progress")?.data).toEqual({
      phase: "receiving",
      first_output_ms: 5000,
    });
    expect(events(text).at(-1)?.data).toMatchObject({ status: "succeeded", first_output_ms: 5000 });
    expect(text).not.toContain("内部思考");
    expect(events(text).at(-1)?.data.model_response).toMatchObject({ content: "内部正文" });
  });

  it.each([
    [false, "MODEL_FIRST_RESPONSE_TIMEOUT"],
    [true, "MODEL_STREAM_IDLE_EXCEEDED"],
  ])("真实输出之前/之后超时分类（已输出=%s），取消底层请求且不重试", async (hasOutput, code) => {
    vi.useFakeTimers();
    const transport = controlledTransport();
    const settings = {
      ...config(),
      modelFirstResponseTimeoutMs: 100,
      modelStreamIdleTimeoutMs: 100,
    };
    const running = diagnose(app(settings));
    await transport.ready;
    if (hasOutput) transport.send(chunk({ content: "局部响应" }));
    await vi.advanceTimersByTimeAsync(101);
    expect(events((await running).text).at(-1)?.data).toMatchObject({
      status: "failed",
      error_code: code,
    });
    expect(transport.signal()?.aborted).toBe(true);
    expect(transport.fetcher).toHaveBeenCalledTimes(1);
  });

  it("持续有效输出仍受 60 秒总预算限制", async () => {
    vi.useFakeTimers();
    const transport = controlledTransport();
    const running = diagnose(app());
    await transport.ready;
    for (let index = 0; index < 6; index++) {
      transport.send(chunk({ content: "持续输出" }));
      await vi.advanceTimersByTimeAsync(10000);
    }
    const result = events((await running).text).at(-1)?.data;
    expect(result).toMatchObject({
      status: "failed",
      error_code: "DIAGNOSTIC_DEADLINE_EXCEEDED",
      duration_ms: 60000,
    });
    expect(transport.signal()?.aborted).toBe(true);
  });

  it("繁忙和冷却返回 429；HTTP 取消释放实例名额但保留 10 秒间隔", async () => {
    vi.useFakeTimers();
    const transport = controlledTransport();
    const application = app();
    const controller = new AbortController();
    const response = await application.request("/model-diagnostics", {
      method: "POST",
      headers,
      signal: controller.signal,
    });
    const reading = response.text();
    await transport.ready;
    const busy = await application.request("/model-diagnostics", { method: "POST", headers });
    expect(busy.status).toBe(429);
    expect(await busy.json()).toMatchObject({ code: "DIAGNOSTIC_BUSY", retry_after_ms: 10000 });
    controller.abort();
    expect(events(await reading).at(-1)?.data).toMatchObject({ status: "cancelled" });
    expect(transport.signal()?.aborted).toBe(true);
    const cooling = await application.request("/model-diagnostics", { method: "POST", headers });
    expect(cooling.status).toBe(429);
    expect(await cooling.json()).toMatchObject({
      code: "DIAGNOSTIC_COOLDOWN",
      retry_after_ms: 10000,
    });
    await vi.advanceTimersByTimeAsync(10000);
    vi.stubGlobal("fetch", () => Promise.resolve(answer()));
    expect(events((await diagnose(application)).text).at(-1)?.data).toMatchObject({
      status: "succeeded",
    });
  });

  it("只取消 SSE 响应读取也会中止模型并释放名额", async () => {
    vi.useFakeTimers();
    const transport = controlledTransport();
    const application = app();
    const response = await application.request("/model-diagnostics", { method: "POST", headers });
    const reader = response.body?.getReader();
    await reader?.read();
    await transport.ready;
    await vi.advanceTimersByTimeAsync(10000);
    await reader?.cancel();
    expect(transport.signal()?.aborted).toBe(true);
    vi.stubGlobal("fetch", () => Promise.resolve(answer()));
    expect(events((await diagnose(application)).text).at(-1)?.data).toMatchObject({
      status: "succeeded",
    });
  });

  it("数据库快照等待期间取消，后到配置不得再触发模型", async () => {
    const settings: AgentServiceConfig = { ...config(), businessConfigurationStorage: "database" };
    let finishSnapshot: (value: unknown) => void = () => {};
    let resolveStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    vi.spyOn(BackendClient.prototype, "agentRuntimeSnapshot").mockImplementation(() => {
      resolveStarted();
      return new Promise((resolve) => {
        finishSnapshot = resolve;
      });
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(answer());
    vi.stubGlobal("fetch", fetcher);
    const controller = new AbortController();
    const running = app(settings).request("/model-diagnostics", {
      method: "POST",
      headers,
      signal: controller.signal,
    });
    await started;
    controller.abort();
    const response = await running;
    expect(response.status).toBe(409);
    finishSnapshot({ version_id: "late", document: agentRuntimeImportDocument(settings) });
    await Promise.resolve();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["GET", "POST"])("%s 配置读取将取消信号传到实际后端 HTTP", async (method) => {
    const settings: AgentServiceConfig = { ...config(), businessConfigurationStorage: "database" };
    let backendSignal: AbortSignal | null | undefined;
    let resolveStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const requests: string[] = [];
    vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requests.push(input instanceof Request ? input.url : String(input));
      backendSignal = init?.signal;
      resolveStarted();
      return new Promise<Response>((_resolve, reject) => {
        backendSignal?.addEventListener(
          "abort",
          () => reject(new DOMException("cancel", "AbortError")),
          { once: true },
        );
      });
    });
    const controller = new AbortController();
    const running = app(settings).request("/model-diagnostics", {
      method,
      headers,
      signal: controller.signal,
    });
    await started;
    controller.abort();
    await running;
    expect(backendSignal?.aborted).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("/api/v1/runtime-config/agent-runtime");
  });

  it("配置读取阶段也遵守 60 秒预算，并释放实例名额", async () => {
    vi.useFakeTimers();
    const settings: AgentServiceConfig = {
      ...config(),
      businessConfigurationStorage: "database",
      backendTimeoutMs: 120000,
    };
    let backendSignal: AbortSignal | null | undefined;
    let resolveStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    vi.stubGlobal("fetch", (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      backendSignal = init?.signal;
      resolveStarted();
      return new Promise<Response>((_resolve, reject) => {
        backendSignal?.addEventListener(
          "abort",
          () => reject(new DOMException("cancel", "AbortError")),
          { once: true },
        );
      });
    });
    const application = app(settings);
    const running = application.request("/model-diagnostics", { method: "POST", headers });
    await started;
    await vi.advanceTimersByTimeAsync(60000);
    const response = await running;
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ code: "DIAGNOSTIC_DEADLINE_EXCEEDED" });
    expect(backendSignal?.aborted).toBe(true);
    vi.spyOn(BackendClient.prototype, "agentRuntimeSnapshot").mockResolvedValue({
      version_id: "recovered",
      document: agentRuntimeImportDocument(settings),
    });
    vi.stubGlobal("fetch", () => Promise.resolve(answer()));
    expect(events((await diagnose(application)).text).at(-1)?.data).toMatchObject({
      status: "succeeded",
    });
  });
});
