import { describe, expect, it } from "vitest"
import { createSSRApp, defineComponent, h, type Component } from "vue"
import { renderToString } from "vue/server-renderer"
import { PopoverContent, PopoverRoot, PopoverTrigger } from "reka-ui"
import BaseTooltip from "../src/components/ui/BaseTooltip.vue"

// SFC 的实际类型由 vue-tsc 检查，SSR 用统一 Component 类型创建测试视图。
const tooltip = BaseTooltip as Component

describe("统一操作提示", () => {
  it("独立渲染无需外部 Provider，并保留按钮、标签和样式", async () => {
    const view = defineComponent(
      () => () =>
        h(
          tooltip,
          { content: "复制回答" },
          {
            default: () =>
              h(
                "button",
                { type: "button", class: "copy-action", "aria-label": "复制回答" },
                "复制",
              ),
          },
        ),
    )
    const html = await renderToString(createSSRApp(view))
    expect(html.match(/<button\b/g)).toHaveLength(1)
    expect(html).toContain('class="copy-action"')
    expect(html).toContain('aria-label="复制回答"')
    expect(html).not.toMatch(/\btitle=/)
  })

  it("说明为空时保留禁用按钮及承载键盘提示的容器", async () => {
    const view = defineComponent(
      () => () =>
        h(
          tooltip,
          { content: undefined },
          {
            default: () =>
              h("span", { tabindex: 0, "aria-disabled": "true" }, [
                h("button", { type: "submit", disabled: true }, "发送"),
              ]),
          },
        ),
    )
    const html = await renderToString(createSSRApp(view))
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('aria-disabled="true"')
    expect(html).toMatch(/<button[^>]*disabled/)
    expect(html).not.toContain('role="tooltip"')
  })

  it("提示与会话操作浮层组合时仍只渲染原按钮", async () => {
    const view = defineComponent(
      () => () =>
        h(
          PopoverRoot,
          {},
          {
            default: () => [
              h(
                tooltip,
                { content: "会话操作" },
                {
                  default: () =>
                    h(
                      PopoverTrigger,
                      { asChild: true },
                      {
                        default: () =>
                          h("button", { type: "button", "aria-label": "会话操作" }, "操作"),
                      },
                    ),
                },
              ),
              h(PopoverContent, {}, { default: () => "修改名称" }),
            ],
          },
        ),
    )
    const html = await renderToString(createSSRApp(view))
    expect(html.match(/<button\b/g)).toHaveLength(1)
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).toContain('aria-label="会话操作"')
  })
})
