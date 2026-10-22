import type {AskMetricRequestContext} from "../requestContext.js";
import type {FieldResolution, ResolvedField} from "../business-context/types.js";
import {hasInputEvidence, organizationInputMembers} from "../business-context/inputEvidence.js";
import type {ModelCalendar, SemanticOperation} from "./protocol.js";

export type TurnFacts = Awaited<ReturnType<AskMetricRequestContext["backend"]["inspectBusinessGoal"]>>;
/** 集合范围已由动作或限定子句表达时，词法提及不能再变成正向全集。 */
export const hasCollectionIntent = (question: string) => /排除|去掉|剔除|不要|不(?:查|看)|只(?:看|查|要)|仅(?:看|查)|换成|换为|改成|改为|替换/u.test(question);

/** 新目标的同一机构清单可被模型分成多次set；仅合并全有原文依据的正向成员，不改历史或集合动作。 */
export function coalesceOrganizationAssignments(operations: SemanticOperation[], question: string): SemanticOperation[] {
  const organizations = operations.filter(operation => operation.field === "organizations");
  if (organizations.length < 2 || hasCollectionIntent(question)) return operations;
  const members: string[] = [];
  for (const operation of organizations) {
    if (operation.action !== "set" || operation.structured || operation.values || operation.organizationScope) return operations;
    const values = organizationInputMembers(operation.value);
    if (!values.every(member => hasInputEvidence(question, member))) return operations;
    members.push(...values);
  }
  const names = [...new Set(members)];
  if (names.length > 100) return operations;
  // 单条suggestion不能代表整个集合；完整清单重新交授权目录解析，不采信模型提供的编码。
  const merged: SemanticOperation = {action: "set", field: "organizations", value: names.join("、")};
  return operations.flatMap(operation => operation.field !== "organizations" ? [operation]
    : operation === organizations[0] ? [merged] : []);
}
export type EntityValue = {codes: string[]; names: string[]};
type ResolveArguments = Parameters<AskMetricRequestContext["backend"]["resolveBusinessField"]>;

/** 同一请求共享目录/日历事实；重提和子目标使用同一解析，不在更新完成后重新裁决原话。 */
export function inspectTurn(request: AskMetricRequestContext, question: string, businessDate: string, referenceYear?: number,
  signal?: AbortSignal): Promise<TurnFacts> {
  const cache = request.semanticFacts ??= new Map();
  const key = JSON.stringify([question, businessDate, referenceYear]);
  let pending = cache.get(key);
  if (!pending) {
    pending = request.backend.inspectBusinessGoal(question, businessDate, {signal}, referenceYear);
    cache.set(key, pending);
    pending.catch(() => {if (cache.get(key) === pending) cache.delete(key);});
  }
  return pending;
}

/** 只复用本轮字段绑定；执行前鉴权仍直接访问后端，不使用这里的缓存。 */
export function resolveTurnField(request: AskMetricRequestContext, ...args: ResolveArguments): Promise<FieldResolution> {
  const cache = request.semanticResolutions ??= new Map();
  const key = JSON.stringify([args[0], args[1], args[3], args[4], args[5]]);
  let pending = cache.get(key);
  if (!pending) {
    pending = request.backend.resolveBusinessField(...args);
    cache.set(key, pending);
    const forget = () => {if (cache.get(key) === pending) cache.delete(key);};
    pending.then(value => {if (value.status === "temporary_error") forget();}, forget);
  }
  return pending;
}

