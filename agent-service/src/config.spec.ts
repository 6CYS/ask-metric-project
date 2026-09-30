import {expect, it} from "vitest";
import {loadConfig} from "./config.js";

const model = {AGENT_MODEL_API_KEY: "synthetic", AGENT_MODEL_BASE_URL: "http://model.test/v1", AGENT_MODEL_NAME: "synthetic"};
it("回答流式开关默认关闭，显式开启与关闭可回退，非法值拒绝启动", () => {
  expect(loadConfig(model).answerStreaming).toBe(false);
  expect(loadConfig({...model, AGENT_ANSWER_STREAMING: "true"}).answerStreaming).toBe(true);
  expect(loadConfig({...model, AGENT_ANSWER_STREAMING: "false"}).answerStreaming).toBe(false);
  expect(() => loadConfig({...model, AGENT_ANSWER_STREAMING: "invalid"})).toThrow("AGENT_ANSWER_STREAMING");
});
