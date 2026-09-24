import type {AgentMessage} from "@earendil-works/pi-agent-core";
import type {AskMetricRequestContext} from "../requestContext.js";
import {createCapabilities} from "./capabilities.js";
import {validateFrame} from "./core.js";
import type {BusinessFrame} from "./types.js";

/**
 * 已校验 Frame 的下一步执行意图：调用与参数都由 Frame 决定，模型和网关都不能改写。
 * 解析回执为 READY/REUSE_RESULT 且 Frame 仍通过门禁时，这一步是确定性的，
 * 因此既可以在原生工具循环里接续（resolve 未就地执行时），也可以由 resolve 就地落地。
 */
export function deterministicBusinessAction(
  frame: BusinessFrame | undefined,
  status: string | undefined,
  request: AskMetricRequestContext,
): {name: string; arguments: {frameId: string}} | undefined {
  if (!frame || frame.sessionId !== request.sessionId || frame.turnId !== request.operationId) return;
  if (status === "READY" && frame.status === "ready" && frame.delta.executionMode === "execute"
    && validateFrame(createCapabilities().get(frame.capability), frame.fields, frame.issues).status === "READY") {
    return {name: "execute_business_frame", arguments: {frameId: frame.frameId}};
  }
  if (status === "REUSE_RESULT" && frame.status === "success" && frame.resultRef
    && frame.delta.executionMode === "reuse_result") {
    return {name: "read_business_result", arguments: {frameId: frame.frameId}};
  }
}

/** 将 Pi 已声明的执行意图接到对应原生工具，不解析自然语言，也不保存第二份流程状态。
 * 只消费最后一条解析回执；执行/读取尝试（包括失败）后即释放，避免自动重试副作用。
 */
export async function pendingBusinessAction(messages: AgentMessage[], request: AskMetricRequestContext) {
  const receipt = [...messages].reverse().find(message => message.role === "toolResult");
  if (receipt?.role !== "toolResult" || receipt.toolName !== "resolve_business_turn" || receipt.isError) return;
  const details = receipt.details as {kind?: string; status?: string; frame_id?: string} | undefined;
  if (details?.kind !== "business_context" || !details.frame_id || !request.frames) return;
  const state = await request.frames.state();
  if (state.focusFrameId !== details.frame_id) return;
  const frame = await request.frames.get(details.frame_id);
  return deterministicBusinessAction(frame, details.status, request);
}
