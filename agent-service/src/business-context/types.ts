/** 业务状态契约：不保存聊天消息，字段、继承和执行规则由能力注册表声明。 */
export type ResolutionStatus = "resolved" | "missing" | "ambiguous" | "not_found" | "needs_confirmation" | "invalid" | "temporary_error";
export interface FieldCandidate { value: unknown; code?: string; score?: number; metadata?: Record<string, unknown> }
export interface FieldResolution {
  status: ResolutionStatus;
  value?: unknown;
  code?: string;
  candidates?: FieldCandidate[];
  metadata?: Record<string, unknown>;
}
export interface ResolvedField extends Omit<FieldResolution, "status" | "value"> {
  rawValue?: unknown;
  resolvedValue?: unknown;
  resolutionStatus: ResolutionStatus;
  source: "explicit" | "inherited" | "resolved" | "confirmed";
  resolver?: string;
  sourceFrameId?: string;
}
export interface ValidationIssue { field: string; reason: Exclude<ResolutionStatus, "resolved">; message?: string }
export interface FrameSelector {
  frameId?: string;
  ordinal?: number;
  relativePosition?: number;
  capability?: string;
  businessConstraints?: Record<string, unknown>;
  resultRequired?: boolean;
}
export interface FieldChange { fieldHint: string; operation: "set" | "clear" | "retain"; rawValue?: unknown }
export interface ContextDelta {
  capabilityHint?: string;
  /** null 明确新建；省略使用焦点；对象必须唯一定位，禁止回退。 */
  baseReference?: FrameSelector | null;
  fieldChanges: FieldChange[];
  executionMode: "execute" | "resolve_more" | "reuse_result";
}
export interface BusinessFrame {
  frameId: string;
  sessionId: string;
  turnId: string;
  requestId: string;
  capability: string;
  parentFrameId?: string;
  /** 一次用户业务操作的根；执行过程中的状态快照不占用历史操作序号。 */
  operationFrameId: string;
  fields: Record<string, ResolvedField>;
  delta: ContextDelta;
  issues: ValidationIssue[];
  status: "draft" | "clarifying" | "ready" | "executing" | "success" | "failed";
  resultRef?: string;
  resultSummary?: { rowCount?: number; truncated?: boolean; fields?: Record<string, unknown> };
  errorCode?: string;
  createdAt: string;
}
export interface BusinessSessionState {
  sessionId: string;
  version: number;
  focusFrameId?: string;
  frameOrder: string[];
  /** 每个业务操作最新快照，selector 的 ordinal/relativePosition 以此为准。 */
  operations: Record<string, string>;
}
export interface FieldSchema {
  label: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  required: boolean;
  resolver: string;
  inheritable: boolean;
  clearable?: boolean;
  confirmationRequired?: boolean;
  allowedSourceCapabilities?: string[];
  validation?: { enum?: unknown[]; min?: number; max?: number };
}
export interface CapabilitySchema {
  capability: string;
  fields: Record<string, FieldSchema>;
  tool: string;
  validate?: (fields: Record<string, ResolvedField>) => ValidationIssue[];
}
export interface ResolverContext {
  originalMessage: string;
  currentDate: string;
  turnId: string;
  previous?: ResolvedField;
  previousTurnId?: string;
  inputSource?: "explicit" | "inherited";
  resolveFactBindings?(bindings: Record<string, {fact_id: string}>): Promise<FieldResolution>;
  resolveMetricMentions?(): Promise<import("./metricMentions.js").MetricMentions>;
  resolveCatalog(entity: string, raw: string[], referenceYear?: number): Promise<FieldResolution>;
}
export interface FieldResolver {
  name: string;
  supports(schema: FieldSchema): boolean;
  resolve(raw: unknown, schema: FieldSchema, context: ResolverContext): Promise<FieldResolution>;
}
export interface FrameResolution { status: "resolved" | "ambiguous" | "not_found"; frameId?: string; candidates?: string[] }
export interface FrameStore {
  state(): Promise<BusinessSessionState>;
  get(frameId: string): Promise<BusinessFrame | undefined>;
  list(): Promise<BusinessFrame[]>;
  command(key: string): Promise<BusinessFrame | undefined>;
  save(frame: BusinessFrame, expectedVersion: number, commandKey: string, focus?: boolean): Promise<BusinessFrame>;
  setFocus(frameId: string, expectedVersion: number): Promise<void>;
}
