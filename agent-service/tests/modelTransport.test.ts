import {channel} from "node:diagnostics_channel";
import {describe, expect, it} from "vitest";
import {createModelTransportDiagnostics, type ModelTransportSummary} from "../src/modelTransport.js";

const publish = (name: string, value: unknown) => channel(`undici:${name}`).publish(value);
const response = () => new Response("stream remains unread", {
  status: 200, headers: {"x-request-id": "request-123", "set-cookie": "private-cookie"},
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {resolve = done;});
  return {promise, resolve};
}

describe("模型 HTTP 传输诊断", () => {
  it("原样传递输入、signal 和响应，不读正文；未观测阶段标为未知", async () => {
    const summaries: ModelTransportSummary[] = [];
    const input = new URL("https://provider.test/v1?token=private-query");
    const init = {method: "POST", signal: new AbortController().signal,
      headers: {Authorization: "Bearer private-key"}, body: "private-business-data"};
    const result = response();
    const observed = createModelTransportDiagnostics(async (actualInput, actualInit) => {
      expect(actualInput).toBe(input);
      expect(actualInit).toBe(init);
      return result;
    }, summary => summaries.push(summary));
    expect(await observed(input, init)).toBe(result);
    expect(result.bodyUsed).toBe(false);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({status: 200, provider_request_ids: {"x-request-id": "request-123"},
      request_created_ms: null, connect_started_ms: null, connection_ready_ms: null,
      headers_sent_ms: null, body_sent_ms: null, connection_reused: null, socket_idle_ms: null,
      error_code: null});
    expect(summaries[0]?.response_headers_ms).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(summaries)).not.toMatch(/private-|provider\.test|Authorization|stream remains/);
  });

  it("将实际请求阶段和新连接关联到本次 fetch，之后可识别同一 socket 复用", async () => {
    const summaries: ModelTransportSummary[] = [];
    const socket = {};
    let previous: object | undefined;
    const observed = createModelTransportDiagnostics(async () => {
      const request = {};
      publish("request:create", {request});
      if (!previous) {
        publish("client:beforeConnect", {});
        publish("client:connected", {socket});
      }
      publish("client:sendHeaders", {request, socket, headers: "private-header"});
      publish("request:bodySent", {request});
      publish("request:headers", {request, response: {statusCode: 200}});
      previous = request;
      return response();
    }, summary => summaries.push(summary));
    await observed("https://provider.test");
    publish("request:trailers", {request: previous});
    await observed("https://provider.test");
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toMatchObject({connection_reused: false, socket_idle_ms: null});
    expect(summaries[1]).toMatchObject({connection_reused: true, connect_started_ms: null});
    expect(summaries[1]?.socket_idle_ms).toBeGreaterThanOrEqual(0);
    for (const item of summaries) {
      expect(item.request_created_ms).toBeGreaterThanOrEqual(0);
      expect(item.headers_sent_ms).toBeGreaterThanOrEqual(item.connection_ready_ms!);
      expect(item.body_sent_ms).toBeGreaterThanOrEqual(item.headers_sent_ms!);
      expect(item.response_headers_ms).toBeGreaterThanOrEqual(item.body_sent_ms!);
    }
  });

  it("此前未被诊断观察到的 socket 不武断标为新建", async () => {
    const summaries: ModelTransportSummary[] = [];
    const observed = createModelTransportDiagnostics(async () => {
      const request = {};
      publish("request:create", {request});
      publish("client:sendHeaders", {request, socket: {}, headers: "private-header"});
      return response();
    }, summary => summaries.push(summary));
    await observed("https://provider.test");
    expect(summaries[0]).toMatchObject({connection_reused: null, socket_idle_ms: null});
  });

  it("并发请求和外部请求的诊断事件不串线", async () => {
    const entered = [deferred(), deferred()];
    const finish = [deferred(), deferred()];
    const requests = [{}, {}];
    const summaries: ModelTransportSummary[][] = [[], []];
    const calls = requests.map((request, index) => createModelTransportDiagnostics(async () => {
      publish("request:create", {request});
      entered[index]!.resolve();
      await finish[index]!.promise;
      return response();
    }, summary => summaries[index]!.push(summary))("https://provider.test"));
    await Promise.all(entered.map(item => item.promise));
    publish("request:bodySent", {request: requests[1]});
    publish("request:create", {request: {unrelated: true}});
    publish("request:bodySent", {request: requests[0]});
    finish[1]!.resolve();
    await calls[1];
    expect(summaries[0]).toEqual([]);
    expect(summaries[1]).toHaveLength(1);
    finish[0]!.resolve();
    await calls[0];
    expect(summaries[0]).toHaveLength(1);
    expect(summaries.every(items => items[0]!.body_sent_ms !== null)).toBe(true);
    publish("request:error", {request: requests[0], error: new Error("private-late-error")});
    expect(summaries.map(items => items.length)).toEqual([1, 1]);
  });

  it("共享 socket 上还有请求未结束时，不将某一响应结束误记为连接空闲", async () => {
    const summaries: ModelTransportSummary[] = [];
    const socket = {};
    const requests: object[] = [];
    const observed = createModelTransportDiagnostics(async () => {
      const request = {};
      publish("request:create", {request});
      if (requests.length === 0) publish("client:connected", {socket});
      requests.push(request);
      publish("client:sendHeaders", {request, socket});
      return response();
    }, summary => summaries.push(summary));
    await observed("https://provider.test");
    await observed("https://provider.test");
    publish("request:trailers", {request: requests[0]});
    await observed("https://provider.test");
    expect(summaries[2]).toMatchObject({connection_reused: true, socket_idle_ms: null});
  });

  it.each(["ECONNRESET", "ENOTFOUND"])("失败仍抛出原对象，仅提取受控错误码 %s", async code => {
    const summaries: ModelTransportSummary[] = [];
    const error = new TypeError("private-message", {cause: Object.assign(new Error("private-cause"), {code})});
    const observed = createModelTransportDiagnostics(async () => {throw error;}, summary => summaries.push(summary));
    await expect(observed("https://provider.test")).rejects.toBe(error);
    expect(summaries[0]).toMatchObject({status: null, response_headers_ms: null, error_code: code});
    expect(JSON.stringify(summaries)).not.toContain("private");
  });

  it("取消保留原 signal 和原错误，已发送请求仍可定位为无响应头", async () => {
    const summaries: ModelTransportSummary[] = [];
    const controller = new AbortController();
    const abort = new DOMException("private-cancel", "AbortError");
    const observed = createModelTransportDiagnostics(async (_input, init) => {
      const request = {};
      publish("request:create", {request});
      publish("request:bodySent", {request});
      expect(init?.signal).toBe(controller.signal);
      controller.abort(abort);
      throw controller.signal.reason;
    }, summary => summaries.push(summary));
    await expect(observed("https://provider.test", {signal: controller.signal})).rejects.toBe(abort);
    expect(summaries[0]).toMatchObject({response_headers_ms: null, error_code: "AbortError"});
    expect(summaries[0]?.body_sent_ms).not.toBeNull();
  });

  it("只允许有限的供应商请求 ID，丢弃其他响应头及异常内容", async () => {
    const summaries: ModelTransportSummary[] = [];
    const observed = createModelTransportDiagnostics(async () => new Response(null, {status: 429, headers: {
      "x-tt-logid": "20261025:request-id", "x-request-id": "private value with spaces",
      "request-id": "a".repeat(200), "authorization": "private-key", "set-cookie": "private-cookie",
    }}), summary => summaries.push(summary));
    await observed("https://provider.test");
    expect(summaries[0]).toMatchObject({status: 429, provider_request_ids: {"x-tt-logid": "20261025:request-id"}});
    expect(JSON.stringify(summaries)).not.toContain("private");
  });

  it("诊断回调失败不改变 HTTP 成功或原始失败", async () => {
    const result = response();
    const logFailure = () => {throw new Error("logger unavailable");};
    expect(await createModelTransportDiagnostics(async () => result, logFailure)("https://provider.test")).toBe(result);
    const error = new Error("original failure");
    await expect(createModelTransportDiagnostics(async () => {throw error;}, logFailure)("https://provider.test"))
      .rejects.toBe(error);
  });
});
