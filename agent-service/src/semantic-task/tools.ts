import {Type} from "@earendil-works/pi-ai";
import {Compile} from "typebox/compile";
import type {AgentHarnessTool, AgentToolResult} from "@earendil-works/pi-agent-core";
import type {AskMetricRequestContext} from "../requestContext.js";
import {createExecuteBusinessFrameTool, createReadBusinessResultTool, reconcileExecution} from "../tools/businessContext.js";
import {BusinessContextService} from "../business-context/service.js";
import {createCapabilities} from "../business-context/capabilities.js";
import {createFieldResolvers} from "../business-context/resolvers.js";
import {BackendApiError} from "../backendClient.js";
import {semanticParameters, prepareSemanticArguments, SemanticInputShapeError} from "./protocol.js";
import {SemanticPlanService} from "./planService.js";
import {SemanticConflict, SemanticTaskService} from "./service.js";
import type {SemanticIssue} from "./store.js";
import {semanticFeedback, type SemanticFeedback} from "./feedback.js";
import {permissionFilteredContext, scopeAvailable} from "./contextMemory.js";
import type {SemanticHistoryQuery} from "./store.js";
import {referencedQueryNumbers, requestedHistory} from "./historyReference.js";
import {completeQuery} from "./querySpec.js";
import {QuestionAnswerError} from "./questions.js";
import {backendIssue} from "./backendIssue.js";
import {recoverUnmatchedQuery, parallelMetricAlternatives, normalizeParallelMetricProposal} from "./queryRecovery.js";
import {ANALYSIS_REPAIR, pendingAnalysisRecovery, recoverAnalysisPlan, repairAnalysisPlan} from "./analysisRecovery.js";
import {analysisPlanSchema, type AnalysisPlan} from "../analysis/contracts.js";

type Tool = AgentHarnessTool<AskMetricRequestContext>;
const receipt = (feedback: SemanticFeedback, evidence?: AgentToolResult<unknown>): AgentToolResult<SemanticFeedback> => {
  const details: SemanticFeedback = evidence?.details && typeof evidence.details === "object" ? {...feedback, state: {...feedback.state,
    evidence: {...evidence.details as Record<string, unknown>, payloads: evidence.content.flatMap(block => {
      if (block.type !== "text") return [];
      try {return [JSON.parse(block.text) as unknown];} catch {return [{message: block.text}];}
    })}}} : feedback;
  // Pi实际读取content；必须与宿主/页面details使用同一份正式状态，否则会看不到任务引用而猜用Frame或结果ID。
  return {content: [{type: "text", text: JSON.stringify(details)}], details};
};
const refs = Type.Object({task_ref: Type.String({minLength: 1}), target_ref: Type.String({minLength: 1})}, {additionalProperties: false});
const checkRefs = Compile(refs);
const readSchema = Type.Object({cursor: Type.Optional(Type.String({minLength: 1})), limit: Type.Optional(Type.Integer({minimum: 1, maximum: 50})),
  task_ref: Type.Optional(Type.String({minLength: 1})), query_number: Type.Optional(Type.Integer({minimum: 1})),
  topic_ref: Type.Optional(Type.String({minLength: 1})), query: Type.Optional(Type.String({minLength: 1,maxLength: 1000})),
  latest_per_organization: Type.Optional(Type.Boolean()), status: Type.Optional(Type.Union([Type.Literal("succeeded"),Type.Literal("waiting_input")]))}, {additionalProperties: false});
