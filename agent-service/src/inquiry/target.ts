import { Type, type Static } from "@earendil-works/pi-ai";
import { Check } from "typebox/value";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ResolvedOrganizations } from "../business-context/types.js";
import type { QueryDate } from "./sourceConditions.js";
import { isCalendarDate } from "../tools/shared.js";
import { businessEvidences } from "../answerEvidence.js";
import type { AnalysisEvidence } from "../analysis/tools.js";
import type { DateModelValue } from "../business-context/types.js";

export const inquiryDateCalendarSchema = Type.Object(
  {
    start: Type.String({ minLength: 1, maxLength: 64 }),
    end: Type.String({ minLength: 1, maxLength: 64 }),
    dates: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 100 }),
    ),
  },
  {
    additionalProperties: false,
    description:
      "随期间原表达提交的日历换算，使用YYYY-MM-DD；服务端确定性解析优先，仅不支持的表达采用经校验的换算。保留原期间，不因解析失败改成latest；不明确的边界须澄清。",
  },
);

const timeRequestSchema = Type.Union([
  Type.Object(
    {
      expression: Type.String({
        minLength: 1,
        maxLength: 200,
        description: "用户或已确认上下文中的期间原表达；保留完整期间，不换成数据可得日期。",
      }),
      calendar: Type.Optional(inquiryDateCalendarSchema),
    },
    { additionalProperties: false },
  ),
  Type.Null(),
]);

const names = Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
  minItems: 1,
  maxItems: 100,
  uniqueItems: true,
});
export const inquiryTargetChangeSchema = Type.Object(
  {
    mode: Type.Union([Type.Literal("new"), Type.Literal("update"), Type.Literal("continue")]),
    base_ref: Type.Optional(Type.String({ minLength: 1 })),
    topic: Type.Optional(Type.String({
      minLength: 1, maxLength: 500,
      description: "所问指标和分析目标。机构和统计期由各自字段保存，只换机构或日期时不改写topic。",
    })),
    organizations: Type.Optional(
      Type.Object(
        {
          mode: Type.Union([Type.Literal("replace"), Type.Literal("add")]),
          scope: Type.Union([Type.Literal("named"), Type.Literal("all_banks")]),
          names: Type.Optional(names),
        },
        { additionalProperties: false },
      ),
    ),
    time: Type.Optional(timeRequestSchema),
    selection: Type.Optional(
      Type.Union(
        [
          Type.Literal("exact"),
          Type.Literal("latest"),
          Type.Literal("latest_in_range"),
          Type.Literal("all_in_range"),
          Type.Literal("available_in_range"),
        ],
        {
          description:
            "取数策略，不改变time的原期间；latest仅用于无指定期间或原文最新，限定期间内取最新使用latest_in_range。未填时采用期间解析结果。",
        },
      ),
    ),
    date: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 200,
        description: "仅兼容旧在途请求；新运行使用time.expression及time.calendar，不能与time混填。",
      }),
    ),
    date_calendar: Type.Optional(inquiryDateCalendarSchema),
  },
  {
    additionalProperties: false,
    description:
      "本轮首次取数明确声明业务目标：new仅用于新业务主题，须给topic、organizations(replace)、time；同一分析只换机构或期间用update，带base_ref且只填改动字段。先保留用户期间原表达与可选calendar，未指定期间才time:null并selection:latest。机构替换用replace、追加对比用add；continue带base_ref沿用全部条件。未改变的字段由宿主继承。后续同目标取数省略此项；独立补查不得填写。",
  },
);
export type InquiryTargetChange = Static<typeof inquiryTargetChangeSchema>;

