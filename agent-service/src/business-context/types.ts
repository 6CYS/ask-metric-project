/** 业务状态契约：不保存聊天消息，字段、继承和执行规则由能力注册表声明。 */
export type ResolutionStatus = "resolved" | "missing" | "ambiguous" | "not_found" | "needs_confirmation" | "invalid" | "temporary_error";
export interface FieldCandidate { value: unknown; code?: string; score?: number;
  /** 后端或模型建议通道标记的首选候选：澄清展示置顶并改为确认式话术。 */
  preferred?: boolean; metadata?: Record<string, unknown> }
/** 模型随原文提交的日期换算结果（ISO YYYY-MM-DD）；严格日历与口径校验在服务端。 */
export interface DateModelValue { start: string; end: string; dates?: string[] }
/** “近N年”默认滚动口径的完整年度备选；仅后端在默认解析时给出，随字段 metadata 透传前端切换。 */
export interface TimeAlternative { label: string; start: string; end: string }
export interface FieldResolution {
  status: ResolutionStatus;
  value?: unknown;
  code?: string;
  candidates?: FieldCandidate[];
  metadata?: Record<string, unknown>;
  alternative?: TimeAlternative;
}
export interface ResolvedField extends Omit<FieldResolution, "status" | "value"> {
  rawValue?: unknown;
  resolvedValue?: unknown;
  resolutionStatus: ResolutionStatus;
  source: "explicit" | "inherited" | "resolved" | "confirmed";
  resolver?: string;
  sourceFrameId?: string;
}
/** 仅说明合法调用边界，不替模型选择业务含义，也不自动修改字段。 */
export interface FieldInputCorrection {
  field: string;
  reason: "missing" | "invalid";
  message: string;
  allowedValues?: unknown[];
  inputSchema?: Record<string, unknown>;
  /** 仅提供允许的恢复路径，不判断本次错误是否源于用户业务缺项。 */
  userClarification?: {question: string; instruction: string};
  context?: {timeKind?: "single_day" | "continuous_range" | "discrete_dates"; operationKind?: "value" | "ranking" | "rank_position"};
}
export interface ValidationIssue { field: string; reason: Exclude<ResolutionStatus, "resolved">; message?: string; correction?: FieldInputCorrection }
/** 后端指标 mention 的逐条解析快照；存入字段 metadata，供跨轮确认、显式放弃与覆盖率复核复用。 */
export interface MentionResolution {
  text: string;
  start: number;
  end: number;
  status: string;
  value?: {codes: string[]; names: string[]};
  candidates?: unknown[];
  /** 同一基础指标下的各口径片段共用组号：确认一次基础指标即确定整组。 */
  group?: {id: string};
  /** 后端匹配/纠错来源，保留原文到正式身份的审计依据，不是执行权限。 */
  metadata?: Record<string, unknown>;
}
export interface FrameSelector {
  frameId?: string;
  ordinal?: number;
  relativePosition?: number;
  capability?: string;
  businessConstraints?: Record<string, unknown>;
  resultRequired?: boolean;
}
/** 模型解释指代，服务端仅接受显式历史字段来源，不从措辞推断集合。 */
export interface HistoryFieldReferenceInput {
  fromHistory: true;
  sourceText: string;
  sources: Array<{frame: FrameSelector; field: string}>;
  combine: "single" | "union";
  expectedCount?: number;
  /** 与明确历史来源合并的本轮新增名称，仍由目录解析正式编码。 */
  add?: string[];
  /** 显式保留同一已保存组合的新增项与数量约束，未被替换的未决项继续阻断执行。 */
  retainResolvedAdditions?: true;
  /** 按上一字段保存的未决项索引替换名称，未列出的未决项继续保留。 */
  replaceAdditions?: Array<{index: number; value: string}>;
}
export interface FieldChange { fieldHint: string; operation: "set" | "clear" | "retain" | "remove"; rawValue?: unknown }
/** 本轮目标声明只表达用户意图，业务值仍由字段 Resolver 提供。 */
export interface FieldTurnIntent {
  mode: "inherit" | "set" | "confirm" | "clear" | "remove";
  sourceText: string | null;
  expectedCount: number | null;
}
export interface ContextDelta {
  capabilityHint?: string;
  /** 首次声明或新用户回合明确改变目标，必须附本轮原文依据。 */
  goal?: {capability: string; sourceText: string};
  purpose?: "goal" | "supporting";
  /** null 明确新建；省略使用焦点；对象必须唯一定位，禁止回退。 */
  baseReference?: FrameSelector | "current" | null;
  fieldChanges: FieldChange[];
  /** 旧快照可缺省；模型工具入口必须按能力声明覆盖目标字段。 */
  fieldIntents?: Record<string, FieldTurnIntent>;
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
  /** 已核验选择单独保存；有本轮依据的变化须落实，无依据的额外动作可明确继承取消。 */
  recovery?: {turnId: string; pendingFields: string[]; selectionFrameId: string; optionIds: string[];
    /** 旧快照可缺省；缺少来源记录时不推断 inherit，可沿用显式 retain 的旧恢复契约。 */
    pendingChanges?: Array<{field: string; operation: FieldTurnIntent["mode"]; sourceText?: string; mayRetain: boolean; expectedCount?: number}>};
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
  /** 仅显式业务缺项可请求澄清；问题由服务端声明，模型不提供问题或候选。 */
  userClarification?: {question: string};
  required: boolean;
  /** 模型负责选择的内部控制字段缺失，不能要求用户填写枚举。 */
  missingIsArgumentError?: boolean;
  resolver: string;
  inheritable: boolean;
  clearable?: boolean;
  confirmationRequired?: boolean;
  /** 启用目标声明校验；必需字段始终声明，可选字段仅在本轮实际修改时必需声明。 */
  requireTurnIntent?: boolean;
  /** 已解析集合所在的顶层数组属性；计数完整集合，不截断或选择成员。 */
  turnIntentCollection?: string;
  allowedSourceCapabilities?: string[];
  validation?: { enum?: unknown[]; min?: number; max?: number };
}
export interface CapabilitySchema {
  capability: string;
  fields: Record<string, FieldSchema>;
  tool: string;
  completeFields?: (fields: Record<string, ResolvedField>, delta: ContextDelta, context: ResolverContext, base?: BusinessFrame) => void | Promise<void>;
  validate?: (fields: Record<string, ResolvedField>) => ValidationIssue[];
}
/** 排名只表达前 N / 后 N；名次类指标的实际排序方向由后端按目录属性决定。 */
export type QueryOperation = {kind: "value"} | {kind: "ranking"; position: "top" | "bottom"; top_n: number} | {kind: "rank_position"};
export type OrganizationScope = {kind: "authorized_cohort"; cohort: "rural_commercial_banks"} | {kind: "children_of"; parent_code: string};
export type OrganizationScopeInput = {kind: "authorized_cohort"; cohort: "rural_commercial_banks"; sourceText: string} | {kind: "children_of"; parentName: string; sourceText: string};
export interface ResolvedOrganizations {codes: string[]; names: string[]; scope?: OrganizationScope; scope_fingerprint?: string}
export type ExecutionSettlement = Pick<BusinessFrame, "status" | "resultRef" | "resultSummary" | "errorCode">;
export interface ResolverContext {
  originalMessage: string;
  currentDate: string;
  turnId: string;
  /** 仅由宿主工具入口绑定，模型参数不能关闭目标声明门禁。 */
  requireFieldIntents?: boolean;
  /** 宿主绑定的前端点选来源，模型参数不得创建或更换。 */
  confirmationSelection?: {frameId: string; optionIds: string[]};
  previous?: ResolvedField;
  previousTurnId?: string;
  inputSource?: "explicit" | "inherited";
  /** 由字段合并入口绑定，模型不能更改引用的目标字段。 */
  fieldName?: string;
  /** 本轮字段操作；remove 只路由给声明支持的 Resolver，用于按 mention 放弃部分项。 */
  fieldOperation?: FieldChange["operation"];
  /** 本字段待确认的规范清单与系统按用户回复确定的所选项（主循环计算，模型不参与）。 */
  confirmation?: {options: import("./clarificationOptions.js").ClarificationOption[]; selected: import("./clarificationOptions.js").ClarificationOption[]};
  /** 用户回复的依据：原文、目录识别编码、前端点选（仅对指定待确认 Frame 有效）。 */
  replyEvidence?(frameId: string): Promise<import("./clarificationOptions.js").ReplyEvidence>;
  resolveFactBindings?(bindings: Record<string, {fact_id: string}>): Promise<FieldResolution>;
  /** 保存规划前核对主题指标，参数错误不得污染当前已成功的业务焦点。 */
  validateOverviewPlan?(plan: import("../tools/businessOverview.js").OverviewPlan): Promise<void>;
  validateAnalysisPlan?(plan: import("../analysis/contracts.js").AnalysisPlan): Promise<import("../analysis/contracts.js").AnalysisPlan | void>;
  /** 仅实际提供通用目录与计划校验的宿主开启，旧客户端和隔离解析器保持兼容。 */
  analysisFallbackAvailable?: boolean;
  /** 默认匹配本轮原文；继承重试上次临时失败的指标时传入当时的原句。 */
  resolveMetricMentions?(question?: string): Promise<import("./metricMentions.js").MetricMentions>;
  resolveFieldReference?(input: HistoryFieldReferenceInput, targetField: string, inputSource?: "explicit" | "inherited", previous?: ResolvedField): Promise<FieldResolution>;
  /** 从目录匹配原文中的机构名/别名，编码解析与权限仍由字段 Resolver 校验。 */
  organizationMentions?(): Promise<string[]>;
  /** 统一语义入口已从当前原文正式绑定的完整机构身份；仅供内部分析适配器衔接，不由模型提供。 */
  boundOrganizationCodes?: readonly string[];
  /** 仅分析适配器绑定的原文确定性日历；不是模型的换算建议，不能从公开参数写入。 */
  boundAnalysisCalendar?: {raw: string; value: {start: string; end: string; dates?: string[]}};
  /**
   * 机构话语指代（“上述三家”“那两家”等本轮原文）：按会话历史中最近讨论的去重机构解析。
   * 原文不是指代时返回 undefined（走目录匹配）；指代但无法唯一确定（无数量、历史不足）返回 not_found 交用户澄清。
   */
  resolveOrganizationReference?(raw: string): Promise<FieldResolution | undefined>;
  resolveOrganizationScope?(scope: OrganizationScopeInput): Promise<FieldResolution>;
  /**
   * 上一轮遗留的执行中 Frame：按发送前登记的幂等键只读回查真实终态，不重发查询。
   * 仍在执行或暂时无法确认时返回 undefined，Frame 保持 executing。
   */
  reconcileExecution?(frame: BusinessFrame): Promise<ExecutionSettlement | undefined>;
  /** 宿主绑定的口径切换时间（前端 time_override，已经路由层校验）：等同用户明确指定，模型参数不能创建或改写。 */
  timeOverride?: {start: string; end: string};
  resolveCatalog(entity: string, raw: string[], referenceYear?: number, modelValue?: DateModelValue | null): Promise<FieldResolution>;
}
export interface FieldResolver {
  name: string;
  /** Schema 拒绝时补充可修正的诊断，不代替 Schema 或业务校验。 */
  inputProblem?(raw: unknown): string | undefined;
  /** 声明支持 remove 操作；未声明的字段收到 remove 时由主循环直接报参数错误，不静默退化为继承。 */
  removable?: boolean;
  supports(schema: FieldSchema): boolean;
  /** 无副作用的恢复门禁：只识别必须等待用户的已知状态，不能解析目录或生成字段事实。 */
  recoveryPreflight?(raw: unknown, schema: FieldSchema, context: ResolverContext, intent?: FieldTurnIntent): void;
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
