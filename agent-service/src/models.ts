/**
 * pi-ai 模型接入：以自定义 provider 指向行内 OpenAI 兼容模型网关。
 * 密钥由调用方从运行配置注入（支持 SM4 密文解密后的明文），此处不落盘、不输出日志。
 */
import {
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  type AssistantMessage,
  type Model,
  type MutableModels,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { AgentServiceConfig } from "./config.js";

export const ASK_METRIC_PROVIDER_ID = "ask-metric";

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
  timeoutMs?: number,
): ProviderStreams {
  const timed = <T extends {signal?: AbortSignal; timeoutMs?: number}>(options: T | undefined): T | undefined => {
    if (!timeoutMs) return options;
    // SDK 请求超时不一定覆盖已开始的流；组合总时限与用户取消信号，避免流式参数永久挂起。
    const deadline = AbortSignal.timeout(timeoutMs);
    return {...options, timeoutMs, signal: options?.signal
      ? AbortSignal.any([options.signal, deadline]) : deadline} as T;
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
      return normalizeProviderResponse(inner.stream(model, context, timed(options)), model as Model<"openai-completions">, options?.signal);
    },
    streamSimple: (model, context, options) => {
      if (!authorize()) return denied(model as Model<"openai-completions">);
      return normalizeProviderResponse(inner.streamSimple(model, context, timed(options)), model as Model<"openai-completions">, options?.signal);
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
  source: ReturnType<ProviderStreams["streamSimple"]>, model: Model<"openai-completions">, callerSignal?: AbortSignal,
): ReturnType<ProviderStreams["streamSimple"]> {
  const output = createAssistantMessageEventStream();
  const normalize = (message: AssistantMessage): AssistantMessage => {
    // 错误码刻意不含 "timeout" 字样：SDK 的 isRetryableAssistantError 按字符串匹配
    // "timeout" 判定可重试，超时是确定性失败，重试只会把单次预算花两遍且全程无反馈。
    if (message.stopReason === "aborted" && !callerSignal?.aborted) return {...message, stopReason: "error",
      errorMessage: "MODEL_DEADLINE_EXCEEDED: 模型请求超出本地时限，本轮未正常完成。"};
    // 网关偶发把工具协议标签作为正文返回；禁止展示或把文本伪调用解析成可执行工具。
    const text = message.content.filter(block => block.type === "text").map(block => block.text).join("").trim();
    if (/<(?:[｜|]DSML[｜|]|tool_call(?:s)?[>\s])/u.test(text)) return {...message, content: [], stopReason: "error",
      errorMessage: "MODEL_TOOL_PROTOCOL_ERROR: 模型返回了无效工具调用格式，本轮未正常完成。已确认的查询条件仍保留。"};
    return message;
  };
  void (async () => {
    for await (const event of source) {
      if (event.type === "error") {
        const error = normalize(event.error);
        output.push({...event, error, reason: error.stopReason === "aborted" ? "aborted" : "error"});
      } else if (event.type === "done") {
        const message = normalize(event.message);
        if (message.stopReason === "error") output.push({type: "error", reason: "error", error: message});
        else output.push(event);
      } else output.push(event);
    }
    output.end(normalize(await source.result()));
  })().catch(() => {
    const error: AssistantMessage = {
      role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
      timestamp: Date.now(), stopReason: callerSignal?.aborted ? "aborted" : "error",
      errorMessage: "MODEL_STREAM_FAILED: 模型响应流未完成。",
      usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}},
    };
    output.push({type: "error", reason: callerSignal?.aborted ? "aborted" : "error", error});
    output.end(error);
  });
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
    // 网关/模型扩展参数（如 Qwen 的 enable_thinking），由运行配置注入
    samplingParams: modelConfig.extraBody,
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
    api: wrapStreamsWithAuthorization(openAICompletionsApi(), authorize, config.modelTimeoutMs),
  });

  const models = createModels();
  models.setProvider(provider);
  return { models, model };
}