/** 目标来自显式变更声明；查询、补查和报告的来源集合不具有目标更新权。 */
export interface InquiryTargetSnapshot {
  version: 1;
  ref: string;
  operationId: string;
  sourceQuestion: string;
  analysisQuestion?: string;
  topic: string;
  organizations: ResolvedOrganizations;
  time: QueryDate;
  time_request?: Static<typeof timeRequestSchema>;
  parentRef?: string;
}
export interface InquiryTargetContext {
  version: 1;
  baseline?: InquiryTargetSnapshot;
  time_contract?: 2;
}
export class InquiryTargetError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly validationStage?: string,
    readonly resolution?: unknown,
  ) {
    super(message);
    this.name = "InquiryTargetError";
  }
}
const snapshotSchema = Type.Object(
  {
    version: Type.Literal(1),
    ref: Type.String({ minLength: 1 }),
    operationId: Type.String({ minLength: 1 }),
    sourceQuestion: Type.String(),
    analysisQuestion: Type.Optional(Type.String()),
    topic: Type.String({ minLength: 1 }),
    parentRef: Type.Optional(Type.String({ minLength: 1 })),
    organizations: Type.Object({
      codes: names,
      names,
      scope: Type.Optional(
        Type.Union([
          Type.Object({
            kind: Type.Literal("authorized_cohort"),
            cohort: Type.Literal("rural_commercial_banks"),
          }),
          Type.Object({
            kind: Type.Literal("children_of"),
            parent_code: Type.String({ minLength: 1 }),
          }),
        ]),
      ),
      scope_fingerprint: Type.Optional(Type.String()),
    }),
    time_request: Type.Optional(timeRequestSchema),
    time: Type.Object({
      date_selection: Type.String({ minLength: 1 }),
      start: Type.Optional(Type.String()),
      end: Type.Optional(Type.String()),
      dates: Type.Optional(Type.Array(Type.String())),
      anchor_date: Type.Optional(Type.String()),
    }),
  },
  { additionalProperties: false },
);

export function readInquiryTargetSnapshot(value: unknown): InquiryTargetSnapshot | undefined {
  if (!Check(snapshotSchema, value)) return;
  const { organizations, time } = value;
  if (organizations.codes.length !== organizations.names.length) return;
  if (time.date_selection === "latest_snapshot") {
    if (!time.anchor_date || !isCalendarDate(time.anchor_date)) return;
  } else if (
    !time.start ||
    !time.end ||
    !isCalendarDate(time.start) ||
    !isCalendarDate(time.end) ||
    time.start > time.end
  )
    return;
  if (time.dates?.some((day) => !isCalendarDate(day) || day < time.start! || day > time.end!))
    return;
  return structuredClone(value);
}

export function currentInquiryTarget(messages: readonly AgentMessage[], operationId: string) {
  for (const message of [...messages].reverse()) {
    if (message.role === "user") break;
    if (
      message.role !== "toolResult" ||
      !["metric_query", "metric_availability", "topic_query"].includes(message.toolName)
    )
      continue;
    const details = message.details as { inquiry_target_snapshot?: unknown } | undefined;
    const target = readInquiryTargetSnapshot(details?.inquiry_target_snapshot);
    if (target?.operationId === operationId) return target;
  }
  return undefined;
}

export interface InquiryTargetCoverage {
  target_ref: string;
  requested_time: QueryDate;
  covered_org_codes: string[];
  missing_org_codes: string[];
  missing_org_names: string[];
  missing_queries: Array<{ org_code: string; org_name: string; time: QueryDate }>;
  complete: boolean;
}

/** 查询准入与报告收尾共用实际执行覆盖，局部查询的目标快照不代表整个目标已查完。 */
export function inquiryTargetCoverage(
  messages: readonly AgentMessage[],
  target: InquiryTargetSnapshot,
): InquiryTargetCoverage {
  const covered = new Set<string>();
  const targetDates =
    target.time.date_selection === "exact" && target.time.dates?.length
      ? [...new Set(target.time.dates)].sort()
      : undefined;
  const coveredDates = new Map<string, Set<string>>();
  for (const message of messages) {
    if (
      message.role !== "toolResult" ||
      !["metric_query", "topic_query"].includes(message.toolName)
    )
      continue;
    const details = message.details as { inquiry_target_snapshot?: unknown } | undefined;
    if (readInquiryTargetSnapshot(details?.inquiry_target_snapshot)?.ref !== target.ref) continue;
    for (const evidence of businessEvidences(message.details)) {
      if (evidence.kind !== "analysis_evidence" || evidence.status !== "succeeded") continue;
      const receipt = evidence as AnalysisEvidence & {
        inquiry_date?: QueryDate;
        inquiry_scope?: ResolvedOrganizations;
      };
      if (
        !receipt.run_ref ||
        (receipt.execution_turn_id ?? receipt.scope_id) !== target.operationId
      )
        continue;
      const time: Partial<QueryDate> = receipt.inquiry_date ?? {
        ...(receipt.date_selection ? { date_selection: receipt.date_selection } : {}),
        ...(receipt.requested_start ? { start: receipt.requested_start } : {}),
        ...(receipt.requested_end ? { end: receipt.requested_end } : {}),
        ...(receipt.checked_on ? { anchor_date: receipt.checked_on } : {}),
      };
      const codes = receipt.inquiry_scope?.codes ?? receipt.org_codes;
      if (targetDates) {
        // 只累计明确日期集合中的 exact 请求，不把区间端点或最新日期当成完整日期覆盖。
        if (time.date_selection !== "exact") continue;
        const days = time.dates?.length
          ? time.dates
          : time.start && time.start === time.end
            ? [time.start]
            : [];
        for (const code of codes) {
          const seen = coveredDates.get(code) ?? new Set<string>();
          days.filter((day) => targetDates.includes(day)).forEach((day) => seen.add(day));
          coveredDates.set(code, seen);
          if (targetDates.every((day) => seen.has(day))) covered.add(code);
        }
        continue;
      }
      if (
        time.date_selection !== target.time.date_selection ||
        time.start !== target.time.start ||
        time.end !== target.time.end ||
        (target.time.date_selection === "latest_snapshot" &&
          time.anchor_date !== target.time.anchor_date) ||
        JSON.stringify([...(time.dates ?? [])].sort()) !==
          JSON.stringify([...(target.time.dates ?? [])].sort())
      )
        continue;
      // 正常缺数也证明请求已执行，覆盖取自请求机构而非有值行。
      for (const code of codes) covered.add(code);
    }
  }
  const missingIndexes = target.organizations.codes.flatMap((code, index) =>
    covered.has(code) ? [] : [index],
  );
  return {
    target_ref: target.ref,
    requested_time: target.time,
    covered_org_codes: target.organizations.codes.filter((code) => covered.has(code)),
    missing_org_codes: missingIndexes.map((index) => target.organizations.codes[index]!),
    missing_org_names: missingIndexes.map((index) => target.organizations.names[index]!),
    missing_queries: missingIndexes.map((index) => {
      const code = target.organizations.codes[index]!;
      const dates = targetDates?.filter((day) => !coveredDates.get(code)?.has(day));
      return {
        org_code: code,
        org_name: target.organizations.names[index]!,
        time: dates?.length
          ? { date_selection: "exact", start: dates[0]!, end: dates[dates.length - 1]!, dates }
          : target.time,
      };
    }),
    complete: missingIndexes.length === 0,
  };
}

