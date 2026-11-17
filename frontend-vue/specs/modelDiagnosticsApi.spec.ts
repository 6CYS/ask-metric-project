import { afterEach, describe, expect, it, vi } from "vitest"
import { clearAccessToken, getAccessToken, setAccessToken } from "../src/lib/authSession"
import { getDiagnosticTarget, runModelDiagnostic } from "../src/lib/modelDiagnosticsApi"

const target = {
  model: "isolated-model",
  configuration_source: "database",
  configuration_version: "v1",
  first_response_timeout_ms: 30000,
  stream_idle_timeout_ms: 30000,
  max_duration_ms: 60000,
  cooldown_ms: 10000,
}
const started = { diagnostic_id: "d1", started_at: "2026-11-17T02:00:00Z", target }
const result = {
  ...started,
  finished_at: "2026-11-17T02:00:01Z",
  status: "succeeded",
  first_output_ms: 100,
  duration_ms: 1000,
  error_code: null,
  message: "本次检测完成",
}
const frame = (event: string, data: unknown) =>
  `event: ${event}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`
function response(body: string) {
  const bytes = new TextEncoder().encode(body)
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 5)
          controller.enqueue(bytes.slice(offset, offset + 5))
        controller.close()
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  )
}
afterEach(() => {
  clearAccessToken()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("模型诊断接口", () => {
  it("保留本次模型正文、HTTP 状态和网关返回，兼容旧结果", async () => {
    const completed = {
      ...result,
      status: "failed",
      error_code: "MODEL_RATE_LIMITED",
      model_response: {
        http_status: 429,
        content: "部分回复",
        error: '{"error":{"code":"QPM_LIMIT","message":"稍后重试"}}',
        error_source: "http",
        truncated: false,
      },
    }
    vi.stubGlobal("fetch", () =>
      Promise.resolve(response(frame("started", started) + frame("result", completed))),
    )
    expect(await runModelDiagnostic(new AbortController().signal, () => {})).toEqual(completed)
    vi.stubGlobal("fetch", () =>
      Promise.resolve(response(frame("started", started) + frame("result", result))),
    )
    expect(await runModelDiagnostic(new AbortController().signal, () => {})).toEqual(result)
  })

  it("拒绝类型不完整的模型返回，保留规定长度内的转义文本", async () => {
    const details = {
      http_status: 200,
      content: "\u0001".repeat(8192),
      error: "\u0002".repeat(8192),
      error_source: "client",
      truncated: true,
    }
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        response(
          frame("started", started) + frame("result", { ...result, model_response: details }),
        ),
      ),
    )
    expect(
      (await runModelDiagnostic(new AbortController().signal, () => {})).model_response,
    ).toEqual(details)
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        response(
          frame("started", started) +
            frame("result", { ...result, model_response: { ...details, http_status: "200" } }),
        ),
      ),
    )
    await expect(runModelDiagnostic(new AbortController().signal, () => {})).rejects.toThrow(
      "不完整",
    )
  })
  it("在项目支持的旧浏览器中不依赖新的 AbortSignal 静态方法", async () => {
    const unsupported = () => {
      throw new TypeError("unsupported AbortSignal method")
    }
    vi.spyOn(AbortSignal, "timeout").mockImplementation(unsupported)
    vi.spyOn(AbortSignal, "any").mockImplementation(unsupported)
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) =>
      Promise.resolve(
        init.method === "GET"
          ? Response.json(target)
          : response(frame("started", started) + frame("result", result)),
      ),
    )
    expect(await getDiagnosticTarget()).toEqual(target)
    expect(await runModelDiagnostic(new AbortController().signal, () => {})).toEqual(result)
  })
  it("读取实际配置摘要，检测不发送配置草稿并处理跨块事件", async () => {
    setAccessToken("isolated-token")
    const calls: RequestInit[] = []
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
      calls.push(init)
      return Promise.resolve(
        init.method === "POST"
          ? response(
              frame("started", started) +
                frame("progress", { phase: "receiving", first_output_ms: 100 }) +
                frame("result", result),
            )
          : Response.json(target),
      )
    })
    expect(await getDiagnosticTarget()).toEqual(target)
    const events: unknown[] = []
    expect(
      await runModelDiagnostic(new AbortController().signal, (event) => events.push(event)),
    ).toEqual(result)
    expect(events.map((event) => (event as { type: string }).type)).toEqual(["started", "progress"])
    expect(calls[1]?.body).toBeUndefined()
    expect(new Headers(calls[1]?.headers).get("Authorization")).toBe("Bearer isolated-token")
  })

  it("收到输出但没有结果终态时仍判为连接中断", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        response(
          frame("started", started) +
            frame("progress", { phase: "receiving", first_output_ms: 100 }),
        ),
      ),
    )
    await expect(runModelDiagnostic(new AbortController().signal, () => {})).rejects.toThrow("中断")
  })

  it("等待下一段输出时停止，会关闭流并结束等待", async () => {
    const cancel = vi.fn()
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(stream) {
              stream.enqueue(new TextEncoder().encode(frame("started", started)))
            },
            cancel,
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
      ),
    )
    const controller = new AbortController()
    const running = runModelDiagnostic(controller.signal, () => {
      queueMicrotask(() => controller.abort())
    })
    await expect(running).rejects.toMatchObject({ name: "AbortError" })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it("模型限流终态保留失败原因，不清理应用登录", async () => {
    setAccessToken("current-token")
    const failure = {
      ...result,
      status: "failed",
      error_code: "MODEL_RATE_LIMITED",
      message: "模型服务当前请求较多",
    }
    vi.stubGlobal("fetch", () =>
      Promise.resolve(response(frame("started", started) + frame("result", failure))),
    )
    expect(await runModelDiagnostic(new AbortController().signal, () => {})).toEqual(failure)
    expect(getAccessToken()).toBe("current-token")
  })

  it("保留服务端冷却时间，非JSON错误不展示网关正文", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        Response.json({ detail: "请稍后再检测", retry_after_ms: 6000 }, { status: 429 }),
      ),
    )
    await expect(getDiagnosticTarget()).rejects.toMatchObject({ status: 429, retryAfterMs: 6000 })
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response("private-proxy-information", { status: 502 })),
    )
    await expect(getDiagnosticTarget()).rejects.toThrow("诊断服务暂不可用")
  })

  it("旧请求的401不清除新登录，主动取消保持取消语义", async () => {
    setAccessToken("old-token")
    vi.stubGlobal("fetch", () => {
      setAccessToken("new-token")
      return Promise.resolve(new Response(null, { status: 401 }))
    })
    await expect(getDiagnosticTarget()).rejects.toMatchObject({ status: 401 })
    expect(getAccessToken()).toBe("new-token")
    vi.stubGlobal("fetch", () => Promise.reject(new DOMException("aborted", "AbortError")))
    const controller = new AbortController()
    controller.abort()
    await expect(runModelDiagnostic(controller.signal, () => {})).rejects.toMatchObject({
      name: "AbortError",
    })
  })
})