/** 绑定发生在动作应用前。集合变更由模型的动作表达，提及排除对象不会生成正向查询义务。 */
export function bindFieldOperations(operations: SemanticOperation[], facts: TurnFacts | undefined,
  fields: Record<string, ResolvedField>, options: {joint?: boolean | undefined; analysis?: boolean | undefined; calendar?: ModelCalendar; answered?: Set<string>} = {}): {operations: SemanticOperation[]; calendar?: ModelCalendar} {
  if (!facts) return {operations};
  const calendars = facts.fragments.flatMap(fragment => fragment.calendar.ranges);
  const unresolvedTimes = [...new Set(facts.fragments.flatMap(fragment => fragment.calendar.unresolved))];
  // 两种输入共用一次真实缺项归一；指标名称中的“当日数”等口径不属于时间表达。
  const timeEvidence = facts.fragments.map(fragment => Array.from(fragment.question).map((character, index) =>
    fragment.mentions.some(mention => index >= mention.start && index < mention.end) ? " " : character).join("")).join("；");
  const changesTime = /(?:改|换|另|别|其他|其它|调整).{0,8}(?:日期|时间)|(?:日期|时间).{0,8}(?:改|换|调整)/u.test(facts.question);
  const choosingTime = fields.time?.resolutionStatus !== "resolved" && fields.time?.candidates?.length;
  const normalized = !calendars.length && !unresolvedTimes.length && !choosingTime ? operations.flatMap(operation => {
    if (operation.field !== "time" || !["set", "replace"].includes(operation.action) || !("value" in operation)
      || hasInputEvidence(timeEvidence, operation.value)) return [operation];
    return fields.time?.resolutionStatus === "resolved" && !changesTime ? [] : [{action: "clear" as const, field: "time" as const}];
  }) : operations;
  if (options.joint || normalized.some(operation => "structured" in operation && operation.structured)) return {operations: normalized};
  const bound = normalized.map(operation => {
    const previous = fields[operation.field];
    if (operation.action === "replace" && previous?.resolutionStatus === "resolved" && operation.field !== "time"
      && (previous.resolvedValue as EntityValue).codes.length === 1
      && (operation.subject === operation.value || !hasInputEvidence(facts.question, operation.subject))) {
      return {...operation, subject: (previous.resolvedValue as EntityValue).names[0]!};
    }
    return operation;
  });
  const mentions = facts.fragments.flatMap(fragment => fragment.mentions);
  const orgs = [...new Set(facts.fragments.flatMap(fragment => fragment.organizations))];
  const points = [...new Set(calendars.flatMap(range => range.dates ?? (range.start === range.end ? [range.start] : [])))].sort();
  const discrete = calendars.length > 1 && calendars.every(range => range.start === range.end || range.dates?.length) && points.length > 1
    ? {start: points[0]!, end: points.at(-1)!, dates: points} : undefined;
  const calendar = options.calendar ?? (!facts.fragments.some(fragment => fragment.calendar.unresolved.length)
    ? calendars.length === 1 ? calendars[0] : discrete : undefined);
  let boundTime = false;
  for (const field of ["organizations", "metrics", "time"] as const) {
    const existing = bound.filter(operation => operation.field === field);
    if (field === "metrics" && options.analysis) continue;
    if (field === "time" && /不要|不(?:看|查)|排除|去掉|剔除|(?:把|从).*(?:换|改)(?:成|为|到)/u.test(facts.question)) continue;
    // confirm/copy/clear/add/replace/exclude 已表达角色；不能把同一句的 subject 再补成 set。
    if (options.answered?.has(field) || existing.some(operation => operation.action !== "set")
      || !existing.length && fields[field]?.candidates?.length && fields[field]?.resolutionStatus !== "resolved") continue;
    const texts = field === "metrics" ? mentions.map(mention => mention.text) : orgs;
    if (field === "time" && !calendar && fields[field]?.resolutionStatus !== "resolved" && fields[field]?.candidates?.length) continue;
    if (field === "time" ? !calendar : !texts.length) {
      if (field === "time" && !calendars.length && unresolvedTimes.length === 1) {
        // 含义未换算时仍绑定完整原文；不能把模型摘出的一个端点当作整个区间。
        const expression = unresolvedTimes[0]!, original = existing[0];
        const normalized: SemanticOperation = {action: "set", field, value: expression,
          ...(original && "value" in original && "modelCalendar" in original && original.modelCalendar
            && hasInputEvidence(original.value, expression) ? {modelCalendar: original.modelCalendar} : {})};
        if (original) bound[bound.indexOf(original)] = normalized; else bound.push(normalized);
        continue;
      }
      const label = field === "metrics" ? "指标" : field === "organizations" ? "机构" : "(?:日期|时间)";
      const change = new RegExp(`(?:改|换|另|别|其他|其它|调整).{0,8}${label}|${label}.{0,8}(?:改|换|调整)`, "u");
      if (existing.length && fields[field]?.resolutionStatus === "resolved" && change.test(facts.question)
        && existing.every(op => !("value" in op) || !hasInputEvidence(facts.question, op.value))) {
        const index = bound.indexOf(existing[0]!); bound[index] = {action: "clear", field};
      }
      continue;
    }
    if (field !== "time" && hasCollectionIntent(facts.question)) continue;
    const previous = fields[field];
    if (!existing.length && previous?.resolutionStatus === "resolved") {
      if (field === "time" && JSON.stringify(previous.resolvedValue) === JSON.stringify(calendar)) continue;
      if (field !== "time") {
        const old = (previous.resolvedValue as EntityValue).codes;
        const current = field === "organizations" ? orgs : mentions.flatMap(mention =>
          mention.resolution.status === "resolved" ? (mention.resolution.value as EntityValue).codes : []);
        // 已选目标中的名称还可作为定位线索；没有字段动作时不把它改成子集选择。
        if (current.length && current.every(code => old.includes(code))) continue;
      }
    }
    const value = field === "time" ? calendar!.dates?.length ? calendar!.dates.join("、") : calendar!.start === calendar!.end ? calendar!.start : `${calendar!.start}至${calendar!.end}` : texts.join("、");
    const raw = existing[0] && "value" in existing[0] && hasInputEvidence(facts.question, existing[0].value) ? existing[0].value : value;
    const normalized: SemanticOperation = {action: "set", field, value: field === "time" && !calendar?.dates?.length ? raw : value,
      ...(field === "time" && calendar ? {modelCalendar: calendar} : {})};
    if (existing.length) {
      const index = bound.indexOf(existing[0]!);
      // 原文完整槽位可能含待定成员；不能用词法只识别出的那一部分替换整个槽位。
      if (field === "organizations" && "value" in existing[0]! && organizationInputMembers(existing[0]!.value).every(member => hasInputEvidence(facts.question, member))) continue;
      // 原文机构槽位已明确时，用正式身份绑定；错字建议通道仍按原值和 suggestion 解析。
      if (field === "organizations" && existing[0] && "suggestion" in existing[0] && existing[0].suggestion) continue;
      bound[index] = normalized;
    } else bound.push(normalized);
    if (field === "time") boundTime = true;
  }
  return {operations: bound, ...(boundTime && calendar ? {calendar} : {})};
}

