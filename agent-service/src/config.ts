/**
 * 服务运行配置：全部来自环境变量，敏感项支持 ENC[SM4:v1:...] 密文。
 * 模型地址与密钥不写入源码、日志或查询响应。
 */
import {
  decryptConfigValue,
  isEncryptedConfigValue,
  loadConfigSm4Key,
} from "./sm4ConfigCrypto.js";

export interface AgentServiceConfig {
  host: string;
  port: number;
  /** FastAPI 后端内网地址，agent 工具调用经由此处并透传用户 Bearer */
  backendBaseUrl: string;
  backendTimeoutMs: number;
  /** 首次有效输出后，相邻有效输出的最大空闲时间；不限制整次调用总时长。 */
  modelStreamIdleTimeoutMs?: number;
  /** 从发出请求到收到第一段有效模型输出的时限；超出后按重试策略自动重试。 */
  modelFirstResponseTimeoutMs?: number;
  /** 模型重试策略：默认只重试一次，避免超时按指数退避静默拖满两分钟 */
  modelRetry: { enabled: boolean; maxRetries: number; baseDelayMs: number };
  /** 临时回答流式展示；最终内容仍由原生快照投影。 */
  answerStreaming?: boolean;
  /** 仅影响新 operation；普通取值的宿主交付，observe 只记资格不省模型调用。 */
  directQueryDelivery?: "off" | "observe" | "on";
  /** 发送副本的回执视图；raw 保留原始工具内容，持久记录始终不变。 */
  modelContextView?: "raw" | "compact_v1";
  semanticPromptVariant?: "full" | "compact_v1";
  /** 模型网关不兼容强制工具选择时使用auto；服务端业务与结果校验保持生效。 */
  modelToolChoicePolicy?: "native" | "auto";
  model: {
    baseUrl: string;
    name: string;
    apiKey: string;
    /** 鉴权头名称与前缀：默认 Authorization + "Bearer "，行内网关可能用 accessKey 等自定义头 */
    authHeader: string;
    authPrefix: string;
    /** 追加在用户消息末尾的后缀（如 Qwen 的 /no_think），为空不追加 */
    userMessageSuffix: string;
    /** 并入每次模型请求体的扩展参数（如 {"enable_thinking": false}），JSON 配置 */
    extraBody: Record<string, unknown>;
    contextWindow: number;
    maxTokens: number;
  };
  /** 会话持久化目录（原生 JSONL 存储，重启后恢复；生产指向持久状态目录） */
  dataDir: string;
  /** 原生压缩配置：仅映射 pi 原生 CompactionSettings 字段，不实现第二套阈值算法 */
  compaction: {
    enabled: boolean;
    reserveTokens: number;
    keepRecentTokens: number;
  };
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = (env[name] ?? "").trim();
  if (!value) {
    throw new Error(`缺少必需环境变量 ${name}`);
  }
  return value;
}

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (!raw || !raw.trim()) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`环境变量 ${name} 必须是正整数`);
  }
  return value;
}

function parseJsonObject(raw: string | undefined, name: string): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new Error(`环境变量 ${name} 必须是 JSON 对象`);
  }
}

