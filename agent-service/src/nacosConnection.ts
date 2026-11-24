import { decryptConfigValue, isEncryptedConfigValue, loadConfigSm4Key } from "./sm4ConfigCrypto.js";

export function readNacosConnection(env: NodeJS.ProcessEnv) {
  const timeout = Number(env.NACOS_REQUEST_TIMEOUT_MS ?? 5000);
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2_147_483_647) {
    throw new Error("Nacos 超时必须为有效的正整数毫秒数");
  }
  const servers = (env.NACOS_SERVER_ADDR ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      let url: URL;
      try {
        url = new URL(value.includes("://") ? value : `http://${value}`);
      } catch {
        throw new Error("NACOS_SERVER_ADDR 格式无效");
      }
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      ) {
        throw new Error("NACOS_SERVER_ADDR 格式无效");
      }
      return `${url.origin}${url.pathname.replace(/\/+$/, "") || "/nacos"}`;
    });
  if (!servers.length) throw new Error("必须填写 NACOS_SERVER_ADDR");
  const encryptedPassword = env.NACOS_PASSWORD ?? "";
  const password = isEncryptedConfigValue(encryptedPassword)
    ? decryptConfigValue(encryptedPassword, loadConfigSm4Key(env))
    : encryptedPassword;
  return {
    servers,
    namespace: env.NACOS_NAMESPACE?.trim() || "public",
    timeout,
    username: env.NACOS_USERNAME ?? "",
    password,
  };
}

export async function loginNacos(
  server: string,
  { username, password }: Pick<ReturnType<typeof readNacosConnection>, "username" | "password">,
  request: typeof fetch,
  signal: AbortSignal,
) {
  const response = await request(`${server}/v1/auth/users/login`, {
    method: "POST",
    body: new URLSearchParams({ username, password }),
    redirect: "error",
    signal,
  });
  if (!response.ok) throw new Error("Nacos 鉴权失败");
  const login = (await response.json()) as { accessToken?: unknown; tokenTtl?: unknown };
  if (typeof login.accessToken !== "string" || !login.accessToken)
    throw new Error("Nacos 鉴权响应无效");
  const ttl =
    typeof login.tokenTtl === "number" && Number.isFinite(login.tokenTtl) && login.tokenTtl > 0
      ? login.tokenTtl * 1000
      : 60_000;
  return { token: login.accessToken, expiresAt: Date.now() + ttl - Math.min(5000, ttl / 2) };
}
