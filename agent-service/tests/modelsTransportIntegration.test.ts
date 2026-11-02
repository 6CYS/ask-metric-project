import {createAssistantMessageEventStream, type AssistantMessage, type Model, type ProviderStreams} from "@earendil-works/pi-ai";
import {afterEach, describe, expect, it, vi} from "vitest";
import {MODEL_FIRST_RESPONSE_TIMEOUT, wrapStreamsWithAuthorization} from "../src/models.js";

const model: Model<"openai-completions"> = {id: "test", name: "test", api: "openai-completions",
  provider: "test", baseUrl: "https://provider.test", reasoning: false, input: ["text"],
  contextWindow: 1000, maxTokens: 100, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}};
const message = (): AssistantMessage => ({role: "assistant", api: model.api, provider: model.provider,
  model: model.id, timestamp: 0, content: [{type: "text", text: "完成"}], stopReason: "stop",
  usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}});

function provider(): ProviderStreams {
  const stream: ProviderStreams["streamSimple"] = (_model, _context, options) => {
    const result = createAssistantMessageEventStream();
    void (async () => {
      try {
        await options!.fetch!("https://provider.test/private?secret=hidden",
          options?.signal ? {signal: options.signal} : {});
        const answer = message();
        result.push({type: "done", reason: "stop", message: answer});
        result.end(answer);
      } catch {
        const answer: AssistantMessage = {...message(), content: [], stopReason: "aborted"};
        result.push({type: "error", reason: "aborted", error: answer});
        result.end(answer);
      }
    })();
    return result;
  };
  return {stream, streamSimple: stream};
}

afterEach(() => {vi.restoreAllMocks(); vi.useRealTimers();});

describe("模型接入的传输诊断接线", () => {
  it("保留调用方 fetch 和正常模型结果，并输出一次脱敏 HTTP 摘要", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const response = new Response("正文不应由诊断读取", {headers: {"x-request-id": "request-1"}});
    let fetchCalls = 0;
    const customFetch: typeof fetch = async () => {fetchCalls++; return response;};
    const wrapped = wrapStreamsWithAuthorization(provider(), () => true);
    expect((await wrapped.streamSimple(model, {messages: []}, {fetch: customFetch, sessionId: "session-1"}).result()).stopReason).toBe("stop");
    expect(fetchCalls).toBe(1);
    expect(response.bodyUsed).toBe(false);
    const events = log.mock.calls.map(([value]) => JSON.parse(String(value)));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({event: "model_transport", session_id: "session-1", model: "test", status: 200});
    expect(JSON.stringify(events)).not.toMatch(/hidden|private|正文/);
  });

  it("授权拒绝时不触发任何 HTTP 请求或传输诊断", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const customFetch = vi.fn<typeof fetch>();
    const wrapped = wrapStreamsWithAuthorization(provider(), () => false);
    expect((await wrapped.streamSimple(model, {messages: []}, {fetch: customFetch}).result()).errorMessage)
      .toBe("CONTEXT_ACCESS_CHANGED");
    expect(customFetch).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("原首响应时限仍会取消 HTTP，诊断不延长等待也不增加重试", async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    let fetchCalls = 0;
    const customFetch: typeof fetch = async (_input, init) => {
      fetchCalls++;
      return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort",
        () => reject(new DOMException("cancel", "AbortError")), {once: true}));
    };
    const wrapped = wrapStreamsWithAuthorization(provider(), () => true, 100, 10);
    const result = wrapped.streamSimple(model, {messages: []}, {fetch: customFetch}).result();
    await vi.advanceTimersByTimeAsync(10);
    expect((await result).errorMessage).toContain(MODEL_FIRST_RESPONSE_TIMEOUT);
    expect(fetchCalls).toBe(1);
    expect(log.mock.calls.map(([value]) => JSON.parse(String(value))))
      .toMatchObject([{event: "model_transport", status: null, error_code: "AbortError"}]);
  });
});
