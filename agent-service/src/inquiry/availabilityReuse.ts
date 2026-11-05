import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AvailabilityRequest, AvailabilityResult } from "../backendClient.js";
import type { ResolvedOrganizations } from "../business-context/types.js";
import type { AskMetricRequestContext } from "../requestContext.js";
import { isCalendarDate } from "../tools/shared.js";
import { currentTurnMessages } from "../tools/turnContract.js";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const stringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
const sameSet = (left: unknown, right: string[] | undefined): boolean =>
  stringList(left) &&
  !!right &&
  left.length === right.length &&
  new Set(left).size === left.length &&
  new Set(right).size === right.length &&
  [...left].sort().every((item, index) => item === [...right].sort()[index]);

/** 日期范围和分页不属于授权身份；正式绑定、实际机构与范围版本必须一致。 */
export function availabilityScopeKey(
  request: AskMetricRequestContext,
  bindings: string[],
  orgs: ResolvedOrganizations,
  targetRef?: string,
): string {
  const scope = orgs.scope;
  return createHash("sha256")
    .update(
      JSON.stringify({
        actor: request.actor.id,
        session: request.sessionId,
        operation: request.operationId,
        target: targetRef ?? null,
        bindings: [...bindings].sort(),
        orgs: [...orgs.codes].sort(),
        scope:
          scope?.kind === "authorized_cohort"
            ? { kind: scope.kind, cohort: scope.cohort }
            : scope
              ? { kind: scope.kind, parent_code: scope.parent_code }
              : null,
        fingerprint: orgs.scope_fingerprint ?? null,
      }),
    )
    .digest("hex");
}

function validInterval(request: Record<string, unknown>): boolean {
  if (request.start === undefined && request.end === undefined) return true;
  return (
    typeof request.start === "string" &&
    typeof request.end === "string" &&
    isCalendarDate(request.start) &&
    isCalendarDate(request.end) &&
    request.start <= request.end
  );
}

function completeResult(details: Record<string, unknown>): AvailabilityResult | undefined {
  const source = record(details.request);
  if (
    details.status !== "succeeded" ||
    source.dimension !== "dates" ||
    !validInterval(source) ||
    details.page !== 1 ||
    (source.page ?? 1) !== 1 ||
    details.has_more === true ||
    typeof details.page_size !== "number" ||
    !Number.isInteger(details.page_size) ||
    details.page_size < 1 ||
    typeof details.mode !== "string" ||
    typeof details.notice !== "string" ||
    typeof details.metric_count !== "number" ||
    typeof details.org_count !== "number" ||
    !stringList(details.org_names) ||
    !stringList(source.org_codes) ||
    !stringList(source.metric_codes) ||
    (details.metric_names !== undefined && !stringList(details.metric_names)) ||
    !Array.isArray(details.groups) ||
    !details.groups.length
  )
    return undefined;
  const groups: AvailabilityResult["groups"] = [];
  for (const raw of details.groups) {
    const group = record(raw);
    // 只有逐个日期完整返回，才能证明区间内没有遗漏；最大日期或最后一页不能证明完整。
    if (
      group.has_more !== false ||
      !stringList(group.dates) ||
      !group.dates.every(
        (date) =>
          isCalendarDate(date) &&
          (typeof source.start !== "string" || date >= source.start) &&
          (typeof source.end !== "string" || date <= source.end),
      ) ||
      group.date_count !== group.dates.length ||
      new Set(group.dates).size !== group.dates.length
    )
      return undefined;
    const dates = [...group.dates].sort().reverse();
    if (group.earliest !== (dates.at(-1) ?? null) || group.latest !== (dates[0] ?? null))
      return undefined;
    groups.push({
      ...group,
      date_count: dates.length,
      earliest: dates.at(-1) ?? null,
      latest: dates[0] ?? null,
      dates,
      has_more: false,
    });
  }
  return {
    status: "succeeded",
    request: {
      dimension: "dates",
      org_codes: source.org_codes,
      metric_codes: source.metric_codes,
      ...(typeof source.start === "string" && typeof source.end === "string"
        ? { start: source.start, end: source.end }
        : {}),
      match: source.match === "all" ? "all" : "any",
      page: 1,
      page_size: details.page_size,
    },
    mode: details.mode,
    metric_count: details.metric_count,
    org_count: details.org_count,
    org_names: details.org_names,
    ...(stringList(details.metric_names) ? { metric_names: details.metric_names } : {}),
    groups,
    page: 1,
    page_size: details.page_size,
    ...(details.has_more === false ? { has_more: false } : {}),
    notice: details.notice,
  };
}

export function reusableAvailability(
  messages: AgentMessage[],
  scopeKey: string,
  spec: AvailabilityRequest,
): { sourceKey: string; result: AvailabilityResult } | undefined {
  const page = spec.page ?? 1,
    size = spec.page_size ?? 12;
  if (
    spec.dimension !== "dates" ||
    !validInterval({ ...spec }) ||
    !Number.isInteger(page) ||
    page < 1 ||
    !Number.isInteger(size) ||
    size < 1
  )
    return undefined;
  for (const message of currentTurnMessages(messages)) {
    if (
      message.role !== "toolResult" ||
      message.toolName !== "metric_availability" ||
      message.isError
    )
      continue;
    const details = record(message.details),
      source = record(details.request);
    if (
      details.kind !== "data_availability" ||
      details.availability_scope_key !== scopeKey ||
      typeof details.availability_key !== "string" ||
      !details.availability_key ||
      details.reused === true ||
      details.no_new_evidence === true ||
      (source.match ?? "any") !== (spec.match ?? "any") ||
      !sameSet(source.org_codes, spec.org_codes) ||
      !sameSet(source.metric_codes, spec.metric_codes) ||
      (typeof source.start === "string" && (!spec.start || spec.start < source.start)) ||
      (typeof source.end === "string" && (!spec.end || spec.end > source.end))
    )
      continue;
    const complete = completeResult(details);
    if (!complete) continue;
    const groups = complete.groups.map((group) => {
      const dates = group.dates.filter(
        (date) => (!spec.start || date >= spec.start) && (!spec.end || date <= spec.end),
      );
      return {
        ...group,
        date_count: dates.length,
        earliest: dates.at(-1) ?? null,
        latest: dates[0] ?? null,
        dates: dates.slice((page - 1) * size, page * size),
        has_more: page * size < dates.length,
      };
    });
    return {
      sourceKey: details.availability_key,
      result: {
        ...complete,
        request: { ...spec },
        groups,
        page,
        page_size: size,
        ...(complete.has_more !== undefined
          ? { has_more: groups.some((group) => group.has_more) }
          : {}),
      },
    };
  }
  return undefined;
}
