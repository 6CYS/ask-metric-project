import {createServer, type ServerResponse} from "node:http";
import type {AddressInfo} from "node:net";
import {once} from "node:events";
import {openAICompletionsApi} from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type {Model} from "@earendil-works/pi-ai";
import {afterEach, describe, expect, it, vi} from "vitest";
import {wrapStreamsWithAuthorization} from "../src/models.js";
import {modelFailure} from "../src/modelFailure.js";

// 只替换模型 HTTP 边界，真实 SDK、流解析、超时与取消继续运行；不生成业务查询结果。
async function gateway(reply: (response: ServerResponse) => void) {
  let calls = 0;
  const server = createServer((_request, response) => {calls++; reply(response);});
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const model: Model<"openai-completions"> = {id: "fault-test", name: "fault-test", api: "openai-completions",
    provider: "fault-test", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100,
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}};
  return {model, calls: () => calls, close: async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }};
}

function incompleteChunk(response: ServerResponse) {
  response.writeHead(200, {"Content-Type": "text/event-stream"});
  response.write(`data: ${JSON.stringify({id: "fault", choices: [{index: 0,
    delta: {content: "未完成片段"}, finish_reason: null}]})}\n\n`);
}

afterEach(() => vi.restoreAllMocks());

describe("隔离模型 HTTP 故障注入", () => {
  it.each([
    [429, "rate_limit_exceeded", "MODEL_RATE_LIMITED", true],
    [429, "insufficient_quota", "MODEL_QUOTA_EXCEEDED", false],
    [503, "service_unavailable", "MODEL_SERVICE_UNAVAILABLE", true],
    [401, "invalid_api_key", "MODEL_AUTHENTICATION_FAILED", false],
  ] as const)("HTTP %s / %s 不被底层静默重试，保留可分类错误", async (status, code, expected, retryable) => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const test = await gateway(response => {
      response.writeHead(status, {"Content-Type": "application/json", "Retry-After": "1"});
      response.end(JSON.stringify({error: {code, message: `${code}: private-gateway-secret`}}));
    });
    try {
      const streams = wrapStreamsWithAuthorization(openAICompletionsApi(), () => true, 1000, 5000);
      const result = await streams.streamSimple(test.model, {messages: []}, {apiKey: "unused"}).result();
      expect(result.stopReason).toBe("error");
      expect(test.calls()).toBe(1);
      expect(modelFailure(result.errorMessage ?? "")).toMatchObject({code: expected, retryable});
      expect(modelFailure(result.errorMessage ?? "").message).not.toContain("private-gateway-secret");
    } finally {await test.close();}
  });

  it.each([false, true])("HTTP 200 输出截断（含 DONE=%s）不得判为完成", async done => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const test = await gateway(response => {
      incompleteChunk(response);
      response.end(done ? "data: [DONE]\n\n" : undefined);
    });
    try {
      const streams = wrapStreamsWithAuthorization(openAICompletionsApi(), () => true, 1000, 5000);
      const result = await streams.streamSimple(test.model, {messages: []}, {apiKey: "unused"}).result();
      expect(result.stopReason).toBe("error");
      expect(modelFailure(result.errorMessage ?? "").code).toBe("MODEL_STREAM_FAILED");
      expect(test.calls()).toBe(1);
    } finally {await test.close();}
  });

  it.each([false, true])("模型%s有效输出后卡住，按对应时限结束", async started => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const test = await gateway(response => {if (started) incompleteChunk(response);});
    try {
      const streams = wrapStreamsWithAuthorization(openAICompletionsApi(), () => true, 100, 300);
      const result = await streams.streamSimple(test.model, {messages: []}, {apiKey: "unused"}).result();
      expect(result.stopReason).toBe("error");
      expect(modelFailure(result.errorMessage ?? "").code)
        .toBe(started ? "MODEL_STREAM_IDLE_EXCEEDED" : "MODEL_FIRST_RESPONSE_TIMEOUT");
      expect(test.calls()).toBe(1);
    } finally {await test.close();}
  });

  it("等待响应时主动停止，取消不被改成模型故障", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const controller = new AbortController();
    const test = await gateway(() => controller.abort());
    try {
      const streams = wrapStreamsWithAuthorization(openAICompletionsApi(), () => true, 1000, 5000);
      const result = await streams.streamSimple(test.model, {messages: []},
        {apiKey: "unused", signal: controller.signal}).result();
      expect(result.stopReason).toBe("aborted");
      expect(test.calls()).toBe(1);
    } finally {await test.close();}
  });
});
