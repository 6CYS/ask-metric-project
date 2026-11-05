import { describe, expect, it, vi } from "vitest"
import { effectScope, nextTick, reactive, type Component } from "vue"
import BusinessKnowledgeEditor from "../src/components/knowledge/BusinessKnowledgeEditor.vue"

import { useKnowledgeEditorState } from "../src/composables/useKnowledgeEditorState"

function setup(plan = false, editing = false) {
  const props = reactive({
    open: true,
    busy: false,
    editing,
    resetKey: 0,
    modelValue: {
      title: "标题",
      text: "正文",
      enabled: true,
      metric_codes: [] as string[],
      batch_query_enabled: plan,
    },
  })
  const close = vi.fn()
  const loadMetrics = vi.fn()
  const scope = effectScope()
  const state = scope.run(() => useKnowledgeEditorState(props, close, loadMetrics))!
  return { props, state, close, loadMetrics, stop: () => scope.stop() }
}

describe("知识编辑退出与指标选择", () => {
  it("未修改直接关闭，任意关闭入口统一确认，继续编辑保留输入", () => {
    const context = setup()
    context.state.requestClose(false)
    expect(context.close).toHaveBeenCalledOnce()
    context.close.mockClear()
    context.props.modelValue.title = "修改后的标题"
    context.state.requestClose(false)
    expect(context.close).not.toHaveBeenCalled()
    expect(context.state.discardOpen.value).toBe(true)
    context.state.discardOpen.value = false
    expect(context.props.modelValue.title).toBe("修改后的标题")
    context.state.requestClose(false)
    context.state.discard()
    expect(context.close).toHaveBeenCalledOnce()
    context.stop()
  })

  it("重读成功显式重置基线，父级保存关闭不触发确认，下次打开重建快照", async () => {
    const context = setup(true)
    context.props.modelValue.text = "草稿"
    context.state.requestClose(false)
    expect(context.state.discardOpen.value).toBe(true)
    context.props.modelValue.text = "服务器最新正文"
    context.props.resetKey++
    await nextTick()
    context.state.requestClose(false)
    expect(context.close).toHaveBeenCalledOnce()
    context.props.modelValue.text = "已保存"
    context.props.open = false
    await nextTick()
    expect(context.state.discardOpen.value).toBe(false)
    context.props.open = true
    await nextTick()
    context.close.mockClear()
    context.state.requestClose(false)
    expect(context.close).toHaveBeenCalledOnce()
    context.stop()
  })

  it("保存中拒绝关闭；新建方案展开加载，旧方案和普通知识按需展开", () => {
    const plan = setup(true)
    expect(plan.state.expanded.value).toBe(true)
    expect(plan.loadMetrics).toHaveBeenCalledOnce()
    plan.props.busy = true
    plan.state.requestClose(false)
    expect(plan.close).not.toHaveBeenCalled()
    for (const context of [setup(false), setup(true, true)]) {
      expect(context.state.expanded.value).toBe(false)
      expect(context.loadMetrics).not.toHaveBeenCalled()
      context.state.toggleMetrics(true)
      expect(context.loadMetrics).toHaveBeenCalledOnce()
      context.stop()
    }
    plan.stop()
  })
})

vi.mock("../src/components/ui/BaseModal.vue", async () => {
  const { defineComponent, h } = await import("vue")
  return {
    default: defineComponent({
      props: { open: Boolean },
      setup:
        (props, { slots }) =>
        () =>
          props.open ? h("section", slots.default?.()) : null,
    }),
  }
})

it("新建方案展示指标选择及限额", async () => {
  const { createSSRApp } = await import("vue")
  const { renderToString } = await import("vue/server-renderer")
  const Editor = BusinessKnowledgeEditor as Component
  const html = await renderToString(
    createSSRApp(Editor, {
      open: true,
      editing: false,
      modelValue: {
        title: "方案",
        text: "场景",
        enabled: true,
        batch_query_enabled: true,
        metric_codes: [],
      },
      metrics: [],
    }),
  )
  expect(html).toContain("已选 0/24")
  expect(html).toContain("请至少选择 1 个查询指标后保存")
  expect(html).toContain("搜索指标名称、编号或同义词")
})
