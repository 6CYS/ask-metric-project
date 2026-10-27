import {analysisInquirySchema, type AnalysisInquiry} from "./inquiry.js";

/** 通用计划只引用服务端目录绑定；领域名称不作为能力枚举或准入条件。 */
export interface AnalysisPlan {
  objective: string;
  scope_notice: string;
  inquiry?: AnalysisInquiry;
  requirements: Array<{id: string; question: string; gap_reason?: string | null}>;
  steps: Array<{id: string; method: "observe" | "compare" | "trend" | "ranking" | "structure";
    metric_refs: string[]; answers: string[]; depends_on?: string[]; comparisons?: Array<"mom" | "yoy" | "ytd">;
    rationale: string; position?: "top" | "bottom"; top_n?: number; relation_id?: string | null}>;
}

/** 两个协议中的同一排名只绑定一次；允许补空槽，显式冲突不得覆盖或择一执行。 */
export function completeRankingSteps(plan: AnalysisPlan | undefined,
  operation: {kind?: string; position?: string | null; top_n?: number | null} | undefined): boolean {
  const position = operation?.position, top_n = operation?.top_n;
  const rankings = plan?.steps.filter(step => step.method === "ranking") ?? [];
  if (operation?.kind !== "ranking" || (position !== "top" && position !== "bottom")
    || typeof top_n !== "number" || !Number.isInteger(top_n) || top_n < 1 || top_n > 100 || !rankings.length
    || rankings.some(step => step.position !== undefined && step.position !== position
      || step.top_n !== undefined && step.top_n !== top_n)) return false;
  for (const step of rankings) {step.position ??= position; step.top_n ??= top_n;}
  return true;
}

export interface AnalysisPlanDiagnostic {
  code: "REQUIREMENT_UNCOVERED" | "STEP_INVALID" | "BINDING_INVALID" | "EXPLICIT_METRIC_MISSING";
  missing_metrics?: Array<{code: string; name: string}>;
  requirement_ids: string[];
  step_ids: string[];
  next_action: "discover_metrics" | "repair_steps";
}

/** 恢复只使用结构化事实，不解析中文错误文案；未知形状仍交给原严格校验。 */
export function analysisPlanDiagnostics(plan: AnalysisPlan): AnalysisPlanDiagnostic[] {
  const ids = new Set(plan.requirements.map(item => item.id));
  const answered = new Set(plan.steps.flatMap(step => step.answers));
  const uncovered = plan.requirements.filter(item => !answered.has(item.id) && !item.gap_reason?.trim());
  const result: AnalysisPlanDiagnostic[] = uncovered.length ? [{code: "REQUIREMENT_UNCOVERED",
    requirement_ids: uncovered.map(item => item.id), step_ids: [], next_action: "discover_metrics"}] : [];
  const seen = new Set<string>();
  for (const step of plan.steps) {
    if (seen.has(step.id) || !step.metric_refs.length || step.answers.some(id => !ids.has(id))
      || step.method === "compare" && !step.comparisons?.length || step.method === "structure" && !step.relation_id
      || step.depends_on?.some(id => !seen.has(id))) result.push({code: "STEP_INVALID", requirement_ids: step.answers.some(id => ids.has(id))
        ? step.answers.filter(id => ids.has(id)) : [...ids],
        step_ids: [step.id], next_action: "repair_steps"});
    seen.add(step.id);
  }
  return result;
}

