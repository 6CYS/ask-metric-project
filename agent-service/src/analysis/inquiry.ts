import type {EvidenceReference} from "../answerEvidence.js";
import type {AskMetricRequestContext} from "../requestContext.js";
import {analysisEvidenceAliases} from "./verifiedFindings.js";

/** 回执给出当前已签发步骤的来源配对，多目标补查不让模型猜current指向谁。 */
export async function analysisFollowupSource(request: AskMetricRequestContext) {
  if (!request.semanticStep || !request.semanticTasks) return undefined;
  const plan = await request.semanticTasks.plan(request.semanticStep.planRef);
  if (!plan || plan.owner !== request.actor.id) return undefined;
  const matches = plan.steps.filter(step => step.operationId === request.operationId);
  if (matches.length !== 1) return undefined;
  const step = matches[0]!, task = step.taskRef ? await request.semanticTasks.get(step.taskRef) : undefined;
  if (!task || task.owner !== request.actor.id || task.target.ref !== step.targetRef) return undefined;
  return {kind: "reference" as const, task_ref: plan.ref, target_ref: step.targetRef};
}

/** 补查是待验证的问题，不能作为已发生的业务事实展示。 */
export interface AnalysisInquiry {
  question: string;
  prior_judgment: string;
  basis_refs: string[];
  expected_change: string;
}

export const analysisInquirySchema = {type: "object", additionalProperties: false,
  required: ["question", "prior_judgment", "basis_refs", "expected_change"], properties: {
    question: {type: "string", minLength: 1, maxLength: 300, description: "此次新增取数要解决的具体疑问。"},
    prior_judgment: {type: "string", minLength: 1, maxLength: 500, description: "现有证据支持的初步判断，或尚待核验的解释，不能先认定原因。"},
    basis_refs: {type: "array", minItems: 1, maxItems: 8, uniqueItems: true, items: {type: "string"}, description: "触发补查的本轮已有事实原子ref；不能填目录、整份回执或历史引用。"},
    expected_change: {type: "string", minLength: 1, maxLength: 500, description: "新证据将如何支持、修正或限定初步判断；不能只写补齐栏目。"},
  }};

type Atom = {ref: string; type?: string; value?: unknown; display?: string; date?: string; metric_code?: string; org_code?: string; judgment_kind?: string; input_refs?: string[]};
function atoms(source: EvidenceReference) {
  const items = (source.evidence as {evidence_items?: Atom[]}).evidence_items ?? [];
  return items.filter(atom => !["observation", "gap"].includes(atom.type ?? ""));
}
function aliases(source: EvidenceReference) {
  // 通用回执的编号包含gap位置，须与生产端的非observation序号完全一致。
  const items = (source.evidence as {evidence_items?: Atom[]}).evidence_items ?? [];
  const base = new Set(atoms(source).map(atom => atom.ref));
  const allowed = new Set([...base, ...items.filter(atom => atom.judgment_kind && atom.input_refs?.length
    && atom.input_refs.every(ref => base.has(ref))).map(atom => atom.ref)]);
  return [...allowed, ...(source.evidence.kind === "analysis_evidence"
    ? [...analysisEvidenceAliases(source.ref, items)].filter(([, ref]) => allowed.has(ref)).map(([alias]) => alias) : [])];
}

export function inquiryProblem(inquiry: AnalysisInquiry | undefined, previous: EvidenceReference[], requireInquiry = true) {
  if (!inquiry) return requireInquiry && previous.some(source => atoms(source).length)
    ? "补查计划缺少inquiry。请说明question、prior_judgment、basis_refs和expected_change：用已有事实触发一个具体疑问，说明新证据如何支持、修正或限定判断；若没有新问题，直接交付已有结果，不为补齐栏目查询。" : undefined;
  if (![inquiry.question, inquiry.prior_judgment, inquiry.expected_change].every(value => typeof value === "string" && value.trim())
    || !Array.isArray(inquiry.basis_refs) || !inquiry.basis_refs.length || inquiry.basis_refs.length > 8
    || new Set(inquiry.basis_refs).size !== inquiry.basis_refs.length) return "inquiry需包含具体疑问、初步判断、已有事实引用与预期判断变化。";
  const known = new Set(previous.flatMap(aliases));
  if (inquiry.basis_refs.some(ref => !known.has(ref))) return "inquiry.basis_refs只能引用本轮此前取得的事实或计算原子，不能使用目录、历史、缺口、未来或整份回执。请按已有回执修正。";
}

/** 只判断是否新增可引用证据；支持/修正/限定哪项业务判断由模型结合证据作出。 */
export function inquiryReview(inquiry: AnalysisInquiry | undefined, previous: EvidenceReference[], current: EvidenceReference) {
  if (!inquiry) return undefined;
  const identity = (atom: Atom) => JSON.stringify([atom.metric_code && atom.date ? [atom.metric_code, atom.org_code, atom.date] : atom.ref,
    atom.type, atom.value ?? atom.display]);
  const known = new Set(previous.flatMap(source => atoms(source).map(identity)));
  const items = (current.evidence as {evidence_items?: Atom[]}).evidence_items ?? [];
  const added = items.filter(atom => atom.type !== "observation").flatMap((atom, i) =>
    atom.type === "gap" || known.has(identity(atom)) ? [] : [current.evidence.kind === "analysis_evidence" ? `${current.ref}.v${i + 1}` : atom.ref]);
  return {...inquiry, outcome: added.length ? "evidence_added" : "no_new_evidence", new_evidence_refs: added,
    next_action: "回到此次具体疑问：说明新证据支持、修正还是限定了原判断；没有新增事实则说明仍未解决。正文吸收有用的结论，不必另开固定补查章节；不得把新数据出现本身当作因果证明。"};
}
