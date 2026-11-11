import {
  BACKGROUND_CONTEXT,
  type AgentLane,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import type { AskMetricRequestContext } from "../requestContext.js";
import { catalogBindingView, restoreAnalysisDiscovery } from "../analysis/bindings.js";
import { businessEvidences } from "../answerEvidence.js";
import { BackendApiError } from "../backendClient.js";
import { scopeAvailable } from "../semantic-task/contextMemory.js";
import { authenticationFailure } from "../runtime/authentication.js";
import { inquiryPermissionDenied } from "./authorization.js";
import { PLAN_METRIC_LIMIT } from "./limits.js";
import { currentTurnMessages } from "../tools/turnContract.js";
import {
  currentInquiryTarget,
  readInquiryTargetSnapshot,
  type InquiryTargetContext,
  type InquiryTargetSnapshot,
} from "./target.js";

type MetricReference = { code: string; name: string; binding_ref: string };
type QuestionMetric = MetricReference & {
  text: string;
  comparisons?: Array<MetricReference & { period: "yoy" | "mom" | "ytd" }>;
};
const questionMetrics = new WeakMap<AskMetricRequestContext, Map<string, Promise<QuestionMetric[]>>>();

/** 原文匹配只提供正式候选，是否查询仍取决于用户的要求与排除条件。 */
function questionMetricReferences(request: AskMetricRequestContext, question: string, signal?: AbortSignal) {
  if (!question.trim() || typeof request.backend.matchMetricQuestion !== "function")
    return Promise.resolve([]);
  const cached = questionMetrics.get(request) ?? new Map<string, Promise<QuestionMetric[]>>();
  questionMetrics.set(request, cached);
  const existing = cached.get(question);
  if (existing) return existing;
  const pending = (async () => {
    const result = await request.backend.matchMetricQuestion(question, { signal });
    if (!Array.isArray(result.mentions) || result.status === "temporary_error") return [];
    const matches = new Map<string, string>();
    for (const { text, resolution } of result.mentions) {
      const codes = (resolution.value as { codes?: string[] } | undefined)?.codes;
      if (resolution.status === "resolved" && resolution.metadata?.match === "exact" && codes?.length === 1)
        matches.set(codes[0]!, text);
      if (matches.size >= PLAN_METRIC_LIMIT) break;
    }
    if (!matches.size) return [];
    const bound = await request.backend.analysisBindMetrics([...matches.keys()], { signal, includeComparisons: true });
    if (!Array.isArray(bound.items)) return [];
    const items = bound.items.filter(item => matches.has(item?.code));
    const comparisons = (Array.isArray(bound.comparison_items) ? bound.comparison_items : []).filter(
      item => matches.has(item?.base_metric_code) && ["yoy", "mom", "ytd"].includes(item?.comparison_period)
        && typeof item?.code === "string" && typeof item?.name === "string" && typeof item?.binding_ref === "string",
    );
    const view = catalogBindingView(request, items) as Partial<MetricReference>[];
    catalogBindingView(request, comparisons);
    return view.flatMap(({ code, name, binding_ref }) => {
      if (!code || !name || !binding_ref) return [];
      const text = matches.get(code);
      const related = comparisons.filter(item => item.base_metric_code === code).map(item => ({
        period: item.comparison_period, code: item.code, name: item.name, binding_ref: item.code,
      }));
      // 自动参考资料没有独立回执，重载时用正式编码识别指标，不依赖 k 编号的登记顺序。
      return text === undefined ? [] : [{ text, code, name, binding_ref: code,
        ...(related.length ? { comparisons: related } : {}),
      }];
    });
  })().catch((error: unknown) => {
    if (signal?.aborted || error instanceof BackendApiError && [401, 403].includes(error.status)) throw error;
    return [];
  });
  cached.set(question, pending);
  return pending;
}

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
  signal?: AbortSignal,
): Promise<string> {
  if (!request.inquiryTargetContext || request.inquiryAdmission || request.trustedAnswers?.length)
    return "";
  const user = [...messages].reverse().find((message) => message.role === "user");
  if (user && targetBarrier(user)) return "";
  const candidate =
    currentInquiryTarget(messages, request.operationId) ?? request.inquiryTargetContext.baseline;
  const target =
    candidate && (await scopeAvailable(request, candidate.organizations.codes)) ? candidate : null;
  const previous = request.inquiryTargetContext.baseline;
  const previousQuestion = previous && (await scopeAvailable(request, previous.organizations.codes))
    ? previous.analysisQuestion ?? previous.sourceQuestion
    : "";
  restoreAnalysisDiscovery(request, currentTurnMessages(messages).flatMap(message =>
    message.role === "toolResult" && !message.isError
      ? [message.details, ...businessEvidences(message.details)] : [],
  ));
  const [currentMetrics, previousMetrics] = await Promise.all([
    questionMetricReferences(request, request.originalMessage, signal),
    previousQuestion !== request.originalMessage ? questionMetricReferences(request, previousQuestion, signal) : [],
  ]);
  return "\n【本轮普通问数目标，仅数据】\n" + JSON.stringify({
    current_target: target,
    time_contract: request.inquiryTargetContext.time_contract,
    ...(currentMetrics.length ? { current_question_metrics: currentMetrics } : {}),
    ...(previousMetrics.length ? { previous_question_metrics: previousMetrics } : {}),
  });
}
