/**
 * pi-ai 模型接入：以自定义 provider 指向行内 OpenAI 兼容模型网关。
 * 密钥由调用方从运行配置注入（支持 SM4 密文解密后的明文），此处不落盘、不输出日志。
 */
import { createModels, createProvider, type Model, type MutableModels } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { AgentServiceConfig } from "./config.js";

export const ASK_METRIC_PROVIDER_ID = "ask-metric";

export interface ModelBundle {
  models: MutableModels;
  model: Model<"openai-completions">;
}

export function createAskMetricModels(config: AgentServiceConfig): ModelBundle {
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
    api: openAICompletionsApi(),
  });

  const models = createModels();
  models.setProvider(provider);
  return { models, model };
}