export function entityIsGrounded(value: EntityValue, previous: ResolvedField | undefined,
  sourceCodes: unknown, question: string, raw: string): boolean {
  const known = new Set([...(previous?.resolutionStatus === "resolved" ? (previous.resolvedValue as EntityValue).codes : []),
    ...(Array.isArray(sourceCodes) ? sourceCodes.filter((code): code is string => typeof code === "string") : [])]);
  return value.codes.every(code => known.has(code)) || hasInputEvidence(question, raw);
}

/** 对绑定后的正式身份应用一次集合代数；排除是幂等操作，替换需要明确原成员。 */
export function updateCollection(before: EntityValue, action: "set" | "add" | "replace" | "exclude" | "confirm",
  value: EntityValue, subject?: EntityValue): EntityValue | undefined {
  if (action === "set" || action === "confirm") return value;
  const members = new Map(before.codes.map((code, index) => [code, before.names[index]!]));
  if (action === "replace" && (!subject?.codes.length || subject.codes.some(code => !members.has(code)))) return;
  if (action === "replace" || action === "exclude") for (const code of (subject ?? value).codes) members.delete(code);
  if (action === "replace" || action === "add") value.codes.forEach((code, index) => members.set(code, value.names[index]!));
  return {codes: [...members.keys()], names: [...members.values()]};
}

/** 联动动作先绑定来源身份；交换复用 copy，不把历史值重写成无来源的本轮 set。 */
export function bindGroupOperations(input: import("./protocol.js").SemanticRequest, question: string) {
  if (!/交换|互换|对调/u.test(question) || input.targets.length !== 2) return;
  const [left, right] = input.targets;
  if (left!.source.kind !== "reference" || right!.source.kind !== "reference") return;
  const labels = {time: "(?:日期|时间)", metrics: "指标", organizations: "机构"} as const;
  for (const field of ["time", "metrics", "organizations"] as const) {
    const action = "(?:交换|互换|对调)";
    if (!new RegExp(`${labels[field]}(?:互相|相互)?${action}|${action}(?:一下)?(?:各自|两[家笔]的)?${labels[field]}`, "u").test(question.replace(/\s/gu, ""))) continue;
    const sources = [left!.source, right!.source];
    [left!, right!].forEach((target, index) => {
      const other = sources[1 - index]!;
      target.operations = [...target.operations.filter(operation => operation.field !== field),
        {action: "copy", field, reference: {task_ref: other.task_ref, target_ref: other.target_ref}}];
    });
  }
}
