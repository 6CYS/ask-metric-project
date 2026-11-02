import { describe, expect, it } from "vitest";
import { parsePromptInput } from "../src/routes.js";

const base = { protocol_version: 3, request_id: "request", message: "" };
const target = { task_id: "task", version: 2, clarification_id: "card" };

describe("结构化输入的 HTTP 契约", () => {
  it.each([
    {
      answers: [
        { question_id: "question", version: 1, choice: { type: "select", option_ids: ["option"] } },
      ],
    },
    { clarification_selection: { frame_id: "frame", option_ids: ["option"] } },
    { clarification_target: target, selected_answers: { set: { metrics: [{ code: "M1" }] } } },
  ])("只有已支持的结构化输入也能提交，不伪造用户原文：%j", (selection) => {
    expect(parsePromptInput({ ...base, ...selection })).toMatchObject({ ...base, ...selection });
  });

  it.each([
    {},
    { clarification_target: target },
    { clarification_selection: { frame_id: "frame", option_ids: [] } },
    { selected_answers: { set: { metrics: [{ code: "M1" }] } } },
    { time_override: { start: "2026-08-01", end: "2026-08-31" } },
  ])("没有有效问题或选择不能启动：%j", (selection) => {
    expect(parsePromptInput({ ...base, ...selection })).toBeNull();
  });

  it.each([
    { start: "2026-02-30", end: "2026-03-01" },
    { start: "2026-09-01", end: "2026-08-31" },
    { start: "2026-08-01", end: "2026-08-31", internal: true },
  ])("时间切换只校验日期格式和范围：%j", (time_override) => {
    expect(parsePromptInput({ ...base, message: "重新查看", time_override })).toBeNull();
  });

  it("有效日期直接保留，不重写原问题", () => {
    const input = {
      ...base,
      message: "查看最近两年的存款",
      time_override: { start: "2024-01-01", end: "2025-12-31" },
    };
    expect(parsePromptInput(input)).toEqual(input);
  });
});
