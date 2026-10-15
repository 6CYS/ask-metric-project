/**
 * pi-ai 模型接入：以自定义 provider 指向行内 OpenAI 兼容模型网关。
 * 密钥由调用方从运行配置注入（支持 SM4 密文解密后的明文），此处不落盘、不输出日志。
 */
import {
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
  type MutableModels,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { AgentServiceConfig } from "./config.js";

export const ASK_METRIC_PROVIDER_ID = "ask-metric";
/** 模型在首次响应时限内未返回任何内容；错误文本含 timeout，由原生重试策略自动重试一次。 */
export const MODEL_FIRST_RESPONSE_TIMEOUT = "MODEL_FIRST_RESPONSE_TIMEOUT";
/** 仅保留旧会话错误码兼容；新请求不再按固定总时长中断持续输出。 */
export const MODEL_DEADLINE_EXCEEDED = "MODEL_DEADLINE_EXCEEDED";
/** 已开始输出后长时间没有有效进展；不含 timeout，避免原生策略重放已有输出的请求。 */
export const MODEL_STREAM_IDLE_EXCEEDED = "MODEL_STREAM_IDLE_EXCEEDED";

interface ResponseProgressWatch {
  signal: AbortSignal;
  progress(event: AssistantMessageEvent): void;
  errorMessage(): string | undefined;
  dispose(): void;
}

/** 响应头和空增量不算进展；思考、正文及工具调用均属于模型真实输出。 */
function hasOutputProgress(event: AssistantMessageEvent): boolean {
  switch (event.type) {
    case "text_delta":
    case "thinking_delta":
    case "toolcall_delta":
      return event.delta.length > 0;
    case "toolcall_start": {
      const block = event.partial.content[event.contentIndex];
      return block?.type === "toolCall" && !!block.id && !!block.name;
    }
    case "toolcall_end":
      return !!event.toolCall.id && !!event.toolCall.name;
    default:
      return false;
  }
}

/** 首次有效输出前计时，之后每次进展续期；持续正常输出没有固定总时限。 */
function watchResponseProgress(firstResponseMs?: number, idleMs?: number): ResponseProgressWatch {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let errorMessage: string | undefined;
  const dispose = () => {clearTimeout(timer); timer = undefined;};
  const arm = (ms: number | undefined, first: boolean) => {
    dispose();
    if (!ms || controller.signal.aborted) return;
    timer = setTimeout(() => {
      errorMessage = first
        ? `${MODEL_FIRST_RESPONSE_TIMEOUT}: 模型服务未在时限内开始返回内容（first response timeout）。`
        : `${MODEL_STREAM_IDLE_EXCEEDED}: 模型输出长时间没有有效进展，本轮未正常完成。`;
      controller.abort();
    }, ms);
  };
  arm(firstResponseMs ?? idleMs, true);
  return {signal: controller.signal, errorMessage: () => errorMessage, dispose,
    progress: event => {if (hasOutputProgress(event)) arm(idleMs, false);}};
}

export interface ModelBundle {
  models: MutableModels;
  model: Model<"openai-completions">;
}

/**
 * 模型调用的 fail-closed 授权边界：包装 provider 的流实现，
 * 授权失效时在发出任何请求前直接返回错误流，内部实现（含 HTTP）零调用。
 * 原生 hook 异常可能被报告后跳过，不能作为唯一拦截点；授权判断由宿主按会话注入。
 */
export function wrapStreamsWithAuthorization(
  inner: ProviderStreams,
  authorize: () => boolean,
  idleTimeoutMs?: number,
  firstResponseTimeoutMs?: number,
): ProviderStreams {
  const timed = <T extends {signal?: AbortSignal; timeoutMs?: number}>(options: T | undefined, watch: ResponseProgressWatch): T & {signal: AbortSignal} => {
    // 两阶段计时统一由本层负责；取消旧请求 timeout 参数，避免与响应进度的语义冲突。
    const {timeoutMs: _requestTimeoutMs, ...rest} = options ?? {};
    return {...rest, signal: options?.signal ? AbortSignal.any([options.signal, watch.signal]) : watch.signal} as T & {signal: AbortSignal};
  };
  const denied = (model: Model<"openai-completions">): ReturnType<ProviderStreams["streamSimple"]> => {
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage: "CONTEXT_ACCESS_CHANGED",
      timestamp: Date.now(),
    };
    queueMicrotask(() => {
      stream.push({ type: "error", reason: "error", error: message });
      stream.end(message);
    });
    return stream;
  };
  const guarded: ProviderStreams = {
    stream: (model, context, options) => {
      if (!authorize()) return denied(model as Model<"openai-completions">);
      const watch = watchResponseProgress(firstResponseTimeoutMs, idleTimeoutMs);
      const requestOptions = timed(options, watch);
      try {
        return normalizeProviderResponse(inner.stream(model, context, requestOptions),
          model as Model<"openai-completions">, options?.signal, watch, requestOptions.signal);
      } catch (error) {watch.dispose(); throw error;}
    },
    streamSimple: (model, context, options) => {
      if (!authorize()) return denied(model as Model<"openai-completions">);
      const watch = watchResponseProgress(firstResponseTimeoutMs, idleTimeoutMs);
      const requestOptions = timed(options, watch);
      try {
        return normalizeProviderResponse(inner.streamSimple(model, context, requestOptions),
          model as Model<"openai-completions">, options?.signal, watch, requestOptions.signal);
      } catch (error) {watch.dispose(); throw error;}
    },
  };
  if (inner.fetchDeferred) {
    const fetchDeferred = inner.fetchDeferred;
    guarded.fetchDeferred = (model, handle, options) => {
      if (!authorize()) throw new Error("CONTEXT_ACCESS_CHANGED");
      return fetchDeferred(model, handle, options);
    };
  }
  if (inner.cancelDeferred) {
    guarded.cancelDeferred = inner.cancelDeferred.bind(inner);
  }
  return guarded;
}

