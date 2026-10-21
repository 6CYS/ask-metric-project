import {createServer} from "node:http";
import {once} from "node:events";
import {expect, it} from "vitest";
import {validateToolArguments} from "@earendil-works/pi-ai";
import {loadConfig} from "./config.js";
import {createAskMetricModels} from "./models.js";
import {createAskMetricTools} from "./tools/index.js";

it("统一语义工具支持结构化查询与分析计划，拒绝未知动作", () => {
  const tool = createAskMetricTools().find(item => item.name === "resolve_business_turn")!;
  const schema = JSON.parse(JSON.stringify(tool.parameters));
  expect(schema.definitions.target.properties.analysis.oneOf).toHaveLength(2);
  const args = {protocol_version: 2, intent: "query", targets: [{source: {kind: "new"},
    operations: [{action: "set", field: "metrics", value: "合成指标"}]}]};
  expect(() => validateToolArguments(tool, {type: "toolCall", id: "fixture", name: tool.name, arguments: args})).not.toThrow();
  const invalid = {...args, targets: [{...args.targets[0], operations: [{action: "unregistered", field: "metrics", value: "合成指标"}]}]};
  expect(() => validateToolArguments(tool, {type: "toolCall", id: "fixture", name: tool.name, arguments: invalid})).toThrow();
});

it.each([false, true])("原生 SDK 携带完整业务工具及accessKey，输出上限正确发送（硅基流动=%s）", async siliconFlow => {
  let payload: any;
  let headers: Record<string, unknown> | undefined;
  const server = createServer(async (request, response) => {
    headers = request.headers;
    let body = "";
    for await (const part of request) body += part;
    payload = JSON.parse(body);
    const raw = payload.tools.find((tool: any) => tool.function.name === "resolve_business_turn")
      .function.parameters.definitions.target.properties.analysis;
    if (!raw.oneOf) {
      response.writeHead(400, {"Content-Type": "application/json"});
      response.end(JSON.stringify({error: {message: "Unsupported JSON Schema structure " + JSON.stringify(raw)}}));
      return;
    }
    response.writeHead(200, {"Content-Type": "text/event-stream"});
    response.write(`data: ${JSON.stringify({id: "tools-check", object: "chat.completion.chunk", created: 0,
      model: "fixture", choices: [{index: 0, delta: {role: "assistant", tool_calls: [{index: 0, id: "reply-1",
        type: "function", function: {name: "respond_without_business_action", arguments: JSON.stringify({answer: "你好"})}}]}, finish_reason: null}]})}\n\n`);
    response.write(`data: ${JSON.stringify({choices: [{index: 0, delta: {}, finish_reason: "tool_calls"}]})}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind");
  try {
    const config = loadConfig({AGENT_MODEL_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      AGENT_MODEL_NAME: "fixture", AGENT_MODEL_API_KEY: "fixture-key", AGENT_MODEL_AUTH_HEADER: "accessKey", AGENT_MODEL_AUTH_PREFIX: ""});
    const {models, model} = createAskMetricModels(config);
    if (siliconFlow) {
      // 供应商识别用真实域名，所有HTTP仍只发到隔离本地桩。
      const compat = createAskMetricModels({...config, model: {...config.model, baseUrl: "https://api.siliconflow.cn/v1"}}).model.compat;
      if (!compat) throw new Error("SiliconFlow compatibility not configured");
      model.compat = compat;
    }
    const tools = createAskMetricTools();
    const reply = await models.completeSimple(model, {tools, messages: [{role: "user", content: "你好", timestamp: 1}]},
      {onPayload: payload => ({...payload as object, tool_choice: "required"})});
    expect(reply.errorMessage).toBeUndefined();
    expect(reply.stopReason).toBe("toolUse");
    expect(reply.content).toContainEqual({type: "toolCall", id: "reply-1", name: "respond_without_business_action", arguments: {answer: "你好"}});
    expect(payload.tools).toHaveLength(tools.length);
    expect(payload.tool_choice).toBe("required");
    expect(payload[siliconFlow ? "max_tokens" : "max_completion_tokens"]).toBe(config.model.maxTokens);
    expect(payload[siliconFlow ? "max_completion_tokens" : "max_tokens"]).toBeUndefined();
    expect(headers?.accesskey).toBe("fixture-key");
    expect(headers?.authorization).toBeUndefined();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
