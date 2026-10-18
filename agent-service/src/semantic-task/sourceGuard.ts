import type {AskMetricRequestContext} from "../requestContext.js";
import type {SemanticRequest} from "./protocol.js";
import type {SemanticIssue, SemanticTurn, SemanticTask} from "./store.js";
import {referencedQueryNumbers} from "./historyReference.js";
import {inspectTurn} from "./actionBinding.js";
import {scopeAvailable} from "./contextMemory.js";

type GoalFacts = Awaited<ReturnType<AskMetricRequestContext["backend"]["inspectBusinessGoal"]>>;
/** 用户明确禁止继承时是执行边界，模型选了current也不能覆盖这个要求。 */
const resetInstruction = /(?:不|不要|无需|不再)(?:沿用|继承|保留|使用)(?:之前|以前|已有|原来|旧的?|上文|历史|任何|前文)?(?:的)?(?:条件|上下文)/u;
export function explicitContextReset(question: string): boolean {
  return resetInstruction.test(question.replace(/\s/gu, ""));
}
export function withoutContextResetInstruction(question: string): string {return question.replace(new RegExp(resetInstruction.source, "gu"), " ");}
export function frozenSourceOptions(turn: SemanticTurn, owner: string): NonNullable<SemanticIssue["source_options"]> {
  const plan = turn.context?.plan;
  return plan?.owner === owner ? plan.steps.map(step => ({task_ref: plan.ref, target_ref: step.targetRef})) : [];
}

/** 只识别可独立证明的缺项字段赋值回复；未知新话题/否定/清空表达不推断为续补。 */
export async function pendingCompletionSource(request: AskMetricRequestContext, input: SemanticRequest, turn: SemanticTurn, facts: GoalFacts): Promise<NonNullable<SemanticIssue["source_options"]> | undefined> {
  const plan = turn.context?.plan;
  const clauses = request.originalMessage.split(/[，,；;。\n]+|(?<=[^，,；;。\n])(?=(?:机构|日期|时间|指标|取数方式)(?:是|用|为))/u).map(value => value.trim()).filter(Boolean);
  const incremental = /^(?:改查|改为|改成|换成|换为|继续查|接着查|再查)/u.test(request.originalMessage.trim());
  const elliptical = /呢[?？。！!\s]*$/u.test(request.originalMessage);
  const explicitRetention = clauses.some(clause => /^(?:其他|其余|其它)条件(?:保持)?不变$/u.test(clause));
  // 待明确任务续接覆盖指标与取数方式：本轮出现指标 mention 或旧任务指标未定都不再退出续接判断；
  // 逐分句的字段归属与依据核验在下面完成，不能把整句新话题误当补缺。
  if (input.intent !== "query" || !input.targets.some(target => target.source.kind === "new") || turn.context?.clarification
    || !plan || plan.owner !== request.actor.id || !["query", "reuse", "prepare"].includes(plan.intent) || !(plan.status === "waiting_input" || plan.status === "completed" && (explicitRetention || elliptical || incremental) || plan.status === "active" && incremental) || plan.steps.length !== 1
    || plan.steps[0]?.kind !== "query") return;
  const task = turn.context?.tasks.find(item => item.ref === plan.steps[0]?.taskRef);
  if (!task || task.owner !== request.actor.id) return;
  if ((elliptical || incremental) && !explicitContextReset(request.originalMessage)
    && facts.fragments.some(fragment => fragment.organizations.length || fragment.mentions.length || fragment.calendar.ranges.length)) {
    return frozenSourceOptions(turn, request.actor.id);
  }
  const pending = Object.keys(task.target.pending);
  // 已完成任务的继承规则不变，仍只接机构/日期；待明确任务扩展到指标与取数方式缺项。
  const completable = plan.status === "completed" ? ["organizations", "time"] : ["organizations", "time", "metrics", "selection"];
  if (plan.status === "waiting_input" && (!pending.length || pending.some(field => !completable.includes(field)))) return;
  if (plan.status === "completed" && ["organizations", "time"].some(field => task.target.fields[field]?.resolutionStatus !== "resolved")) return;
  let supplied = false;
  for (const clause of clauses) {
    if (/^(?:请)?(?:继续)?(?:查询|查一下|执行)(?:吧)?$/u.test(clause)) continue;
    if (/^(?:其他|其余|其它)条件(?:保持)?不变$/u.test(clause)) continue;
    const assignment = /^(机构|日期|时间|指标|取数方式)(?:改成|改为|换成|换为|选择|设为|定为|是|为|用|选)?(.+)$/u.exec(clause);
    if (!assignment) return;
    const field = assignment[1] === "机构" ? "organizations" : assignment[1] === "指标" ? "metrics" : assignment[1] === "取数方式" ? "selection" : "time";
    if (!completable.includes(field)) return;
    const value = assignment[2]!.trim();
    // 补缺字段须是本轮未决项；已确定字段只接受同一轮里的显式修改，不能借续接复述无关字段。
    if (plan.status === "waiting_input" && !pending.includes(field) && task.target.fields[field]?.resolutionStatus !== "resolved") return;
    // 这是明确的字段赋值，来源由唯一待补目标确定；目录是否命中只在字段绑定时处理。
    // 未知机构或模糊指标也应保留其它已确认条件，不能为了来源证明再次解析值。
    if (/^(?:不是|不要|不沿用|非|除|别用|勿用|清空|清除|重置|取消|排除)/u.test(value)) return;
    supplied = true;
  }
  return supplied ? frozenSourceOptions(turn, request.actor.id) : undefined;
}

