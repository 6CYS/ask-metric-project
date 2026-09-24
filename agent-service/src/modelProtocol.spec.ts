import {expect, it} from "vitest";
import {createAssistantMessageEventStream, type AssistantMessage, type Model, type ProviderStreams} from "@earendil-works/pi-ai";
import {wrapStreamsWithAuthorization} from "./models.js";

it("网关泄漏工具协议时返回原生错误，不展示伪调用也不执行工具", async () => {
  const model = {id: "test", api: "openai-completions", provider: "test"} as Model<"openai-completions">;
  const message: AssistantMessage = {role: "assistant", content: [{type: "text", text: '我继续处理。\n<｜DSML｜tool_calls.\n<｜DSML｜invoking name="business_context_read">'}],
    api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: 1,
    usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}};
  const response = () => {const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {stream.push({type: "done", reason: "stop", message}); stream.end(message);}); return stream;};
  const inner: ProviderStreams = {stream: response, streamSimple: response};
  const stream = wrapStreamsWithAuthorization(inner, () => true).streamSimple(model, {messages: []});
  const events = []; for await (const event of stream) events.push(event);
  expect(events.at(-1)).toMatchObject({type: "error", reason: "error"});
  expect(await stream.result()).toMatchObject({content: [], stopReason: "error", errorMessage: expect.stringContaining("MODEL_TOOL_PROTOCOL_ERROR")});
});


it("模型失败在历史和刷新投影中保持失败标识，不泄漏网关内部错误", async () => {
  const {projectEntries} = await import("./sessionProjection.js");
  const entries = [
    {id: "u", type: "message", message: {role: "user", content: "继续", timestamp: 1, businessProtocol: "frame_v1"}},
    {id: "a", type: "message", message: {role: "assistant", content: [{type: "text", text: "让我重新发起一次完整查询"}], stopReason: "error", errorMessage: "private gateway response", timestamp: 2}},
  ];
  const projected = projectEntries(entries as unknown as import("@earendil-works/pi-agent-core").Entry[]);
  expect(projected.at(-1)).toMatchObject({role: "assistant", business_protocol: "frame_v1", error: expect.stringContaining("未完成")});
  expect(projected.at(-1)).toMatchObject({text: expect.stringContaining("未完成")});
  expect(JSON.stringify(projected)).not.toContain("让我重新发起一次完整查询");
  expect(JSON.stringify(projected)).not.toContain("private gateway response");
});
