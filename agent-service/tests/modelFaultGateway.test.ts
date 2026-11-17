import { once } from "node:events";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createModelFaultGateway } from "../scripts/model-fault-gateway.js";

describe("隔离模型故障网关", () => {
  let server: Server;
  let baseUrl: string;
  beforeEach(async () => {
    server = createServer(createModelFaultGateway());
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const control = (scenario: string) =>
    fetch(`${baseUrl}/__fault/scenario`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Model-Fault-Fixture": "1" },
      body: JSON.stringify({ scenario }),
    });
  const model = (signal?: AbortSignal) =>
    fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "private-question" }] }),
      ...(signal ? { signal } : {}),
    });

  it("默认返回真实 HTTP 429 和重试提示，不输出请求正文或凭证", async () => {
    const response = await model();
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("2");
    expect(await response.json()).toMatchObject({ error: { code: "rate_limit_exceeded" } });
    const state = await fetch(`${baseUrl}/__fault/state`).then((response) => response.text());
    expect(JSON.parse(state)).toMatchObject({ scenario: "rate-limit", requests: 1 });
    expect(state).not.toMatch(/private-question|Authorization|Bearer/);
  });

  it("控制入口拒绝浏览器来源、缺少测试头、未知场景及非回环 Host", async () => {
    expect(
      (
        await fetch(`${baseUrl}/__fault/scenario`, {
          method: "POST",
          body: '{"scenario":"unavailable"}',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${baseUrl}/__fault/scenario`, {
          method: "POST",
          headers: { Origin: "http://external.test", "X-Model-Fault-Fixture": "1" },
          body: '{"scenario":"unavailable"}',
        })
      ).status,
    ).toBe(403);
    expect((await control("forward-to-remote")).status).toBe(400);
    const foreignHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(
        `${baseUrl}/__fault/state`,
        { headers: { Host: "attacker.test" } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.on("error", reject);
      request.end();
    });
    expect(foreignHostStatus).toBe(403);
    expect(
      await fetch(`${baseUrl}/__fault/state`).then((response) => response.json()),
    ).toMatchObject({ scenario: "rate-limit", requests: 0 });
  });

  it("503 场景保留失败状态", async () => {
    expect((await control("unavailable")).status).toBe(200);
    const response = await model();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "service_unavailable" } });
  });

  it("首包停顿可通过取消终止，没有返回伪成功内容", async () => {
    await control("first-timeout");
    await expect(model(AbortSignal.timeout(100))).rejects.toThrow();
  });

  it("流中停顿只有明确的测试片段，取消后结束连接", async () => {
    await control("idle-timeout");
    const controller = new AbortController();
    const response = await model(controller.signal);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    if (!response.body) throw new Error("expected SSE response body");
    const reader = response.body.getReader();
    const first = await reader.read();
    const chunk: unknown = first.value;
    if (!(chunk instanceof Uint8Array)) throw new Error("expected SSE bytes");
    expect(new TextDecoder().decode(chunk)).toContain("故障注入");
    controller.abort();
    await expect(reader.read()).rejects.toThrow();
  });

  it("截断场景没有正常完成标记，断连场景产生传输错误", async () => {
    await control("truncated");
    const body = await model().then((response) => response.text());
    expect(body).toContain("故障注入");
    expect(body).not.toContain("[DONE]");
    expect(body).not.toContain('"finish_reason":"stop"');
    await control("disconnect");
    await expect(model()).rejects.toThrow();
  });
});
