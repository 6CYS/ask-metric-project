import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
  type ProviderStreams,
  type StreamOptions,
  isRetryableAssistantError,
} from "@earendil-works/pi-ai";
import * as openAICompletions from "@earendil-works/pi-ai/api/openai-completions";
import {MODEL_FIRST_RESPONSE_TIMEOUT, MODEL_STREAM_IDLE_EXCEEDED, wrapStreamsWithAuthorization} from "../src/models.js";

const model = {id: "synthetic", api: "openai-completions", provider: "synthetic"} as Model<"openai-completions">;
const openSources: ReturnType<typeof createAssistantMessageEventStream>[] = [];
function message(): AssistantMessage {
  return {role: "assistant", content: [{type: "text", text: ""}], api: model.api,
    provider: model.provider, model: model.id, timestamp: 0, stopReason: "stop",
    usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}};
}

function controlled(method: "stream" | "streamSimple", idle = 30_000, first = 30_000, caller?: AbortSignal) {
  const source = createAssistantMessageEventStream();
  openSources.push(source);
  const partial = message();
  let requestOptions: StreamOptions | undefined;
  const response: ProviderStreams["stream"] = (_model, _context, options) => {
    requestOptions = options;
    // 故意不响应 abort，验证宿主自己收敛失败，不依赖 provider 及时结束。
    return source;
  };
  const wrapped = wrapStreamsWithAuthorization({stream: response, streamSimple: response}, () => true, idle, first);
  const output = wrapped[method](model, {messages: []}, {...(caller ? {signal: caller} : {}), timeoutMs: 10});
  const push = async (event: AssistantMessageEvent) => {
    source.push(event);
    await vi.advanceTimersByTimeAsync(0);
  };
  const text = async (delta: string) => {
    const block = partial.content[0];
    if (block?.type === "text") block.text += delta;
    await push({type: "text_delta", contentIndex: 0, delta, partial});
  };
  return {source, partial, output, push, text, options: () => requestOptions};
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const source of openSources.splice(0)) source.end(message());
  vi.useRealTimers();
});

it.each(["stream", "streamSimple"] as const)("%s 持续输出超过旧30秒总时限仍能正常完成", async method => {
  const h = controlled(method);
  await h.push({type: "start", partial: h.partial});
  for (let i = 0; i < 5; i++) {
    await vi.advanceTimersByTimeAsync(10_000);
    await h.text(`第${i + 1}段。`);
    expect(h.options()?.signal?.aborted).toBe(false);
  }
  await h.push({type: "done", reason: "stop", message: h.partial});
  expect(await h.output.result()).toMatchObject({stopReason: "stop", content: [{text: "第1段。第2段。第3段。第4段。第5段。"}]});
  expect(h.options()).not.toHaveProperty("timeoutMs");
  expect(vi.getTimerCount()).toBe(0);
});

it("实际 OpenAI SDK 解析持续50秒的合成 SSE 时完成回答，不发起额外请求", async () => {
  let writer!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({start(controller) {writer = controller;}});
  const fetch = vi.fn(async () => new Response(body, {headers: {"content-type": "text/event-stream"}}));
  const actualModel: Model<"openai-completions"> = {...model, name: "synthetic", baseUrl: "https://synthetic.invalid/v1",
    reasoning: false, input: ["text"], cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
    contextWindow: 128_000, maxTokens: 8192};
  const wrapped = wrapStreamsWithAuthorization(openAICompletions, () => true, 30_000, 30_000);
  const output = wrapped.streamSimple(actualModel, {messages: [{role: "user", content: "合成问题", timestamp: 0}]},
    {apiKey: "synthetic", fetch});
  const encode = (delta: Record<string, unknown>, finish: string | null = null) => new TextEncoder().encode(
    `data: ${JSON.stringify({id: "synthetic", object: "chat.completion.chunk", created: 1, model: model.id,
      choices: [{index: 0, delta, finish_reason: finish}]})}\n\n`);
  try {
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
      writer.enqueue(encode({content: "合成段落。"}));
      await vi.advanceTimersByTimeAsync(0);
    }
    writer.enqueue(encode({}, "stop"));
    writer.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
    writer.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(await output.result()).toMatchObject({stopReason: "stop", content: [{type: "text", text: "合成段落。".repeat(5)}]});
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    try {writer.close();} catch { /* 流可能已正常关闭 */ }
  }
});

