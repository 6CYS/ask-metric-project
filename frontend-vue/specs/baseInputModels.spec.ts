import { renderToString } from "@vue/server-renderer"
import { injectNumberFieldRootContext, NumberFieldInput } from "reka-ui"
import {
  createSSRApp,
  h,
  type Component,
  type ComponentInternalInstance,
  type ComponentPublicInstance,
} from "vue"
import { describe, expect, it, vi } from "vitest"
import BaseCheckbox from "../src/components/ui/BaseCheckbox.vue"
import BaseNumberField from "../src/components/ui/BaseNumberField.vue"
import BaseRadioGroup from "../src/components/ui/BaseRadioGroup.vue"

// SSR 运行真实 Reka 输入解析与模型事件；DOM 键盘和焦点由桌面验收覆盖。
async function numberField(props: Record<string, unknown>) {
  const updated = vi.fn()
  let state: ReturnType<typeof injectNumberFieldRootContext> | undefined
  const app = createSSRApp({
    render: () => h(BaseNumberField as Component, { ...props, "onUpdate:modelValue": updated }),
  })
  app.mixin({
    created(this: ComponentPublicInstance) {
      if (this.$.type === NumberFieldInput) state = injectNumberFieldRootContext()
    },
  })
  const html = await renderToString(app)
  if (!state) throw new Error("未捕获数值输入上下文")
  return { html, updated, state }
}

describe("统一输入的模型和表单契约", () => {
  it("0.1步长保留既有小数精度且遵守上下限，可空配置清空输出null", async () => {
    const { state, updated } = await numberField({
      modelValue: 0.7,
      min: 0,
      max: 2,
      step: 0.1,
      nullable: true,
    })
    state.applyInputValue("0.15")
    expect(updated).toHaveBeenLastCalledWith(0.15)
    state.applyInputValue("99")
    expect(updated).toHaveBeenLastCalledWith(2)
    state.handleMinMaxValue("min")
    expect(updated).toHaveBeenLastCalledWith(0)
    state.applyInputValue("")
    expect(updated).toHaveBeenLastCalledWith(null)
  })

  it("整数和边界保留数值类型；必填配置清空恢复下限，不向接口传空串或undefined", async () => {
    const { state, updated } = await numberField({ modelValue: 60, min: 1, max: 600 })
    state.applyInputValue("5")
    expect(updated).toHaveBeenLastCalledWith(5)
    state.applyInputValue("1000")
    expect(updated).toHaveBeenLastCalledWith(600)
    state.applyInputValue("")
    expect(updated).toHaveBeenLastCalledWith(1)
  })

  it("模板的nullable布尔简写清空仍输出null", async () => {
    const { state, updated } = await numberField({ modelValue: 1024, min: 1, nullable: "" })
    state.applyInputValue("")
    expect(updated).toHaveBeenLastCalledWith(null)
  })

  it("数值输入禁用、标签、必填和隐藏表单字段完整传递", async () => {
    const { html } = await numberField({
      modelValue: 600,
      min: 1,
      max: 600,
      id: "timeout",
      name: "timeout",
      disabled: true,
      required: true,
      "aria-label": "请求超时",
    })
    const input = html.match(/<input\b[^>]*role="spinbutton"[^>]*>/)?.[0]
    expect(input).toContain('id="timeout"')
    expect(input).toContain('aria-label="请求超时"')
    expect(input).toContain('aria-required="true"')
    expect(input).toMatch(/\bdisabled\b/)
    const buttons = html.match(/<button\b[^>]*>/g) ?? []
    expect(buttons).toHaveLength(2)
    for (const button of buttons) expect(button).toMatch(/\bdisabled\b/)
    expect(html).toContain('name="timeout"')
    expect(html).not.toMatch(/\btitle=/)
  })

  it("复选框保留布尔选中、禁用、标签和隐藏表单语义", async () => {
    const html = await renderToString(
      createSSRApp({
        render: () =>
          h(BaseCheckbox, {
            modelValue: true,
            disabled: true,
            required: true,
            name: "enabled",
            "aria-label": "包含停用指标",
          }),
      }),
    )
    expect(html).toMatch(/<button[^>]*role="checkbox"[^>]*>/)
    expect(html).toContain('aria-checked="true"')
    expect(html).toContain('aria-label="包含停用指标"')
    expect(html).toMatch(/<button[^>]*disabled/)
    expect(html).toContain('name="enabled"')
  })

  it("单选组保留数字和同形字符串类型，不接受选项以外的值", async () => {
    const updated = vi.fn()
    let instance: ComponentInternalInstance | undefined
    const app = createSSRApp({
      render: () =>
        h(BaseRadioGroup as Component, {
          modelValue: 0,
          options: [
            { value: 0, label: "数字零" },
            { value: "0", label: "字符串零" },
          ],
          "onUpdate:modelValue": updated,
          "aria-label": "类型选择",
        }),
    })
    app.mixin({
      created(this: ComponentPublicInstance) {
        if (this.$.type.__file === (BaseRadioGroup as { __file?: string }).__file) instance = this.$
      },
    })
    const html = await renderToString(app)
    if (!instance) throw new Error("未捕获单选组件")
    const state = Reflect.get(instance, "setupState") as { updateValue(value: unknown): void }
    state.updateValue("0")
    expect(updated).toHaveBeenLastCalledWith("0")
    state.updateValue(0)
    expect(updated).toHaveBeenLastCalledWith(0)
    state.updateValue("其他")
    expect(updated).toHaveBeenCalledTimes(2)
    expect(html).toContain('role="radiogroup"')
    expect(html).toContain('aria-label="类型选择"')
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1)
  })
})
