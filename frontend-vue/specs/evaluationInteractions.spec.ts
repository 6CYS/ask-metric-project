import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createSSRApp,
  h,
  type Component,
  type ComponentInternalInstance,
  type ComponentPublicInstance,
} from "vue"
import { renderToString } from "vue/server-renderer"
import { createMemoryHistory, createRouter, RouterView } from "vue-router"
import EvaluationDatasetPanel from "../src/components/evaluation/EvaluationDatasetPanel.vue"
import EvaluationView from "../src/views/EvaluationView.vue"
import { evaluationApi } from "../src/lib/evaluationApi"
import type { DatasetInput, EvaluationDataset, EvaluationRun } from "../src/types/evaluation"
import { runFixture } from "./evaluationFixtures"

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

// 当前测试入口以 SSR 编译 Vue；直接调用真实组件处理器，桌面浮层与焦点另行验收。
function capture(app: ReturnType<typeof createSSRApp>, component: Component) {
  let instance: ComponentInternalInstance | undefined
  app.mixin({
    created(this: ComponentPublicInstance) {
      if (
        this.$.type === component ||
        this.$.type.__file === (component as { __file?: string }).__file
      )
        instance = this.$
    },
  })
  return () => {
    if (!instance) throw new Error("未捕获组件实例")
    const state: unknown = Reflect.get(instance, "setupState")
    if (!state || typeof state !== "object") throw new Error("组件缺少 setup 状态")
    return state as Record<string, unknown>
  }
}
type Editor = {
  open(dataset?: EvaluationDataset): void
  addGroup(): void
  removeGroup(index: number): void
  handleImport(event: Event): void
  confirmAction(): Promise<void>
  closeConfirmation(): void
  draft: DatasetInput
  pendingAction: object | null
  error: string
}
async function dirtyEditor() {
  const app = createSSRApp(EvaluationDatasetPanel as Component, {
    datasets: [runFixture().dataset],
    busy: false,
  })
  const captured = capture(app, EvaluationDatasetPanel as Component)
  await renderToString(app)
  const editor = captured() as Editor
  editor.open()
  editor.addGroup()
  return editor
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("问题集确认操作", () => {
  it("切换前保留草稿，取消不切换，确认后才打开目标问题集", async () => {
    const editor = await dirtyEditor()
    const draft = editor.draft
    editor.open(runFixture().dataset)
    expect(editor.pendingAction).not.toBeNull()
    expect(editor.draft).toBe(draft)
    editor.closeConfirmation()
    expect(editor.draft).toBe(draft)
    editor.open(runFixture().dataset)
    await editor.confirmAction()
    expect(editor.draft.name).toBe("隔离题集")
    expect(editor.draft.groups).toHaveLength(1)
  })
  it("移除会话先确认，取消保留，重复确认不会删除下一个会话", async () => {
    const editor = await dirtyEditor()
    editor.removeGroup(0)
    expect(editor.draft.groups).toHaveLength(2)
    editor.closeConfirmation()
    expect(editor.draft.groups).toHaveLength(2)
    const retainedId = editor.draft.groups[1]?.id
    editor.removeGroup(0)
    editor.draft.groups.reverse()
    await Promise.all([editor.confirmAction(), editor.confirmAction()])
    expect(editor.draft.groups).toHaveLength(1)
    expect(editor.draft.groups[0]?.id).toBe(retainedId)
  })
  it("导入取消不读取文件，确认只读取一次，失败保留原草稿并允许重试", async () => {
    const editor = await dirtyEditor()
    const draft = editor.draft
    const text = vi.fn().mockRejectedValue(new Error("文件读取失败"))
    const event = new Event("change")
    Object.defineProperty(event, "target", { value: { files: [{ size: 10, text }], value: "x" } })
    editor.handleImport(event)
    expect(text).not.toHaveBeenCalled()
    editor.closeConfirmation()
    expect(text).not.toHaveBeenCalled()
    editor.handleImport(event)
    await Promise.all([editor.confirmAction(), editor.confirmAction()])
    expect(text).toHaveBeenCalledTimes(1)
    expect(editor.error).toBe("文件读取失败")
    expect(editor.draft).toBe(draft)
    expect(editor.pendingAction).not.toBeNull()
    text.mockResolvedValue(JSON.stringify(runFixture().dataset))
    await editor.confirmAction()
    expect(text).toHaveBeenCalledTimes(2)
    expect(editor.draft.groups).toHaveLength(1)
  })
})

type ViewState = {
  state: { activate(): Promise<void>; deactivate(): void }
  datasetEditor: { isDirty(): boolean; deleted?(id: string): Promise<void> }
  changeTab(tab: string): void
  closeLeaveConfirmation(): void
  confirmLeave(): Promise<void>
  cancelRun(run: EvaluationRun): Promise<void> | void
  confirmCancelRun(): Promise<void>
  pendingCancelRun: EvaluationRun | null
  requestDeleteRun(run: EvaluationRun): void
  requestDeleteDataset(dataset: EvaluationDataset): void
  closeDelete(): void
  confirmDelete(): Promise<void>
  pendingDelete: { kind: "run" | "dataset"; value: EvaluationRun | EvaluationDataset } | null
  actionError: string
}
async function view() {
  const run = runFixture({ status: "running", finished_at: null })
  vi.spyOn(evaluationApi, "listDatasets").mockResolvedValue([run.dataset])
  vi.spyOn(evaluationApi, "listRuns").mockResolvedValue([run])
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/evaluations", name: "evaluations", component: EvaluationView as Component },
      { path: "/other", component: { render: () => h("p", "其他页面") } },
    ],
  })
  await router.push("/evaluations?tab=datasets")
  const app = createSSRApp(RouterView)
  app.use(router)
  const captured = capture(app, EvaluationView as Component)
  await renderToString(app)
  const state = captured() as ViewState
  await state.state.activate()
  return { state, router, run }
}