it("响应头、空文本块和空增量不能延长首次有效响应等待", async () => {
  const h = controlled("streamSimple", 5_000, 30_000);
  await h.push({type: "start", partial: h.partial});
  await vi.advanceTimersByTimeAsync(20_000);
  await h.push({type: "text_start", contentIndex: 0, partial: h.partial});
  await vi.advanceTimersByTimeAsync(9_999);
  await h.text("");
  expect(h.options()?.signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await h.output.result()).toMatchObject({stopReason: "error", errorMessage: expect.stringContaining(MODEL_FIRST_RESPONSE_TIMEOUT)});
  expect(h.options()?.signal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("开始输出后按最后一次进展检测停顿，保留失败快照且迟到事件不能覆盖", async () => {
  const h = controlled("streamSimple", 30_000, 5_000);
  await h.text("已输出的部分");
  await vi.advanceTimersByTimeAsync(29_999);
  await h.text("");
  expect(h.options()?.signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  const result = await h.output.result();
  expect(result).toMatchObject({stopReason: "error", errorMessage: expect.stringContaining(MODEL_STREAM_IDLE_EXCEEDED),
    content: [{text: "已输出的部分"}]});
  expect(isRetryableAssistantError(result)).toBe(true);
  await h.text("迟到的内容");
  await h.push({type: "done", reason: "stop", message: h.partial});
  expect(await h.output.result()).toBe(result);
  expect(result.content).toEqual([{type: "text", text: "已输出的部分"}]);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["thinking_delta", "toolcall_delta"] as const)("%s 持续生成可以超过30秒且独立使用流空闲时限", async type => {
  const h = controlled("streamSimple", 10_000, 3_000);
  h.partial.content = type === "thinking_delta" ? [{type: "thinking", thinking: ""}]
    : [{type: "toolCall", id: "call", name: "synthetic", arguments: {}}];
  const delta = type === "thinking_delta" ? "继续分析" : '"argument"';
  await h.push({type, contentIndex: 0, delta, partial: h.partial});
  for (let i = 0; i < 5; i++) {
    await vi.advanceTimersByTimeAsync(8_000);
    await h.push({type, contentIndex: 0, delta, partial: h.partial});
    expect(h.options()?.signal?.aborted).toBe(false);
  }
  await h.push({type: "done", reason: "stop", message: h.partial});
  expect((await h.output.result()).stopReason).toBe("stop");
  expect(vi.getTimerCount()).toBe(0);
});

it("无参数工具的有效调用也进入流输出阶段", async () => {
  const h = controlled("streamSimple", 10_000, 3_000);
  const toolCall = {type: "toolCall" as const, id: "call", name: "synthetic", arguments: {}};
  h.partial.content = [toolCall];
  await h.push({type: "toolcall_start", contentIndex: 0, partial: h.partial});
  await vi.advanceTimersByTimeAsync(8_000);
  await h.push({type: "toolcall_end", contentIndex: 0, toolCall, partial: h.partial});
  await vi.advanceTimersByTimeAsync(8_000);
  expect(h.options()?.signal?.aborted).toBe(false);
  await h.push({type: "done", reason: "toolUse", message: {...h.partial, stopReason: "toolUse"}});
  expect((await h.output.result()).stopReason).toBe("toolUse");
});

it("开始输出后的空思考或空工具增量不能掩盖停顿", async () => {
  const h = controlled("streamSimple", 10_000, 3_000);
  await h.text("部分回答");
  await vi.advanceTimersByTimeAsync(9_000);
  await h.push({type: "thinking_start", contentIndex: 0, partial: h.partial});
  await h.push({type: "thinking_delta", contentIndex: 0, delta: "", partial: h.partial});
  await h.push({type: "toolcall_delta", contentIndex: 0, delta: "", partial: h.partial});
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await h.output.result()).toMatchObject({stopReason: "error", errorMessage: expect.stringContaining(MODEL_STREAM_IDLE_EXCEEDED)});
});

it("用户取消保持 aborted，立即停止等待并清理输出计时", async () => {
  const caller = new AbortController();
  const h = controlled("streamSimple", 30_000, 30_000, caller.signal);
  await h.text("部分回答");
  caller.abort();
  expect(await h.output.result()).toMatchObject({stopReason: "aborted", errorMessage: "模型请求已取消。"});
  expect(h.options()?.signal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("完成、服务错误和同步建流异常均清理计时器", async () => {
  const h = controlled("streamSimple");
  const error = {...h.partial, stopReason: "error" as const, errorMessage: "synthetic failure"};
  await h.push({type: "error", reason: "error", error});
  expect(await h.output.result()).toBe(error);
  expect(vi.getTimerCount()).toBe(0);
  const fail = () => {throw new Error("synthetic setup failure");};
  const wrapped = wrapStreamsWithAuthorization({stream: fail, streamSimple: fail}, () => true, 30_000, 30_000);
  expect(() => wrapped.streamSimple(model, {messages: []})).toThrow("synthetic setup failure");
  expect(vi.getTimerCount()).toBe(0);
});

it("授权被拒时不调用 provider，也不启动任何超时计时", async () => {
  const call = vi.fn();
  const wrapped = wrapStreamsWithAuthorization({stream: call, streamSimple: call}, () => false, 30_000, 30_000);
  expect(await wrapped.streamSimple(model, {messages: []}).result()).toMatchObject({errorMessage: "CONTEXT_ACCESS_CHANGED"});
  expect(call).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
