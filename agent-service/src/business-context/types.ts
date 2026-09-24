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
/** 后端指标 mention 的逐条解析快照；存入字段 metadata，供跨轮确认、显式放弃与覆盖率复核复用。 */
export interface MentionResolution {
  text: string;
  start: number;
  end: number;
  status: string;
  value?: {codes: string[]; names: string[]};
  candidates?: unknown[];
}
export interface FrameSelector {
  frameId?: string;
  ordinal?: number;
  relativePosition?: number;
  capability?: string;
  businessConstraints?: Record<string, unknown>;
  resultRequired?: boolean;
}
export interface FieldChange { fieldHint: string; operation: "set" | "clear" | "retain" | "remove"; rawValue?: unknown }
export interface ContextDelta {
  capabilityHint?: string;
  /** 首次声明或新用户回合明确改变目标，必须附本轮原文依据。 */
  goal?: {capability: string; sourceText: string};
  purpose?: "goal" | "supporting";
  /** null 明确新建；省略使用焦点；对象必须唯一定位，禁止回退。 */
  baseReference?: FrameSelector | null;
  fieldChanges: FieldChange[];
  executionMode: "execute" | "resolve_more" | "reuse_result";
}
export interface BusinessGoal {
  turnId: string;
  capability: string;
  /** 本轮开始时的可信条件来源，辅助步骤不能夺取此焦点。 */
  baseFrameId?: string;
}
export interface BusinessFrame {
  frameId: string;
  sessionId: string;
  turnId: string;
  requestId: string;
  capability: string;
  goalCapability?: string;
  purpose?: "goal" | "supporting";
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
  /** 模型负责选择的内部控制字段缺失，不能要求用户填写枚举。 */
  missingIsArgumentError?: boolean;
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
  completeFields?: (fields: Record<string, ResolvedField>, delta: ContextDelta) => void;
  validate?: (fields: Record<string, ResolvedField>) => ValidationIssue[];
}
export type QueryOperation = {kind: "value"} | {kind: "ranking"; order: "asc" | "desc"; top_n: number};
export type OrganizationScope = {kind: "authorized_cohort"; cohort: "rural_commercial_banks"} | {kind: "children_of"; parent_code: string};
export type OrganizationScopeInput = {kind: "authorized_cohort"; cohort: "rural_commercial_banks"; sourceText: string} | {kind: "children_of"; parentName: string; sourceText: string};
export interface ResolvedOrganizations {codes: string[]; names: string[]; scope?: OrganizationScope; scope_fingerprint?: string}
export interface ResolverContext {
  originalMessage: string;
  currentDate: string;
  turnId: string;
  previous?: ResolvedField;
  previousTurnId?: string;
  inputSource?: "explicit" | "inherited";
  /** 本轮字段操作；remove 只路由给声明支持的 Resolver，用于按 mention 放弃部分项。 */
  fieldOperation?: FieldChange["operation"];
  resolveFactBindings?(bindings: Record<string, {fact_id: string}>): Promise<FieldResolution>;
  resolveMetricMentions?(): Promise<import("./metricMentions.js").MetricMentions>;
  resolveOrganizationScope?(scope: OrganizationScopeInput): Promise<FieldResolution>;
  resolveCatalog(entity: string, raw: string[], referenceYear?: number): Promise<FieldResolution>;
}
export interface FieldResolver {
  name: string;
  /** 声明支持 remove 操作；未声明的字段收到 remove 时由主循环直接报参数错误，不静默退化为继承。 */
  removable?: boolean;
  supports(schema: FieldSchema): boolean;
  resolve(raw: unknown, schema: FieldSchema, context: ResolverContext): Promise<FieldResolution>;
}
export interface FrameResolution { status: "resolved" | "ambiguous" | "not_found"; frameId?: string; candidates?: string[] }
export interface FrameStore {
  goal(turnId: string): Promise<BusinessGoal | undefined>;
  bindGoal(goal: BusinessGoal): Promise<BusinessGoal>;
  state(): Promise<BusinessSessionState>;
  get(frameId: string): Promise<BusinessFrame | undefined>;
  list(): Promise<BusinessFrame[]>;
  command(key: string): Promise<BusinessFrame | undefined>;
  save(frame: BusinessFrame, expectedVersion: number, commandKey: string, focus?: boolean): Promise<BusinessFrame>;
  setFocus(frameId: string, expectedVersion: number): Promise<void>;
}