/** 选择多目标中的单笔须有独立来源线索；修改后的新值不能反过来冒充来源选择依据。 */
export async function sourceSelection(request: AskMetricRequestContext, input: SemanticRequest, turn: SemanticTurn, facts: GoalFacts) {
  if (!["query", "prepare", "availability"].includes(input.intent) || input.targets.length !== 1) return;
  const target = input.targets[0]!;
  const numbers = referencedQueryNumbers(request.originalMessage);
  if (numbers.length === 1) {
    const references = (await request.semanticTasks!.historyCatalog()).filter(row => row.query_number === numbers[0])
      .map(row => ({task_ref: row.task_ref, target_ref: row.target_ref}));
    if (!references.length) return {code: "REFERENCE_UNAVAILABLE", category: "reference", remediation: "user" as const,
      message: `没有找到第${numbers[0]}次查询，请确认查询序号。`};
    if (references.length === 1 && target.operations.some(operation => operation.action === "copy")) {
      // 序号限定的是所复制字段的来源；当前目标的其它条件继续继承自己的基线。
      for (const operation of target.operations) if (operation.action === "copy") operation.reference = {...references[0]!};
      return;
    }
    if (references.length && (target.source.kind !== "reference" || references.length !== 1
      || target.source.task_ref !== references[0]!.task_ref || target.source.target_ref !== references[0]!.target_ref)) {
      return {code: "SOURCE_BINDING", category: "reference", remediation: "pi" as const,
        message: "按用户点名的查询序号绑定历史来源。", source_options: references};
    }
  }
  const vagueReference = /那一(?:笔|家|次)|之前那(?:笔|次)|前面那(?:笔|次)/u.test(request.originalMessage);
  if (target.source.kind !== "reference" && !vagueReference) return;
  if (["organizations", "metrics", "time"].every(field => target.operations.some(operation => operation.field === field && operation.action === "set"))
    && facts.fragments.every(fragment => fragment.organizations.length && fragment.mentions.length && fragment.calendar.ranges.length && !fragment.calendar.unresolved.length)) return;
  const source = target.source, plan = source.kind === "reference" ? await request.semanticTasks!.plan(source.task_ref) : turn.context?.plan;
  if (!plan || plan.owner !== request.actor.id) return;
  const candidates: Array<{planRef: string; step: typeof plan.steps[number]; task: SemanticTask}> = [];
  const sources = vagueReference ? (await request.semanticTasks!.historyCatalog()).slice(-20).map(row => ({planRef: row.task_ref, targetRef: row.target_ref}))
    : plan.steps.map(step => ({planRef: plan.ref, targetRef: step.targetRef}));
  const seen = new Set<string>();
  for (const reference of sources.reverse()) {
    const parent = reference.planRef === plan.ref ? plan : await request.semanticTasks!.plan(reference.planRef);
    const step = parent?.steps.find(item => item.targetRef === reference.targetRef);
    const task = step?.taskRef ? await request.semanticTasks!.get(step.taskRef) : undefined;
    if (!step || !task || parent?.owner !== request.actor.id) continue;
    const identity = JSON.stringify(["organizations", "metrics", "time"].map(field => task.target.fields[field]?.resolvedValue));
    if (seen.has(identity)) continue;
    const scope = ["organizations", "comparison_organizations"].flatMap(field => (task.target.fields[field]?.resolvedValue as {codes?:string[]} | undefined)?.codes ?? []);
    if (await scopeAvailable(request, scope)) {candidates.push({planRef: parent.ref, step, task}); seen.add(identity);}
  }
  if (candidates.length < 2) return;
  if (target.operations.length && target.operations.every(operation => operation.action === "confirm")) {
    const pending = candidates.filter(({task}) => target.operations.every(operation => {
      const field = task.target.fields[operation.field];
      return field && field.resolutionStatus !== "resolved" && field.candidates?.length;
    }));
    if (pending.length === 1 && pending[0]!.step.targetRef === (source.kind === "reference" ? source.target_ref : undefined)) return;
    if (pending.length === 1) return {code: "SOURCE_SELECTOR_MISMATCH", category: "reference", remediation: "pi" as const,
      message: "确认应绑定唯一待确认目标，不能将已确定目标当作候选来源。", source_options: [{task_ref: pending[0]!.planRef, target_ref: pending[0]!.step.targetRef}]};
  }
  const updates = await Promise.all(target.operations.flatMap(operation => "value" in operation && ["organizations", "metrics", "time"].includes(operation.field)
    ? [inspectTurn(request, operation.value, turn.businessDate).then(value => ({field: operation.field, facts: value}))] : []));
  const metricCodes = (goal: GoalFacts) => goal.fragments.flatMap(fragment => fragment.mentions.flatMap(mention => (mention.resolution.value as {codes?:string[]} | undefined)?.codes ?? []));
  const orgs = facts.fragments.flatMap(fragment => fragment.organizations).filter(code => !updates.some(update => update.field === "organizations" && update.facts.fragments.some(fragment => fragment.organizations.includes(code))));
  const metrics = metricCodes(facts).filter(code => !updates.some(update => update.field === "metrics" && metricCodes(update.facts).includes(code)));
  const dates = facts.fragments.flatMap(fragment => fragment.calendar.ranges).filter(range => !updates.some(update => update.field === "time" && update.facts.fragments.some(fragment => fragment.calendar.ranges.some(value => value.start === range.start && value.end === range.end))));
  const matches = candidates.filter(({task}) => {
    const codes = (field: string) => (task.target.fields[field]?.resolvedValue as {codes?:string[]} | undefined)?.codes ?? [];
    const time = task.target.fields.time?.resolvedValue as {start?:string;end?:string} | undefined;
    return (!orgs.length || orgs.some(code => codes("organizations").includes(code))) && (!metrics.length || metrics.some(code => codes("metrics").includes(code)))
      && (!dates.length || dates.some(range => range.start === time?.start && range.end === time?.end));
  });
  const options = matches.map(({planRef, step}) => ({task_ref: planRef, target_ref: step.targetRef}));
  if (matches.length === 1 && matches[0]!.step.targetRef === (source.kind === "reference" ? source.target_ref : undefined)) return;
  if (matches.length === 1 || !matches.length) return {code: "SOURCE_SELECTOR_MISMATCH", category: "reference", remediation: "pi" as const,
    message: "没有找到对应的历史查询，请明确要修改哪一笔。", source_options: options};
  if (/全部|所有|都|分别|各自|这些|上述|以上|一起|同时/u.test(request.originalMessage)) return {code: "SOURCE_GROUP_REQUIRED", category: "reference", remediation: "pi" as const,
    message: "本轮指向整个目标组，请用references保留全部成员，不能任选单笔。", source_options: options};
  const labels = matches.map(({planRef,step,task}) => ({task_ref: planRef, target_ref: step.targetRef,
    label: ["organizations","metrics","time"].map(field => {const value=task.target.fields[field];return (value?.resolvedValue as {names?:string[]} | undefined)?.names?.join("、") || String(value?.rawValue ?? "");}).filter(Boolean).join(" / ")}));
  await request.semanticTasks!.saveClarification({operationId: request.operationId, originalMessage: request.originalMessage,
    question: "请明确要修改哪一笔，原始待修改条件已保存。", alternatives: labels});
  return {code: "TARGET_SELECTION_AMBIGUOUS", category: "reference", remediation: "user" as const,
    message: "请明确要修改哪一笔，原始待修改条件已保存：\n" + labels.map(item=>item.label).join("；")};
}
