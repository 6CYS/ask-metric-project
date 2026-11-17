import { describe, expect, it } from "vitest"
import { createSSRApp, type Component } from "vue"
import { renderToString } from "vue/server-renderer"
import ModelDiagnosticResponse from "../src/components/llm/ModelDiagnosticResponse.vue"

const responseComponent = ModelDiagnosticResponse as Component

describe("模型返回内容展示", () => {
  it("网关返回按纯文本转义，区分未完整正文和错误来源", async () => {
    const html = await renderToString(
      createSSRApp(responseComponent, {
        incomplete: true,
        response: {
          http_status: 429,
          content: '<script>alert("x")</script>',
          error: '{"message":"<img src=x onerror=alert(1)>"}',
          error_source: "http",
          truncated: false,
        },
      }),
    )
    expect(html).toContain("HTTP 429")
    expect(html).toContain("模型回复（未完整返回）")
    expect(html).toContain("网关错误返回")
    expect(html).toContain("&lt;script&gt;")
    expect(html).not.toContain("<script>")
    expect(html).not.toContain("<img")
    expect(html).toContain("复制返回内容")
  })

  it("本地连接错误不能显示为网关返回，截断有明确提示", async () => {
    const html = await renderToString(
      createSSRApp(responseComponent, {
        incomplete: true,
        response: {
          http_status: null,
          content: "",
          error: "connection refused",
          error_source: "client",
          truncated: true,
        },
      }),
    )
    expect(html).toContain("调用错误")
    expect(html).not.toContain("网关错误返回")
    expect(html).toContain("未收到模型回复正文")
    expect(html).toContain("已截取")
  })
})
