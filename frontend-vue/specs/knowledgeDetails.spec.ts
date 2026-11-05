import { describe, expect, it, vi } from "vitest"
import { createSSRApp, type Component } from "vue"
import { renderToString } from "vue/server-renderer"
import { createMemoryHistory, createRouter } from "vue-router"
import BusinessKnowledgeDetails from "../src/components/knowledge/BusinessKnowledgeDetails.vue"
import type { BusinessKnowledgeItem } from "../src/types/api"

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

async function render(item: BusinessKnowledgeItem | null) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/metrics", component: { template: "<div />" } }],
  })
  await router.push("/metrics")
  return renderToString(
    createSSRApp(BusinessKnowledgeDetails as Component, {
      item,
      metrics: [
        {
          metric_code: "A",
          metric_name: "贷款余额",
          enabled: true,
          unit: "元",
          synonyms: [],
          description: "",
          metric_explanation: "",
        },
      ],
    }).use(router),
  )
}

const knowledge: BusinessKnowledgeItem = {
  id: "k1",
  title: "完整知识标题",
  text: "第一行\n<script>不执行</script>",
  enabled: true,
  updated_at: null,
}

describe("知识与查询方案只读详情", () => {
  it("完整显示正文并转义内容，不提供编辑表单", async () => {
    const html = await render(knowledge)
    expect(html).toContain("完整知识标题")
    expect(html).toContain("第一行\n&lt;script&gt;不执行&lt;/script&gt;")
    expect(html).toContain("whitespace-pre-wrap")
    expect(html).toContain("已启用")
    expect(html).toContain("相关指标（选填）")
    expect(html).toContain("无需关联指标")
    expect(html).not.toContain("<textarea")
    expect(html).toContain("编辑知识")
  })
  it("方案保留停用状态并完整显示已知和未知指标及跳转链接", async () => {
    const html = await render({
      ...knowledge,
      enabled: false,
      batch_query_enabled: true,
      metric_codes: ["A", "UNKNOWN"],
    })
    expect(html).toContain("已停用")
    expect(html).toContain("查询指标")
    expect(html).toContain("贷款余额")
    expect(html).toContain("UNKNOWN")
    expect(html).toContain('href="/metrics?metric=A"')
    expect(html).toContain('href="/metrics?metric=UNKNOWN"')
    expect(html).toContain("编辑方案")
  })
  it("无条目时不呈现详情", async () => {
    expect(await render(null)).not.toContain("编辑知识")
  })
})