interface TargetResolution {
  baseline?: InquiryTargetSnapshot | undefined;
  operationId: string;
  sourceQuestion: string;
  timeContract?: 2;
  resolveOrganizations(
    scope: "named" | "all_banks",
    names?: string[],
  ): Promise<ResolvedOrganizations>;
  resolveTime(value: string, calendar?: DateModelValue): Promise<QueryDate>;
}
export async function resolveInquiryTarget(
  change: InquiryTargetChange,
  context: TargetResolution,
): Promise<InquiryTargetSnapshot> {
  const invalid = (message: string, stage: string): never => {
    throw new InquiryTargetError("INQUIRY_TARGET_INVALID", message, stage);
  };
  if (!Check(inquiryTargetChangeSchema, change))
    return invalid("目标变更格式不完整。", "target_schema");
  const hasTime = change.time !== undefined;
  const hasLegacyTime = change.date !== undefined || change.date_calendar !== undefined;
  if (hasLegacyTime && (hasTime || change.selection !== undefined))
    return invalid(
      "time/selection与旧date/date_calendar不能混填，请保留一个期间声明。",
      "target_time_contract",
    );
  if (context.timeContract === 2 && hasLegacyTime)
    return invalid(
      "本轮期间须用time保留原表达及calendar换算；selection单独选择数据，不能以date跳过期间声明。",
      "target_time_contract",
    );
  if (change.time === null && change.selection !== "latest")
    return invalid(
      "仅用户未指定期间时声明time:null，并明确selection:latest。",
      "target_time_selection",
    );
  if (change.date_calendar && !change.date)
    return invalid("日期换算须附带date原表达，不能独立改变目标期间。", "target_date_expression");
  const base = change.mode === "new" ? undefined : context.baseline;
  if (change.mode !== "new" && (!base || change.base_ref !== base.ref))
    throw new InquiryTargetError(
      "INQUIRY_TARGET_STALE",
      "请使用本轮参考资料中的目标引用，不从历史查询集合合并目标。",
    );
  // 只记录尚未满足的结构条件，补齐一项可继续；改写已有主题或日期不构成格式纠正。
  const invalidNewFields = [
    ...(change.base_ref ? ["base_ref"] : []),
    ...(!change.topic ? ["topic"] : []),
    ...(!hasTime && !change.date ? [context.timeContract === 2 ? "time" : "date"] : []),
    ...(change.organizations?.mode !== "replace" ? ["organizations"] : []),
  ];
  if (change.mode === "new" && invalidNewFields.length)
    return invalid(
      "新目标须明确主题、机构和期间；存量会话没有目标时依据用户问题声明，不能自动把来源升级为目标。",
      `target_new:${invalidNewFields.join(",")}`,
    );
  if (
    change.mode === "continue" &&
    (change.topic || change.date || hasTime || change.selection || change.organizations)
  )
    return invalid(
      "沿用目标不包含字段修改；有明确变化请使用update。",
      `target_continue:${[
        change.topic && "topic",
        change.date && "date",
        hasTime && "time",
        change.selection && "selection",
        change.organizations && "organizations",
      ]
        .filter(Boolean)
        .join(",")}`,
    );
  if (
    change.mode === "update" &&
    !change.topic &&
    !change.date &&
    !hasTime &&
    !change.selection &&
    !change.organizations
  )
    return invalid("update须说明改变的字段；全部沿用时使用continue。", "target_update");
  const selection = change.organizations;
  if (
    selection &&
    ((selection.scope === "named" && !selection.names?.length) ||
      (selection.scope === "all_banks" && selection.names))
  )
    return invalid(
      "named须明确机构；all_banks不混入手写机构清单。",
      `target_organizations:${selection.scope}`,
    );
  if (
    selection?.mode === "add" &&
    (!base || selection.scope !== "named" || base.organizations.scope)
  )
    return invalid(
      "追加比较用于明确机构集合；改变动态机构范围时请完整替换范围。",
      "target_organizations_add",
    );
  const prior = base?.organizations;
  const selected = selection
    ? await context.resolveOrganizations(selection.scope, selection.names)
    : prior
      ? await context.resolveOrganizations(
          prior.scope?.kind === "authorized_cohort" ? "all_banks" : "named",
          prior.scope?.kind === "authorized_cohort" ? undefined : prior.codes,
        )
      : undefined;
  if (!selected?.codes.length)
    return invalid("机构尚未解析，不能创建查询目标。", "target_organizations_empty");
  const sameMembers = (left: string[], right: string[]) =>
    JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
  if (!selection && prior && !prior.scope && !sameMembers(selected.codes, prior.codes))
    throw new InquiryTargetError(
      "INQUIRY_TARGET_SCOPE_CHANGED",
      "原目标机构未能完整重新核验，不能缩小或替换后继续。",
    );
  let organizations = selected;
  if (selection?.mode === "add" && prior) {
    // 追加前重验原对象，旧快照不提供当前访问许可。
    const checked = await context.resolveOrganizations("named", prior.codes);
    if (!sameMembers(checked.codes, prior.codes))
      throw new InquiryTargetError(
        "INQUIRY_TARGET_SCOPE_CHANGED",
        "原比较对象未能完整重新核验，不能仅保留新机构继续。",
      );
    const members = new Map(checked.codes.map((code, index) => [code, checked.names[index]!]));
    selected.codes.forEach((code, index) => members.set(code, selected.names[index]!));
    organizations = { codes: [...members.keys()], names: [...members.values()] };
  }
  let time = hasTime
    ? await context.resolveTime(change.time?.expression ?? "latest", change.time?.calendar)
    : change.date
      ? await context.resolveTime(change.date, change.date_calendar)
      : structuredClone(base!.time);
  const strategy = change.selection;
  if (strategy) {
    if (
      strategy === "latest"
        ? time.date_selection !== "latest_snapshot"
        : time.date_selection === "latest_snapshot"
    )
      return invalid(
        "取数策略与原期间冲突：限定期间不能改用全局latest，期间内取最新用latest_in_range。",
        "target_time_selection",
      );
    if (
      (strategy === "exact" && time.start !== time.end && !time.dates?.length) ||
      (time.dates?.length && strategy !== "exact")
    )
      return invalid(
        "取数策略不能缩小连续期间为单日，也不能将明确离散日期扩张成区间。",
        "target_time_selection",
      );
    if (strategy !== "latest") time = { ...time, date_selection: strategy };
  }
  const timeRequest = hasTime
    ? change.time
    : change.date
      ? {
          expression: change.date,
          ...(change.date_calendar ? { calendar: change.date_calendar } : {}),
        }
      : base?.time_request;
  const analysisQuestion = base && (!change.topic || change.topic === base.topic)
    ? base.analysisQuestion ?? base.sourceQuestion
    : undefined;
  return {
    version: 1,
    ref: `target:${context.operationId}`,
    operationId: context.operationId,
    sourceQuestion: context.sourceQuestion,
    ...(analysisQuestion ? { analysisQuestion } : {}),
    topic: change.topic ?? base!.topic,
    organizations,
    time,
    ...(timeRequest !== undefined ? { time_request: structuredClone(timeRequest) } : {}),
    ...(base ? { parentRef: base.ref } : {}),
  };
}
