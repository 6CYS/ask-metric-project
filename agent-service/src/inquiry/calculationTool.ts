import {Type} from "@earendil-works/pi-ai";
import type {AgentHarnessTool} from "@earendil-works/pi-agent-core";
import type {AskMetricRequestContext} from "../requestContext.js";
import type {BusinessEvidence} from "../answerEvidence.js";
import type {AnalysisEvidence} from "../analysis/tools.js";
import {analysisEvidenceAliases} from "../analysis/verifiedFindings.js";
import {BackendApiError} from "../backendClient.js";
import {commandKey} from "../harnessHost.js";

export interface InquiryCalculation extends BusinessEvidence {
  kind: "metric_calculate";
  calculation_ref: {task_id: string; calculation_id: string};
  run_refs: string[];
  evidence_items: Array<{ref: string; type: "calculation"; name: string; value: string; unit: string;
    display: string; input_refs: string[]; formula?: string}>;
  inputs: Record<string, Record<string, unknown>>;
  limitations: string[];
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export function isInquiryCalculation(value: unknown): value is InquiryCalculation {
  if (!record(value) || value.kind !== "metric_calculate" || value.status !== "succeeded"
    || !record(value.calculation_ref) || typeof value.calculation_ref.task_id !== "string"
    || typeof value.calculation_ref.calculation_id !== "string" || !record(value.inputs)
    || ![value.inputs.current, value.inputs.base].every(fact => record(fact)
      && typeof fact.task_id === "string" && typeof fact.fact_id === "string")
    || !Array.isArray(value.run_refs) || !value.run_refs.every(ref => typeof ref === "string")
    || !Array.isArray(value.limitations) || !value.limitations.every(item => typeof item === "string")
    || !Array.isArray(value.evidence_items) || !value.evidence_items.length) return false;
  return value.evidence_items.every(item => record(item) && item.type === "calculation"
    && [item.ref, item.name, item.value, item.unit, item.display].every(field => typeof field === "string")
    && Array.isArray(item.input_refs) && item.input_refs.every(ref => typeof ref === "string"));
}

const parameters = Type.Object({
  current_ref: Type.String({minLength: 1, maxLength: 200, description: "被比较的原始事实引用，如e1.v1。"}),
  base_ref: Type.String({minLength: 1, maxLength: 200, description: "参照事实引用，差额按被比较值减参照值计算。"}),
}, {additionalProperties: false});

export function createInquiryCalculationTool(): AgentHarnessTool<AskMetricRequestContext, typeof parameters> {
  return {name: "analysis_calculate", label: "计算已有结果", parameters,
    description: "复用已查询或本轮已鉴权读取的两条同指标事实，计算差额及支持的增幅，不重复取数。同机构可以比较不同日期，同日可以比较不同机构；两者同时变化须先对齐。比例编码不明时不可计算；零或负基期不提供相对增幅。输入和结果都有正式引用，不能把差额称为机构贡献或业务原因。",
    execute: async (_id, input, _update, request, _invocation, context) => {
      try {
        const evidence = await request.answerEvidence?.() ?? [];
        const sources = evidence.filter((item): item is {ref: string; evidence: AnalysisEvidence} =>
          item.evidence.kind === "analysis_evidence" && item.evidence.status === "succeeded");
        const aliases = new Map(sources.flatMap(item => [...analysisEvidenceAliases(item.ref, item.evidence.evidence_items ?? [])]));
        const currentRef = aliases.get(input.current_ref) ?? input.current_ref;
        const baseRef = aliases.get(input.base_ref) ?? input.base_ref;
        const selected = [currentRef, baseRef].flatMap(ref => {
          const source = sources.find(item => item.evidence.evidence_items?.some(atom => atom.ref === ref));
          return source ? [source] : [];
        });
        const conversationId = await request.commands.getConversationId();
        if (!conversationId || selected.length !== 2)
          throw new BackendApiError(422, "请先查询或读取所需事实，再使用本轮回执的引用计算。", "ANALYSIS_CALCULATION_SOURCE");
        const payload = {conversation_id: conversationId, run_refs: [...new Set(selected.map(item => item.evidence.run_ref))],
          current_ref: currentRef, base_ref: baseRef,
          calculation_context: {scope_id: request.operationId, user_question: request.originalMessage}};
        const key = commandKey({owner: request.actor.id, session: request.sessionId, request: request.requestId,
          action: "inquiry-comparison", payload});
        const result = await request.backend.analysisCalculate(payload, key, {signal: context.abortSignal});
        if (!isInquiryCalculation(result)) throw new Error("INVALID_CALCULATION_RECEIPT");
        const evidenceRef = `e${evidence.length + 1}`;
        const outputRefs = new Map([...analysisEvidenceAliases(evidenceRef, result.evidence_items)].map(([alias, ref]) => [ref, alias]));
        const view = {status: result.status, inputs: Object.fromEntries(Object.entries(result.inputs).map(([name, fact]) =>
          [name, Object.fromEntries(["metric_name", "org_name", "date", "display"].map(field => [field, fact[field]]))])),
        calculations: result.evidence_items.map(atom => ({ref: outputRefs.get(atom.ref), name: atom.name,
          display: atom.display, formula: atom.formula})), limitations: result.limitations};
        return {content: [{type: "text", text: JSON.stringify(view)}],
          details: {...result, execution_turn_id: request.operationId}};
      } catch (error) {
        if (context.abortSignal?.aborted || error instanceof BackendApiError && [401, 403].includes(error.status)) throw error;
        return {isError: true, content: [{type: "text", text: error instanceof BackendApiError ? error.message : "计算未完成，请根据实际来源重试。"}],
          details: {kind: "metric_calculate", status: "error", retryable: error instanceof BackendApiError && error.status === 422,
            ...(error instanceof BackendApiError ? {error_code: error.code} : {})}};
      }
    }};
}
