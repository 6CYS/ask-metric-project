import {createServer, type IncomingHttpHeaders} from "node:http";
import {once} from "node:events";
import {expect, it} from "vitest";
import {loadConfig} from "./config.js";
import {createAskMetricModels} from "./models.js";

it.each([
  ["accessKey", "", "fixture-model-key", undefined],
  ["Authorization", "Bearer", undefined, "Bearer fixture-model-key"],
  ["authorization", "", undefined, "fixture-model-key"],
])("原生 SDK 使用 %s / %s 鉴权头发送真实 HTTP 流式请求", async (header, prefix, accessKey, authorization) => {
  const requests: {headers: IncomingHttpHeaders; path: string | undefined}[] = [];
  const server = createServer((request, response) => {
    requests.push({headers: request.headers, path: request.url});
    request.resume();
    response.writeHead(200, {"Content-Type": "text/event-stream"});
    response.write(`data: ${JSON.stringify({id: "auth-check", object: "chat.completion.chunk", created: 0,
      model: "fixture-model", choices: [{index: 0, delta: {role: "assistant", content: "ok"}, finish_reason: null}]})}\n\n`);
    response.write(`data: ${JSON.stringify({choices: [{index: 0, delta: {}, finish_reason: "stop"}]})}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind");
  try {
    const config = loadConfig({AGENT_MODEL_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      AGENT_MODEL_NAME: "fixture-model", AGENT_MODEL_API_KEY: "fixture-model-key",
      AGENT_MODEL_AUTH_HEADER: header, AGENT_MODEL_AUTH_PREFIX: prefix});
    const {models, model} = createAskMetricModels(config);
    const answer = await models.completeSimple(model, {messages: [{role: "user", content: "Synthetic check", timestamp: 1}]});
    expect(answer.errorMessage).toBeUndefined();
    expect(answer.stopReason).toBe("stop");
    expect(answer.content).toEqual([{type: "text", text: "ok"}]);
    expect(requests).toHaveLength(1);
    const request = requests[0];
    if (!request) throw new Error("SDK did not send a model request");
    expect(request.path).toBe("/v1/chat/completions");
    expect(request.headers.accesskey).toBe(accessKey);
    expect(request.headers.authorization).toBe(authorization);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
