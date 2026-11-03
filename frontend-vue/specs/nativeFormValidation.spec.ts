import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createSSRApp,
  type Component,
  type ComponentInternalInstance,
  type ComponentPublicInstance,
} from "vue"
import { renderToString } from "vue/server-renderer"

import BaseDisclosure from "../src/components/ui/BaseDisclosure.vue"
import { parseDatasetInput } from "../src/lib/evaluation"
import EvaluationDatasetPanel from "../src/components/evaluation/EvaluationDatasetPanel.vue"
import EvaluationRunDialog from "../src/components/evaluation/EvaluationRunDialog.vue"
import BusinessKnowledgeEditor from "../src/components/knowledge/BusinessKnowledgeEditor.vue"
import MetricRelationEditor from "../src/components/metrics/MetricRelationEditor.vue"
import { useKnowledgeManagement } from "../src/composables/useKnowledgeManagement"
import * as api from "../src/lib/api"
import type { BusinessKnowledgeForm } from "../src/lib/businessKnowledge"
import type { RelationForm } from "../src/lib/metricRelationships"
import type { MetricRelationWriteResult } from "../src/types/metricRelationships"
import type { DatasetInput, EvaluationDataset, RunInput } from "../src/types/evaluation"
import { runFixture } from "./evaluationFixtures"

// Portal 与桌面焦点在浏览器验收；这里渲染真实表单并运行业务提交处理器。
vi.mock("../src/components/ui/BaseModal.vue", async () => {
  const { defineComponent, h } = await import("vue")
  return {
    default: defineComponent({
      setup:
        (_, { slots }) =>
        () =>
          h("section", [slots.default?.(), slots.footer?.()]),
    }),
  }
})

async function renderForm<T>(
  component: Component,
  props: Record<string, unknown>,
  initialize?: (state: T) => void,
) {
  let captured: ComponentInternalInstance | undefined
  const app = createSSRApp(component, props)
  app.mixin({
    created(this: ComponentPublicInstance) {
      if (
        this.$.type !== component &&
        this.$.type.__file !== (component as { __file?: string }).__file
      )
        return
      captured = this.$
      initialize?.(Reflect.get(this.$, "setupState") as T)
    },
  })
  const html = await renderToString(app)
  if (!captured) throw new Error("未捕获表单组件")
  return { html, state: Reflect.get(captured, "setupState") as T }
}

type DatasetEditor = {
  open(dataset?: EvaluationDataset): void
  save(): Promise<void>
  draft: DatasetInput
  error: string
}
type RunEditor = {
  datasetId: string
  name: string
  versionLabel: string
  dataLabel: string
  start(): Promise<void>
  validationError: string
}
type RelationEditor = { form: RelationForm; save(): Promise<void>; error: string }
const knowledgeForm = (): BusinessKnowledgeForm => ({
  title: "隔离知识",
  text: "仅作校验测试",
  enabled: true,
  metric_codes: [],
})
const runProps = () => ({
  open: true,
  datasets: [runFixture().dataset],
  initialDatasetId: "dataset-a",
  busy: false,
  blocked: false,
  error: "",
})
const relationProps = () => ({
  open: true,
  relation: null,
  parent: "TOTAL",
  revision: "r1",
  metrics: [],
})

afterEach(() => vi.restoreAllMocks())

