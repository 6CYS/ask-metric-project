import {afterEach, expect, it, vi} from "vitest"
import {observeAgentSession, promptAgentSession, cancelAgentRequest, cancelAgentOperation} from "../../src/lib/agentApi"

vi.mock("@/lib/authSession", () => ({getAccessToken: () => "synthetic", clearAccessToken: vi.fn(), setAuthFailureReason: vi.fn()}))
afterEach(() => vi.unstubAllGlobals())

it("提问声明支持累计回答，解析新事件并忽略未知事件；GET 重连只读取快照", async () => {
  const blocks = [
    ["accepted", {}], ["future_event", {text: "应忽略"}],
    ["answer_delta", {call_seq: 1, mode: "reply", text: "你好"}],
    ["answer_reset", {call_seq: 1, reason: "tool_call"}],
    ["snapshot", {messages: [], running: false, operation_id: null}],
    ["run_terminal", {run_status: "completed", answer_status: "ok"}],
  ]
  const fetcher = vi.fn(async () => new Response(blocks.map(([type, data]) =>
    `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`).join(""), {headers: {"Content-Type": "text/event-stream"}}))
  vi.stubGlobal("fetch", fetcher)
  const received = vi.fn()
  await promptAgentSession("synthetic", {request_id: "qa", message: "你好"}, {onEvent: received})
  expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({"X-Agent-Answer-Streaming": "v1"})
  expect(received.mock.calls.map(([event]) => event.type)).toEqual(["accepted", "answer_delta", "answer_reset", "snapshot", "run_terminal"])
  received.mockClear()
  await observeAgentSession("synthetic", {onEvent: received})
  expect((fetcher.mock.calls[1] as unknown as [string, RequestInit])[1].headers).not.toHaveProperty("X-Agent-Answer-Streaming")
});

it("纯点击请求允许空 message，并原样序列化结构化 answers", async () => {
 const fetcher=vi.fn(async()=>new Response('event: run_terminal\ndata: {"run_status":"completed","answer_status":"ok"}\n\n'));vi.stubGlobal("fetch",fetcher);
 const answers=[{question_id:"q1",version:2,choice:{type:"select" as const,option_ids:["o1","o2"]}},{question_id:"q2",version:1,choice:{type:"accept" as const}}];
 await promptAgentSession("synthetic",{request_id:"click-only",message:"",answers},{onEvent:()=>{}});
 const body=JSON.parse(String((fetcher.mock.calls[0] as unknown as [string,RequestInit])[1].body));
 expect(body).toEqual({protocol_version:3,request_id:"click-only",message:"",answers});
});


it("停止支持accepted前的request身份，并保留旧operation停止接口",async()=>{
 const fetcher=vi.fn(async()=>new Response(null,{status:204}));vi.stubGlobal("fetch",fetcher);
 await cancelAgentRequest("session-one","request-one");await cancelAgentOperation("session-one","operation-one");
 expect((fetcher.mock.calls[0] as unknown as [string,RequestInit])[1].body).toBe(JSON.stringify({request_id:"request-one"}));
 expect((fetcher.mock.calls[1] as unknown as [string,RequestInit])[1].body).toBe(JSON.stringify({operation_id:"operation-one"}));
});
