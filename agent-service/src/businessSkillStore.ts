import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Skill } from "@earendil-works/pi-agent-core";
import { inquiryBusinessSkills } from "./businessSkills.js";

export interface BusinessSkillItem {
  name: string;
  display_name: string;
  description: string;
  content: string;
  revision: string;
  editable: boolean;
  modified: boolean;
  updated_at: string | null;
  updated_by: string | null;
}

interface SkillOverride {
  content: string;
  updated_at: string;
  updated_by: string;
}

export class SkillConfigError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const MAX_CONTENT_LENGTH = 100_000;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** 人工正文独立于部署文件保存；仅管理操作读写磁盘，问数按轮取得内存快照。 */
export class BusinessSkillStore {
  private readonly path: string;
  private overrides: Record<string, SkillOverride> = {};

  constructor(
    private readonly dataDir: string,
    private readonly defaults: readonly Skill[],
  ) {
    this.path = join(dataDir, "business-skills.json");
    if (!existsSync(this.path)) return;
    const document: unknown = JSON.parse(readFileSync(this.path, "utf8"));
    if (!record(document) || document.version !== 1 || !record(document.overrides))
      throw new Error("Skill 配置格式无效，请检查持久数据目录");
    for (const [name, value] of Object.entries(document.overrides)) {
      if (
        !record(value) ||
        typeof value.content !== "string" ||
        !value.content.trim() ||
        value.content.length > MAX_CONTENT_LENGTH ||
        typeof value.updated_at !== "string" ||
        typeof value.updated_by !== "string"
      )
        throw new Error("Skill 配置正文或修改记录无效");
      this.overrides[name] = {
        content: value.content,
        updated_at: value.updated_at,
        updated_by: value.updated_by,
      };
    }
  }

  list(): BusinessSkillItem[] {
    const editable = new Set(inquiryBusinessSkills(this.defaults).map((skill) => skill.name));
    return this.defaults
      .map((skill) => {
        const override = this.overrides[skill.name];
        const content = override?.content ?? skill.content;
        return {
          name: skill.name,
          display_name:
            skill.content
              .split("\n")
              .find((line) => line.startsWith("# "))
              ?.slice(2)
              .trim() || skill.name,
          description: skill.description,
          content,
          revision: createHash("sha256")
            .update(JSON.stringify([skill.name, skill.description, content]))
            .digest("hex"),
          editable: editable.has(skill.name),
          modified: Boolean(override),
          updated_at: override?.updated_at ?? null,
          updated_by: override?.updated_by ?? null,
        };
      })
      .sort((left, right) => Number(right.editable) - Number(left.editable));
  }

  snapshot(): Skill[] {
    return inquiryBusinessSkills(this.defaults).map((skill) => ({
      ...skill,
      content: this.overrides[skill.name]?.content ?? skill.content,
    }));
  }

  update(name: string, revision: unknown, content: unknown, actor: string): BusinessSkillItem {
    this.ensureEditable(name, revision);
    if (typeof content !== "string" || !content.trim() || content.length > MAX_CONTENT_LENGTH)
      throw new SkillConfigError(
        400,
        "SKILL_CONTENT_INVALID",
        "Skill 正文不能为空，且不能超过 100,000 字符",
      );
    this.persist({
      ...this.overrides,
      [name]: { content, updated_at: new Date().toISOString(), updated_by: actor },
    });
    return this.find(name);
  }

  restore(name: string, revision: unknown): BusinessSkillItem {
    this.ensureEditable(name, revision);
    const next = { ...this.overrides };
    delete next[name];
    this.persist(next);
    return this.find(name);
  }

  private find(name: string): BusinessSkillItem {
    const item = this.list().find((skill) => skill.name === name);
    if (!item) throw new SkillConfigError(404, "SKILL_NOT_FOUND", "Skill 不存在");
    return item;
  }

  private ensureEditable(name: string, revision: unknown): void {
    const item = this.find(name);
    if (!item.editable)
      throw new SkillConfigError(400, "SKILL_NOT_CONNECTED", "该 Skill 尚未接入当前问数，仅可查看");
    if (typeof revision !== "string" || !revision)
      throw new SkillConfigError(400, "SKILL_REVISION_REQUIRED", "缺少 Skill 版本，请刷新后重试");
    if (revision !== item.revision)
      throw new SkillConfigError(
        409,
        "SKILL_REVISION_CONFLICT",
        "Skill 已被修改，请刷新后核对最新内容",
      );
  }

  private persist(next: Record<string, SkillOverride>): void {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      mkdirSync(this.dataDir, { recursive: true });
      writeFileSync(temporary, JSON.stringify({ version: 1, overrides: next }, null, 2) + "\n", {
        mode: 0o600,
      });
      renameSync(temporary, this.path);
      this.overrides = next;
    } catch {
      throw new SkillConfigError(503, "SKILL_SAVE_FAILED", "Skill 保存失败，当前生效内容保持不变");
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}
