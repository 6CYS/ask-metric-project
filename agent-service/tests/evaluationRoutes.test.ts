import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BackendUser } from "../src/backendClient.js";
import { loadConfig } from "../src/config.js";
import { createEvaluationRoutes } from "../src/evaluation/routes.js";
import { EvaluationService } from "../src/evaluation/service.js";
import { EvaluationStore } from "../src/evaluation/store.js";
import type {
  EvaluationDataset,
  EvaluationRun,
  SessionEvaluationClient,
} from "../src/evaluation/types.js";

const actor: BackendUser = {
  id: "owner",
  username: "owner",
  display_name: "测试",
  org_code: "100",
  org_name: "机构",
  role_code: "user",
};
const data = {
  name: "隔离题集",
  description: "",
  groups: [{ id: "g1", name: "组", turns: [{ id: "q1", question: "问题", expected: "" }] }],
};

describe("evaluation routes", () => {
  let root: string;
  let app: Hono<{ Variables: { user: BackendUser; token: string } }>;
  let service: EvaluationService;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "evaluation-routes-"));
    const config = loadConfig({
      AGENT_MODEL_API_KEY: "isolated",
      AGENT_MODEL_BASE_URL: "https://unused.invalid",
      AGENT_MODEL_NAME: "isolated",
      AGENT_DATA_DIR: root,
    });
    const client: SessionEvaluationClient = {
      createSession: () => Promise.resolve("session"),
      executeTurn: () =>
        Promise.resolve({
          status: "completed",
          run_status: "succeeded",
          user_entry_id: "entry",
          operation_id: "operation",
          answer_status: "answered",
          error_code: null,
          error_message: null,
          timings_ms: {},
        }),
      readTurn: () => Promise.resolve([]),
      cancelTurn: () => Promise.resolve(),
    };
    service = new EvaluationService(new EvaluationStore(root), client, config);
    app = new Hono();
    app.use("*", async (context, next) => {
      context.set("user", { ...actor, id: context.req.header("X-Owner") ?? actor.id });
      context.set("token", "current-token");
      await next();
    });
    app.route("/evaluations", createEvaluationRoutes(service));
  });
  afterEach(async () => {
    await service.waitForIdle();
    rmSync(root, { recursive: true, force: true });
  });
  const json = (body: unknown, method = "POST") => ({
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  it("supports create, versioned edit, frozen run and manual review", async () => {
    const created = await app.request("/evaluations/datasets", json(data));
    expect(created.status).toBe(201);
    const dataset = (await created.json()) as EvaluationDataset;
    expect(await (await app.request("/evaluations/datasets")).json()).toMatchObject({
      items: [{ id: dataset.id }],
    });
    expect(
      (
        await app.request(
          `/evaluations/datasets/${dataset.id}`,
          json({ ...data, version: 1 }, "PUT"),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(
          `/evaluations/datasets/${dataset.id}`,
          json({ ...data, version: 1 }, "PUT"),
        )
      ).status,
    ).toBe(409);
    const started = await app.request(
      "/evaluations/runs",
      json({
        dataset_id: dataset.id,
        dataset_version: 2,
        name: "批次",
        version_label: "v1",
        data_label: "隔离样本",
      }),
    );
    expect(started.status).toBe(201);
    const run = (await started.json()) as EvaluationRun;
    await service.waitForIdle();
    expect(await (await app.request(`/evaluations/runs/${run.id}`)).json()).toMatchObject({
      status: "completed",
      turns: [{ review: null }],
    });
    expect(
      (
        await app.request(
          `/evaluations/runs/${run.id}/turns/q1/review`,
          json({ verdict: "passed", note: "已核对" }, "PUT"),
        )
      ).status,
    ).toBe(200);
    expect(await (await app.request(`/evaluations/runs/${run.id}/turns/q1`)).json()).toMatchObject({
      turn: { review: { verdict: "passed" } },
      messages: [],
    });
    expect(await (await app.request("/evaluations/runs")).json()).toMatchObject({
      items: [{ id: run.id }],
    });
    expect(
      (await app.request(`/evaluations/runs/${run.id}`, { headers: { "X-Owner": "other" } }))
        .status,
    ).toBe(404);
  });

  it("rejects malformed input and invalid review verdicts with controlled errors", async () => {
    expect((await app.request("/evaluations/datasets", json({ ...data, groups: [] }))).status).toBe(
      400,
    );
    expect(
      (
        await app.request("/evaluations/datasets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{",
        })
      ).status,
    ).toBe(400);
    const dataset = service.createDataset(actor.id, data);
    const run = service.startRun(actor, "token", {
      dataset_id: dataset.id,
      dataset_version: 1,
      name: "批次",
      version_label: "",
      data_label: "",
    });
    await service.waitForIdle();
    expect(
      (
        await app.request(
          `/evaluations/runs/${run.id}/turns/q1/review`,
          json({ verdict: "automatic_pass", note: "" }, "PUT"),
        )
      ).status,
    ).toBe(400);
    expect((await app.request(`/evaluations/runs/${run.id}/cancel`, json({}))).status).toBe(409);
  });
});
