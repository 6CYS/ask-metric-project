import {Type} from "@earendil-works/pi-ai";
import type {AgentHarnessTool} from "@earendil-works/pi-agent-core";
import type {AskMetricRequestContext} from "../requestContext.js";
import {factualReceiptAnswer, lastReceiptDelivery, publicTextProblem, RUNTIME_FINALIZE, RUNTIME_INCOMPLETE, type RuntimeDelivery} from "./delivery.js";
import {RUNTIME_LIMITS, recoveryDecision} from "./recovery.js";
import {historySources, resolveHistoryOrganizationScopes} from "../historySources.js";

const parameters = Type.Object({mode: Type.Union([Type.Literal("receipt"), Type.Literal("catalog"), Type.Literal("incomplete")])}, {additionalProperties: false});

/** 宿主内部收口，不接收模型正文，不增加模型往返；重启后从原生回执重新构建。 */
export function createRuntimeFinalizeTool(): AgentHarnessTool<AskMetricRequestContext, typeof parameters> {
  return {name: RUNTIME_FINALIZE, label: "整理已核验结果", description: "宿主内部交付工具，不由模型主动调用。", parameters,
    execute: async (_id, params, _update, request) => {
      const messages = await request.turnMessages?.() ?? [];
      let answer = lastReceiptDelivery(messages) ?? factualReceiptAnswer(messages);
      if (!answer && params.mode === "catalog") {
        answer = messages.flatMap(message => {
          if (message.role !== "toolResult" || message.isError) return [];
          const d = message.details as {kind?: string; public_answer?: unknown; catalog_answer?: unknown; status?: string} | undefined;
          const text = ["catalog", "analysis_catalog"].includes(d?.kind ?? "") ? d?.catalog_answer : d?.public_answer;
          return ["catalog", "analysis_catalog", "metric_catalog_overview"].includes(d?.kind ?? "") && typeof text === "string"
            && !publicTextProblem(text) ? [text] : [];
        }).join("\n\n") || undefined;
      }
      const receipts = messages.filter(message => message.role === "toolResult");
      const outputLimited = receipts.some(message => (message.details as {status?: string})?.status === "MODEL_OUTPUT_LIMIT");
      const noProgress = recoveryDecision(messages).kind === "stop_no_progress";
      const stopAnswer = outputLimited ? "模型未能生成完整的调用参数，截断的调用没有执行。原问题及已确认条件仍保留，可以重试当前问题。"
        : noProgress ? "相同调用重复后仍未通过校验，已停止重复尝试。原问题、已取得结果和已确认条件仍保留，可以继续补充条件或重试。"
          : receipts.length >= RUNTIME_LIMITS.toolCalls ? "本轮已达到处理步数上限，已保留现有结果与条件，可以继续处理尚未完成的部分。" : RUNTIME_INCOMPLETE;
      const unavailable = (): never => {throw new Error("RUNTIME_DELIVERY_SOURCE_UNAVAILABLE");};
      const sources = historySources(receipts.map(message => message.details), unavailable);
      const details: RuntimeDelivery = {kind: "runtime_delivery", version: 1, operation_id: request.operationId, status: "delivered",
        outcome: answer ? params.mode === "catalog" ? "explanation" : "result" : "incomplete",
        source_call_ids: messages.flatMap(message => message.role === "toolResult" ? [message.toolCallId] : []),
        history_sources: {tasks: [...sources.tasks].map(([task_id, result_id]) => ({task_id, ...(result_id ? {result_id} : {})})),
          organizationScopes: await resolveHistoryOrganizationScopes(sources, request.semanticTasks, unavailable)},
        public_answer: answer ?? stopAnswer};
      return {content: [{type: "text", text: details.public_answer}], details, terminate: true};
    }};
}
