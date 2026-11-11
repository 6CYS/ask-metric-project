import { createSSRApp, type Component, type ComponentPublicInstance } from "vue"
import { renderToString } from "vue/server-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"
import SkillConfigPanel from "../src/components/llm/SkillConfigPanel.vue"
import * as api from "../src/lib/api"
import type { BusinessSkillItem } from "../src/types/api"

const skill: BusinessSkillItem = {
  name: "inquiry-analysis",
  display_name: "业务分析",
  description: "分析方法",
  content: "原方法",
  revision: "old",
  editable: true,
  modified: false,
  updated_at: null,
  updated_by: null,
}
const inactive: BusinessSkillItem = {
  ...skill,
  name: "data-coverage",
  display_name: "覆盖方法",
  editable: false,
}
type PanelState = {
  load(): Promise<void>
  save(): Promise<void>
  select(name: string): void
  confirmAction(): Promise<void>
  items: BusinessSkillItem[]
  selectedName: string
  contentDraft: string
  selected: BusinessSkillItem | undefined
  pendingAction: unknown
  error: string
  message: string
}
async function panel(canWrite = true) {
  const app = createSSRApp(SkillConfigPanel as Component, { canWrite, adminToken: "admin-token" })
  let state: PanelState | undefined
  app.mixin({
    created(this: ComponentPublicInstance) {
      if (this.$.type.__file === (SkillConfigPanel as { __file?: string }).__file)
        state = Reflect.get(this.$, "setupState") as PanelState
    },
  })
  await renderToString(app)
  if (!state) throw new Error("未取得 Skill 面板")
  await state.load()
  return state
}

afterEach(() => vi.restoreAllMocks())

describe("Skill 配置交互", () => {
  it("切换已编辑的正文需要确认，取消不丢草稿，未接入项不能保存", async () => {
    vi.spyOn(api, "listBusinessSkills").mockResolvedValue({ items: [skill, inactive] })
    const state = await panel()
    state.contentDraft = "未保存方法"
    state.select(inactive.name)
    expect(state.selectedName).toBe(skill.name)
    expect(state.contentDraft).toBe("未保存方法")
    expect(state.pendingAction).not.toBeNull()
    state.pendingAction = null
    state.select(inactive.name)
    await state.confirmAction()
    expect(state.selectedName).toBe(inactive.name)
    const write = vi.spyOn(api, "updateBusinessSkill")
    await state.save()
    expect(write).not.toHaveBeenCalled()
  })

  it("保存失败保留草稿和原版本，成功后更新服务端实际版本", async () => {
    vi.spyOn(api, "listBusinessSkills").mockResolvedValue({ items: [skill] })
    const state = await panel()
    state.contentDraft = "新方法"
    const write = vi
      .spyOn(api, "updateBusinessSkill")
      .mockRejectedValue(new Error("已被修改，请刷新"))
    await state.save()
    expect(state.error).toContain("已被修改")
    expect(state.contentDraft).toBe("新方法")
    expect(state.selected?.revision).toBe("old")
    write.mockResolvedValue({ ...skill, content: "新方法", revision: "new", modified: true })
    await state.save()
    expect(state.selected).toMatchObject({ content: "新方法", revision: "new", modified: true })
    expect(state.message).toContain("下一轮")
  })

  it("写入关闭时不提交，刷新目录失败不会清掉已有正文", async () => {
    const list = vi.spyOn(api, "listBusinessSkills").mockResolvedValue({ items: [skill] })
    const state = await panel(false)
    state.contentDraft = "草稿"
    const write = vi.spyOn(api, "updateBusinessSkill")
    await state.save()
    expect(write).not.toHaveBeenCalled()
    list.mockRejectedValue(new Error("服务不可用"))
    await state.load()
    expect(state.selected?.content).toBe("原方法")
    expect(state.contentDraft).toBe("草稿")
    expect(state.error).toBe("服务不可用")
  })
})