describe("表单使用统一业务校验", () => {
  it("多个字段为空时按页面顺序先提示问题集名称", () => {
    const dataset = structuredClone(runFixture().dataset)
    dataset.name = ""
    dataset.groups[0]!.turns[0]!.question = ""
    expect(() => parseDatasetInput(dataset)).toThrow("问题集名称")
  })

  it("四个表单关闭浏览器校验气泡并保留必填语义", async () => {
    const forms = [
      await renderForm<DatasetEditor>(
        EvaluationDatasetPanel as Component,
        { datasets: [], busy: false },
        (editor) => editor.open(runFixture().dataset),
      ),
      await renderForm(EvaluationRunDialog as Component, runProps()),
      await renderForm(MetricRelationEditor as Component, relationProps()),
      await renderForm(BusinessKnowledgeEditor as Component, {
        open: true,
        modelValue: knowledgeForm(),
        metrics: [],
      }),
    ]
    for (const { html } of forms) {
      expect(html).toMatch(/<form\b[^>]*\bnovalidate(?:="")?/)
      expect(html).toMatch(/(?:\brequired\b|aria-required="true")/)
    }
  })

  it.each(["name", "group", "question"] as const)("问题集拒绝空白%s且不发出保存", async (field) => {
    const saved = vi.fn()
    const { state } = await renderForm<DatasetEditor>(
      EvaluationDatasetPanel as Component,
      { datasets: [], busy: false, onSave: saved },
      (editor) => editor.open(runFixture().dataset),
    )
    if (field === "name") state.draft.name = " "
    else if (field === "group") state.draft.groups[0]!.name = " "
    else state.draft.groups[0]!.turns[0]!.question = " "
    await state.save()
    expect(saved).not.toHaveBeenCalled()
    expect(state.error).toContain("不能为空")
  })

  it.each([
    { field: "name" as const, value: "字".repeat(121) },
    { field: "description" as const, value: "字".repeat(2001) },
  ])("问题集拒绝超长$field且不发出保存", async ({ field, value }) => {
    const saved = vi.fn()
    const { state } = await renderForm<DatasetEditor>(
      EvaluationDatasetPanel as Component,
      { datasets: [], busy: false, onSave: saved },
      (editor) => editor.open(runFixture().dataset),
    )
    state.draft[field] = value
    await state.save()
    expect(saved).not.toHaveBeenCalled()
    expect(state.error).toContain("不能超过")
  })

  it("有效问题集仍保存原分组、轮次与人工期望", async () => {
    const saved = vi.fn()
    const { state } = await renderForm<DatasetEditor>(
      EvaluationDatasetPanel as Component,
      { datasets: [], busy: false, onSave: saved },
      (editor) => editor.open(runFixture().dataset),
    )
    await state.save()
    expect(state.error).toBe("")
    expect(saved).toHaveBeenCalledWith(
      {
        name: "隔离题集",
        description: "仅供单元测试",
        groups: [
          {
            id: "group-a",
            name: "连续会话",
            turns: [{ id: "turn-a", question: "首问", expected: "业务确认" }],
          },
        ],
      },
      runFixture().dataset,
    )
  })

  it("问题集允许UI长度边界，历史解码仍兼容服务端200字名称", async () => {
    const saved = vi.fn()
    const { state } = await renderForm<DatasetEditor>(
      EvaluationDatasetPanel as Component,
      { datasets: [], busy: false, onSave: saved },
      (editor) => editor.open(runFixture().dataset),
    )
    state.draft.name = "字".repeat(120)
    state.draft.description = "字".repeat(2000)
    await state.save()
    expect(state.error).toBe("")
    expect(saved).toHaveBeenCalledTimes(1)
    const historical = { ...runFixture().dataset, name: "字".repeat(200) }
    expect(parseDatasetInput(historical).name).toHaveLength(200)
  })

  it.each([
    { name: " ", versionLabel: "", dataLabel: "", message: "批次名称" },
    { name: "字".repeat(121), versionLabel: "", dataLabel: "", message: "120" },
    { name: "批次", versionLabel: "字".repeat(201), dataLabel: "", message: "200" },
    { name: "批次", versionLabel: "", dataLabel: "字".repeat(1001), message: "1000" },
  ])("测评批次拒绝无效输入：$message", async (change) => {
    const started = vi.fn<(input: RunInput) => void>()
    const { state } = await renderForm<RunEditor>(EvaluationRunDialog as Component, {
      ...runProps(),
      onStart: started,
    })
    Object.assign(state, change, { datasetId: "dataset-a" })
    await state.start()
    expect(started).not.toHaveBeenCalled()
    expect(state.validationError).toContain(change.message)
  })

  it("测评批次恢复有效输入后清除校验错误并携带冻结版本", async () => {
    const started = vi.fn<(input: RunInput) => void>()
    const { state } = await renderForm<RunEditor>(EvaluationRunDialog as Component, {
      ...runProps(),
      onStart: started,
    })
    state.datasetId = "dataset-a"
    await state.start()
    state.name = " 批次 "
    state.versionLabel = " v1 "
    state.dataLabel = " 条件 "
    await state.start()
    expect(state.validationError).toBe("")
    expect(started).toHaveBeenCalledExactlyOnceWith({
      dataset_id: "dataset-a",
      dataset_version: 1,
      name: "批次",
      version_label: "v1",
      data_label: "条件",
    })
  })

  it.each([{ busy: true }, { blocked: true }, { datasets: [] }])(
    "测评不可发起时不会提交 %j",
    async (change) => {
      const started = vi.fn()
      const { state } = await renderForm<RunEditor>(EvaluationRunDialog as Component, {
        ...runProps(),
        ...change,
        onStart: started,
      })
      state.datasetId = "dataset-a"
      state.name = "有效名称"
      await state.start()
      expect(started).not.toHaveBeenCalled()
      if ("datasets" in change) expect(state.validationError).toContain("问题集")
    },
  )

  it("关系说明允许2000字边界，保存继续携带选中指标与打开时版本", async () => {
    const source = "字".repeat(2000)
    const result: MetricRelationWriteResult = {
      item: {
        id: "relation-a",
        kind: "classification",
        status: "draft",
        parent: "TOTAL",
        children: ["PART"],
        source,
        origin: "managed",
        editable: true,
      },
      revision: "r2",
    }
    const request = vi.spyOn(api, "createMetricRelationship").mockResolvedValue(result)
    const saved = vi.fn()
    const { state } = await renderForm<RelationEditor>(MetricRelationEditor as Component, {
      ...relationProps(),
      onSaved: saved,
    })
    state.form.children = ["PART"]
    state.form.source = source
    await state.save()
    expect(request).toHaveBeenCalledExactlyOnceWith({
      kind: "classification",
      parent: "TOTAL",
      children: ["PART"],
      source,
      status: "draft",
      revision: "r1",
    })
    expect(saved).toHaveBeenCalledExactlyOnceWith(result)
    expect(state.error).toBe("")
  })

  it.each(["", " ", "字".repeat(2001)])(
    "关系说明无效时保留草稿与业务错误，且不请求网络",
    async (source) => {
      const request = vi
        .spyOn(api, "createMetricRelationship")
        .mockRejectedValue(new Error("不应到达网络"))
      const { state } = await renderForm<RelationEditor>(
        MetricRelationEditor as Component,
        relationProps(),
      )
      state.form.children = ["PART"]
      state.form.source = source
      await state.save()
      expect(request).not.toHaveBeenCalled()
      expect(state.form.source).toBe(source)
      expect(state.error).toMatch(/关系说明|2000/)
    },
  )

  it.each([
    { title: " " },
    { text: " " },
    { title: "字".repeat(201) },
    { text: "字".repeat(8001) },
  ])("知识父级拒绝无效正文且不请求网络 %j", async (change) => {
    const create = vi.fn()
    const update = vi.fn()
    const state = useKnowledgeManagement({
      list: () => Promise.resolve({ items: [], revision: "r1" }),
      create,
      update,
      setEnabled: vi.fn(),
    })
    await state.load()
    state.openCreate()
    Object.assign(state.form.value, knowledgeForm(), change)
    expect(await state.save()).toBe(false)
    expect(state.editorOpen.value).toBe(true)
    expect(state.formError.value).not.toBe("")
    expect(create).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })
})

