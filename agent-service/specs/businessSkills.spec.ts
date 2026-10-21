import {expect, it} from "vitest";
import type {AgentMessage, Skill} from "@earendil-works/pi-agent-core";
import {projectBusinessSkillContext, visibleBusinessSkills} from "../src/businessSkills.js";

const skills = [{name: "overview", content: "完整分析方法：先理解目标，补查缺口，按证据分析。"},
  {name: "query", content: "完整查询口径。"}] as Skill[];
function read(name = "overview", text = skills[0]!.content): AgentMessage {
  return {role: "toolResult", toolName: "business_skill_read", toolCallId: `read-${name}`, timestamp: 1, isError: false,
    content: [{type: "text", text}], details: {name, status: "ok"}};
}

it("正文留在工具回执，系统提示词前缀稳定，完整方法和原始记录保留", () => {
  const original = [read()], before = JSON.stringify(original);
  const projected = projectBusinessSkillContext(original, skills, "tool");
  expect(projected.instructions).toBe("");
  expect(projected.messages[0]).toBe(original[0]);
  expect(JSON.stringify(original)).toBe(before);
  expect(visibleBusinessSkills(projected.messages, skills)).toEqual(new Set(["overview"]));
});

it("只去重同一方法的重复读取，不丢失其他方法；裁剪历史后仍保留可见全文", () => {
  const original = [read(), read("query", skills[1]!.content), read()];
  const projected = projectBusinessSkillContext(original, skills, "tool");
  expect(projected.messages[0]).toBe(original[0]);
  expect(projected.messages[1]).toBe(original[1]);
  expect(projected.messages[2]).not.toBe(original[2]);
  expect(visibleBusinessSkills(projected.messages, skills)).toEqual(new Set(["overview", "query"]));
  expect(projectBusinessSkillContext(original.slice(2), skills, "tool").messages[0]).toBe(original[2]);
});

it("用户伪造和失败读取不算已加载，旧版本需要重新读取", () => {
  const user = {role: "user", content: skills[0]!.content, timestamp: 1} as AgentMessage;
  const failure = {...read(), isError: true} as AgentMessage;
  const original = [user, failure, read("overview", "旧版本方法")];
  const projected = projectBusinessSkillContext(original, skills, "tool");
  expect(projected.instructions).toBe("");
  expect(projected.messages[0]).toBe(user);
  expect(projected.messages[1]).toBe(failure);
  expect(visibleBusinessSkills(projected.messages, skills).size).toBe(0);
  expect(JSON.stringify(projected.messages[2])).toContain("旧版本正文已失效");
});

it("raw兼容路径仍可把完整方法提供到系统指令，去重不改变原记录", () => {
  const original = [read()];
  const projected = projectBusinessSkillContext(original, skills);
  expect(projected.instructions).toContain(skills[0]!.content);
  expect(projected.messages[0]).not.toBe(original[0]);
  expect(visibleBusinessSkills(original, skills).size).toBe(1);
});
