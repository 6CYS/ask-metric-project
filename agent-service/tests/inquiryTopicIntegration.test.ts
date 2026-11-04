import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { inquiryPayload, inquirySystemPrompt } from "../src/inquiry/runtime.js";
import { createAskMetricTools } from "../src/tools/index.js";

const environment = {
  AGENT_MODEL_BASE_URL: "https://model.test.invalid/v1",
  AGENT_MODEL_NAME: "integration-test",
  AGENT_MODEL_API_KEY: "test-only-key",
};

describe("主题查询与流式交付整合", () => {
  it("未配置时保持原工具集合，主题入口默认关闭", () => {
    const config = loadConfig(environment);
    expect(config.topicQueryEnabled).toBe(false);
    const names = createAskMetricTools().map((tool) => tool.name);
    expect(names).not.toContain("topic_query");
    expect(names).toEqual(
      expect.arrayContaining([
        "metric_search",
        "metric_query",
        "metric_availability",
        "analysis_read",
        "business_knowledge_search",
      ]),
    );
  });

  it.each([
    { topics: false, streaming: false },
    { topics: false, streaming: true },
    { topics: true, streaming: false },
    { topics: true, streaming: true },
  ])("主题=$topics、SSE=$streaming 独立生效", ({ topics, streaming }) => {
    const config = loadConfig({
      ...environment,
      AGENT_TOPIC_QUERY_ENABLED: String(topics),
      AGENT_ANSWER_STREAMING: String(streaming),
    });
    expect(config.topicQueryEnabled).toBe(topics);
    expect(config.answerStreaming).toBe(streaming);

    const registered = createAskMetricTools({ topicsEnabled: config.topicQueryEnabled ?? false });
    const names = registered.map((tool) => tool.name);
    expect(names.filter((name) => name === "topic_query")).toHaveLength(topics ? 1 : 0);
    expect(names.filter((name) => name === "metric_query")).toHaveLength(1);
    expect(new Set(names).size).toBe(names.length);

    const payload = inquiryPayload(
      { tools: registered.map(({ name }) => ({ function: { name } })) },
      [],
      config.answerStreaming,
    );
    const topicTool = { function: { name: "topic_query" } };
    if (topics) expect(payload.tools).toContainEqual(topicTool);
    else expect(payload.tools).not.toContainEqual(topicTool);
    expect(payload.tool_choice).toBe(streaming ? "required" : "auto");

    const prompt = inquirySystemPrompt(
      "2026-11-03",
      true,
      config.answerStreaming,
      config.topicQueryEnabled,
    );
    expect(prompt.includes("topic_query")).toBe(topics);
    expect(prompt.includes("直接调用analysis_answer，将最终业务正文放入body")).toBe(streaming);
    expect(prompt.includes("直接写正常assistant正文，不把全文封装成工具参数")).toBe(!streaming);
  });
});
