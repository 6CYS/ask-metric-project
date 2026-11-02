import type {AnalysisInquiry} from "../analysis/inquiry.js";

export interface OverviewPlan {
  topic?: "loan" | "deposit";
  topic_version?: string;
  goal: "overview" | "growth" | "structure" | "quality";
  sections: Array<"scale" | "growth" | "structure" | "quality">;
  objective?: string;
  questions?: string[];
  metric_ids?: string[];
  comparisons?: Array<"mom" | "yoy" | "ytd">;
  rationale?: string;
  inquiry?: AnalysisInquiry;
}
