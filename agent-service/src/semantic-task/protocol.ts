import type {AnalysisPlan} from "../analysis/contracts.js";
import type {OverviewPlan} from "../tools/businessOverview.js";
import type {ModelAnswerInput} from "./questions.js";
import type {OrganizationScopeInput, QueryOperation} from "../business-context/types.js";
export type {ModelAnswerInput} from "./questions.js";
export type SemanticField = "organizations" | "comparison_organizations" | "metrics" | "time" | "selection" | "operation" | "objective" | "calculation" | "availability" | "_analysis";
export type EnhancedAnalysis = ({kind: "business_overview"; plan: OverviewPlan} | {kind: "business_analysis"; plan: AnalysisPlan})
  & {organizations?: StructuredOrganization | null};
/** 模型按有权机构清单自主判断的机构结论：code/name 至少其一取自清单，excerpt 仅记录用户原文片段。 */
export interface OrgSuggestion {code?: string; name?: string; excerpt?: string}
export type ModelCalendar = {start: string; end: string; dates?: string[]};
export type StructuredOrganization = {kind: "named"; names: string[]; suggestion?: OrgSuggestion}
  | {kind: "authorized_cohort"; cohort: "rural_commercial_banks"; source_text: string}
  | {kind: "children_of"; parent_name: string; source_text: string};
export type StructuredOperation = QueryOperation | {kind: "sort"; direction: "ascending" | "descending"}
  | {kind: "ranking"; position: "top" | "bottom" | null; top_n: number | null};
export interface StructuredQuery {
  objective?: string;
  organizations: StructuredOrganization | null;
  metrics: string[] | null;
  time: {expression: string; calendar?: ModelCalendar} | null;
  selection: "exact" | "latest" | "latest_in_range" | "all_in_range" | null;
  operation: StructuredOperation;
  comparison_organizations?: StructuredOrganization | null;
}
/** 旧操作快照中的字段绑定，仅供历史记录读取。 */
export interface QueryBinding {structured?: true; values?: string[]; organizationScope?: OrganizationScopeInput;
  queryOperation?: StructuredOperation; selectionValue?: StructuredQuery["selection"]}
export type SemanticOperation = ({action: "set" | "add" | "confirm"; field: SemanticField; value: string; suggestion?: OrgSuggestion; modelCalendar?: ModelCalendar} & QueryBinding)
  | {action: "replace"; field: SemanticField; subject: string; value: string; suggestion?: OrgSuggestion; modelCalendar?: ModelCalendar}
  | {action: "exclude"; field: SemanticField; subject: string} | {action: "clear"; field: SemanticField}
  | {action: "copy"; field: SemanticField; reference: SemanticReference}
  | {action: "select"; field: "organizations"; offset: number; limit: number}
  | {action: "rank_all"; field: "operation"; direction: "ascending" | "descending"};
export type SemanticReference = {task_ref: string; target_ref: string};
export type SemanticSource = {kind: "new" | "current"} | ({kind: "reference"} & SemanticReference)
  | {kind: "references"; references: SemanticReference[]};
export interface SemanticRequest {protocol_version: 2; context_action?: "resume" | "defer" | "abandon"; intent: "query" | "prepare" | "reuse" | "analyze" | "availability" | "calculate";
  answers?: ModelAnswerInput[]; targets: Array<{source: SemanticSource; operations: SemanticOperation[]; query?: StructuredQuery; analysis?: EnhancedAnalysis}>}
