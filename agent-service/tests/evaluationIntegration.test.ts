import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendUser } from "../src/backendClient.js";
import { loadConfig } from "../src/config.js";
import type { EvaluationService } from "../src/evaluation/service.js";
import type { HarnessHost, HostedSession } from "../src/harnessHost.js";
import type { NativeSessionStore } from "../src/nativeSessions.js";
import { createApp } from "../src/routes.js";

const actor: BackendUser = {
  id: "integration-owner",
  username: "integration-owner",
  display_name: "隔离账号",
  org_code: "100",
  org_name: "隔离机构",
  role_code: "USER",
};

describe("测评与原会话路由的集成边界", () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "evaluation-integration-"));
    // 保留真实路由和鉴权中间件，只替换后端身份与原生宿主边界。
    vi.stubGlobal("fetch", (url: Parameters<typeof fetch>[0]) => {
      const address = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (!address.endsWith("/api/v1/auth/me"))
        throw new Error("隔离路由检查不得调用业务或模型服务");
      return Promise.resolve(Response.json(actor));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    rmSync(directory, { recursive: true, force: true });
  });

  function fixture() {
    const resumeOpenOperations = vi.fn<HarnessHost["resumeOpenOperations"]>(() =>
      Promise.resolve(0),
    );
    const hosted = {
      sessionId: "chat-session",
      ownerUserId: actor.id,
      createdAt: 1,
      open: [{ operationId: "unfinished-operation" }],
      session: {
        getName: () => Promise.resolve("普通问数"),
        scanValues: () => Promise.resolve([]),
      },
      lane: {
        findEntries: () => Promise.resolve([]),
        inspectExecution: () => Promise.resolve({ current: { id: "unfinished-operation" } }),
      },
    } as unknown as HostedSession;
    const sessionTitle = vi.fn((_owner: string, metadata: { id: string }) =>
      Promise.resolve(metadata.id === "chat-session" ? "普通问数" : "测评会话"),
    );
    const host = {
      openSession: () => Promise.resolve(hosted),
      viewSession: () => Promise.resolve(hosted),
      releaseView: () => Promise.resolve(),
      retain: () => () => {},
      releaseIdle: () => Promise.resolve(),
      resumeOpenOperations,
      sessionTitle,
      isRunning: () => Promise.resolve(false),
      readOnlyReason: () => Promise.resolve(undefined),
    } as unknown as HarnessHost;
    const list = vi.fn(() =>
      Promise.resolve([
        { id: "chat-session", createdAt: 1, modifiedAt: 3 },
        { id: "evaluation-session", createdAt: 2, modifiedAt: 4 },
      ]),
    );
    const store = { list } as unknown as NativeSessionStore;
    const listSessionIds = vi.fn(() => ["evaluation-session"]);
    const evaluations = { listSessionIds } as unknown as EvaluationService;
    const config = loadConfig({
      AGENT_MODEL_API_KEY: "unused",
      AGENT_MODEL_BASE_URL: "https://unused.invalid",
      AGENT_MODEL_NAME: "isolated",
      AGENT_DATA_DIR: directory,
    });
    return {
      app: createApp(config, host, store, evaluations),
      resumeOpenOperations,
      list,
      listSessionIds,
      sessionTitle,
    };
  }

  const headers = { Authorization: "Bearer isolated-request" };

  it("测评只读快照不恢复未完成操作，普通详情保留原有恢复行为", async () => {
    const test = fixture();
    const readOnly = await test.app.request("/sessions/chat-session?resume=false", { headers });
    expect(readOnly.status).toBe(200);
    expect(await readOnly.json()).toMatchObject({
      session_id: "chat-session",
      running: true,
      operation_id: "unfinished-operation",
      messages: [],
    });
    expect(test.resumeOpenOperations).not.toHaveBeenCalled();

    const ordinary = await test.app.request("/sessions/chat-session", { headers });
    expect(ordinary.status).toBe(200);
    expect(test.resumeOpenOperations).toHaveBeenCalledTimes(1);
    expect(test.resumeOpenOperations.mock.calls[0]?.[1]).toMatchObject({ actor });
  });

  it("普通聊天历史仅过滤本人测评会话，并保留普通会话及原有元数据", async () => {
    const test = fixture();
    const response = await test.app.request("/sessions", { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [
        {
          session_id: "chat-session",
          title: "普通问数",
          created_at: 1,
          last_active_at: 3,
          running: false,
        },
      ],
    });
    expect(test.list).toHaveBeenCalledWith(actor.id);
    expect(test.listSessionIds).toHaveBeenCalledWith(actor.id);
    expect(test.sessionTitle).toHaveBeenCalledTimes(1);
    expect(test.sessionTitle.mock.calls[0]?.[1]).toMatchObject({ id: "chat-session" });
  });

  it("测评索引不可用时普通聊天历史仍按原权限可读", async () => {
    const test = fixture();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    test.listSessionIds.mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    const response = await test.app.request("/sessions", { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      items: [{ session_id: "evaluation-session" }, { session_id: "chat-session" }],
    });
    expect(warning).toHaveBeenCalledWith("测评会话索引不可读取，暂按原生会话列表展示");
  });
});