function parseBoolean(raw: string | undefined, fallback: boolean, name: string): boolean {
  if (!raw || !raw.trim()) return fallback;
  const value = raw.trim().toLowerCase();
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`环境变量 ${name} 必须是 true/false`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentServiceConfig {
  const directQueryDelivery = env.AGENT_DIRECT_QUERY_DELIVERY?.trim() || "on";
  const modelToolChoicePolicy = env.AGENT_MODEL_TOOL_CHOICE_POLICY?.trim() || "native";
  if (!["native", "auto"].includes(modelToolChoicePolicy)) throw new Error("AGENT_MODEL_TOOL_CHOICE_POLICY 必须为 native 或 auto");
  if (!["off", "observe", "on"].includes(directQueryDelivery)) throw new Error("AGENT_DIRECT_QUERY_DELIVERY 必须为 off、observe 或 on");
  const modelContextView = env.AGENT_MODEL_CONTEXT_VIEW?.trim() || "compact_v1";
  if (!["raw", "compact_v1"].includes(modelContextView)) throw new Error("AGENT_MODEL_CONTEXT_VIEW 必须为 raw 或 compact_v1");
  const semanticPromptVariant = env.AGENT_SEMANTIC_PROMPT_VARIANT?.trim() || "compact_v1";
  if (!["full", "compact_v1"].includes(semanticPromptVariant)) throw new Error("AGENT_SEMANTIC_PROMPT_VARIANT 必须为 full 或 compact_v1");
  // 存在任一密文时必须先加载主密钥；密钥缺失或密文被篡改时拒绝启动
  const sensitiveNames = ["AGENT_MODEL_API_KEY"] as const;
  const needsKey = sensitiveNames.some((name) => isEncryptedConfigValue(env[name]));
  const masterKey = needsKey ? loadConfigSm4Key(env) : undefined;
  const resolve = (value: string): string =>
    isEncryptedConfigValue(value) ? decryptConfigValue(value, masterKey) : value;

  const apiKey = resolve(requireEnv(env, "AGENT_MODEL_API_KEY"));
  const contextWindow = parsePositiveInt(env.AGENT_MODEL_CONTEXT_WINDOW, 128_000, "AGENT_MODEL_CONTEXT_WINDOW");
  const maxTokens = parsePositiveInt(env.AGENT_MODEL_MAX_TOKENS, 8_192, "AGENT_MODEL_MAX_TOKENS");
  // 收紧原生 SDK 的重试次数，避免未响应时多次重试拉长无反馈等待。
  const modelRetry = {
    enabled: parseBoolean(env.AGENT_MODEL_RETRY_ENABLED, true, "AGENT_MODEL_RETRY_ENABLED"),
    maxRetries: parsePositiveInt(env.AGENT_MODEL_MAX_RETRIES, 1, "AGENT_MODEL_MAX_RETRIES"),
    baseDelayMs: parsePositiveInt(env.AGENT_MODEL_RETRY_BASE_DELAY_MS, 1_000, "AGENT_MODEL_RETRY_BASE_DELAY_MS"),
  };
  // 新配置优先；旧总时限变量仅兼容为空闲时限，已有部署无需先修改环境文件。
  const modelStreamIdleTimeoutName = env.AGENT_MODEL_STREAM_IDLE_TIMEOUT_MS?.trim()
    ? "AGENT_MODEL_STREAM_IDLE_TIMEOUT_MS" : "AGENT_MODEL_TIMEOUT_MS";
  const compaction = {
    enabled: parseBoolean(env.AGENT_COMPACTION_ENABLED, true, "AGENT_COMPACTION_ENABLED"),
    reserveTokens: parsePositiveInt(env.AGENT_COMPACTION_RESERVE_TOKENS, 16_384, "AGENT_COMPACTION_RESERVE_TOKENS"),
    keepRecentTokens: parsePositiveInt(env.AGENT_COMPACTION_KEEP_RECENT_TOKENS, 20_000, "AGENT_COMPACTION_KEEP_RECENT_TOKENS"),
  };
  // 配置一致性检查：压缩与输出预算必须落在模型窗口内，配置不成立时拒绝启动
  if (maxTokens >= contextWindow) {
    throw new Error("AGENT_MODEL_MAX_TOKENS 必须小于 AGENT_MODEL_CONTEXT_WINDOW");
  }
  if (compaction.enabled && compaction.reserveTokens + compaction.keepRecentTokens >= contextWindow) {
    throw new Error("AGENT_COMPACTION_RESERVE_TOKENS + AGENT_COMPACTION_KEEP_RECENT_TOKENS 必须小于 AGENT_MODEL_CONTEXT_WINDOW");
  }
  return {
    host: (env.AGENT_SERVICE_HOST ?? "127.0.0.1").trim() || "127.0.0.1",
    port: parsePositiveInt(env.AGENT_SERVICE_PORT, 8020, "AGENT_SERVICE_PORT"),
    backendBaseUrl: (env.BACKEND_BASE_URL ?? "http://127.0.0.1:8010").replace(/\/+$/, ""),
    backendTimeoutMs: parsePositiveInt(env.BACKEND_TIMEOUT_MS, 120_000, "BACKEND_TIMEOUT_MS"),
    modelStreamIdleTimeoutMs: parsePositiveInt(env[modelStreamIdleTimeoutName], 30_000, modelStreamIdleTimeoutName),
    modelFirstResponseTimeoutMs: parsePositiveInt(env.AGENT_MODEL_FIRST_RESPONSE_TIMEOUT_MS, 30_000,
      "AGENT_MODEL_FIRST_RESPONSE_TIMEOUT_MS"),
    modelRetry,
    answerStreaming: parseBoolean(env.AGENT_ANSWER_STREAMING, false, "AGENT_ANSWER_STREAMING"),
    directQueryDelivery: directQueryDelivery as "off" | "observe" | "on",
    modelToolChoicePolicy: modelToolChoicePolicy as "native" | "auto",
    modelContextView: modelContextView as "raw" | "compact_v1",
    semanticPromptVariant: semanticPromptVariant as "full" | "compact_v1",
    model: {
      baseUrl: requireEnv(env, "AGENT_MODEL_BASE_URL").replace(/\/+$/, ""),
      name: requireEnv(env, "AGENT_MODEL_NAME"),
      apiKey,
      authHeader: (env.AGENT_MODEL_AUTH_HEADER ?? "Authorization").trim() || "Authorization",
      authPrefix: env.AGENT_MODEL_AUTH_PREFIX ?? "Bearer",
      // .env 中的转义写法（\n、\t）还原为实际控制字符
      userMessageSuffix: (env.AGENT_MODEL_USER_SUFFIX ?? "").replace(/\\n/g, "\n").replace(/\\t/g, "\t"),
      extraBody: parseJsonObject(env.AGENT_MODEL_EXTRA_BODY, "AGENT_MODEL_EXTRA_BODY"),
      contextWindow,
      maxTokens,
    },
    dataDir: (env.AGENT_DATA_DIR ?? "./data").trim() || "./data",
    compaction,
  };
}
