import {
  BACKGROUND_CONTEXT,
  type AgentLane,
  type Context,
  type OperationResultRecord,
} from "@earendil-works/pi-agent-core";

export const LEGACY_OPERATION_INTERRUPTED_MESSAGE =
  "升级前未完成的提问已停止自动续跑，原问题、条件和已有结果均已保留。尚未返回的查询结果仍需核对，不能据此判断查询成功或失败。你可以在本会话继续提问。";

/**
 * 旧调用的外部结果可能未知，不能把原请求改标后重新执行。
 * 只让 Pi 落实取消：planned 不执行，effect_pending 保留中断回执，已完成结果原样回放。
 */
export async function stopLegacyOperation(
  lane: Pick<AgentLane, "getResult" | "requestAbort" | "drive">,
  operationId: string,
  context: Context = BACKGROUND_CONTEXT,
): Promise<OperationResultRecord> {
  const result = await lane.getResult(operationId, context);
  if (result) return result;
  const requested = await lane.requestAbort(operationId, context);
  if (!requested.ok) {
    // 读取与取消之间可能刚好结束；只能回放同一 operation，不能停止后来接纳的新提问。
    const settled = await lane.getResult(operationId, context);
    if (settled) return settled;
    throw requested.error;
  }
  const driven = await lane.drive(
    { operationId, waitForRetry: false, pollDeferred: false },
    context,
  );
  if (!driven.ok) throw driven.error;
  if (driven.value.kind !== "settled" || driven.value.outcome.status !== "aborted") {
    throw new Error("LEGACY_OPERATION_INTERRUPTION_INCOMPLETE");
  }
  return driven.value.outcome;
}
