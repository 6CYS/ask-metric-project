export interface ResolutionFailureDisposition {
  readonly retryable: false;
  readonly message: string;
  readonly instruction: string;
}

const instruction = "这是当前条件下确定无法完成的业务请求，不是临时故障。保持用户原始目标，说明无法完成的原因后结束本轮；不得自动重试、改写字段或切换业务能力绕过限制，也不得自行缩小或扩大机构范围。";

// 只分级已确认的确定错误；未知码与参数纠错仍走各自原有处理路径。
const dispositions = Object.freeze({
  EMPTY_AUTHORIZED_SCOPE: Object.freeze({retryable: false,
    message: "您指定的机构范围内没有当前账号可查看的机构，无法完成本次查询。", instruction}),
  UNSUPPORTED_QUERY_COMBINATION: Object.freeze({retryable: false,
    message: "当前系统不支持按您要求的条件组合查询。", instruction}),
  UNSUPPORTED_ORGANIZATION_SCOPE: Object.freeze({retryable: false,
    message: "当前系统不支持按您指定的机构范围查询数据覆盖情况。", instruction}),
} satisfies Record<string, ResolutionFailureDisposition>);

export function getResolutionFailureDisposition(code: unknown): ResolutionFailureDisposition | undefined {
  return typeof code === "string" && Object.hasOwn(dispositions, code)
    ? dispositions[code as keyof typeof dispositions] : undefined;
}

/** 只识别原生 resolve 回执的明确标记；所属工具和当前轮范围由宿主核对。 */
export function isTerminalResolutionFailure(details: unknown): boolean {
  if (!details || typeof details !== "object" || Array.isArray(details)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(details) as object | null)) return false;
  const value = details as Record<string, unknown>;
  return Object.hasOwn(value, "status") && value.status === "error"
    && Object.hasOwn(value, "error_code") && getResolutionFailureDisposition(value.error_code) !== undefined
    && Object.hasOwn(value, "retryable") && value.retryable === false;
}