export const analysisPlanSchema = {type: "object", required: ["objective", "scope_notice", "requirements", "steps"], additionalProperties: false,
  properties: {
    inquiry: analysisInquirySchema,
    objective: {type: "string", minLength: 1, maxLength: 500}, scope_notice: {type: "string", minLength: 1, maxLength: 500},
    requirements: {type: "array", minItems: 1, maxItems: 8, description: "需要回答的业务疑问，不是表格栏目。精确问值可直接查值；宏观目标围绕规模与收益的差异、分类是否分化、质量如何变化等实际疑问，首批事实后再确定重点，不预先认定结论。", items: {type: "object", required: ["id", "question"], additionalProperties: false,
      properties: {id: {type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]*$", maxLength: 40}, question: {type: "string", minLength: 1, maxLength: 300, description: "用户想弄清的业务问题；不要只把指标名称与环比同比拼成问题。"},
        gap_reason: {type: ["string", "null"], maxLength: 300}}}},
    steps: {type: "array", maxItems: 12, items: {type: "object", required: ["id", "method", "metric_refs", "answers", "rationale"], additionalProperties: false,
      properties: {id: {type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]*$", maxLength: 40},
        method: {enum: ["observe", "compare", "trend", "ranking", "structure"]},
        metric_refs: {type: "array", minItems: 1, maxItems: 12, uniqueItems: true, items: {type: "string"}},
        answers: {type: "array", minItems: 1, maxItems: 8, items: {type: "string"}, description: "必须引用requirements中的id，如q1/q2；不能填问题文本或指标名。"},
        depends_on: {type: "array", maxItems: 12, items: {type: "string"}},
        comparisons: {type: "array", maxItems: 3, uniqueItems: true, items: {enum: ["mom", "yoy", "ytd"]}},
        rationale: {type: "string", minLength: 1, maxLength: 500}, position: {enum: ["top", "bottom"]}, top_n: {type: "integer", minimum: 1, maximum: 100},
        relation_id: {type: ["string", "null"], maxLength: 100}}}},
  }};

export function validateAnalysisPlanShape(raw: unknown): raw is AnalysisPlan {
  if (!raw || typeof raw !== "object") return false;
  const plan = raw as AnalysisPlan;
  if (!plan.objective?.trim() || !plan.scope_notice?.trim() || !Array.isArray(plan.requirements) || !plan.requirements.length
    || plan.requirements.length > 8 || !Array.isArray(plan.steps) || plan.steps.length > 12) return false;
  const requirements = new Set(plan.requirements.map(item => item.id));
  if (requirements.size !== plan.requirements.length || plan.requirements.some(item => typeof item.question !== "string" || !item.question.trim())) return false;
  const seen = new Set<string>(), answered = new Set<string>();
  for (const step of plan.steps) {
    if (seen.has(step.id) || !["observe", "compare", "trend", "ranking", "structure"].includes(step.method)
      || !Array.isArray(step.metric_refs) || !step.metric_refs.length || step.metric_refs.length > 12
      || step.metric_refs.some(ref => typeof ref !== "string" || !ref)
      || !Array.isArray(step.answers) || !step.answers.length || step.answers.some(id => !requirements.has(id))
      || (step.depends_on ?? []).some(id => !seen.has(id)) || !step.rationale?.trim()
      || step.method === "compare" && !step.comparisons?.length || step.method === "structure" && !step.relation_id) return false;
    seen.add(step.id);
    step.answers.forEach(id => answered.add(id));
  }
  return plan.requirements.every(item => answered.has(item.id) || !!item.gap_reason?.trim());
}