describe("表单折叠内容", () => {
  it("相关指标在实际展开时加载，收起不加载，并保留再次展开刷新", async () => {
    const loaded = vi.fn()
    let updateDisclosure: ((open: boolean) => void) | undefined
    const app = createSSRApp(BusinessKnowledgeEditor as Component, {
      open: true,
      modelValue: knowledgeForm(),
      metrics: [],
      onLoadMetrics: loaded,
    })
    app.mixin({
      created(this: ComponentPublicInstance) {
        if (this.$.type.__file === (BaseDisclosure as Component & { __file?: string }).__file)
          updateDisclosure = (open) => this.$emit("update:open", open)
      },
    })
    await renderToString(app)
    expect(loaded).not.toHaveBeenCalled()
    if (!updateDisclosure) throw new Error("未渲染公共折叠组件")
    updateDisclosure(true)
    expect(loaded).toHaveBeenCalledTimes(1)
    updateDisclosure(false)
    expect(loaded).toHaveBeenCalledTimes(1)
    updateDisclosure(true)
    expect(loaded).toHaveBeenCalledTimes(2)
  })
  it("稳定身份与相关指标使用公共折叠按钮", async () => {
    const dataset = await renderForm<DatasetEditor>(
      EvaluationDatasetPanel as Component,
      { datasets: [], busy: false },
      (editor) => editor.open(runFixture().dataset),
    )
    const knowledge = await renderForm(BusinessKnowledgeEditor as Component, {
      open: true,
      modelValue: knowledgeForm(),
      metrics: [],
    })
    for (const { html } of [dataset, knowledge]) {
      expect(html).not.toMatch(/<(?:details|summary)\b/)
      expect(html).toContain('aria-expanded="false"')
    }
  })
})
