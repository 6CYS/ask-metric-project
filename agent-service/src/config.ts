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
  modelTimeoutMs?: number;
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
  /** 会话持久化目录（JSON 文件存储，重启后恢复；生产指向持久状态目录） */
  dataDir: string;
  maxSessionsPerUser: number;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentServiceConfig {
  // 存在任一密文时必须先加载主密钥；密钥缺失或密文被篡改时拒绝启动
  const sensitiveNames = ["AGENT_MODEL_API_KEY"] as const;
  const needsKey = sensitiveNames.some((name) => isEncryptedConfigValue(env[name]));
  const masterKey = needsKey ? loadConfigSm4Key(env) : undefined;
  const resolve = (value: string): string =>
    isEncryptedConfigValue(value) ? decryptConfigValue(value, masterKey) : value;

  const apiKey = resolve(requireEnv(env, "AGENT_MODEL_API_KEY"));
  return {
    host: (env.AGENT_SERVICE_HOST ?? "127.0.0.1").trim() || "127.0.0.1",
    port: parsePositiveInt(env.AGENT_SERVICE_PORT, 8020, "AGENT_SERVICE_PORT"),
    backendBaseUrl: (env.BACKEND_BASE_URL ?? "http://127.0.0.1:8010").replace(/\/+$/, ""),
    backendTimeoutMs: parsePositiveInt(env.BACKEND_TIMEOUT_MS, 120_000, "BACKEND_TIMEOUT_MS"),
    modelTimeoutMs: parsePositiveInt(env.AGENT_MODEL_TIMEOUT_MS, 30_000, "AGENT_MODEL_TIMEOUT_MS"),
    model: {
      baseUrl: requireEnv(env, "AGENT_MODEL_BASE_URL").replace(/\/+$/, ""),
      name: requireEnv(env, "AGENT_MODEL_NAME"),
      apiKey,
      authHeader: (env.AGENT_MODEL_AUTH_HEADER ?? "Authorization").trim() || "Authorization",
      authPrefix: env.AGENT_MODEL_AUTH_PREFIX ?? "Bearer",
      // .env 中的转义写法（\n、\t）还原为实际控制字符
      userMessageSuffix: (env.AGENT_MODEL_USER_SUFFIX ?? "").replace(/\\n/g, "\n").replace(/\\t/g, "\t"),
      extraBody: parseJsonObject(env.AGENT_MODEL_EXTRA_BODY, "AGENT_MODEL_EXTRA_BODY"),
      contextWindow: parsePositiveInt(env.AGENT_MODEL_CONTEXT_WINDOW, 128_000, "AGENT_MODEL_CONTEXT_WINDOW"),
      maxTokens: parsePositiveInt(env.AGENT_MODEL_MAX_TOKENS, 8_192, "AGENT_MODEL_MAX_TOKENS"),
    },
    dataDir: (env.AGENT_DATA_DIR ?? "./data").trim() || "./data",
    maxSessionsPerUser: parsePositiveInt(env.AGENT_MAX_SESSIONS_PER_USER, 20, "AGENT_MAX_SESSIONS_PER_USER"),
  };
}
