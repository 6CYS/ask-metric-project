import { renderToString } from "@vue/server-renderer"
import { createSSRApp, h } from "vue"
import { describe, expect, it } from "vitest"

import BaseDisclosure from "../src/components/ui/BaseDisclosure.vue"

function renderDisclosure(props = {}) {
  return renderToString(
    createSSRApp({
      render: () =>
        h(BaseDisclosure, props, {
          trigger: () => "查看来源",
          default: () => h("p", "已保存的数据来源"),
        }),
    }),
  )
}

describe("统一折叠区", () => {
  it("默认收起提供可访问按钮，内容在展开前不挂载", async () => {
    const html = await renderDisclosure()

    expect(html).toMatch(/<button\b[^>]*type="button"[^>]*>/)
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain("查看来源")
    expect(html).not.toContain("已保存的数据来源")
    expect(html).not.toMatch(/<(?:details|summary)\b/)
  })

  it.each([{ defaultOpen: true }, { open: true }])(
    "默认展开或受控展开均保留内容与展开语义：%j",
    async (props) => {
      const html = await renderDisclosure(props)

      expect(html).toContain('aria-expanded="true"')
      expect(html).toContain("已保存的数据来源")
      expect(html).toContain("rotate-90")
    },
  )

  it("受控关闭优先于默认展开", async () => {
    const html = await renderDisclosure({ open: false, defaultOpen: true })

    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain("已保存的数据来源")
  })

  it("禁用落到按钮，布局属性与触发器样式保留在指定位置", async () => {
    const html = await renderDisclosure({
      disabled: true,
      id: "source-disclosure",
      class: "consumer-layout",
      triggerClass: "consumer-trigger",
    })

    expect(html).toMatch(/<div\b[^>]*id="source-disclosure"[^>]*>/)
    expect(html).toMatch(/<div\b[^>]*class="[^"]*consumer-layout[^"]*"[^>]*>/)
    expect(html).toMatch(/<button\b[^>]*class="[^"]*consumer-trigger[^"]*"[^>]*>/)
    expect(html).toMatch(/<button\b[^>]*\bdisabled[^>]*>/)
  })
})
