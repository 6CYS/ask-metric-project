/** Nacos 仅加载启动配置；中心故障时拒绝启动，不回退本机业务变量。 */
import { loadConfig, type AgentServiceConfig } from "./config.js";
import { decryptConfigValue, isEncryptedConfigValue, loadConfigSm4Key } from "./sm4ConfigCrypto.js";

const runtimeId = "sznsznws_agent_runtime.json";
const securityId = "sznsznws_agent_security.json";
const runtimeKeys = new Set([
  "BACKEND_TIMEOUT_MS", "AGENT_MODEL_BASE_URL", "AGENT_MODEL_NAME",
  "AGENT_MODEL_AUTH_HEADER", "AGENT_MODEL_AUTH_PREFIX", "AGENT_MODEL_USER_SUFFIX",
  "AGENT_MODEL_EXTRA_BODY", "AGENT_MODEL_CONTEXT_WINDOW", "AGENT_MODEL_MAX_TOKENS",
  "AGENT_MODEL_TIMEOUT_MS", "AGENT_MODEL_FIRST_RESPONSE_TIMEOUT_MS",
  "AGENT_MODEL_RETRY_ENABLED", "AGENT_MODEL_MAX_RETRIES", "AGENT_MODEL_RETRY_BASE_DELAY_MS",
  "AGENT_ANSWER_STREAMING", "AGENT_COMPACTION_ENABLED", "AGENT_COMPACTION_RESERVE_TOKENS",
  "AGENT_COMPACTION_KEEP_RECENT_TOKENS",
]);
const nodeKeys = ["AGENT_SERVICE_HOST", "AGENT_SERVICE_PORT", "AGENT_DATA_DIR",
  "BACKEND_BASE_URL", "ASK_METRIC_CONFIG_SM4_KEY_FILE", "ASK_METRIC_CONFIG_SM4_KEY"];

export async function loadRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env, request: typeof fetch = fetch,
): Promise<AgentServiceConfig> {
  const enabled = (env.NACOS_CONFIG_ENABLED ?? "false").trim().toLowerCase();
  if (!["true", "false", "1", "0"].includes(enabled)) {
    throw new Error("NACOS_CONFIG_ENABLED 必须为 true/false");
  }
  if (enabled === "false" || enabled === "0") return loadConfig(env);
  const group = env.NACOS_CONFIG_GROUP?.trim();
  if (!group) throw new Error("必须填写 NACOS_CONFIG_GROUP");
  const namespace = env.NACOS_NAMESPACE?.trim() || "public";
  const timeout = Number(env.NACOS_REQUEST_TIMEOUT_MS ?? 5000);
  if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error("Nacos 超时必须为正整数");
  const servers = (env.NACOS_SERVER_ADDR ?? "").split(",").filter((v) => v.trim()).map((value) => {
    const raw = value.trim().replace(/\/+$/, "");
    const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("NACOS_SERVER_ADDR 格式无效");
    }
    return `${url.origin}${url.pathname.replace(/\/+$/, "") || "/nacos"}`;
  });
  if (!servers.length) throw new Error("必须填写 NACOS_SERVER_ADDR");
  const encryptedPassword = env.NACOS_PASSWORD ?? "";
  const password = isEncryptedConfigValue(encryptedPassword)
    ? decryptConfigValue(encryptedPassword, loadConfigSm4Key(env)) : encryptedPassword;

  async function readDocument(dataId: string): Promise<Record<string, unknown>> {
    for (const server of servers) {
      try {
        let token = "";
        if (env.NACOS_USERNAME) {
          const response = await request(`${server}/v1/auth/users/login`, {
            method: "POST", body: new URLSearchParams({ username: env.NACOS_USERNAME, password }),
            signal: AbortSignal.timeout(timeout),
          });
          if (!response.ok) throw new Error("鉴权失败");
          const login = await response.json() as { accessToken?: string };
          if (typeof login.accessToken !== "string" || !login.accessToken) throw new Error("鉴权响应无效");
          token = login.accessToken;
        }
        const params = new URLSearchParams({ dataId, groupName: group!, namespaceId: namespace });
        if (token) params.set("accessToken", token);
        let response = await request(`${server}/v3/client/cs/config?${params}`, { signal: AbortSignal.timeout(timeout) });
        let text = await response.text();
        let envelope: { code?: number; data?: { content?: string } } = {};
        try { envelope = JSON.parse(text) as typeof envelope; } catch { /* 2.x 路由可能返回 HTML */ }
        let content: string;
        // 仅路由不存在时探测 2.x；3.x 配置缺失与权限错误不得触发旧接口回退。
        if (response.status === 404 && envelope.code === undefined) {
          const legacy = new URLSearchParams({ dataId, group: group! });
          if (namespace !== "public") legacy.set("tenant", namespace);
          if (token) legacy.set("accessToken", token);
          response = await request(`${server}/v1/cs/configs?${legacy}`, { signal: AbortSignal.timeout(timeout) });
          text = await response.text();
          if (!response.ok) throw new Error("配置读取失败");
          content = text;
        } else {
          if (!response.ok || envelope.code !== 0 || typeof envelope.data?.content !== "string") {
            throw new Error("配置读取失败");
          }
          content = envelope.data.content;
        }
        const document: unknown = JSON.parse(content);
        if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("配置格式错误");
        return document as Record<string, unknown>;
      } catch { /* 只读请求可切换节点，错误不包含地址、令牌或响应内容。 */ }
    }
    throw new Error(`无法从 Nacos 读取有效配置：${dataId}`);
  }

  const selected: NodeJS.ProcessEnv = {};
  for (const key of nodeKeys) if (env[key] !== undefined) selected[key] = env[key];
  for (const dataId of [runtimeId, securityId]) {
    const document = await readDocument(dataId);
    const normalized = new Set<string>();
    for (const [rawName, value] of Object.entries(document)) {
      const name = rawName.toUpperCase();
      if (normalized.has(name)) throw new Error(`Nacos 配置字段重复：${name}`);
      normalized.add(name);
      const allowed = dataId === securityId ? name === "AGENT_MODEL_API_KEY" : runtimeKeys.has(name);
      if (!allowed) throw new Error(`Nacos 配置字段不支持：${name}`);
      if (name === "AGENT_MODEL_EXTRA_BODY" && value && typeof value === "object" && !Array.isArray(value)) {
        selected[name] = JSON.stringify(value);
      } else if (["string", "number", "boolean"].includes(typeof value)) {
        selected[name] = String(value);
      } else throw new Error(`Nacos 配置字段类型无效：${name}`);
    }
  }
  if (!isEncryptedConfigValue(selected.AGENT_MODEL_API_KEY)) {
    throw new Error("Nacos 中 AGENT_MODEL_API_KEY 必须使用 SM4 密文");
  }
  return loadConfig(selected);
}
