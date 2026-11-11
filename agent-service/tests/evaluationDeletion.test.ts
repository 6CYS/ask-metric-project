import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendUser } from "../src/backendClient.js";
import { loadConfig } from "../src/config.js";
import { createEvaluationRoutes } from "../src/evaluation/routes.js";
import { EvaluationService } from "../src/evaluation/service.js";
import { createSessionEvaluationClient } from "../src/evaluation/sessionClient.js";
import { EvaluationError, EvaluationStore } from "../src/evaluation/store.js";
import type { ExecutionResult, SessionEvaluationClient } from "../src/evaluation/types.js";

const actor: BackendUser = {
  id: "owner",
  username: "owner",
  display_name: "隔离账号",
  org_code: "100",
  org_name: "隔离机构",
  role_code: "USER",
};
const success: ExecutionResult = {
  status: "completed",
  run_status: "completed",
  answer_status: "ok",
  user_entry_id: "entry",
  operation_id: "operation",
  error_code: null,
  error_message: null,
  timings_ms: {},
};
const datasetInput = {
  name: "隔离题集",
  description: "",
  groups: [
    {
      id: "g1",
      name: "连续追问",
      turns: [
        { id: "q1", question: "首问", expected: "" },
        { id: "q2", question: "追问", expected: "" },
      ],
    },
    { id: "g2", name: "独立会话", turns: [{ id: "q3", question: "独立问题", expected: "" }] },
  ],
};

