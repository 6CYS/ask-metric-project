import { Type, type Static } from "@earendil-works/pi-ai";
import { Check } from "typebox/value";
import { BackendApiError, type BackendClient } from "./backendClient.js";
import type { AgentServiceConfig } from "./config.js";

const positive = Type.Integer({ minimum: 1 });
const schema = Type.Object({
  schema_version: Type.Literal(1),
  model: Type.Object({
    baseUrl: Type.String(), name: Type.String(), apiKeyEnv: Type.Literal("AGENT_MODEL_API_KEY"),
    authHeader: Type.String({ pattern: "^[A-Za-z0-9-]+$" }), authPrefix: Type.String(),
    userMessageSuffix: Type.String(), extraBody: Type.Record(Type.String(), Type.Unknown()),
    contextWindow: positive, maxTokens: positive,
  }, { additionalProperties: false }),
  modelRetry: Type.Object({ enabled: Type.Boolean(), maxRetries: positive, baseDelayMs: positive },
    { additionalProperties: false }),
  modelStreamIdleTimeoutMs: positive, modelFirstResponseTimeoutMs: positive,
  answerStreaming: Type.Boolean(), topicQueryEnabled: Type.Boolean(),
  compaction: Type.Object({ enabled: Type.Boolean(), reserveTokens: positive, keepRecentTokens: positive },
    { additionalProperties: false }),
}, { additionalProperties: false });

export type AgentRuntimeDocument = Static<typeof schema>;
export interface AgentRuntimeSnapshot { version_id: string; document: AgentRuntimeDocument }

export function validateAgentRuntime(document: unknown): AgentRuntimeDocument {
  if (!Check(schema, document) || document.model.maxTokens >= document.model.contextWindow ||
    /[\r\n]/u.test(document.model.authPrefix) ||
    (document.compaction.enabled && document.compaction.reserveTokens + document.compaction.keepRecentTokens >= document.model.contextWindow))
    throw new BackendApiError(503, "Agent 运行配置无效", "AGENT_RUNTIME_INVALID");
  // 接口只传非敏感参数；嵌套扩展参数也不能夹带凭据。
  const encoded = JSON.stringify(document.model.extraBody);
  if (/"(?:accesskey|access_key|api_key|apikey|authorization)"\s*:/iu.test(encoded))
    throw new BackendApiError(503, "Agent 扩展参数含凭据字段", "AGENT_RUNTIME_INVALID");
  return structuredClone(document);
}

export async function databaseAgentRuntimeSnapshot(backend: BackendClient, versionId?: string): Promise<AgentRuntimeSnapshot> {
  const value = await backend.agentRuntimeSnapshot(versionId);
  if (!value || typeof value !== "object" || !("version_id" in value) ||
    typeof value.version_id !== "string" || !value.version_id || (versionId && value.version_id !== versionId) || !("document" in value))
    throw new BackendApiError(503, "Agent 运行配置响应无效", "AGENT_RUNTIME_INVALID");
  return { version_id: value.version_id, document: validateAgentRuntime(value.document) };
}

/** 只有启动安全配置提供密钥；轮次正文从数据库取得，不写回环境或本机文件。 */
export function materializeAgentRuntime(base: AgentServiceConfig, document: AgentRuntimeDocument): AgentServiceConfig {
  const { apiKeyEnv: _reference, ...model } = document.model;
  void _reference;
  return { ...base, ...document, model: { ...model, apiKey: base.model.apiKey } };
}

/** 受控导入时从实际生效配置提取；不调用它作为运行时默认值。 */
export function agentRuntimeImportDocument(config: AgentServiceConfig): AgentRuntimeDocument {
  const { apiKey: _secret, ...model } = config.model;
  void _secret;
  return validateAgentRuntime({ schema_version: 1, model: { ...model, apiKeyEnv: "AGENT_MODEL_API_KEY" },
    modelRetry: config.modelRetry, modelStreamIdleTimeoutMs: config.modelStreamIdleTimeoutMs,
    modelFirstResponseTimeoutMs: config.modelFirstResponseTimeoutMs,
    answerStreaming: config.answerStreaming ?? false, topicQueryEnabled: config.topicQueryEnabled ?? false,
    compaction: config.compaction });
}
