import type {BusinessEvidence} from "../answerEvidence.js";
import type {AnalysisPlan} from "./contracts.js";
import type {VerifiedFindings} from "./verifiedFindings.js";
import type {AvailabilityRequest, BasicQuerySpec} from "../backendClient.js";

export interface AnalysisEvidence extends BusinessEvidence {
  kind: "analysis_evidence"; run_ref: string; scope_id: string; frame_id?: string;
  execution_turn_id?: string;
  result_reused?: boolean;
  inquiry_scope_role?: "reference";
  analysis_date: string | null; org_codes: string[]; rows: unknown[]; plan: AnalysisPlan;
  date_selection?: string; requested_start?: string | null; requested_end?: string | null;
  checked_on?: string;
  coverage_checks?: Array<{request: AvailabilityRequest; scope?: string; date_count?: number;
    earliest?: string | null; latest?: string | null; dates?: string[]; has_more?: boolean; gaps?: string[]}>;
  tasks?: Array<{task_id: string; status: string; request?: BasicQuerySpec; truncated?: boolean; error_code?: string | null}>;
  requirement_dispositions?: Array<{id: string; question: string; status: string; step_ids: string[]}>;
  metric_descriptors: Array<{binding_ref: string; code: string; name?: string}>;
  verified_findings?: VerifiedFindings;
  evidence_items?: Array<{ref: string; type?: string; metric_code?: string; metric_name?: string;
    org_code?: string; date?: string; value?: string; display?: string; judgment_kind?: string; input_refs?: string[]; step_ids?: string[]}>;
}
