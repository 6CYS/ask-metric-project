import {Compile} from "typebox/compile";
import {Type} from "@earendil-works/pi-ai";
import type {AskMetricRequestContext} from "../requestContext.js";
import {BusinessInputError} from "../business-context/inputError.js";
import type {AnalysisPlan} from "./contracts.js";
import {resolveCatalogBindings} from "./bindings.js";
import {inquiryProblem} from "./inquiry.js";

type Action = {question: string; metrics?: string[]; method?: AnalysisPlan["steps"][number]["method"];
  comparisons?: Array<"mom" | "yoy" | "ytd">; position?: "top" | "bottom"; count?: number;
  from_ranking?: number; relation_id?: string; gap?: string};
interface AnalysisActions {kind: "business_analysis"; actions: Action[]; based_on?: string[]}

/** 模型只选择业务问题、目录候选与方法；节点身份、回答关联和依赖由宿主编译。 */
export const analysisActionsSchema = {type: "object", required: ["kind", "actions"], additionalProperties: false,
  properties: {kind: {const: "business_analysis"},
    based_on: {type: "array", minItems: 1, maxItems: 8, uniqueItems: true, items: {type: "string"},
      description: "同轮补查时选择触发疑问的已有事实或判断引用；首次取数省略。"},
    actions: {type: "array", minItems: 1, maxItems: 8, items: {type: "object", required: ["question"], additionalProperties: false,
      oneOf: [{required: ["metrics"], not: {required: ["gap"]}}, {required: ["gap"], not: {required: ["metrics"]}}],
      properties: {question: {type: "string", minLength: 1, maxLength: 300},
        metrics: {type: "array", minItems: 1, maxItems: 12, uniqueItems: true, items: {type: "string", minLength: 1},
          description: "选择analysis_catalog已返回的k短引用；不重新填写编码或指标名称。"},
        method: {enum: ["observe", "compare", "trend", "ranking", "structure"], description: "默认observe读取正式指标；compare才是同指标跨日期比较。"},
        comparisons: {type: "array", minItems: 1, maxItems: 3, uniqueItems: true, items: {enum: ["mom", "yoy", "ytd"]}},
        position: {enum: ["top", "bottom"]}, count: {type: "integer", minimum: 1, maximum: 100},
        from_ranking: {type: "integer", minimum: 1, maximum: 8, description: "仅针对前面第几项排名的入选机构补查，从1计数；程序传递机构及日期。"},
        relation_id: {type: "string", minLength: 1},
        gap: {type: "string", minLength: 1, maxLength: 300, description: "已核对能力或目录后仍无法执行的具体原因，不能把未查询写成无数据。"}}}}}};
const validator = Compile(Type.Unsafe(analysisActionsSchema));

export function analysisPublicParameters(parameters: unknown): unknown {
  const schema = structuredClone(parameters) as {definitions: {target: {properties: {analysis: {oneOf: Array<{properties: {kind: {const: string}}}>}}}}};
  schema.definitions.target.properties.analysis.oneOf = schema.definitions.target.properties.analysis.oneOf
    .map(branch => branch.properties.kind.const === "business_analysis" ? analysisActionsSchema : branch);
  return schema;
}

export async function materializeAnalysisActions(raw: unknown, request: AskMetricRequestContext): Promise<unknown> {
  if (!raw || typeof raw !== "object") return raw;
  const input = raw as {intent?: string; targets?: Array<{analysis?: unknown}>};
  if (!Array.isArray(input.targets)) return raw;
  const result = structuredClone(input);
  for (const target of result.targets!) {
    const proposed = target?.analysis as Partial<AnalysisActions> | undefined;
    if (proposed?.kind !== "business_analysis" || !("actions" in proposed)) continue;
    if (input.intent !== "analyze" || !validator.Check(proposed)) throw new BusinessInputError(
      "ANALYSIS_ACTION_INVALID", "analysis", "分析只提交actions：每项写question及目录metrics，或具体gap；不要混入plan和节点编号。");
    const selection = proposed as AnalysisActions;
    const plan: AnalysisPlan = {objective: request.originalMessage.slice(0, 500),
      scope_notice: "沿用本次已确认的机构与时间；缺数保留缺口，不扩大范围。", requirements: [], steps: []};
    selection.actions.forEach((action, index) => {
      const id = `q${index + 1}`;
      plan.requirements.push({id, question: action.question, ...(action.gap ? {gap_reason: action.gap} : {})});
      if (action.gap) {
        if (Object.keys(action).some(key => !["question", "gap"].includes(key))) throw new BusinessInputError(
          "ANALYSIS_ACTION_INVALID", "analysis", "缺口项只保留question和gap，不混入尚未执行的方法或依赖。");
        return;
      }
      const method = action.method ?? "observe";
      if (method === "ranking" && (!action.position || action.count == null)
        || method === "compare" && !action.comparisons?.length
        || method === "structure" && !action.relation_id
        || method !== "ranking" && (action.position !== undefined || action.count !== undefined)
        || method !== "compare" && action.comparisons !== undefined
        || method !== "structure" && action.relation_id !== undefined) throw new BusinessInputError(
          "ANALYSIS_ACTION_INVALID", "analysis", `第${index + 1}项方法参数不完整或冲突：ranking需position/count，compare需comparisons，structure需正式relation_id；不猜测方向或公式。`);
      const source = action.from_ranking === undefined ? undefined : selection.actions[action.from_ranking - 1];
      if (action.from_ranking !== undefined && (action.from_ranking > index || source?.method !== "ranking" || source.gap || method === "ranking"))
        throw new BusinessInputError("ANALYSIS_ACTION_INVALID", "analysis", "from_ranking必须选择前面已经声明的排名动作，不能引用未来项或自行构造机构。");
      plan.steps.push({id: `s${index + 1}`, method, metric_refs: action.metrics!, answers: [id], rationale: action.question,
        ...(action.comparisons ? {comparisons: action.comparisons} : {}),
        ...(method === "ranking" ? {position: action.position, top_n: action.count} : {}),
        ...(action.relation_id ? {relation_id: action.relation_id} : {}),
        ...(action.from_ranking ? {depends_on: [`s${action.from_ranking}`], organization_from_step: `s${action.from_ranking}`} : {})});
    });
    // 只接受本轮已发现候选，完整签名、机构与权限仍由原执行链复核。
    const bound = resolveCatalogBindings(request, plan);
    const previous = (await request.answerEvidence?.() ?? []).filter(item =>
      ["analysis_evidence", "business_overview"].includes(item.evidence.kind) && item.evidence.status === "succeeded");
    if (selection.based_on?.length) {
      const question = selection.actions.map(action => action.question).join("；").slice(0, 300);
      bound.inquiry = {question, prior_judgment: "依据已有证据提出核查疑问，尚未认定原因。",
        basis_refs: selection.based_on, expected_change: "新证据用于支持、修正或限定上述疑问。"};
      const problem = inquiryProblem(bound.inquiry, previous, false);
      if (problem) throw new BusinessInputError("ANALYSIS_INQUIRY_REQUIRED", "analysis.based_on", problem);
    }
    target.analysis = {kind: "business_analysis", plan: bound};
  }
  return result;
}
