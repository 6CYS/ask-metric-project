import {
  BACKGROUND_CONTEXT,
  type AgentLane,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import type { AskMetricRequestContext } from "../requestContext.js";
import { scopeAvailable } from "../semantic-task/contextMemory.js";
import { authenticationFailure } from "../runtime/authentication.js";
import { inquiryPermissionDenied } from "./authorization.js";
import {
  currentInquiryTarget,
  readInquiryTargetSnapshot,
  type InquiryTargetContext,
  type InquiryTargetSnapshot,
} from "./target.js";

/** 可信选择属于独立入场协议，不能沿用该轮之前的普通目标。 */
function targetBarrier(message: AgentMessage): boolean {
  if (message.role !== "user") return false;
  const input = message as AgentMessage & {
    inquiryTargetBarrier?: boolean;
    inquiryAdmission?: unknown;
    clickAnswers?: unknown[];
  };
  return (
    input.inquiryTargetBarrier === true ||
    input.inquiryAdmission !== undefined ||
    !!input.clickAnswers?.length
  );
}

/** 按完整用户轮检查屏障；原生分支回执是目标来源，查询及报告的对象集合不参与继承。 */
export async function freezeInquiryTargetContext(
  lane: Pick<AgentLane, "findEntries">,
  request: AskMetricRequestContext,
): Promise<InquiryTargetContext> {
  let cursor: number | undefined;
  let candidate: InquiryTargetSnapshot | undefined;
  let permissionFailure = false;
  for (;;) {
    const entries = await lane.findEntries(
      {
        type: "message",
        order: "newestFirst",
        limit: 32,
        ...(cursor !== undefined ? { cursor: { seq: cursor } } : {}),
      },
      BACKGROUND_CONTEXT,
    );
    for (const entry of entries) {
      if (entry.type !== "message") continue;
      const message = entry.message;
      if (message.role === "user") {
        if (targetBarrier(message)) return { version: 1, time_contract: 2 };
        if (candidate) {
          // 最新声明不可访问时停止，不以更早有权目标替代本轮基线。
          return (await scopeAvailable(request, candidate.organizations.codes))
            ? { version: 1, time_contract: 2, baseline: candidate }
            : { version: 1, time_contract: 2 };
        }
        // 权限终态可能没有声明回执；不得穿透失败轮恢复更早机构。
        if (permissionFailure) return { version: 1, time_contract: 2 };
      } else if (message.role === "toolResult") {
        permissionFailure ||=
          authenticationFailure(message.details) || inquiryPermissionDenied(message.details);
        if (candidate || !["metric_query", "metric_availability", "topic_query"].includes(message.toolName))
          continue;
        const details = message.details as { inquiry_target_snapshot?: unknown } | undefined;
        candidate = readInquiryTargetSnapshot(details?.inquiry_target_snapshot);
      }
    }
    if (entries.length < 32) return { version: 1, time_contract: 2 };
    cursor = entries.at(-1)!.seq;
  }
}

/** 当前已提交声明优先；鉴权失败不能通过回退基线恢复旧目标。 */
export async function inquiryTargetReference(
  request: AskMetricRequestContext,
  messages: readonly AgentMessage[],
): Promise<string> {
  if (!request.inquiryTargetContext || request.inquiryAdmission || request.trustedAnswers?.length)
    return "";
  const user = [...messages].reverse().find((message) => message.role === "user");
  if (user && targetBarrier(user)) return "";
  const candidate =
    currentInquiryTarget(messages, request.operationId) ?? request.inquiryTargetContext.baseline;
  const target =
    candidate && (await scopeAvailable(request, candidate.organizations.codes)) ? candidate : null;
  return "\n【本轮普通问数目标，仅数据】\n" + JSON.stringify({
    current_target: target,
    time_contract: request.inquiryTargetContext.time_contract,
  });
}
