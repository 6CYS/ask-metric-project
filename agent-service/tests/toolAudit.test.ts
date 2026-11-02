import {BACKGROUND_CONTEXT, withAbortSignal, type AgentHarnessTool} from "@earendil-works/pi-agent-core";
import {Type} from "@earendil-works/pi-ai";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {BackendClient} from "../src/backendClient.js";
import type {AskMetricRequestContext} from "../src/requestContext.js";
import {auditToolCall, withToolExecutionAudit} from "../src/toolAudit.js";
import {MemoryCommandBridge, runTool, testRequestContext} from "../src/tools/testUtils.js";

afterEach(() => vi.restoreAllMocks());

describe("工具执行耗时与实际调用对应", () => {
  it.each(["returned", "threw", "aborted"] as const)("%s保留调用身份、耗时及原返回/异常，不记录敏感正文", async outcome => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValueOnce(146.4);
    const controller = new AbortController();
    const failure = new Error("业务详情不能进入日志：SECRET_ERROR");
    const returned = {content: [{type: "text" as const, text: "SECRET_RESULT"}],
      details: {kind: "analysis_answer", status: "ARGUMENT_ERROR"}};
    const tool: AgentHarnessTool<AskMetricRequestContext> = {name: "analysis_answer", label: "报告", description: "测试边界",
      parameters: Type.Object({body: Type.String()}), execute: async () => {
        if (outcome === "aborted") controller.abort();
        if (outcome !== "returned") throw failure;
        return returned;
      }};
    const request = testRequestContext({} as BackendClient, new MemoryCommandBridge());
    const pending = runTool(withToolExecutionAudit(tool), {body: "SECRET_ARGUMENT"}, request,
      withAbortSignal(controller.signal, BACKGROUND_CONTEXT));
    if (outcome === "returned") expect(await pending).toBe(returned);
    else await expect(pending).rejects.toBe(failure);
    const records = log.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({event: "agent_tool_call", stage: "executed"});
    expect(records[1]).toMatchObject({event: "agent_tool_call", stage: "finished", tool: "analysis_answer",
      request_id: "req-1", session_id: "session-1", operation_id: "op-1", tool_call_id: "tc-1",
      duration_ms: 46, execution_outcome: outcome});
    expect(JSON.stringify(records)).not.toMatch(/SECRET_ARGUMENT|SECRET_RESULT|SECRET_ERROR/);
  });

  it("未执行的准入拦截不伪造执行耗时", () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const request = testRequestContext({} as BackendClient, new MemoryCommandBridge());
    auditToolCall(request, "blocked-call", "metric_query", "blocked", {org_names: ["SECRET_ORG"]});
    expect(log).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(String(log.mock.calls[0]![0]));
    expect(entry).toMatchObject({stage: "blocked", tool_call_id: "blocked-call"});
    expect(entry).not.toHaveProperty("duration_ms");
    expect(entry).not.toHaveProperty("execution_outcome");
  });
});
