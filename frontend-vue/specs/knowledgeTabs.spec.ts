import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createSSRApp,
  type Component,
  type ComponentInternalInstance,
  type ComponentPublicInstance,
} from "vue"
import { renderToString } from "vue/server-renderer"
import { createMemoryHistory, createRouter } from "vue-router"
import KnowledgeView from "../src/views/KnowledgeView.vue"
import * as api from "../src/lib/api"
import type { BusinessKnowledgeForm } from "../src/lib/businessKnowledge"
import type { BusinessKnowledgeItem } from "../src/types/api"

vi.mock("../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api")>()),
  listBusinessKnowledge: vi.fn(),
}))

vi.mock("@/components/AppShell.vue", async () => {
  const { defineComponent, h } = await import("vue")
  return {
    default: defineComponent({
      setup:
        (_, { slots }) =>
        () =>
          h("main", slots.default?.()),
    }),
  }
})

const entries: BusinessKnowledgeItem[] = [
  { id: "knowledge", title: "贷款口径", text: "口径说明", enabled: true, updated_at: null },
  {
    id: "plan",
    title: "贷款质量查询",
    text: "查询指标组合",
    enabled: true,
    batch_query_enabled: true,
    metric_codes: ["LOAN"],
    updated_at: null,
  },
  {
    id: "disabled-plan",
    title: "停用的查询方案",
    text: "已有方案",
    enabled: false,
    batch_query_enabled: true,
    metric_codes: ["LOAN"],
    updated_at: null,
  },
]
type ViewState = {
  load(): Promise<boolean>
  applyRouteSelection(): void
  changeTab(value: string): Promise<void>
  createKnowledge(): void
  activeTab: string
  visibleItems: BusinessKnowledgeItem[]
  tabItems: BusinessKnowledgeItem[]
  listDescription: string
  showDisabled: boolean
  searchKeyword: string
  page: number
  form: BusinessKnowledgeForm
  editorOpen: boolean
  editingId: string | null
  notice: { item: BusinessKnowledgeItem; action: "saved" | "enabled" | "disabled" } | null
  noticeHint: string
  viewingItem: BusinessKnowledgeItem | null
  showNoticeDetails(): void
  showDetails(item: BusinessKnowledgeItem): void
  editDetails(item: BusinessKnowledgeItem): void
}

async function view(path = "/knowledge") {
  vi.mocked(api.listBusinessKnowledge).mockResolvedValue({
    items: structuredClone(entries),
    revision: "r1",
  })
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/knowledge", name: "knowledge", component: KnowledgeView as Component }],
  })
  await router.push(path)
  const app = createSSRApp(KnowledgeView as Component).use(router)
  let instance: ComponentInternalInstance | undefined
  app.mixin({
    created(this: ComponentPublicInstance) {
      if (this.$.type.__file === (KnowledgeView as { __file?: string }).__file) instance = this.$
    },
  })
  await renderToString(app)
  if (!instance) throw new Error("未找到知识页面")
  const state = Reflect.get(instance, "setupState") as ViewState
  expect(await state.load()).toBe(true)
  state.applyRouteSelection()
  return { state, router }
}

afterEach(() => vi.restoreAllMocks())

describe("知识与查询方案分类管理", () => {
  it("保存内容被筛选隐藏时解释原因，查看详情不清空筛选或进入编辑", async () => {
    const { state } = await view("/knowledge?tab=plans")
    state.searchKeyword = "其他内容"
    state.notice = { item: entries[1]!, action: "saved" }
    expect(state.noticeHint).toContain("搜索")
    state.showNoticeDetails()
    expect(state.viewingItem?.id).toBe("plan")
    expect(state.searchKeyword).toBe("其他内容")
    expect(state.editorOpen).toBe(false)
    state.editDetails(state.viewingItem!)
    expect(state.viewingItem).toBeNull()
    expect(state.editingId).toBe("plan")
  })

  it("停用条目可从反馈查看，缺失内容不会展示过期快照", async () => {
    const { state } = await view("/knowledge?tab=plans")
    state.notice = { item: entries[2]!, action: "disabled" }
    expect(state.noticeHint).toContain("已停用")
    state.showNoticeDetails()
    expect(state.viewingItem?.id).toBe("disabled-plan")
    state.viewingItem = null
    state.notice = { item: { ...entries[2]!, id: "removed" }, action: "saved" }
    state.showNoticeDetails()
    expect(state.viewingItem).toBeNull()
  })

  it("默认只显示知识，方案包含停用条目且计数独立", async () => {
    const { state } = await view()
    expect(state.visibleItems.map((item) => item.id)).toEqual(["knowledge"])
    state.page = 4
    state.searchKeyword = "口径"
    await state.changeTab("plans")
    expect(state.visibleItems.map((item) => item.id)).toEqual(["plan"])
    expect(state.tabItems.map((item) => item.id)).toEqual(["plan", "disabled-plan"])
    expect(state.listDescription).toContain("共 2 条")
    expect(state.page).toBe(1)
    expect(state.searchKeyword).toBe("")
    state.showDisabled = true
    expect(state.visibleItems.map((item) => item.id)).toEqual(["plan", "disabled-plan"])
  })

  it("切换保留指标筛选并写入URL，刷新仍定位方案", async () => {
    const { state, router } = await view("/knowledge?metric=LOAN")
    await state.changeTab("plans")
    expect(router.currentRoute.value.query).toEqual({ metric: "LOAN", tab: "plans" })
    expect(state.visibleItems.map((item) => item.id)).toEqual(["plan"])
    const reloaded = await view(router.currentRoute.value.fullPath)
    expect(reloaded.state.activeTab).toBe("plans")
  })

  it("编辑深链按条目类别定位，刷新不会覆盖正在编辑的草稿", async () => {
    const { state } = await view("/knowledge?edit=disabled-plan")
    expect(state.activeTab).toBe("plans")
    expect(state.editingId).toBe("disabled-plan")
    state.form.text = "尚未保存的说明"
    state.applyRouteSelection()
    expect(state.form.text).toBe("尚未保存的说明")
  })

  it("新增入口保存类别，弹窗打开时不允许切换改变草稿", async () => {
    const { state } = await view("/knowledge?tab=plans")
    state.createKnowledge()
    expect(state.form.batch_query_enabled).toBe(true)
    await state.changeTab("knowledge")
    expect(state.activeTab).toBe("plans")
    expect(state.form.batch_query_enabled).toBe(true)
    state.editorOpen = false
    await state.changeTab("knowledge")
    state.createKnowledge()
    expect(state.form.batch_query_enabled ?? false).toBe(false)
  })
})