describe("测评删除的归属、快照与会话清理", () => {
  let root: string;
  let store: EvaluationStore;
  let service: EvaluationService;
  let client: SessionEvaluationClient;
  let sessions: Set<string>;
  let deleted: string[];
  let deleteRequests: string[];
  let failSession: string | null;
  let holdDelete: (() => Promise<void>) | undefined;
  const config = () =>
    loadConfig({
      AGENT_DATA_DIR: root,
      AGENT_MODEL_API_KEY: "isolated",
      AGENT_MODEL_BASE_URL: "https://unused.invalid",
      AGENT_MODEL_NAME: "isolated",
    });
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "evaluation-delete-"));
    store = new EvaluationStore(root);
    sessions = new Set(["ordinary-chat"]);
    deleted = [];
    deleteRequests = [];
    failSession = null;
    holdDelete = undefined;
    let sequence = 0;
    client = createSessionEvaluationClient(async (path, init) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer current-token");
      if (init?.method === "POST" && path === "/sessions") {
        const id = `session-${++sequence}`;
        sessions.add(id);
        return Response.json({ session_id: id });
      }
      if (init?.method === "DELETE") {
        const id = decodeURIComponent(path.slice("/sessions/".length));
        deleteRequests.push(id);
        if (holdDelete) await holdDelete();
        if (id === failSession) return new Response(null, { status: 503 });
        if (!sessions.delete(id)) return new Response(null, { status: 404 });
        deleted.push(id);
        return new Response(null, { status: 204 });
      }
      throw new Error("隔离检查不得执行其他服务调用");
    });
    client.executeTurn = () => Promise.resolve(success);
    service = new EvaluationService(store, client, config());
  });
  afterEach(async () => {
    await service.waitForIdle();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });
  function app() {
    const router = new Hono<{ Variables: { user: BackendUser; token: string } }>();
    router.use("*", async (context, next) => {
      context.set("user", { ...actor, id: context.req.header("X-Owner") ?? actor.id });
      context.set("token", "current-token");
      await next();
    });
    router.route("/evaluations", createEvaluationRoutes(service));
    return router;
  }
  function request(path: string, method = "DELETE", body?: unknown, owner = actor.id) {
    return app().request(`/evaluations${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Owner": owner },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  function start() {
    const dataset = service.createDataset(actor.id, datasetInput);
    return service.startRun(actor, "current-token", {
      dataset_id: dataset.id,
      dataset_version: dataset.version,
      name: "隔离批次",
      version_label: "",
      data_label: "",
    });
  }

  it("删除题集检查归属和版本，并保留已有批次的冻结题目", async () => {
    const run = start();
    await service.waitForIdle();
    const path = `/datasets/${run.dataset.id}`;
    expect((await request(path, "DELETE", { version: 1 }, "other")).status).toBe(404);
    store.updateDataset(actor.id, run.dataset.id, 1, { ...datasetInput, name: "新版本" });
    expect((await request(path, "DELETE", { version: 1 })).status).toBe(409);
    expect((await request(path, "DELETE", { version: 2 })).status).toBe(204);
    expect(service.listDatasets(actor.id)).toEqual([]);
    expect(service.getRun(actor.id, run.id).dataset).toEqual(run.dataset);
    expect(sessions.size).toBe(3);
  });

  it("删除批次只清理该批次独占的会话，保留题集、其他批次和普通聊天", async () => {
    const run = start();
    await service.waitForIdle();
    const retained = start();
    await service.waitForIdle();
    expect((await request(`/runs/${run.id}`, "DELETE", undefined, "other")).status).toBe(404);
    expect(deleted).toEqual([]);
    expect(service.listSessionIds(actor.id)).toHaveLength(4);
    expect((await request(`/runs/${run.id}`)).status).toBe(204);
    expect(deleted).toEqual(["session-1", "session-2"]);
    expect(sessions).toEqual(new Set(["ordinary-chat", "session-3", "session-4"]));
    expect(service.listRuns(actor.id).map((item) => item.id)).toEqual([retained.id]);
    expect(service.listDatasets(actor.id)).toHaveLength(2);
    expect(service.listSessionIds(actor.id)).toEqual(["session-3", "session-4"]);
    service = new EvaluationService(new EvaluationStore(root), client, config());
    expect(service.listSessionIds(actor.id)).toEqual(["session-3", "session-4"]);
  });

  it.each(["running", "cancelling"] as const)("%s 批次不能删除", async (status) => {
    const run = start();
    await service.waitForIdle();
    const saved = service.getRun(actor.id, run.id);
    saved.status = status;
    store.saveRun(actor.id, saved);
    expect((await request(`/runs/${run.id}`)).status).toBe(409);
    expect(service.getRun(actor.id, run.id).status).toBe(status);
    expect(deleted).toEqual([]);
  });

  it("部分清理失败保留删除状态与关联信息，重启后可继续且不重复删除已清理会话", async () => {
    const run = start();
    await service.waitForIdle();
    failSession = "session-2";
    expect((await request(`/runs/${run.id}`)).status).toBe(503);
    expect(deleted).toEqual(["session-1"]);
    expect(service.getRun(actor.id, run.id).status).toBe("deleting");
    expect((await request(`/runs/${run.id}/turns/q1`, "GET")).status).toBe(409);
    expect(
      (await request(`/runs/${run.id}/turns/q1/review`, "PUT", { verdict: "passed", note: "" }))
        .status,
    ).toBe(409);
    service = new EvaluationService(new EvaluationStore(root), client, config());
    expect(service.listSessionIds(actor.id)).toEqual(["session-2"]);
    failSession = null;
    expect((await request(`/runs/${run.id}`)).status).toBe(204);
    expect(deleted).toEqual(["session-1", "session-2"]);
    expect(deleteRequests).toEqual(["session-1", "session-2", "session-2"]);
    expect(service.listRuns(actor.id)).toEqual([]);
    expect(sessions).toEqual(new Set(["ordinary-chat"]));
  });

  it("清理超出单次预算后保存进度，重启继续只处理剩余会话", async () => {
    const run = start();
    await service.waitForIdle();
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const deleteSession = client.deleteSession.bind(client);
    client.deleteSession = async (token, sessionId, signal) => {
      await deleteSession(token, sessionId, signal);
      deadline.abort();
    };
    expect((await request(`/runs/${run.id}`)).status).toBe(503);
    expect(service.getRun(actor.id, run.id).turns.map((turn) => turn.session_id)).toEqual([
      null,
      null,
      "session-2",
    ]);
    timeout.mockRestore();
    client.deleteSession = deleteSession;
    service = new EvaluationService(new EvaluationStore(root), client, config());
    expect((await request(`/runs/${run.id}`)).status).toBe(204);
    expect(deleteRequests).toEqual(["session-1", "session-2"]);
    expect(sessions).toEqual(new Set(["ordinary-chat"]));
  });

  it("批次文件删除失败后继续删除仍能完成，不把已不存在的会话当作失败", async () => {
    const run = start();
    await service.waitForIdle();
    vi.spyOn(store, "deleteRun").mockImplementationOnce(() => {
      throw new EvaluationError(503, "EVALUATION_STORAGE_UNAVAILABLE", "隔离存储故障");
    });
    expect((await request(`/runs/${run.id}`)).status).toBe(503);
    expect(service.getRun(actor.id, run.id).status).toBe("deleting");
    expect((await request(`/runs/${run.id}`)).status).toBe(204);
    expect(service.listRuns(actor.id)).toEqual([]);
  });

  it("同批次重复点击不并行清理，其他批次引用的会话仍保留", async () => {
    const run = start();
    await service.waitForIdle();
    const other = start();
    await service.waitForIdle();
    const shared = service.getRun(actor.id, other.id);
    shared.turns[0]!.session_id = "session-1";
    store.saveRun(actor.id, shared);
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    holdDelete = () => pending;
    const first = request(`/runs/${run.id}`);
    try {
      await vi.waitFor(() => expect(service.getRun(actor.id, run.id).status).toBe("deleting"));
      expect((await request(`/runs/${run.id}`)).status).toBe(409);
    } finally {
      release();
    }
    expect((await first).status).toBe(204);
    expect(sessions.has("session-1")).toBe(true);
    expect(deleted).toEqual(["session-2"]);
  });
});
