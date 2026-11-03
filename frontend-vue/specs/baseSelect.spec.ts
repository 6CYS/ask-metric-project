import { renderToString } from "@vue/server-renderer"
import { createSSRApp, h } from "vue"
import { describe, expect, it } from "vitest"

import BaseSelect from "../src/components/ui/BaseSelect.vue"

describe("统一选择框", () => {
  it("空字符串是有效筛选值，触发器显示对应标签而不是占位文字", async () => {
    const html = await renderToString(
      createSSRApp({
        render: () =>
          h(BaseSelect, {
            modelValue: "",
            options: [
              { value: "", label: "全部状态" },
              { value: "enabled", label: "已启用" },
            ],
            placeholder: "请选择状态",
          }),
      }),
    )

    expect(html).toContain('role="combobox"')
    expect(html).toContain("全部状态")
    expect(html).not.toContain("请选择状态")
  })

  it.each([
    { value: 0, label: "零分钟" },
    { value: "0", label: "字符串零" },
  ])("区分数字与字符串同形选项：$label", async ({ value, label }) => {
    const html = await renderToString(
      createSSRApp({
        render: () =>
          h(BaseSelect, {
            modelValue: value,
            options: [
              { value: 0, label: "零分钟" },
              { value: "0", label: "字符串零" },
            ],
          }),
      }),
    )

    expect(html).toContain(label)
    expect(html).not.toContain(value === 0 ? "字符串零" : "零分钟")
  })

  it("未选值显示占位文字，属性和禁用状态落到可访问触发器", async () => {
    const html = await renderToString(
      createSSRApp({
        render: () =>
          h(BaseSelect, {
            modelValue: null,
            options: [{ value: "float", label: "float" }],
            placeholder: "请选择编码格式",
            disabled: true,
            id: "encoding-format",
            "aria-label": "编码格式",
            class: "consumer-width",
          }),
      }),
    )

    expect(html).toMatch(/<button[^>]*id="encoding-format"[^>]*>/)
    expect(html).toMatch(/<button[^>]*aria-label="编码格式"[^>]*>/)
    expect(html).toMatch(/<button[^>]*class="[^"]*consumer-width[^"]*"[^>]*>/)
    expect(html).toMatch(/<button[^>]*disabled[^>]*>/)
    expect(html).toContain("请选择编码格式")
  })

  it("必填字段向触发器和隐藏表单控件传递必填语义", async () => {
    const html = await renderToString(
      createSSRApp({
        render: () =>
          h(BaseSelect, {
            modelValue: null,
            options: [{ value: "dataset-a", label: "问题集甲" }],
            name: "datasetId",
            required: true,
          }),
      }),
    )

    expect(html).toMatch(/<button[^>]*aria-required="true"[^>]*>/)
    const formControl = html.match(/<select\b[^>]*>/)?.[0]
    expect(formControl).toContain('name="datasetId"')
    expect(formControl).toMatch(/\brequired\b/)
    expect(html).not.toMatch(/<button[^>]*name="datasetId"[^>]*>/)
  })
})
