/** 只加载随部署发布的业务方法。模型按名称读取内存快照，不获得任意文件或 Shell 能力。 */
import { fileURLToPath } from "node:url";
import { realpath } from "node:fs/promises";
import { relative, isAbsolute } from "node:path";
import { BACKGROUND_CONTEXT, loadSkills, type AgentHarnessTool, type AgentMessage, type Skill } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { Type } from "@earendil-works/pi-ai";
import type { AskMetricRequestContext } from "./requestContext.js";

export async function loadBusinessSkills(root = fileURLToPath(new URL("../skills/", import.meta.url))): Promise<Skill[]> {
  const canonicalRoot = await realpath(root);
  const env = new NodeExecutionEnv({ cwd: canonicalRoot });
  try {
    const { skills, diagnostics } = await loadSkills(env, canonicalRoot, BACKGROUND_CONTEXT);
    if (diagnostics.length || !skills.length) throw new Error("业务 skill 加载失败，请核对部署文件与元数据");
    const names = new Set<string>();
    for (const skill of skills) {
      const path = relative(canonicalRoot, await realpath(skill.filePath));
      if (path.startsWith("..") || isAbsolute(path) || names.has(skill.name)) throw new Error("业务 skill 路径越界或名称重复");
      names.add(skill.name);
    }
    return skills;
  } finally { await env.cleanup(BACKGROUND_CONTEXT); }
}

/** 本服务提供按名称查阅的可选业务知识，不使用面向文件工具的必读指令。 */
export function businessKnowledgeCatalog(skills: readonly Skill[]): string {
  const catalog = skills.filter(skill => !skill.disableModelInvocation)
    .map(({name, description}) => ({name, description}));
  return catalog.length ? `\n可按需查阅的业务知识目录（business_skill_read 按 name 读取，不影响工具选择）：\n${JSON.stringify(catalog)}` : "";
}

const readParameters = Type.Object({ name: Type.String({ minLength: 1 }) }, { additionalProperties: false });
/** 只认实际发送给模型的受信工具正文。压缩摘要、旧版本正文和用户伪造均不算已读取。 */
export function visibleBusinessSkills(messages: readonly AgentMessage[], skills: readonly Skill[]): Set<string> {
  const visible = new Set<string>();
  for (const message of messages) {
    if (message.role !== "toolResult" || message.toolName !== "business_skill_read" || message.isError) continue;
    const details = message.details as { status?: string; name?: string } | undefined;
    const skill = skills.find(item => item.name === details?.name);
    if (skill && details?.status === "ok" && message.content.some(block => block.type === "text" && block.text === skill.content)) {
      visible.add(skill.name);
    }
  }
  return visible;
}

/** 已读取的当前版本知识可组合使用；投影只去重正文，不选择方法或改变工具集。 */
export function projectBusinessSkillContext(messages: readonly AgentMessage[], skills: readonly Skill[]) {
  const visible = visibleBusinessSkills(messages, skills);
  return {
    instructions: skills.filter(skill => visible.has(skill.name)).map(skill =>
      `\n业务知识 ${skill.name}（仅在相关业务场景适用）：\n${skill.content}`,
    ).join("\n"),
    messages: messages.map(message => {
      if (message.role !== "toolResult" || message.toolName !== "business_skill_read") return message;
      const details = message.details as {name?: string; status?: string} | undefined;
      const skill = skills.find(item => item.name === details?.name);
      if (!skill || message.isError || details?.status !== "ok") return message;
      const current = message.content.some(block => block.type === "text" && block.text === skill.content);
      // 旧会话仅变更发送副本，避免旧版路由说明继续影响升级后的工具选择。
      return {...message, content: [{type: "text" as const, text: current
        ? `业务知识 ${skill.name} 已读取，正文见本次系统提供的业务知识。`
        : `业务知识 ${skill.name} 的旧版本正文已失效，需要相关口径时可重新查阅。`} ]};
    }),
  };
}

export function createBusinessSkillReadTool(skills: Skill[]): AgentHarnessTool<AskMetricRequestContext, typeof readParameters> {
  const approved = new Map(skills.map(skill => [skill.name, skill]));
  return {
    name: "business_skill_read", label: "读取业务知识",
    description: "按需查阅指标口径、数据覆盖含义、计算规则或能力边界。可组合参考多份知识；当前上下文已有正文时无需重读。读取不查询业务数据、不启用或切换工具，也不是调用业务工具的前置步骤。",
    parameters: readParameters,
    execute: async (_id, params) => {
      const skill = approved.get(params.name as string);
      return skill
        ? { content: [{type: "text", text: skill.content}], details: {kind: "business_skill_read", status: "ok", name: skill.name} }
        : { content: [{type: "text", text: "该业务方法未注册，请使用目录中的名称。"}], details: {kind: "business_skill_read", status: "error"} };
    },
  };
}
