import { Hono } from "hono";
import { BackendApiError, BackendClient, type BackendUser } from "./backendClient.js";
import type { AgentServiceConfig } from "./config.js";
import { BusinessSkillStore, SkillConfigError } from "./businessSkillStore.js";

type SkillVariables = { user: BackendUser; token: string };

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (Buffer.byteLength(text) > 512 * 1024)
    throw new SkillConfigError(400, "SKILL_INPUT_TOO_LARGE", "请求超过大小限制");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new SkillConfigError(400, "SKILL_INPUT_INVALID", "请求不是有效 JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new SkillConfigError(400, "SKILL_INPUT_INVALID", "请求必须为 JSON 对象");
  return body as Record<string, unknown>;
}

export function createBusinessSkillRoutes(store: BusinessSkillStore, config: AgentServiceConfig) {
  const router = new Hono<{ Variables: SkillVariables }>();
  router.onError((error, c) => {
    if (error instanceof SkillConfigError)
      return c.json({ code: error.code, detail: error.message }, error.status);
    if (error instanceof BackendApiError && error.code === "MODEL_CONFIG_UNAUTHORIZED")
      return c.json({ code: error.code, detail: "管理令牌无效，请核对后重试" }, 403);
    if (error instanceof BackendApiError && (error.status === 401 || error.status === 403))
      return c.json(
        { code: error.code ?? "CONFIG_WRITE_DENIED", detail: error.message },
        error.status,
      );
    return c.json({ code: "SKILL_CONFIG_UNAVAILABLE", detail: "Skill 配置服务暂不可用" }, 503);
  });
  router.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (c.get("user")?.role_code !== "SYSTEM_ADMIN")
      return c.json({ code: "CONFIG_ADMIN_REQUIRED", detail: "需要系统管理员权限" }, 403);
    await next();
  });
  router.get("/", (c) => c.json({ items: store.list() }));
  for (const action of ["save", "restore"] as const) {
    router.on(
      action === "save" ? "PUT" : "POST",
      action === "save" ? "/:name" : "/:name/restore",
      async (c) => {
        const body = await readBody(c.req.raw);
        const backend = new BackendClient(
          config.backendBaseUrl,
          c.get("token"),
          config.backendTimeoutMs,
        );
        // 复用后端配置写入开关与管理令牌规则，Agent 不另存一份权限配置。
        const authorization = await backend.authorizeConfigWrite(
          c.req.header("X-Model-Admin-Token"),
        );
        if (authorization?.authorized !== true)
          throw new SkillConfigError(
            503,
            "CONFIG_AUTHORIZATION_INVALID",
            "配置写入授权未确认，请稍后重试",
          );
        return c.json(
          action === "save"
            ? store.update(c.req.param("name"), body.revision, body.content, c.get("user").username)
            : store.restore(c.req.param("name"), body.revision),
        );
      },
    );
  }
  return router;
}
