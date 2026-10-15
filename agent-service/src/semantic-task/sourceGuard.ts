import type {AskMetricRequestContext} from "../requestContext.js";
import type {SemanticRequest} from "./protocol.js";
import type {SemanticIssue, SemanticTurn} from "./store.js";
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
export async function pendingCompletionSource(request: AskMetricRequestContext, input: SemanticRequest, turn: SemanticTurn, facts: GoalFacts,
  signal?: AbortSignal | undefined): Promise<NonNullable<SemanticIssue["source_options"]> | undefined> {
  const plan = turn.context?.plan;
  const clauses = request.originalMessage.split(/[，,；;。\n]+|(?<=[^，,；;。\n])(?=(?:机构|日期|时间)(?:是|用|为))/u).map(value => value.trim()).filter(Boolean);
  const explicitRetention = clauses.some(clause => /^(?:其他|其余|其它)条件(?:保持)?不变$/u.test(clause));
  if (input.intent !== "query" || !input.targets.some(target => target.source.kind === "new") || turn.context?.clarification
    || !plan || plan.owner !== request.actor.id || !["query", "reuse"].includes(plan.intent) || !(plan.status === "waiting_input" || plan.status === "completed" && explicitRetention) || plan.steps.length !== 1
    || plan.steps[0]?.kind !== "query" || facts.fragments.some(fragment => fragment.mentions.length)) return;
  const task = turn.context?.tasks.find(item => item.ref === plan.steps[0]?.taskRef);
  if (!task || task.owner !== request.actor.id || task.target.fields.metrics?.resolutionStatus !== "resolved") return;
  const pending = Object.keys(task.target.pending);
  if (plan.status === "waiting_input" && (!pending.length || pending.some(field => !["organizations", "time"].includes(field)))) return;
  if (plan.status === "completed" && ["organizations", "time"].some(field => task.target.fields[field]?.resolutionStatus !== "resolved")) return;
  let supplied = false;
  for (const clause of clauses) {
    if (/^(?:请)?(?:继续)?(?:查询|查一下|执行)(?:吧)?$/u.test(clause)) continue;
    if (/^(?:其他|其余|其它)条件(?:保持)?不变$/u.test(clause)) continue;
    const assignment = /^(机构|日期|时间)(?:改成|改为|换成|换为|选择|设为|定为|是|为|用|选)?(.+)$/u.exec(clause);
    if (!assignment) return;
    const field = assignment[1] === "机构" ? "organizations" : "time", value = assignment[2]!.trim();
    if (plan.status === "waiting_input" && !pending.includes(field)) return;
    if (field === "organizations") {
      // 目录可能从带否定/重置的短语中仍匹配机构；这不能证明用户要求沿用旧目标。
      if (/(?:不|非|除|别用|勿用|清空|清除|重置|取消|排除)/u.test(value)) return;
      const expected = new Set(facts.fragments.flatMap(fragment => fragment.organizations));
      if (!expected.size) return;
      const resolution = await request.backend.resolveBusinessField("organization", [value], {signal});
      const codes = (resolution.value as {codes?: string[]} | undefined)?.codes;
      if (resolution.status !== "resolved" || !codes?.length || codes.some(code => !expected.has(code))) return;
    } else {
      // 日期仅接受日期词汇及格式字符，不能把同句的重置/不沿用指令吞进字段原值。
      if (!/^[0-9一二两三四五六七八九十〇零年月日号天末底初本今去上前昨这周季度半年最近过去当前滚动截至至到范围\-/\s]+$/u.test(value)
        || !facts.fragments.some(fragment => fragment.calendar.ranges.length && !fragment.calendar.unresolved.length)) return;
    }
    supplied = true;
  }
  return supplied ? frozenSourceOptions(turn, request.actor.id) : undefined;
}

/** 选择多目标中的单笔须有独立来源线索；修改后的新值不能反过来冒充来源选择依据。 */
export async function sourceSelection(request: AskMetricRequestContext, input: SemanticRequest, turn: SemanticTurn, facts: GoalFacts) {
  if (!["query", "prepare", "availability"].includes(input.intent) || input.targets.length !== 1) return;
  const target = input.targets[0]!;
  if (target.source.kind !== "reference") return;
  if (["organizations", "metrics", "time"].every(field => target.operations.some(operation => operation.field === field && operation.action === "set"))
    && facts.fragments.every(fragment => fragment.organizations.length && fragment.mentions.length && fragment.calendar.ranges.length && !fragment.calendar.unresolved.length)) return;
  const source = target.source, plan = await request.semanticTasks!.plan(source.task_ref);
  if (!plan || plan.owner !== request.actor.id || plan.steps.length < 2) return;
  const candidates = [];
  for (const step of plan.steps) {
    const task = step.taskRef ? await request.semanticTasks!.get(step.taskRef) : undefined;
    const scope = ["organizations","comparison_organizations"].flatMap(field => (task?.target.fields[field]?.resolvedValue as {codes?:string[]} | undefined)?.codes ?? []);
    if (task && await scopeAvailable(request, scope)) candidates.push({step, task});
  }
  if (candidates.length < 2) return;
  const updates = await Promise.all(target.operations.flatMap(operation => "value" in operation && ["organizations", "metrics", "time"].includes(operation.field)
    ? [request.backend.inspectBusinessGoal(operation.value, turn.businessDate).then(value => ({field: operation.field, facts: value}))] : []));
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
  const options = matches.map(({step}) => ({task_ref: plan.ref, target_ref: step.targetRef}));
  if (matches.length === 1 && matches[0]!.step.targetRef === source.target_ref) return;
  if (matches.length === 1 || !matches.length) return {code: "SOURCE_SELECTOR_MISMATCH", category: "reference", remediation: "pi" as const,
    message: "所选目标与本轮来源线索不符，请按机构、指标或原日期选择匹配引用；修改后的新值不证明原目标身份。", source_options: options};
  if (/全部|所有|都|分别|各自|这些|上述|以上|一起|同时/u.test(request.originalMessage)) return {code: "SOURCE_GROUP_REQUIRED", category: "reference", remediation: "pi" as const,
    message: "本轮指向整个目标组，请用references保留全部成员，不能任选单笔。", source_options: options};
  const labels = matches.map(({step,task}) => ({task_ref: plan.ref, target_ref: step.targetRef,
    label: ["organizations","metrics","time"].map(field => {const value=task.target.fields[field];return (value?.resolvedValue as {names?:string[]} | undefined)?.names?.join("、") || String(value?.rawValue ?? "");}).filter(Boolean).join(" / ")}));
  await request.semanticTasks!.saveClarification({operationId: request.operationId, originalMessage: request.originalMessage,
    question: "请明确要修改哪一笔，原始待修改条件已保存。", alternatives: labels});
  return {code: "TARGET_SELECTION_AMBIGUOUS", category: "reference", remediation: "user" as const,
    message: "请明确要修改哪一笔，原始待修改条件已保存：\n" + labels.map(item=>item.label).join("；")};
}
