import { Hono } from "hono";
import { BackendApiError, type BackendUser } from "../backendClient.js";
import { EvaluationService } from "./service.js";
import { EvaluationError, evaluationRecord, evaluationVersion } from "./store.js";

type EvaluationVariables = { user: BackendUser; token: string };

async function readBody(request: Request): Promise<unknown> {
  if (Number(request.headers.get("Content-Length") ?? 0) > 2 * 1024 * 1024) {
    throw new EvaluationError(400, "EVALUATION_INPUT_TOO_LARGE", "测评请求超过大小限制");
  }
  const text = await request.text();
  if (Buffer.byteLength(text) > 2 * 1024 * 1024)
    throw new EvaluationError(400, "EVALUATION_INPUT_TOO_LARGE", "测评请求超过大小限制");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new EvaluationError(400, "EVALUATION_INPUT_INVALID", "请求不是有效 JSON");
  }
}

/** 挂在现有认证中间件后；每次均使用当次解析的账号与令牌。 */
export function createEvaluationRoutes(
  service: EvaluationService,
): Hono<{ Variables: EvaluationVariables }> {
  const router = new Hono<{ Variables: EvaluationVariables }>();
  router.onError((error, context) => {
    if (error instanceof EvaluationError)
      return context.json({ code: error.code, detail: error.message }, error.status);
    if (error instanceof BackendApiError) {
      const status =
        error.status === 401 || error.status === 403 || error.status === 404 || error.status === 409
          ? error.status
          : 503;
      return context.json(
        {
          code: error.code ?? "EVALUATION_SESSION_UNAVAILABLE",
          detail: status === 401 || status === 403 ? "当前身份无权访问该会话" : "会话详情暂不可用",
        },
        status,
      );
    }
    return context.json({ code: "EVALUATION_UNAVAILABLE", detail: "测评服务暂不可用" }, 503);
  });
  router.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    if (!context.get("user") || !context.get("token"))
      return context.json({ detail: "需要当前登录身份" }, 401);
    await next();
  });
  router.get("/datasets", async (context) =>
    context.json({ items: await service.listDatasets(context.get("user").id) }),
  );
  router.post("/datasets", async (context) =>
    context.json(
      await service.createDataset(context.get("user").id, await readBody(context.req.raw)),
      201,
    ),
  );
  router.put("/datasets/:id", async (context) => {
    const body = evaluationRecord(await readBody(context.req.raw));
    return context.json(
      await service.updateDataset(
        context.get("user").id,
        context.req.param("id"),
        evaluationVersion(body.version),
        body,
      ),
    );
  });
  router.get("/runs", async (context) =>
    context.json({ items: await service.listRuns(context.get("user").id) }),
  );
  router.delete("/datasets/:id", async (context) => {
    const body = evaluationRecord(await readBody(context.req.raw));
    await service.deleteDataset(
      context.get("user").id,
      context.req.param("id"),
      evaluationVersion(body.version),
    );
    return context.body(null, 204);
  });
  router.delete("/runs/:id", async (context) => {
    await service.deleteRun(context.get("user").id, context.get("token"), context.req.param("id"));
    return context.body(null, 204);
  });
  router.post("/runs", async (context) =>
    context.json(
      await service.startRun(
        context.get("user"),
        context.get("token"),
        await readBody(context.req.raw),
      ),
      201,
    ),
  );
  router.get("/runs/:id", async (context) =>
    context.json(await service.getRun(context.get("user").id, context.req.param("id"))),
  );
  router.post("/runs/:id/cancel", async (context) =>
    context.json(
      await service.cancelRun(
        context.get("user").id,
        context.get("token"),
        context.req.param("id"),
      ),
    ),
  );
  router.get("/runs/:id/turns/:turnId", async (context) =>
    context.json(
      await service.turnDetail(
        context.get("user").id,
        context.get("token"),
        context.req.param("id"),
        context.req.param("turnId"),
      ),
    ),
  );
  router.put("/runs/:id/turns/:turnId/review", async (context) =>
    context.json(
      await service.reviewTurn(
        context.get("user"),
        context.req.param("id"),
        context.req.param("turnId"),
        await readBody(context.req.raw),
      ),
    ),
  );
  return router;
}
