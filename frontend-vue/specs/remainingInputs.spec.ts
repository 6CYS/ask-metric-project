import { renderToString } from "@vue/server-renderer"
import { createSSRApp, h, type Component, type ComponentPublicInstance, type Slots } from "vue"
import { describe, expect, it, vi } from "vitest"
import MetricPicker from "../src/components/metrics/MetricPicker.vue"
import EvaluationTurnDetail from "../src/components/evaluation/EvaluationTurnDetail.vue"
import LlmView from "../src/views/LlmView.vue"
import type { MetricItem, ModelEndpointConfig, ModelRuntimeConfig } from "../src/types/api"
import { runFixture } from "./evaluationFixtures"

vi.mock("@/components/AppShell.vue", () => ({
  default: {
    setup:
      (_: unknown, { slots }: { slots: Slots }) =>
      () =>
        h("main", slots.default?.()),
  },
}))

function setupState(instance: ComponentPublicInstance): Record<string, unknown> {
  return Reflect.get(instance.$, "setupState") as Record<string, unknown>
}

function endpoint(): ModelEndpointConfig {
  return {
    enabled: true,
    base_url: "",
    path: "/v1/test",
    model: "isolated-test",
    send_model: true,
    api_key_env: "",
    authentication: { type: "none", header: "", prefix: "" },
    timeout_seconds: 60,
    extra_body: {},
  }
}

function modelConfig(): ModelRuntimeConfig {
  return {
    schema_version: 2,
    provider: "isolated-test",
    models: {
      chat: {
        ...endpoint(),
        temperature: 0.15,
        max_tokens: null,
        response_format: "text",
        send_response_format: false,
        enable_thinking: false,
        send_enable_thinking: false,
        user_message_suffix: "",
        chat_template_kwargs: { enable_thinking: false },
      },
      embedding: { ...endpoint(), dimensions: null, encoding_format: "float", user: null },
      reranker: {
        ...endpoint(),
        top_n: 20,
        return_documents: false,
        send_top_n: true,
        send_return_documents: false,
        documents_field: "documents",
      },
    },
  }
}

const item = (code: string): MetricItem => ({
  metric_code: code,
  metric_name: `指标${code}`,
  unit: "元",
  enabled: true,
  synonyms: [],
  metric_explanation: "",
  description: "",
})

describe("剩余统一输入控件集成", () => {
  it("指标候选使用自定义复选框，保留选中和上限禁用语义", async () => {
    const html = await renderToString(
      createSSRApp(MetricPicker as Component, {
        modelValue: ["A", "B"],
        items: [item("A"), item("B"), item("C")],
        maxSelections: 2,
      }),
    )
    const checkboxes = html.match(/<button\b[^>]*role="checkbox"[^>]*>/g) ?? []
    expect(checkboxes).toHaveLength(3)
    expect(checkboxes[0]).toContain('aria-checked="true"')
    expect(checkboxes[2]).toMatch(/\bdisabled\b/)
    expect(checkboxes[2]).toContain('aria-label="指标C"')
    expect(html).not.toMatch(/<input[^>]*type="checkbox"/)
  })

  it("人工复核使用具名互斥组，未完成轮次整体禁用且不会提前展开回执", async () => {
    const turn = runFixture().turns[0]
    if (!turn) throw new Error("隔离轮次缺失")
    const html = await renderToString(
      createSSRApp(EvaluationTurnDetail as Component, {
        detail: { turn: { ...turn, status: "running" }, messages: [] },
        loading: false,
        error: "",
        busy: false,
      }),
    )
    expect(html).toContain('role="radiogroup"')
    expect(html).toContain('aria-label="人工复核结论"')
    const radios = html.match(/<button\b[^>]*role="radio"[^>]*>/g) ?? []
    expect(radios).toHaveLength(3)
    for (const radio of radios) expect(radio).toMatch(/\bdisabled\b/)
    expect(html).not.toContain("<details")
    expect(html).not.toContain("evaluation-metadata")
  })

  it("模型配置统一七个数值输入，保留小数、空值、整数与边界", async () => {
    const app = createSSRApp(LlmView as Component)
    app.mixin({
      created(this: ComponentPublicInstance) {
        if (this.$.type.__file !== (LlmView as { __file?: string }).__file) return
        const state = setupState(this)
        const setModelDraft = state.setModelDraft as (config: ModelRuntimeConfig) => void
        setModelDraft(modelConfig())
        state.isLoading = false
      },
    })
    const html = await renderToString(app)
    const fields = html.match(/<input\b[^>]*role="spinbutton"[^>]*>/g) ?? []
    expect(fields).toHaveLength(7)
    expect(fields.filter((field) => field.includes('aria-valuemax="600"'))).toHaveLength(3)
    const temperature = fields.find((field) => field.includes('aria-label="Temperature"'))
    expect(temperature).toContain('aria-valuenow="0.15"')
    expect(temperature).toContain('value="0.15"')
    const optional = fields.find((field) => field.includes('aria-label="向量维度（可留空）"'))
    expect(optional).toMatch(/\bvalue(?:="")?\s/)
    expect(optional).not.toContain("aria-valuenow")
    expect(html).toContain('aria-label="增加"')
    expect(html).toContain('aria-label="减少"')
    expect(html).not.toMatch(/type="number"/)
  })
})
