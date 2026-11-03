import { Type, type Static } from "@earendil-works/pi-ai";
import { Check } from "typebox/value";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ResolvedOrganizations } from "../business-context/types.js";
import type { QueryDate } from "./sourceConditions.js";
import { isCalendarDate } from "../tools/shared.js";
import { businessEvidences } from "../answerEvidence.js";
import type { AnalysisEvidence } from "../analysis/tools.js";

const names = Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
  minItems: 1,
  maxItems: 100,
  uniqueItems: true,
});
export const inquiryTargetChangeSchema = Type.Object(
  {
    mode: Type.Union([Type.Literal("new"), Type.Literal("update"), Type.Literal("continue")]),
    base_ref: Type.Optional(Type.String({ minLength: 1 })),
    topic: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
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
    date: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  },
  {
    additionalProperties: false,
    description:
      "本轮首次取数明确声明业务目标：new新主题须给topic、organizations(replace)、date；update带base_ref，只填本轮改变的字段，机构替换用replace、追加对比用add；continue带base_ref沿用全部条件。未改变的字段由宿主继承，不重填历史机构。后续同目标取数省略此项；独立补查不得填写。",
  },
);
export type InquiryTargetChange = Static<typeof inquiryTargetChangeSchema>;

/** 目标来自显式变更声明；查询、补查和报告的来源集合不具有目标更新权。 */
export interface InquiryTargetSnapshot {
  version: 1;
  ref: string;
  operationId: string;
  sourceQuestion: string;
  topic: string;
  organizations: ResolvedOrganizations;
  time: QueryDate;
  parentRef?: string;
}
export interface InquiryTargetContext {
  version: 1;
  baseline?: InquiryTargetSnapshot;
}
export class InquiryTargetError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly validationStage?: string,
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
    if (message.role !== "toolResult" || !["metric_query", "topic_query"].includes(message.toolName)) continue;
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
  resolveOrganizations(
    scope: "named" | "all_banks",
    names?: string[],
  ): Promise<ResolvedOrganizations>;
  resolveTime(value: string): Promise<QueryDate>;
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
    ...(!change.date ? ["date"] : []),
    ...(change.organizations?.mode !== "replace" ? ["organizations"] : []),
  ];
  if (change.mode === "new" && invalidNewFields.length)
    return invalid(
      "新目标须明确主题、机构和期间；存量会话没有目标时依据用户问题声明，不能自动把来源升级为目标。",
      `target_new:${invalidNewFields.join(",")}`,
    );
  if (change.mode === "continue" && (change.topic || change.date || change.organizations))
    return invalid(
      "沿用目标不包含字段修改；有明确变化请使用update。",
      `target_continue:${[
        change.topic && "topic",
        change.date && "date",
        change.organizations && "organizations",
      ]
        .filter(Boolean)
        .join(",")}`,
    );
  if (change.mode === "update" && !change.topic && !change.date && !change.organizations)
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
  return {
    version: 1,
    ref: `target:${context.operationId}`,
    operationId: context.operationId,
    sourceQuestion: context.sourceQuestion,
    topic: change.topic ?? base!.topic,
    organizations,
    time: change.date ? await context.resolveTime(change.date) : structuredClone(base!.time),
    ...(base ? { parentRef: base.ref } : {}),
  };
}
