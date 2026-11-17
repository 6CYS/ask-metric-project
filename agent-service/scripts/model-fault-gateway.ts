/** 只供隔离验收使用：不代理外部模型，不生成成功业务结果，也不读取或保存请求正文。 */
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";

export const MODEL_FAULT_SCENARIOS = [
  "rate-limit",
  "unavailable",
  "first-timeout",
  "idle-timeout",
  "disconnect",
  "truncated",
] as const;
export type ModelFaultScenario = (typeof MODEL_FAULT_SCENARIOS)[number];

export function isModelFaultScenario(value: unknown): value is ModelFaultScenario {
  return typeof value === "string" && MODEL_FAULT_SCENARIOS.some((item) => item === value);
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

async function readControl(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
    size += chunk.length;
    if (size > 1024) throw new Error("control body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

export function createModelFaultGateway(
  initialScenario: ModelFaultScenario = "rate-limit",
): RequestListener {
  let scenario = initialScenario;
  let requests = 0;
  let active = 0;
  let closed = 0;
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    // 回环监听之外再校验 Host，避免浏览器 DNS rebinding 操纵本地故障状态。
    if (!/^127\.0\.0\.1:\d{1,5}$/.test(request.headers.host ?? "") || request.headers.origin) {
      json(response, 403, { error: "local fixture only" });
      return;
    }
    if (request.method === "GET" && request.url === "/__fault/state") {
      json(response, 200, {
        fixture: true,
        scenario,
        requests,
        active,
        closed,
        scenarios: MODEL_FAULT_SCENARIOS,
      });
      return;
    }
    if (request.method === "POST" && request.url === "/__fault/scenario") {
      if (request.headers["x-model-fault-fixture"] !== "1") {
        json(response, 403, { error: "fixture control header required" });
        return;
      }
      try {
        const value = await readControl(request);
        if (
          !value ||
          typeof value !== "object" ||
          !isModelFaultScenario("scenario" in value ? value.scenario : undefined)
        ) {
          json(response, 400, { error: "unknown scenario" });
          return;
        }
        scenario = (value as { scenario: ModelFaultScenario }).scenario;
        json(response, 200, { fixture: true, scenario, applies: "next model request" });
      } catch {
        json(response, 400, { error: "invalid control body" });
      }
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      json(response, 404, { error: "fixture route not found" });
      return;
    }
    request.resume();
    const currentScenario = scenario;
    requests += 1;
    active += 1;
    // 客户端取消应释放连接；保护上限避免手工测试遗留无限挂起请求。
    const deadline = setTimeout(() => response.destroy(), 120_000);
    deadline.unref();
    response.once("close", () => {
      clearTimeout(deadline);
      active -= 1;
      closed += 1;
    });
    if (currentScenario === "rate-limit") {
      response.setHeader("Retry-After", "2");
      json(response, 429, {
        error: {
          code: "rate_limit_exceeded",
          type: "rate_limit_error",
          message: "QPM rate limit exceeded (local fault fixture)",
        },
      });
    } else if (currentScenario === "unavailable") {
      json(response, 503, {
        error: {
          code: "service_unavailable",
          message: "Model service unavailable (local fault fixture)",
        },
      });
    } else if (currentScenario === "disconnect") {
      response.destroy();
    } else if (currentScenario !== "first-timeout") {
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      response.write(
        `data: ${JSON.stringify({
          id: "fault-fixture",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "local-fault-fixture",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: "【故障注入】此片段只用于中途停顿测试，不包含业务结果。",
              },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      );
      if (currentScenario === "truncated") response.end();
    }
  };
  return (request, response) => {
    handle(request, response).catch(() => {
      if (response.headersSent) response.destroy();
      else json(response, 500, { error: "fault fixture handler failed" });
    });
  };
}