/** 传输协议失败不能作为业务回答；本地超时也不等于用户主动取消。 */
function normalizeProviderResponse(
  source: ReturnType<ProviderStreams["streamSimple"]>, model: Model<"openai-completions">, callerSignal: AbortSignal | undefined,
  watch: ResponseProgressWatch, signal: AbortSignal,
): ReturnType<ProviderStreams["streamSimple"]> {
  const output = createAssistantMessageEventStream();
  let finished = false;
  let lastMessage: AssistantMessage = {
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    timestamp: Date.now(), stopReason: "error",
    usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}},
  };
  const normalize = (message: AssistantMessage): AssistantMessage => {
    if (message.stopReason === "aborted" && !callerSignal?.aborted) return {...message, stopReason: "error",
      errorMessage: watch.errorMessage() ?? message.errorMessage ?? "MODEL_STREAM_FAILED: 模型响应流未完成。"};
    // 网关偶发把工具协议标签作为正文返回；禁止展示或把文本伪调用解析成可执行工具。
    const text = message.content.filter(block => block.type === "text").map(block => block.text).join("").trim();
    if (/<(?:[｜|]DSML[｜|]|tool_call(?:s)?[>\s])/u.test(text)) return {...message, content: [], stopReason: "error",
      errorMessage: "MODEL_TOOL_PROTOCOL_ERROR: 模型返回了无效工具调用格式，本轮未正常完成。已确认的查询条件仍保留。"};
    return message;
  };
  const finish = (message: AssistantMessage) => {
    if (finished) return;
    finished = true;
    watch.dispose();
    signal.removeEventListener("abort", abort);
    output.end(message);
  };
  const fail = () => {
    if (finished) return;
    // provider 的 partial 是共享可变对象；失败快照保留已生成内容，但不能作为完成回答或工具执行。
    const error: AssistantMessage = {...structuredClone(lastMessage),
      stopReason: callerSignal?.aborted ? "aborted" : "error",
      errorMessage: callerSignal?.aborted ? "模型请求已取消。"
        : watch.errorMessage() ?? "MODEL_STREAM_FAILED: 模型响应流未完成。"};
    output.push({type: "error", reason: error.stopReason === "aborted" ? "aborted" : "error", error});
    finish(error);
  };
  const abort = () => fail();
  // 即使底层未及时响应取消，也及时结束上层等待；后续迟到事件不得覆盖失败终态。
  signal.addEventListener("abort", abort, {once: true});
  if (signal.aborted) fail();
  void (async () => {
    for await (const event of source) {
      if (finished) return;
      lastMessage = event.type === "error" ? event.error : event.type === "done" ? event.message : event.partial;
      watch.progress(event);
      if (event.type === "error") {
        const error = normalize(event.error);
        output.push({...event, error, reason: error.stopReason === "aborted" ? "aborted" : "error"});
        finish(error);
        return;
      } else if (event.type === "done") {
        const message = normalize(event.message);
        if (message.stopReason === "error") output.push({type: "error", reason: "error", error: message});
        else output.push(event);
        finish(message);
        return;
      } else output.push(event);
    }
    if (!finished) finish(normalize(await source.result()));
  })().catch(fail);
  return output;
}

export function createAskMetricModels(
  config: AgentServiceConfig,
  authorize: () => boolean = () => true,
): ModelBundle {
  const { model: modelConfig } = config;
  const model: Model<"openai-completions"> = {
    id: modelConfig.name,
    name: modelConfig.name,
    api: "openai-completions",
    provider: ASK_METRIC_PROVIDER_ID,
    baseUrl: modelConfig.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: modelConfig.contextWindow,
    maxTokens: modelConfig.maxTokens,
    // 网关/模型扩展参数（如 Qwen 的 enable_thinking），由运行配置注入；
    // 采样默认 temperature=0 保证确定性，AGENT_MODEL_EXTRA_BODY 可按键覆盖。
    samplingParams: { temperature: 0, ...modelConfig.extraBody },
  };

  // 行内网关的鉴权头可配置：默认 Authorization: Bearer，也支持 accessKey 等自定义头
  const authHeader = modelConfig.authHeader;
  const authPrefix = modelConfig.authPrefix.trimEnd();
  const apiKey = modelConfig.apiKey;
  const headerValue = authPrefix ? `${authPrefix} ${apiKey}` : apiKey;
  const provider = createProvider({
    id: ASK_METRIC_PROVIDER_ID,
    name: "行内模型网关",
    baseUrl: modelConfig.baseUrl,
    auth: {
      apiKey: {
        name: "行内模型 API Key",
        resolve: async () => ({ auth: apiKey ? { headers: { [authHeader]: headerValue } } : {} }),
      },
    },
    models: [model],
    api: wrapStreamsWithAuthorization(openAICompletionsApi(), authorize, config.modelStreamIdleTimeoutMs,
      config.modelFirstResponseTimeoutMs),
  });

  const models = createModels();
  models.setProvider(provider);
  return { models, model };
}
