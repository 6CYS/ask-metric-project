import type {AskMetricRequestContext} from "../requestContext.js";
import {validateAnalysisPlanShape} from "../analysis/contracts.js";
import {resolveCatalogBindings} from "../analysis/bindings.js";
import {hasInputEvidence} from "../business-context/inputEvidence.js";
import {completeRankingOperation} from "../business-context/rankingEvidence.js";
import {metricMentions} from "../business-context/metricMentions.js";
import {applyMetricDefaultContext} from "../business-context/metricDefaults.js";
import {SemanticConflict} from "./service.js";
import {resolveTurnField, updateCollection, type EntityValue, type TurnFacts} from "./actionBinding.js";
import type {SemanticRequest} from "./protocol.js";
import type {SemanticPlan, SemanticTurn} from "./store.js";

type Descriptor = {code: string; name: string; binding_ref: string};
function repair(field: string, message: string): never {throw new SemanticConflict({code: "TASK_MATERIALIZATION_REQUIRED",
  field, category: "input_shape", remediation: "pi",
  message: message + "保留原source和已确认范围，用轻量analysis.actions补齐本轮目标，不要求用户填写内部参数。"});}
const descriptors = (value: unknown): Descriptor[] => Array.isArray(value) ? value.filter((item): item is Descriptor =>
  !!item && typeof item.code === "string" && typeof item.name === "string" && typeof item.binding_ref === "string") : [];