const errors = (error: unknown): SemanticFeedback => {
  const denied = error instanceof BackendApiError && [401, 403].includes(error.status)
    || error instanceof SemanticConflict && error.issue.category === "permission";
  const answerError = error instanceof QuestionAnswerError ? error : undefined;
  const issue: SemanticIssue = error instanceof SemanticConflict ? error.issue : answerError
    ? {code: answerError.code, category: answerError.remediation === "stop" ? "reference" : "input_shape",
      message: answerError.message, remediation: answerError.remediation}
    : backendIssue(error);
  const status = denied ? "denied" : error instanceof SemanticConflict
    ? error.issue.remediation === "user" ? "needs_user"
      : error.issue.remediation === "pi" ? error.issue.category === "reference" ? "conflict" : "needs_interpretation" : "failed"
    : answerError ? answerError.remediation === "user" ? "needs_user" : answerError.remediation === "pi" ? "needs_interpretation" : "failed"
      : issue.remediation === "pi" ? "needs_interpretation" : "failed";
  const feedback = semanticFeedback(undefined, status, [issue]);
  if (issue.remediation === "pi" && issue.source_options?.length) feedback.continuation = {actor: "pi", action: "revise_proposal"};
  return feedback;
};
const readFailure = (result: AgentToolResult<unknown>) => {
  // 旧读取器的结构化错误可能只在正文JSON中；不能把权限拒绝降为普通读取失败。
  const codes = [(result.details as {error_code?: string} | undefined)?.error_code, ...result.content.flatMap(block => {
    if (block.type !== "text") return [];
    try {const payload = JSON.parse(block.text) as {error?: {code?: unknown}; error_code?: unknown} | null; return [payload?.error?.code, payload?.error_code];}
    catch {return [];}
  })];
  const denied = codes.includes("PERMISSION_DENIED");
  return new SemanticConflict({code: denied ? "PERMISSION_DENIED" : "RESULT_READ_FAILED", category: denied ? "permission" : "infrastructure",
    message: denied ? "当前权限不足，不能读取历史结果。" : "结果读取未成功，原查询结果仍保留。", remediation: "stop"});
};
export function createSemanticResolveTool(): Tool {
  return {name: "resolve_business_turn", label: "解析业务语义任务", description: "版本2整笔业务提议。新查询用target.query输出完整结构化机构、指标、时间、取数方式与操作，真实缺项写null；排名直接给position/top_n，不写排序描述。经营分析用intent=analyze、target.analysis完整计划，机构日期写同一target.operations；不混填query。继承或局部修改用operations，排序修改使用queryOperation对象。已发布字段问题用顶层answers。程序绑定目录身份、机构权限和日历后执行，不重新猜排序语义。source及引用见轮状态或business_context_read。",
    parameters: semanticParameters, prepareArguments: prepareSemanticArguments,
    execute: async (_id, args, _update, request, _invocation, context) => {
       try {
         const pending = await pendingAnalysisRecovery(request);
         if (pending) return receipt(pending);
         const input = await normalizeParallelMetricProposal(request, prepareSemanticArguments(args));
        const feedback = await new SemanticPlanService(request, context.abortSignal).resolve(input);
         return receipt(await recoverAnalysisPlan(request, await recoverUnmatchedQuery(request, feedback)));}
      catch (error) {
        // 拒绝模型同轮自确认仍保留原门禁；已有并列恢复时给出可执行的纠错方向，不能改成确认成功。
        if (error instanceof QuestionAnswerError && error.code === "QUESTION_NOT_PUBLISHED") {
          const recovery = (await request.semanticTasks?.turn(request.operationId))?.queryRecovery;
          const plan = recovery ? await request.semanticTasks?.plan(recovery.planRef) : undefined;
          if (plan?.owner === request.actor.id && recovery?.scopes.some(scope => parallelMetricAlternatives(scope.fields.metrics, request.originalMessage).length)) {
            const feedback = await new SemanticPlanService(request, context.abortSignal).feedback(plan, "needs_interpretation");
            feedback.pending_questions = feedback.pending_questions.filter(question => question.scope.field !== "metrics");
            feedback.issues = [{code: "QUERY_RECOVERY_ANALYSIS_REQUIRED", field: "metrics", category: "catalog", remediation: "pi",
              message: "不能替用户确认单选题。当前相关指标应并列查询：继续同一source，提交intent=analyze、analysis.kind=business_analysis及目录k引用的observe计划，不填写answers或普通query。系统会补齐已发现候选读取，保留原机构日期；没有用户确认发生。"}];
            return receipt(feedback);
          }
        }
        return receipt(error instanceof SemanticInputShapeError
        ? semanticFeedback(undefined, "invalid_input", error.problems.map(problem => ({code: "INPUT_SHAPE_INVALID", field: problem.path,
          category: "input_shape", message: `参数位置${problem.path}未通过${problem.rule}校验。${problem.hint ? problem.hint + "。" : ""}请对照版本2 Schema修正该位置的结构，保留其他已正确条件；对象和数组不能写成JSON字符串。`, remediation: "pi"}))) : errors(error));}
    }};
}
export function createAnalysisRepairTool(): Tool {
  const parameters = Type.Unsafe<{task_ref: string; target_ref: string; revision: number; steps: AnalysisPlan["steps"]}>({type: "object",
    required: ["task_ref", "target_ref", "revision", "steps"], additionalProperties: false,
    properties: {task_ref: {type: "string", minLength: 1}, target_ref: {type: "string", minLength: 1}, revision: {type: "integer", minimum: 0},
      steps: analysisPlanSchema.properties.steps}});
  return {name: ANALYSIS_REPAIR, label: "修复分析缺失步骤", parameters,
    description: "仅在analysis_recovery期间使用。引用该回执task_ref/target_ref/revision，只提交diagnostics指定的缺失或错误steps，answers引用原requirements.id。原机构日期、目标、正确步骤由程序保留；不能重交完整计划、删除子问题或编造gap_reason。补查目录后使用正式指标引用。",
    execute: async (_id, args, _update, request, _invocation, context) => {
      try {return receipt(await repairAnalysisPlan(request, args as {task_ref: string; target_ref: string; revision: number; steps: AnalysisPlan["steps"]}, context.abortSignal));}
      catch (error) {return receipt(errors(error));}
    }};
}
export function createSemanticContextTool(): Tool {
  return {name: "business_context_read", label: "读取任务条件", description: "定向读取同会话历史。按query_number定位第N次业务任务，task_ref定位计划，topic_ref查同一主题，query按机构/指标/日期词检索；latest_per_organization仅在用户明确指机构集合时取每个机构最新来源。返回完整配对references、条件和分页；不能把最近N次猜成N家。读取不切业务焦点、不取数；多个历史来源用source.references逐来源继承。", parameters: readSchema,
    execute: async (_id, args, _update, request) => {
      if (!request.semanticTasks) throw new Error("SEMANTIC_STORE_NOT_BOUND");
      const context = await permissionFilteredContext(request, await request.semanticTasks.searchContext(args as SemanticHistoryQuery));
      return {content: [{type: "text", text: JSON.stringify(context)}], details: {protocol_version: 2, context}};
    }};
}
/** 真歧义由Pi判断；宿主只验证备选引用并保留待明确原句，绝不预执行任何分支。 */
export function createSemanticClarifyTool(): Tool {
  const parameters = Type.Object({context_action: Type.Optional(Type.Union([Type.Literal("resume"), Type.Literal("abandon")])), question: Type.String({minLength: 1, maxLength: 2000}), alternatives: Type.Array(
    Type.Object({task_ref: Type.String({minLength: 1}), target_ref: Type.String({minLength: 1}), label: Type.String({minLength: 1, maxLength: 300})}, {additionalProperties: false}), {minItems: 2, maxItems: 100})}, {additionalProperties: false});
  const validator = Compile(parameters);
  return {name: "clarify_business_turn", label: "明确业务目标", description: "仅当结合上下文仍有多个合理目标解释时使用：提交一个必要追问和真实备选目标引用。保留本轮未完成原句供用户明确后继续，不取数、不修改Frame。能明确目标时直接resolve_business_turn，不固定询问。",
    parameters, execute: async (_id, raw, _update, request) => {
      try {
        if (!validator.Check(raw)) throw new SemanticConflict({code: "CLARIFICATION_SHAPE_INVALID", category: "input_shape", message: "请提交必要追问与至少两个真实备选引用。", remediation: "pi"});
        const input = structuredClone(raw) as {context_action?: "resume" | "abandon"; question: string; alternatives: Array<{task_ref: string; target_ref: string; label: string}>};
        const store = request.semanticTasks!;
        const identities = new Set<string>();
        for (const alternative of input.alternatives) {
          const plan = await store.plan(alternative.task_ref);
          if (!plan || plan.owner !== request.actor.id || !plan.steps.some(step => step.targetRef === alternative.target_ref)) throw new SemanticConflict({code: "REFERENCE_INVALID", category: "reference", message: "备选目标必须来自当前会话宿主签发的引用，请读取上下文后重提。", remediation: "pi"});
          identities.add(JSON.stringify([alternative.task_ref, alternative.target_ref]));
        }
        if (identities.size !== input.alternatives.length) throw new SemanticConflict({code: "CLARIFICATION_ALTERNATIVES_DUPLICATED", category: "reference", message: "备选目标重复，不能把同一目标当成多个解释。", remediation: "pi"});
        const turn = await store.admit(request.operationId, request.originalMessage), prior = turn.context?.clarification;
        if (input.context_action === "resume" && !prior) throw new SemanticConflict({code: "CLARIFICATION_SOURCE_REQUIRED", category: "reference", message: "没有已保存的待明确输入可续接，请核对上下文。", remediation: "pi"});
        const originalMessage = input.context_action === "resume" && prior ? prior.originalMessage + "\n" + request.originalMessage : request.originalMessage;
        await store.saveClarification({operationId: request.operationId, originalMessage, question: input.question, alternatives: input.alternatives});
        return receipt(semanticFeedback(undefined, "needs_user", [{code: "TARGET_INTERPRETATION_AMBIGUOUS", category: "semantic", message: input.question + "\n" + input.alternatives.map(item => item.label).join("；"), remediation: "user"}]));
      } catch (error) {return receipt(errors(error));}
    }};
}
async function taskFor(request: AskMetricRequestContext, taskRef: string, targetRef: string) {
  const task = await request.semanticTasks?.get(taskRef);
  if (!task || task.owner !== request.actor.id || task.target.ref !== targetRef) throw new SemanticConflict({code: "REFERENCE_INVALID", category: "reference", message: "任务和目标引用不可读取或已修订，请重新读取上下文。", remediation: "pi"});
  if (task.parentPlan && !request.semanticStep) throw new SemanticConflict({code: "PLAN_REFERENCE_REQUIRED", category: "reference", message: "子步骤不能绕过完整任务执行。", remediation: "pi"});
  return task;
}
export function createSemanticExecuteTool(): Tool {
  return {name: "execute_business_frame", label: "执行获准步骤", parameters: refs,
    prepareArguments: raw => {if (!checkRefs.Check(raw)) throw new Error("SEMANTIC_REFERENCE_SHAPE_INVALID"); return structuredClone(raw);},
    description: "只执行当前任务已签发许可的步骤。引用复制自版本2回执；宿主复核版本和权限，参数不含Frame编码、日期或SQL。结果未知仅回查原命令。",
    execute: async (id, args, update, request, invocation, context) => {
      let binding: Awaited<ReturnType<SemanticPlanService["locate"]>> | undefined;
      const rootOperationId = request.operationId, plans = new SemanticPlanService(request, context.abortSignal);
      let readOnly = false;
      try {
        const {task_ref, target_ref} = args as {task_ref: string; target_ref: string};
        binding = await request.semanticTasks?.plan(task_ref) ? await plans.locate(task_ref, target_ref) : undefined;
        if (binding) {
          if (binding.step.kind === "calculation" && !binding.step.taskRef) await plans.prepareCalculation(binding.plan, binding.step);
          request = binding.request;
        }
        const internalRef = binding?.step.taskRef ?? task_ref;
        let task = await taskFor(request, internalRef, target_ref);
        const store = request.frames!;
        const frame = task.target.frameId ? await store.get(task.target.frameId) : undefined;
        const index = await store.state();
        const latest = frame ? await store.get(index.operations[frame.operationFrameId] ?? frame.frameId) : undefined;
        const service = new SemanticTaskService(request, context.abortSignal);
        if (latest?.status === "executing") {
          const settlement = await reconcileExecution(request, latest, context.abortSignal);
          if (!settlement) return receipt(semanticFeedback(task, "unknown"));
          const frames = new BusinessContextService(store, createCapabilities(), createFieldResolvers());
          const completed = await frames.finishExecution(latest, settlement);
          task = (await service.settle(task, completed))!;
        }
        // 已结算结果只重显，避免一次历史读取再次写回原任务状态。
        if ((latest?.status === "success" && task.target.status !== "succeeded") || (latest?.status === "failed" && task.target.status !== "failed")) task = (await service.settle(task, latest))!;
        if (task.target.status === "succeeded") {
          readOnly = !!binding && binding.plan.operationId !== rootOperationId && binding.step.status === "succeeded";
          const result = await createReadBusinessResultTool().execute(id, {frameId: task.target.frameId!, setFocus: false}, update, request, invocation, context);
          if (binding && (result.details as {status?: string})?.status !== "succeeded") {
            return receipt(await plans.rejected(binding.plan.ref, readFailure(result), {readOnly}), result);
          }
          return receipt(binding ? await plans.settled(binding.plan.ref, binding.step.id, task, {readOnly}) : semanticFeedback(task, "reused"), result);
        }
        if (["unknown", "failed"].includes(task.target.status)) return receipt(semanticFeedback(task, task.target.status));
        const consumed = await service.consume(internalRef, target_ref);
        const result = await createExecuteBusinessFrameTool().execute(id, {frameId: consumed.frameId}, update, request, invocation, context);
        const state = await store.state();
        const current = frame ? await store.get(state.operations[frame.operationFrameId] ?? consumed.frameId) : undefined;
        const settled = (await service.settle(consumed.task, current))!;
        const status = settled.target.status === "succeeded" ? "succeeded" : settled.target.status === "failed" ? "failed" : "unknown";
        return receipt(binding ? await plans.settled(binding.plan.ref, binding.step.id, settled) : semanticFeedback(settled, status), result);
      } catch (error) {return receipt(binding ? await plans.rejected(binding.plan.ref, error, {readOnly}) : errors(error));}
    }};
}
export function createSemanticReadTool(): Tool {
  const readRefs=Type.Object({task_ref:Type.String({minLength:1}),target_ref:Type.String({minLength:1}),discussion:Type.Optional(Type.Boolean({description:"用户明确查看并继续讨论此旧结果时为true；后台取证为false。仅更新讨论和展示焦点，保留原业务任务及待澄清事项。"}))},{additionalProperties:false});
  return {name: "read_business_result", label: "读取任务结果", description: "只读取指定任务已有成功结果，复核当前权限，不重新查询。引用来自宿主回执。", parameters: readRefs,
    execute: async (id, args, update, request, invocation, context) => {
      let binding: Awaited<ReturnType<SemanticPlanService["locate"]>> | undefined;
      const originalMessage = request.originalMessage;
      const rootOperationId = request.operationId, plans = new SemanticPlanService(request, context.abortSignal);
      let readOnly = false;
      let requiresCalculation = false;
      try {
        const {task_ref, target_ref} = args as {task_ref: string; target_ref: string};
        const numbers = referencedQueryNumbers(request.originalMessage);
        if (numbers.length === 1 && !/(?:刚才|上次|上一轮|当前)/u.test(request.originalMessage)) {
          const expected = await requestedHistory(request);
          if (!expected.some(row => row.task_ref === task_ref && row.target_ref === target_ref)) {
            const inaccessible = (await request.semanticTasks!.historyCatalog()).some(row => row.query_number === numbers[0] && row.task_ref === task_ref && row.target_ref === target_ref);
            if (inaccessible) throw new SemanticConflict({code: "PERMISSION_DENIED", category: "permission", remediation: "stop", message: "所选历史来源当前无权访问，未读取或交付结果。"});
            throw new SemanticConflict({
            code: "HISTORY_QUERY_ORDINAL_MISMATCH", category: "reference", remediation: "pi",
            message: "所选来源与用户明确的查询序号不符，未读取或交付该结果。请按requested_history选择配对引用。",
            source_options: expected.map(row => ({task_ref: row.task_ref, target_ref: row.target_ref})),
            });
          }
        }
        binding = await request.semanticTasks?.plan(task_ref) ? await plans.locate(task_ref, target_ref) : undefined;
        readOnly = !!binding && binding.plan.operationId !== rootOperationId;
        if (binding) request = binding.request;
        const task = await taskFor(request, binding?.step.taskRef ?? task_ref, target_ref);
        if (numbers.length && /展示|重显|回看|查看|回读/u.test(originalMessage)) {
          const turn = await request.semanticTasks!.turn(rootOperationId);
          const conversation = await request.commands.getConversationId();
          const sources = [];
          // 失权不能让用户点名的旧机构消失，再把同次查询的有权机构误当成唯一来源。
          // 历史定位只传历史规范化 spec，不再附旧签票回执。
          for (const row of (await request.semanticTasks!.historyCatalog()).filter(row => numbers.includes(row.query_number))) {
            const plan = await request.semanticTasks!.plan(row.task_ref);
            const step = plan?.steps.find(step => step.targetRef === row.target_ref);
            const historical = step?.taskRef ? await request.semanticTasks!.get(step.taskRef) : undefined;
            const spec = historical && completeQuery(historical.target);
            if (plan?.owner === request.actor.id && historical?.owner === request.actor.id && spec) sources.push({spec});
          }
          const goal = await request.backend.inspectBusinessGoal(originalMessage, turn!.businessDate, {signal: context.abortSignal}, undefined,
            conversation && sources.length ? {conversation_id: conversation, session_id: request.sessionId, sources} : undefined);
          requiresCalculation = goal.requires_calculation === true;
          if (!requiresCalculation) {
            const orgs = goal.fragments.flatMap(fragment => fragment.organizations);
            if (!await scopeAvailable(request, orgs)) throw new SemanticConflict({code: "PERMISSION_DENIED", category: "permission", remediation: "stop", message: "用户指定的历史机构当前无权访问，未读取或交付结果。"});
            const spec = completeQuery(task.target);
            const fragments = goal.fragments.filter(fragment => fragment.organizations.length || fragment.mentions.length || fragment.calendar.ranges.length);
            const compatible = spec && (!fragments.length || fragments.some(fragment => {
              const metrics = fragment.mentions.flatMap(mention => (mention.resolution.value as {codes?:string[]} | undefined)?.codes ?? []);
              return (!fragment.organizations.length || spec.org_codes?.every(code => fragment.organizations.includes(code)))
                && (!fragment.mentions.length || spec.metric_codes.every(code => metrics.includes(code)))
                && (!fragment.calendar.ranges.length || fragment.calendar.ranges.some(range => range.start === spec.time.start && range.end === spec.time.end
                  && JSON.stringify(range.dates ?? []) === JSON.stringify(spec.time.dates ?? [])));
            }));
            if (!compatible) throw new SemanticConflict({code: "HISTORY_READ_SCOPE_MISMATCH", category: "reference", remediation: "pi", message: "所选历史结果与用户明确的机构、指标或日期不符，请选择匹配来源；未交付该结果。"});
          }
        }
        if (task.target.status !== "succeeded" || !task.target.frameId) return receipt(semanticFeedback(task, "needs_user", [{code: "RESULT_NOT_READY", category: "reference", message: "所选目标尚无成功结果，不能重显或冒充重新查询。", remediation: "user"}]));
        const result = await createReadBusinessResultTool().execute(id, {frameId: task.target.frameId, setFocus: false}, update, request, invocation, context);
        const succeeded = (result.details as {status?: string})?.status === "succeeded";
        if (succeeded && binding) {
          const discussion = (args as {discussion?:boolean}).discussion;
          const explicitView = discussion === undefined && numbers.length === 1 && /展示|重显|回看|查看|回读/u.test(originalMessage)
            && !requiresCalculation;
          if (discussion || explicitView) await request.semanticTasks!.discussion(binding.plan.ref);
        }
        const failure = readFailure(result);
        return receipt(binding ? succeeded ? await plans.settled(binding.plan.ref, binding.step.id, task, {readOnly}) : await plans.rejected(binding.plan.ref, failure, {readOnly}) : semanticFeedback(task, succeeded ? "reused" : failure.issue.category === "permission" ? "denied" : "failed", succeeded ? [] : [failure.issue]), result);
      } catch (error) {return receipt(binding ? await plans.rejected(binding.plan.ref, error, {readOnly}) : errors(error));}
    }};
}
/** 能力说明工具接入语义回执：综合分析改用 analyze 规划，其余保留原能力说明。 */
export function semanticCapabilityTool(tool: Tool): Tool {
  return {...tool,
    description: "说明尚未提供的预测、因果归因或血缘能力。综合分析已支持现有指标查询、比较排名、覆盖和可验证公式，应使用resolve_business_turn的analyze分阶段规划，不因综合分析这一名称拒绝。",
    execute: async (...args: Parameters<Tool["execute"]>) => {
      if ((args[1] as {capability: string}).capability === "comprehensive_analysis") return receipt(semanticFeedback(undefined, "needs_interpretation", [{
        code: "ANALYSIS_AVAILABLE", category: "capability", message: "综合分析已支持现有指标、比较排名、覆盖与公式；请保留用户目标，使用analyze继续同一Pi循环，取得结果后再规划。", remediation: "pi"}]));
      const result = await tool.execute(...args), details = result.details as {public_answer?: string};
      return receipt(semanticFeedback(undefined, "unsupported", [{code: "CAPABILITY_UNSUPPORTED", category: "capability",
        message: details.public_answer ?? "当前能力尚未提供。", remediation: "stop"}]));
    }};
}
/** 原生校验失败会跳过after_tool。隔离结构错误为正式回执，避免不同错误走不同恢复链。
 * 仅原生注册适配器接收未转换JSON；执行入口仍先用唯一严格Schema核验，错误绝不进入解析/执行。
 */
export function semanticRuntimeAdapter(tool: Tool): Tool {
  return tool.name === "resolve_business_turn" ? {...tool, parameters: Type.Unsafe({}), prepareArguments: raw => structuredClone(raw)} : tool;
}
/** 给模型的Schema始终唯一且严格；原生隔离适配器的容器形状不得公开。 */
export function semanticPublicToolDefinitions(payload: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(payload.tools)) return payload;
  return {...payload, tools: payload.tools.map(raw => {
    const definition = raw as {name?: string; function?: {name?: string}};
    if (definition.function?.name === "resolve_business_turn") return {...definition, function: {...definition.function, parameters: semanticParameters}};
    return definition.name === "resolve_business_turn" ? {...definition, parameters: semanticParameters} : raw;
  })};
}
