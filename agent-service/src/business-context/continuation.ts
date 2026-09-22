import type {AgentMessage} from "@earendil-works/pi-agent-core";
import type {AskMetricRequestContext} from "../requestContext.js";
import {createCapabilities} from "./capabilities.js";
import {validateFrame} from "./core.js";

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
  if (!frame || frame.sessionId !== request.sessionId || frame.turnId !== request.operationId) return;
  if (details.status === "READY" && frame.status === "ready" && frame.delta.executionMode === "execute"
    && validateFrame(createCapabilities().get(frame.capability), frame.fields, frame.issues).status === "READY") {
    return {name: "execute_business_frame", arguments: {frameId: frame.frameId}};
  }
  if (details.status === "REUSE_RESULT" && frame.status === "success" && frame.resultRef
    && frame.delta.executionMode === "reuse_result") {
    return {name: "read_business_result", arguments: {frameId: frame.frameId}};
  }
}