/** 追问只由模型表达变化；宿主从冻结来源重建完整业务目标，重新编译计划，不跨能力搬运执行参数。 */
export async function materializeTaskRequest(request: AskMetricRequestContext, input: SemanticRequest,
  turn: SemanticTurn, focus: SemanticPlan | undefined, facts: TurnFacts, signal?: AbortSignal): Promise<SemanticRequest> {
  if (!["query", "analyze", "prepare"].includes(input.intent) || input.answers?.length) return input;
  const result = structuredClone(input);
  for (const target of result.targets) {
    if (target.source.kind === "new" || target.source.kind === "references") continue;
    const declared = target.operations.find(op => op.field === "_analysis");
    const changes = target.operations.filter(op => ["metrics", "operation"].includes(op.field));
    if (declared && !changes.some(op => op.field === "metrics")) continue;
    const source = target.source;
    const parent = source.kind === "reference" ? await request.semanticTasks?.plan(source.task_ref) : turn.context?.plan ?? focus;
    if (!parent || parent.owner !== request.actor.id) continue; // 归属与多源歧义仍由统一来源守卫裁决。
    const steps = source.kind === "reference" ? parent.steps.filter(step => step.targetRef === source.target_ref) : parent.steps;
    if (steps.length !== 1 || !steps[0]?.taskRef) continue;
    if (source.kind === "reference" && !await request.semanticTasks?.planReference(source.target_ref, source.task_ref)) continue;
    const task = turn.context?.tasks.find(item => item.ref === steps[0]!.taskRef)
      ?? await request.semanticTasks?.get(steps[0]!.taskRef);
    const field = task?.target.fields.plan;
    if (!task || task.owner !== request.actor.id || task.capability !== "business_analysis" || task.target.status !== "succeeded"
      || field?.resolutionStatus !== "resolved" || !validateAnalysisPlanShape(field.resolvedValue)) continue;
    const plan = structuredClone(field.resolvedValue);
    // 只有业务条件和目标参与续接；旧补查依据、结果、许可及执行状态不成为新计划。
    delete plan.inquiry;
    let repeated: typeof plan | undefined;
    if (declared) {
      const value = declared.action === "set" ? JSON.parse(declared.value) as {kind?: string; plan?: unknown} : undefined;
      if (value?.kind !== "business_analysis" || !validateAnalysisPlanShape(value.plan) || value.plan.workflow_id
        || !value.plan.steps.length || value.plan.steps.some(step => step.method !== "observe" || step.depends_on?.length || step.organization_from_step)
        || value.plan.requirements.some(item => item.gap_reason))
        repair("analysis", "变化字段与独立分析目标不能混合：请仅提交变化，或用analysis.actions提交完整本轮目标。");
      // 兼容模型重复附带旧观察动作；变化操作才是本轮增减语义，不能被旧动作覆盖。
      repeated = resolveCatalogBindings(request, value.plan);
    }
    if (target.operations.some(op => !["organizations", "time", "metrics", "operation", "objective", "_analysis"].includes(op.field)))
      repair("analysis", "本轮包含需要重新规划的取数或计算方式。");
    const scope = target.operations.filter(op => ["organizations", "time"].includes(op.field));
    if (scope.some(op => !["set", "clear"].includes(op.action))) repair("organizations", "机构集合修改须先形成明确的本轮范围。");
    if (changes.length) {
      // 独立观察项可按本轮指标集合重新组合；有关系、依赖或多种方法时交模型重规划。
      if (!plan.workflow_id && plan.steps.length > 1 && plan.steps.every(step => step.method === "observe"
        && !step.depends_on?.length && !step.organization_from_step) && plan.requirements.every(item => !item.gap_reason)) {
        plan.steps = [{...plan.steps[0]!, metric_refs: [...new Set(plan.steps.flatMap(step => step.metric_refs))], answers: ["q1"]}];
        plan.requirements = [{id: "q1", question: request.originalMessage.slice(0, 300)}];
      }
      if (plan.workflow_id || plan.steps.length !== 1 || plan.requirements.length !== 1
        || plan.steps[0]?.method === "structure" || plan.steps[0]?.depends_on?.length || plan.steps[0]?.organization_from_step)
        repair("analysis", "原任务有多个分析义务或依赖关系，请按本轮变化重新组织分析动作，不能直接改旧执行步骤。");
      const step = plan.steps[0]!;
      const metricChanges = changes.filter(op => op.field === "metrics");
      const checked = metricChanges.length || repeated ? await request.backend.analysisValidate(plan, "", {signal}) : undefined;
      let selected = descriptors(checked?.metric_descriptors);
      if (metricChanges.length && !selected.length) repair("metrics", "来源计划的正式指标身份需要重新读取目录。");
      const original = new Map(selected.map(item => [item.code, item]));
      let priorIdentity: Promise<Descriptor[]> | undefined;
      const priorDescriptors = () => priorIdentity ??= (async () => {
        // “再加上”可能恢复刚被移除的指标；只读取同一话题根的正式身份，不复用历史数值。
        if (!parent.topicRef || parent.topicRef === parent.ref) return [];
        const root = await request.semanticTasks?.plan(parent.topicRef);
        if (!root || root.owner !== request.actor.id || root.steps.length !== 1 || !root.steps[0]?.taskRef) return [];
        const previous = await request.semanticTasks?.get(root.steps[0].taskRef);
        const previousPlan = previous?.target.fields.plan;
        if (previous?.owner !== request.actor.id || previous.capability !== "business_analysis"
          || previous.target.status !== "succeeded" || previousPlan?.resolutionStatus !== "resolved"
          || !validateAnalysisPlanShape(previousPlan.resolvedValue)) return [];
        return descriptors((await request.backend.analysisValidate(previousPlan.resolvedValue, "", {signal})).metric_descriptors);
      })();
      for (const op of metricChanges) {
        if (!["set", "add", "replace", "exclude"].includes(op.action)) repair("metrics", "该指标变更需要先明确目标指标。");
        const resolve = async (raw: string): Promise<EntityValue> => {
          const mentions = facts.fragments.flatMap(fragment => fragment.mentions);
          const grounded = new Set(mentions.flatMap(mention => [
            ...((mention.resolution.value as EntityValue | undefined)?.codes ?? []),
            ...(mention.resolution.candidates ?? []).flatMap(candidate => candidate.code ? [candidate.code] : []),
          ]));
          let found = applyMetricDefaultContext(await resolveTurnField(request, "metric", [raw], {signal}),
            {codes: [...original.keys()], names: [...original.values()].map(item => item.name)});
          if (found.metadata?.metric_defaults && !found.metadata.default_context_applied) {
            const prior = await priorDescriptors();
            found = applyMetricDefaultContext(found, {codes: prior.map(item => item.code), names: prior.map(item => item.name)});
          }
          let value = found.status === "resolved" ? found.value as EntityValue : undefined;
          if (!value?.codes?.length) {
            // 泛称只有在原目录候选与已选指标交集唯一时才能沿用原口径；不从新候选任选。
            const candidates = new Set((found.candidates ?? []).flatMap(candidate => candidate.code ? [candidate.code] : []));
            let known = [...original.values()].filter(item => candidates.has(item.code));
            if (!known.length) known = (await priorDescriptors()).filter(item => candidates.has(item.code));
            if (known.length === 1) value = {codes: [known[0]!.code], names: [known[0]!.name]};
          }
          if (!value?.codes?.length || value.codes.some(code => !grounded.has(code)) && !hasInputEvidence(request.originalMessage, raw))
            repair("metrics", "本轮指标含义或口径尚未唯一绑定，请用正式目录候选完成指标选择。");
          return value!;
        };
        const raw = "value" in op ? op.value : "subject" in op ? op.subject : "";
        const value = await resolve(raw);
        const subject = op.action === "replace" ? await resolve(op.subject) : undefined;
        const before = {codes: selected.map(item => item.code), names: selected.map(item => item.name)};
        const next = updateCollection(before, op.action as "set" | "add" | "replace" | "exclude", value, subject);
        if (!next?.codes.length) repair("metrics", "指标变更没有留下可执行指标，或替换对象不属于所选任务。");
        selected = await Promise.all(next!.codes.map(async (code, index) => {
          const known = original.get(code);
          if (known) return known;
          const catalog = await request.backend.analysisCatalog(code, 1, 1, {signal});
          const exact = descriptors(catalog.items).filter(item => item.code === code);
          if (exact.length !== 1) repair("metrics", `正式指标${next!.names[index]}尚未取得可执行目录绑定。`);
          return exact[0]!;
        }));
      }
      if (repeated) {
        const allowed = new Set([...original.values(), ...selected].map(item => item.binding_ref));
        if (repeated.steps.some(item => item.metric_refs.some(ref => !allowed.has(ref))))
          repair("metrics", "附带分析包含变化字段以外的新指标，请用analysis.actions明确完整本轮目标。");
      }
      const operations = changes.filter(op => op.field === "operation");
      if (operations.length > 1) repair("operation", "同一目标的查询操作存在多个修改。");
      if (operations.length) {
        const op = operations[0]!;
        if (op.action !== "set" || !op.queryOperation || op.queryOperation.kind === "sort")
          repair("operation", "本轮操作须明确普通取值或榜单方向与数量。");
        // 方向由模型理解本轮目标；只补可证明的空槽，不用词法模板否定“那最高呢”等省略表达。
        const operation = op.queryOperation.kind === "ranking" ? await completeRankingOperation(op.queryOperation,
          {originalMessage: request.originalMessage, currentDate: turn.businessDate, turnId: request.operationId,
            resolveCatalog: async () => ({status: "invalid"}), resolveMetricMentions: question => metricMentions(request, question)}) : op.queryOperation;
        if (operation.kind !== "value" && (operation.kind !== "ranking" || operation.position == null || operation.top_n == null))
          repair("operation", "本轮榜单方向、数量或比较操作尚未明确。");
        step.method = operation.kind === "ranking" ? "ranking" : "observe";
        delete step.position; delete step.top_n; delete step.comparisons;
        if (operation.kind === "ranking") {step.position = operation.position!; step.top_n = operation.top_n!;}
      }
      if (metricChanges.length) step.metric_refs = selected.map(item => item.binding_ref);
      step.rationale = request.originalMessage.slice(0, 500);
      plan.requirements[0]!.question = request.originalMessage.slice(0, 300);
      delete plan.requirements[0]!.gap_reason;
    }
    plan.objective = request.originalMessage.slice(0, 500);
    target.operations = [...scope, {action: "set", field: "_analysis", value: JSON.stringify({kind: "business_analysis", plan})}];
    if (result.intent !== "prepare") result.intent = "analyze";
  }
  return result;
}
