import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadBusinessSkills, projectBusinessSkillContext } from "../src/businessSkills.js";
import { BusinessSkillStore } from "../src/businessSkillStore.js";
import type { Skill } from "@earendil-works/pi-agent-core";

describe("Skill 人工配置与运行快照", () => {
  let root: string;
  let defaults: Skill[];
  let store: BusinessSkillStore;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "skill-config-"));
    defaults = await loadBusinessSkills();
    store = new BusinessSkillStore(root, defaults);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("部署目录可查阅，只有实际接入的分析方法可维护", () => {
    const items = store.list();
    expect(items).toHaveLength(defaults.length);
    expect(items.filter((item) => item.editable).map((item) => item.name)).toEqual([
      "inquiry-analysis",
    ]);
    const inactive = items.find((item) => !item.editable)!;
    expect(() => store.update(inactive.name, inactive.revision, "修改正文", "admin")).toThrow(
      "尚未接入",
    );
    expect(() => store.update("../../outside", "invalid", "正文", "admin")).toThrow("不存在");
  });

  it("修改独立持久化，重建存储恢复人工内容，部署默认正文保持原样", () => {
    const current = store.list().find((item) => item.name === "inquiry-analysis")!;
    const oldSnapshot = store.snapshot();
    const saved = store.update(
      current.name,
      current.revision,
      "# 更新方法\n核对同口径证据。",
      "admin",
    );
    expect(saved).toMatchObject({
      content: "# 更新方法\n核对同口径证据。",
      modified: true,
      updated_by: "admin",
    });
    expect(saved.revision).not.toBe(current.revision);
    expect(new BusinessSkillStore(root, defaults).snapshot()[0]?.content).toBe(saved.content);
    expect(oldSnapshot[0]?.content).toBe(current.content);
    expect(defaults.find((item) => item.name === current.name)?.content).toBe(current.content);
    expect(() => store.update(current.name, current.revision, "覆盖旧草稿", "admin")).toThrow(
      "已被修改",
    );
  });

  it("空正文不能清掉现有方法；恢复默认后重启仍读取部署正文", () => {
    const current = store.list().find((item) => item.name === "inquiry-analysis")!;
    expect(() => store.update(current.name, current.revision, "  \n", "admin")).toThrow("正文");
    const saved = store.update(current.name, current.revision, "人工正文", "admin");
    store.restore(current.name, saved.revision);
    expect(new BusinessSkillStore(root, defaults).snapshot()[0]?.content).toBe(current.content);
    expect(store.list().find((item) => item.name === current.name)?.modified).toBe(false);
  });

  it("换版后历史读取的旧正文失效，不能继续作为当前已读方法", () => {
    const current = store.list().find((item) => item.name === "inquiry-analysis")!;
    store.update(current.name, current.revision, "新版方法", "admin");
    const result = projectBusinessSkillContext(
      [
        {
          role: "toolResult",
          toolName: "business_skill_read",
          toolCallId: "old-read",
          content: [{ type: "text", text: current.content }],
          details: { status: "ok", name: current.name },
          isError: false,
          timestamp: 0,
        },
      ],
      store.snapshot(),
      "tool",
    );
    const message = result.messages[0];
    if (message?.role !== "toolResult") throw new Error("缺少工具回执");
    expect(
      message.content[0]?.type === "text" && message.content[0].text.includes("旧版本正文已失效"),
    ).toBe(true);
  });
});
