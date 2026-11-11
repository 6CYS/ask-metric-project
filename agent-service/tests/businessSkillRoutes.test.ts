import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import type { BackendUser } from "../src/backendClient.js";
import { loadBusinessSkills } from "../src/businessSkills.js";
import { BusinessSkillStore } from "../src/businessSkillStore.js";
import { createBusinessSkillRoutes } from "../src/businessSkillRoutes.js";

describe("Skill 管理接口", () => {
  let root: string;
  let store: BusinessSkillStore;
  let app: Hono<{ Variables: { user: BackendUser; token: string } }>;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "skill-routes-"));
    store = new BusinessSkillStore(root, await loadBusinessSkills());
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("user", {
        id: "admin",
        username: "admin",
        display_name: "管理员",
        org_code: "O1",
        org_name: "机构",
        role_code: c.req.header("X-Test-Role") ?? "SYSTEM_ADMIN",
      });
      c.set("token", "test-bearer");
      await next();
    });
    app.route(
      "/skills",
      createBusinessSkillRoutes(
        store,
        loadConfig({
          AGENT_MODEL_API_KEY: "unused",
          AGENT_MODEL_BASE_URL: "https://unused.invalid",
          AGENT_MODEL_NAME: "unused",
          BACKEND_BASE_URL: "http://backend.invalid",
        }),
      ),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });
  const put = (body: unknown, headers = {}) => ({
    method: "PUT",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

  it("普通用户不能读取或修改，管理员目录不暴露服务器绝对路径", async () => {
    expect((await app.request("/skills", { headers: { "X-Test-Role": "USER" } })).status).toBe(403);
    expect(
      (await app.request("/skills/inquiry-analysis", put({}, { "X-Test-Role": "USER" }))).status,
    ).toBe(403);
    const response = await app.request("/skills");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).not.toContain("filePath");
  });

  it("配置写入授权失败时保留原正文，后端异常也不能绕过权限", async () => {
    const current = store.list().find((item) => item.name === "inquiry-analysis")!;
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ detail: "配置写入已关闭" }), { status: 403 }),
      );
    const response = await app.request(
      `/skills/${current.name}`,
      put({ content: "新正文", revision: current.revision }),
    );
    expect(response.status).toBe(403);
    expect(store.snapshot()[0]?.content).toBe(current.content);
    fetcher.mockRejectedValue(new Error("离线"));
    expect(
      (
        await app.request(
          `/skills/${current.name}`,
          put({ content: "新正文", revision: current.revision }),
        )
      ).status,
    ).toBe(503);
    expect(store.snapshot()[0]?.content).toBe(current.content);
    fetcher.mockResolvedValue(Response.json({ authorized: false }));
    expect(
      (
        await app.request(
          `/skills/${current.name}`,
          put({ content: "新正文", revision: current.revision }),
        )
      ).status,
    ).toBe(503);
    expect(store.snapshot()[0]?.content).toBe(current.content);
  });

  it("管理令牌错误作为配置拒绝处理，登录令牌过期才返回 401", async () => {
    const current = store.list().find((item) => item.name === "inquiry-analysis")!;
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        Response.json(
          { code: "MODEL_CONFIG_UNAUTHORIZED", message: "invalid admin token" },
          { status: 401 },
        ),
      );
    const body = { content: "新正文", revision: current.revision };
    expect((await app.request(`/skills/${current.name}`, put(body))).status).toBe(403);
    fetcher.mockResolvedValue(
      Response.json({ code: "AUTH_UNAUTHORIZED", message: "expired" }, { status: 401 }),
    );
    expect((await app.request(`/skills/${current.name}`, put(body))).status).toBe(401);
    expect(store.snapshot()[0]?.content).toBe(current.content);
  });

  it("透传当前身份及管理令牌，保存后返回真实版本，旧草稿冲突不覆盖", async () => {
    const current = store.list().find((item) => item.name === "inquiry-analysis")!;
    vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
      if (url !== "http://backend.invalid/api/v1/model-config/authorize-write")
        throw new Error("错误授权地址");
      const headers = new Headers(init?.headers);
      return Promise.resolve(
        headers.get("Authorization") === "Bearer test-bearer" &&
          headers.get("X-Model-Admin-Token") === "test-admin-token"
          ? Response.json({ authorized: true })
          : Response.json({ detail: "未授权" }, { status: 403 }),
      );
    });
    const body = { content: "已授权的方法", revision: current.revision };
    const response = await app.request(
      `/skills/${current.name}`,
      put(body, { "X-Model-Admin-Token": "test-admin-token" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ content: "已授权的方法", modified: true });
    expect(
      (
        await app.request(
          `/skills/${current.name}`,
          put(body, { "X-Model-Admin-Token": "test-admin-token" }),
        )
      ).status,
    ).toBe(409);
    expect(
      (await app.request(`/skills/${current.name}`, { method: "PUT", body: "{" })).status,
    ).toBe(400);
  });
});
