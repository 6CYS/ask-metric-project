import type {AnalysisInquiry} from "./inquiry.js";

/** 通用计划只引用服务端目录绑定；领域名称不作为能力枚举或准入条件。 */
export interface AnalysisPlan {
  objective: string;
  scope_notice: string;
  inquiry?: AnalysisInquiry;
  requirements: Array<{id: string; question: string; gap_reason?: string | null; deferred_reason?: string | null}>;
  steps: Array<{id: string; method: "observe" | "compare" | "trend" | "ranking" | "structure";
    metric_refs: string[]; answers: string[]; depends_on?: string[]; comparisons?: Array<"mom" | "yoy" | "ytd">;
    rationale: string; position?: "top" | "bottom"; top_n?: number; relation_id?: string | null}>;
}

export interface AnalysisPlanDiagnostic {
  code: "REQUIREMENT_UNCOVERED" | "STEP_INVALID" | "BINDING_INVALID";
  requirement_ids: string[];
  step_ids: string[];
  next_action: "discover_metrics" | "repair_steps";
}
