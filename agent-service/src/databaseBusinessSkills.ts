import type { Skill } from "@earendil-works/pi-agent-core";
import { BackendApiError, type BackendClient } from "./backendClient.js";

export interface BusinessSkillSnapshot {
  version_id: string;
  skills: Skill[];
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** 每轮只读一次；恢复/重试按已持久化版本回读，不把新正文插入旧操作。 */
export async function databaseBusinessSkillSnapshot(backend: BackendClient, versionId?: string): Promise<BusinessSkillSnapshot> {
  const response = await backend.businessSkillSnapshot(versionId);
  if (!record(response) || typeof response.version_id !== "string" || !response.version_id ||
    (versionId && response.version_id !== versionId) || !Array.isArray(response.skills))
    throw new BackendApiError(503, "Skill 配置响应无效", "SKILL_CONFIG_INVALID");
  const skills: Skill[] = [];
  for (const item of response.skills) {
    if (!record(item) || typeof item.name !== "string" || !item.name ||
      typeof item.description !== "string" || typeof item.content !== "string" || !item.content.trim() ||
      typeof item.disable_model_invocation !== "boolean" || skills.some(skill => skill.name === item.name))
      throw new BackendApiError(503, "Skill 配置正文无效", "SKILL_CONFIG_INVALID");
    skills.push({ name: item.name, description: item.description, content: item.content,
      disableModelInvocation: item.disable_model_invocation,
      // Pi Skill 类型需要位置标识；数据库资源不是可供文件工具读取的路径。
      filePath: `database:business-skills/${response.version_id}/${encodeURIComponent(item.name)}` });
  }
  if (!skills.some(skill => skill.name === "inquiry-analysis"))
    throw new BackendApiError(503, "缺少已接入的 Skill", "SKILL_CONFIG_INVALID");
  return { version_id: response.version_id, skills };
}
