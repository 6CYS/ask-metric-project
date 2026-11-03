import { afterEach, describe, expect, it, vi } from "vitest"
import { clearAccessToken, getAccessToken, setAccessToken } from "../src/lib/authSession"
import { evaluationApi } from "../src/lib/evaluationApi"
import { runFixture } from "./evaluationFixtures"

afterEach(() => {
  clearAccessToken()
  vi.unstubAllGlobals()
})

describe("测评接口边界", () => {
  it("使用同源接口和内存身份，保留服务端错误", async () => {
    setAccessToken("isolated-test-token")
    let requestedUrl = ""
    let requestedAuth = ""
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
      requestedUrl = url
      requestedAuth = new Headers(init.headers).get("Authorization") ?? ""
      return Promise.resolve(
        new Response(JSON.stringify({ error: "问题集版本已变化" }), { status: 409 }),
      )
    })
    await expect(evaluationApi.listDatasets()).rejects.toThrow("问题集版本已变化")
    expect(requestedUrl).toBe("/agent-api/evaluations/datasets")
    expect(requestedAuth).toBe("Bearer isolated-test-token")
  })
  it("旧身份请求迟到的401不能清掉新身份", async () => {
    setAccessToken("old-token")
    vi.stubGlobal("fetch", () => {
      setAccessToken("new-token")
      return Promise.resolve(new Response(JSON.stringify({ error: "登录已过期" }), { status: 401 }))
    })
    await expect(evaluationApi.listRuns()).rejects.toThrow("登录已过期")
    expect(getAccessToken()).toBe("new-token")
  })
  it("本次身份失效时清理令牌，不把错误响应视为列表空态", async () => {
    setAccessToken("expired-token")
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response(JSON.stringify({ error: "登录已过期" }), { status: 401 })),
    )
    await expect(evaluationApi.listRuns()).rejects.toThrow("登录已过期")
    expect(getAccessToken()).toBeNull()
  })
  it("拒绝未知执行状态，不默认显示成功", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response(JSON.stringify({ id: "run", status: "unknown" }))),
    )
    await expect(evaluationApi.getRun("run")).rejects.toThrow("无法识别")
  })
  it("拒绝格式错误的时序，真实模型耗时数组保持原值", async () => {
    const run = runFixture()
    const result = {
      status: "completed",
      user_entry_id: "entry",
      operation_id: "operation",
      run_status: "completed",
      answer_status: "delivered",
      error_code: null,
      error_message: null,
      timings_ms: { model_calls: [120, 240] },
    }
    const valid = { ...run, turns: run.turns.map((turn) => ({ ...turn, result })) }
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(JSON.stringify(valid))))
    expect((await evaluationApi.getRun(run.id)).turns[0]?.result?.timings_ms.model_calls).toEqual([
      120, 240,
    ])
    const invalid = {
      ...valid,
      turns: valid.turns.map((turn) => ({
        ...turn,
        result: { ...result, timings_ms: { model_calls: "unknown" } },
      })),
    }
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(JSON.stringify(invalid))))
    await expect(evaluationApi.getRun(run.id)).rejects.toThrow("无法识别")
  })
})

it("接纳中的轮次保留已落盘身份，不误判为终态或拒绝响应", async () => {
  const run = runFixture({ status: "running", finished_at: null })
  const result = {
    status: "running",
    user_entry_id: "accepted-user-entry",
    operation_id: "accepted-operation",
    run_status: null,
    answer_status: null,
    error_code: null,
    error_message: null,
    timings_ms: {},
  }
  const response = {
    ...run,
    turns: run.turns.map((turn) => ({ ...turn, status: "running", result })),
  }
  vi.stubGlobal("fetch", () => Promise.resolve(Response.json(response)))
  const received = await evaluationApi.getRun(run.id)
  expect(received.turns[0]?.result).toEqual(result)
  expect(received.turns[0]?.status).toBe("running")
})