/** 返回可以直接纠正的契约错误，避免模型在笼统失败后重复相同参数。 */
export function analysisPlanProblem(raw: unknown): string | undefined {
  if (raw && typeof raw === "object") {
    const plan = raw as Partial<AnalysisPlan>;
    if (!Array.isArray(plan.steps)) return "缺少steps执行步骤。请保留requirements，按子问题填写步骤id、method、metric_refs、answers和rationale；answers逐字引用requirements.id。不能只提交分析目标而没有取数步骤。无可查指标的子问题写gap_reason，steps可以为空数组。";
    const extra = Object.keys(raw).filter(key => !["objective", "scope_notice", "requirements", "steps", "inquiry"].includes(key));
    if (extra.length) return `计划顶层不支持${extra.join("、")}。缺口写在对应requirements项的gap_reason中；每个可执行步骤必须有metric_refs，没有指标的子问题保留为缺口并删除空步骤。`;
    if (Array.isArray(plan.requirements) && Array.isArray(plan.steps)) {
      if (plan.steps.some(step => !step || typeof step !== "object") || plan.requirements.some(item => !item || typeof item !== "object"))
        return "requirements和steps中的每项必须是符合Schema的对象，不传null或字符串。";
      const metricCount = new Set(plan.steps.flatMap(step => step.metric_refs ?? [])).size;
      if (metricCount > 32)
        return `本计划有${metricCount}个不同指标，单批最多32个。先查与用户目标直接相关的核心水平及比较指标，其他子问题保留为明确gap_reason，按证据另批补查；不要删除用户明确要求或重复相同超限计划。`;
      const ids = plan.requirements.flatMap(item => item && typeof item.id === "string" ? [item.id] : []);
      if (new Set(ids).size !== ids.length) return "requirements.id重复。每个子问题使用唯一id，steps.answers引用对应id；不复制整个计划或删除用户问题。";
      const problems: string[] = [];
      for (const step of plan.steps) {
        const invalid = Array.isArray(step?.answers) ? step.answers.filter(id => !ids.includes(id)) : [];
        if (invalid.length) return `步骤${step.id}的answers引用错误：${JSON.stringify(invalid)}。`
          + `answers只能填写requirements.id：${JSON.stringify(ids)}；按该步骤实际回答的问题关联这些ID，不能填写指标名或问题文本。其他正确条件保持。`;
        if (!step?.metric_refs?.length) problems.push(`步骤${step?.id}没有可执行指标。将缺口写到对应requirements.gap_reason，并删除这个空步骤；保留用户目标，不删除未完成的子问题。`);
        if (step?.method === "compare" && !step.comparisons?.length) problems.push(`步骤${step.id}使用compare时必须提供comparisons（mom/yoy/ytd）。正式比较指标本身取值用observe，不对差额再做相同比较。`);
        if (step?.method === "structure" && !step.relation_id) return `步骤${step.id}没有正式relation_id，不能做结构分解。改用observe并列读取这些指标，说明缺少审核关系、不计算占比或贡献；其他有效步骤保留。整体经营还应按目标探索收益、质量等方面，不能仅凭存贷款代替全部经营。`;
      }
      if (problems.length) return problems.join("\n");
      const answered = new Set(plan.steps.flatMap(step => step.answers ?? []));
      const uncovered = plan.requirements.filter(item => !answered.has(item.id) && !item.gap_reason?.trim());
      if (uncovered.length) return `以下子问题没有对应步骤，也没有具体缺口：${JSON.stringify(uncovered.map(item => ({id: item.id, question: item.question})))}。`
        + "请为这些id补充使用正式目录引用的steps（answers填写对应id）；没有所需指标先查analysis_catalog，确认仍不可获得才写gap_reason。保留其他正确步骤，不删除问题，不把尚未查询当作没有数据。";
      const seen = new Set<string>();
      for (const step of plan.steps) {
        if (seen.has(step.id)) return `步骤id重复：${step.id}。每个步骤使用唯一id，不能复制已经提交的步骤。`;
        const missing = (step.depends_on ?? []).filter(id => !seen.has(id));
        if (missing.length) return `步骤${step.id}的depends_on不是已排在前面的步骤：${JSON.stringify(missing)}。按依赖顺序排列并检查是否成环，独立步骤省略depends_on。`;
        seen.add(step.id);
      }
    }
  }
  try {if (validateAnalysisPlanShape(raw)) return undefined;} catch { /* 后端仍保留最终严格校验。 */ }
  return "按通用计划Schema提交objective、scope_notice、requirements和无环steps；每项子问题有步骤或明确缺口，使用analysis_catalog签发的binding_ref。";
}
