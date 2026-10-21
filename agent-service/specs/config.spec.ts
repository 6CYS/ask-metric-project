import {expect, it} from "vitest";
import {loadConfig} from "../src/config.js";

const model = {AGENT_MODEL_API_KEY: "synthetic", AGENT_MODEL_BASE_URL: "http://model.test/v1", AGENT_MODEL_NAME: "synthetic"};
it("模型工具选择兼容策略默认native，仅接受显式auto", () => {
  expect(loadConfig(model).modelToolChoicePolicy).toBe("native");
  expect(loadConfig({...model, AGENT_MODEL_TOOL_CHOICE_POLICY: "auto"}).modelToolChoicePolicy).toBe("auto");
  expect(() => loadConfig({...model, AGENT_MODEL_TOOL_CHOICE_POLICY: "invalid"})).toThrow("AGENT_MODEL_TOOL_CHOICE_POLICY");
});
it("直接交付与上下文精简配置有明确默认、观察和回退值，非法值拒绝启动", () => {
  expect(loadConfig(model)).toMatchObject({directQueryDelivery: "on", modelContextView: "compact_v1", semanticPromptVariant: "compact_v1"});
  expect(loadConfig({...model, AGENT_DIRECT_QUERY_DELIVERY: "off", AGENT_MODEL_CONTEXT_VIEW: "raw", AGENT_SEMANTIC_PROMPT_VARIANT: "full"}))
    .toMatchObject({directQueryDelivery: "off", modelContextView: "raw", semanticPromptVariant: "full"});
  expect(loadConfig({...model, AGENT_DIRECT_QUERY_DELIVERY: "observe"}).directQueryDelivery).toBe("observe");
  for (const name of ["AGENT_DIRECT_QUERY_DELIVERY", "AGENT_MODEL_CONTEXT_VIEW", "AGENT_SEMANTIC_PROMPT_VARIANT"]) {
    expect(() => loadConfig({...model, [name]: "invalid"})).toThrow(name);
  }
});
it("回答流式开关默认关闭，显式开启与关闭可回退，非法值拒绝启动", () => {
  expect(loadConfig(model).answerStreaming).toBe(false);
  expect(loadConfig({...model, AGENT_ANSWER_STREAMING: "true"}).answerStreaming).toBe(true);
  expect(loadConfig({...model, AGENT_ANSWER_STREAMING: "false"}).answerStreaming).toBe(false);
  expect(() => loadConfig({...model, AGENT_ANSWER_STREAMING: "invalid"})).toThrow("AGENT_ANSWER_STREAMING");
});

it("模型首次响应与输出空闲时限分别默认 30 秒", () => {
  const config = loadConfig(model);
  expect(config.modelFirstResponseTimeoutMs).toBe(30_000);
  expect(config.modelStreamIdleTimeoutMs).toBe(30_000);
  expect(config).not.toHaveProperty("modelTimeoutMs");
});

it("模型输出空闲新配置优先，旧变量兼容后备，不影响首次响应时限", () => {
  expect(loadConfig({...model, AGENT_MODEL_TIMEOUT_MS: "45000"}).modelStreamIdleTimeoutMs).toBe(45_000);
  const config = loadConfig({...model, AGENT_MODEL_TIMEOUT_MS: "invalid",
    AGENT_MODEL_STREAM_IDLE_TIMEOUT_MS: "60000", AGENT_MODEL_FIRST_RESPONSE_TIMEOUT_MS: "12000"});
  expect(config.modelStreamIdleTimeoutMs).toBe(60_000);
  expect(config.modelFirstResponseTimeoutMs).toBe(12_000);
  expect(loadConfig({...model, AGENT_MODEL_STREAM_IDLE_TIMEOUT_MS: "  ",
    AGENT_MODEL_TIMEOUT_MS: "45000"}).modelStreamIdleTimeoutMs).toBe(45_000);
});

it.each(["0", "-1", "invalid"])("模型响应时限非法值 %s 拒绝启动", (value) => {
  expect(() => loadConfig({...model, AGENT_MODEL_FIRST_RESPONSE_TIMEOUT_MS: value})).toThrow("AGENT_MODEL_FIRST_RESPONSE_TIMEOUT_MS");
  expect(() => loadConfig({...model, AGENT_MODEL_STREAM_IDLE_TIMEOUT_MS: value,
    AGENT_MODEL_TIMEOUT_MS: "45000"})).toThrow("AGENT_MODEL_STREAM_IDLE_TIMEOUT_MS");
  expect(() => loadConfig({...model, AGENT_MODEL_TIMEOUT_MS: value})).toThrow("AGENT_MODEL_TIMEOUT_MS");
});