describe("测评页离开与停止确认", () => {
  it("批次删除必须确认，取消保留数据；失败保留弹窗，成功才关闭且不重复提交", async () => {
    const { state, run } = await view()
    const completed = { ...run, status: "completed" as const }
    const remove = vi.spyOn(evaluationApi, "deleteRun").mockRejectedValue(new Error("删除未完成"))
    try {
      state.requestDeleteRun(run)
      expect(state.pendingDelete).toBeNull()
      state.requestDeleteRun(completed)
      expect(remove).not.toHaveBeenCalled()
      state.closeDelete()
      expect(remove).not.toHaveBeenCalled()
      state.requestDeleteRun(completed)
      await Promise.all([state.confirmDelete(), state.confirmDelete()])
      expect(remove).toHaveBeenCalledTimes(1)
      expect(state.pendingDelete?.value.id).toBe(run.id)
      expect(state.actionError).toBe("删除未完成")
      remove.mockResolvedValue(undefined)
      await state.confirmDelete()
      expect(state.pendingDelete).toBeNull()
      expect(remove).toHaveBeenCalledTimes(2)
    } finally {
      state.state.deactivate()
    }
  })
  it("删除问题集只在确认后发送，取消不清除未保存草稿", async () => {
    const { state, run } = await view()
    const remove = vi.spyOn(evaluationApi, "deleteDataset").mockResolvedValue(undefined)
    try {
      state.datasetEditor = { isDirty: () => true, deleted: () => Promise.resolve() }
      state.requestDeleteDataset(run.dataset)
      state.closeDelete()
      expect(remove).not.toHaveBeenCalled()
      expect(state.datasetEditor.isDirty()).toBe(true)
      state.requestDeleteDataset(run.dataset)
      await state.confirmDelete()
      expect(remove).toHaveBeenCalledWith(run.dataset)
      expect(state.pendingDelete).toBeNull()
    } finally {
      state.state.deactivate()
    }
  })
  it("未保存草稿切换分区和离开路由都等待确认，取消保留原位置", async () => {
    const { state, router } = await view()
    try {
      state.datasetEditor = { isDirty: () => true }
      state.changeTab("compare")
      expect(router.currentRoute.value.query.tab).toBe("datasets")
      state.closeLeaveConfirmation()
      expect(router.currentRoute.value.query.tab).toBe("datasets")
      const rejected = router.push("/other")
      await vi.waitFor(() => expect(router.currentRoute.value.path).toBe("/evaluations"))
      await new Promise((resolve) => setTimeout(resolve, 0))
      state.closeLeaveConfirmation()
      await rejected
      expect(router.currentRoute.value.path).toBe("/evaluations")
      const accepted = router.push("/other")
      await new Promise((resolve) => setTimeout(resolve, 0))
      await state.confirmLeave()
      await accepted
      expect(router.currentRoute.value.path).toBe("/other")
    } finally {
      state.state.deactivate()
    }
  })
  it("停止失败保留确认与错误，重复点击不重发，成功才关闭", async () => {
    const { state, run } = await view()
    try {
      const cancel = vi
        .spyOn(evaluationApi, "cancelRun")
        .mockRejectedValue(new Error("停止服务不可用"))
      await state.cancelRun(run)
      expect(cancel).not.toHaveBeenCalled()
      await Promise.all([state.confirmCancelRun(), state.confirmCancelRun()])
      expect(cancel).toHaveBeenCalledTimes(1)
      expect(state.actionError).toBe("停止服务不可用")
      expect(state.pendingCancelRun?.id).toBe(run.id)
      cancel.mockResolvedValue({ ...run, status: "cancelled" })
      await state.confirmCancelRun()
      expect(cancel).toHaveBeenCalledTimes(2)
      expect(state.pendingCancelRun).toBeNull()
    } finally {
      state.state.deactivate()
    }
  })
})
