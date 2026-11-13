import type { ProjectedMessage } from "../sessionProjection.js";
import type { ConfigurationVersions } from "../configurationVersions.js";

export interface EvaluationQuestion {
  id: string;
  question: string;
  expected: string;
}
export interface EvaluationGroup {
  id: string;
  name: string;
  turns: EvaluationQuestion[];
}
export interface DatasetInput {
  name: string;
  description: string;
  groups: EvaluationGroup[];
}
export interface EvaluationDataset extends DatasetInput {
  id: string;
  version: number;
  updated_at: string;
}
export type RunStatus =
  "running" | "cancelling" | "completed" | "failed" | "cancelled" | "interrupted" | "deleting";
export type TurnStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "skipped";
export interface EvaluationReview {
  verdict: "passed" | "failed" | "needs_review";
  note: string;
  updated_at: string;
  reviewer: string;
}
export interface ExecutionIdentity {
  user_entry_id: string | null;
  operation_id: string | null;
}
export interface ExecutionResult extends ExecutionIdentity {
  status: "completed" | "failed" | "cancelled";
  run_status: string | null;
  answer_status: string | null;
  error_code: string | null;
  error_message: string | null;
  timings_ms: Record<string, number | number[] | null>;
}
export interface AcceptedExecution extends ExecutionIdentity {
  status: "running";
  run_status: null;
  answer_status: null;
  error_code: null;
  error_message: null;
  timings_ms: Record<string, number | number[] | null>;
}
export interface EvaluationTurn {
  id: string;
  group_id: string;
  question: string;
  expected: string;
  status: TurnStatus;
  session_id: string | null;
  request_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  result: ExecutionResult | AcceptedExecution | null;
  review: EvaluationReview | null;
}
export interface EvaluationRun {
  id: string;
  name: string;
  status: RunStatus;
  dataset: EvaluationDataset;
  dataset_hash: string;
  version_label: string;
  data_label: string;
  model: string;
  config_hash: string;
  configuration_versions?: ConfigurationVersions;
  actor: { id: string; name: string; org_code: string; role_code: string };
  created_at: string;
  finished_at: string | null;
  turns: EvaluationTurn[];
}
export interface RunInput {
  dataset_id: string;
  dataset_version: number;
  name: string;
  version_label: string;
  data_label: string;
}
export interface EvaluationTurnDetail {
  turn: EvaluationTurn;
  messages: ProjectedMessage[];
}
export type EvaluationRequest = (
  path: string,
  init?: RequestInit,
  versions?: ConfigurationVersions,
) => Promise<Response>;
export interface SessionEvaluationClient {
  createSession(token: string): Promise<string>;
  deleteSession(token: string, sessionId: string, signal?: AbortSignal): Promise<void>;
  executeTurn(input: {
    token: string;
    sessionId: string;
    requestId: string;
    question: string;
    configurationVersions?: ConfigurationVersions;
    signal: AbortSignal;
    onIdentity?: (identity: ExecutionIdentity) => void | Promise<void>;
    cancel?: () => Promise<void>;
  }): Promise<ExecutionResult>;
  readTurn(token: string, sessionId: string, userEntryId: string): Promise<ProjectedMessage[]>;
  cancelTurn(token: string, sessionId: string, requestId: string): Promise<void>;
}
