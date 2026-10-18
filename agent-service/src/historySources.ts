import type {PendingQuestion, QuestionBinding} from "./semantic-task/questions.js";

export interface HistoryQuestionSource {question_id: string; version: number; option_ids: string[]; selected: boolean}
export interface HistoryQuestionReader {
  question(questionId: string, version?: number): Promise<{question: PendingQuestion; binding: QuestionBinding} | undefined>;
}
/** 历史、快照和实时回执共用的权限来源提取。正文快照只是展示，不是授权票据。 */
export interface HistorySources {
  tasks: Map<string, string | undefined>;
  organizationScopes: string[][];
  questions: HistoryQuestionSource[];
}
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const queryKinds = new Set(["metric_query_structured", "metric_ask", "metric_read"]);
const factKeys = ["rows", "sample_rows", "facts", "comparisons"];
const hasFacts = (value: Record<string, unknown>) => factKeys.some(key => Array.isArray(value[key]));

/** 不认识的事实容器、缺引用和同一来源的冲突均失败关闭；不会执行查询 SQL。 */
export function historySources(values: unknown[], unavailable: () => never): HistorySources {
  const tasks = new Map<string, string | undefined>(), organizationScopes: string[][] = [], questions: HistoryQuestionSource[] = [];
  let referencesSeen = 0;
  const text = (value: unknown): string => typeof value === "string" && value.trim() ? value : unavailable();
  const add = (task: unknown, result?: unknown): {task: string; result?: string} => {
    const taskId = text(task), resultId = result === undefined || result === null ? undefined : text(result);
    const old = tasks.get(taskId);
    // 当前后端每个任务仅保存一份禁止覆盖的 ResultArtifact；task.version 不是结果版本。
    // 旧记录若声称同一任务有多份 result，现有端点无法逐份查证，不能借最新范围放行旧事实。
    if (old && resultId && old !== resultId) unavailable();
    tasks.set(taskId, resultId ?? old);
    referencesSeen += 1;
    return {task: taskId, ...(resultId ? {result: resultId} : {})};
  };
  const collectQuestions = (node: Record<string, unknown>): void => {
    const addQuestion = (value: unknown, rawOptions: unknown, selected: boolean) => {
      const question = object(value); if (!question || !Number.isInteger(question.version) || Number(question.version) <= 0) unavailable();
      if (!Array.isArray(rawOptions)) unavailable();
      const optionIds = (rawOptions as unknown[]).map(option => {
        const item = object(option); if (!item) unavailable();
        return text(item!.option_id);
      });
      if (!optionIds.length || new Set(optionIds).size !== optionIds.length) unavailable();
      questions.push({question_id: text(question!.question_id), version: Number(question!.version), option_ids: optionIds, selected});
    };
    if (node.pending_questions !== undefined) {
      if (!Array.isArray(node.pending_questions)) unavailable();
      for (const question of node.pending_questions as unknown[]) {
        const field = object(object(question)?.scope)?.field;
        if (field === "metrics") continue;
        if (field !== "organizations" && field !== "comparison_organizations") unavailable();
        addQuestion(question, object(question)?.options, false);
      }
    }
    if (node.answer_receipts !== undefined) {
      if (!Array.isArray(node.answer_receipts)) unavailable();
      for (const receipt of node.answer_receipts as unknown[]) {
        const selected = object(receipt)?.selected_options;
        if (Array.isArray(selected) && selected.length) addQuestion(receipt, selected, true);
        else if (selected !== undefined && !Array.isArray(selected)) unavailable();
      }
    }
  };
  type Context = {kind?: string | undefined; task?: string; result?: string; scope?: string[]};
  const collect = (value: unknown, context: Context = {}): void => {
    if (Array.isArray(value)) {for (const item of value) collect(item, context); return;}
    const node = object(value); if (!node) return;
    // 浏览器副本携带原语义回执；两份表示必须逐一检查，不能只检查外层的最后一个结果。
    if (node.semantic_task !== undefined) collect(node.semantic_task);
    if (node.protocol_version === 2) {
      collectQuestions(node);
      collect(object(node.state)?.evidence);
      if (node.direct_answer !== undefined) collectSnapshot(node.direct_answer);
      return;
    }
    const kind = typeof node.kind === "string" ? node.kind : context.kind;
    if (kind === "session_history_read" && node.status === "ok" || kind === "conversation_reply" && node.status === "answered") {
      // 原生回读正文也可能含旧数值，必须携带被读取回合的来源；旧无来源回执不能成为权限旁路。
      const sources = object(node.history_sources);
      if (!sources || !Array.isArray(sources.tasks) || !Array.isArray(sources.organizationScopes)) unavailable();
      for (const source of sources!.tasks as unknown[]) {
        const ref = object(source); if (!ref) unavailable();
        add(ref!.task_id, ref!.result_id);
      }
      for (const scope of sources!.organizationScopes as unknown[]) {
        if (!Array.isArray(scope) || !scope.length || !scope.every(code => typeof code === "string" && code)) unavailable();
        organizationScopes.push(scope as string[]); referencesSeen += 1;
      }
      return;
    }
    if (kind === "semantic_results") {
      if (!Array.isArray(node.results) || !node.results.length) unavailable();
      for (const result of node.results as unknown[]) {
        if (!object(result)) unavailable();
        const before = referencesSeen;
        collect(result);
        if (["succeeded", "SUCCEEDED"].includes(String(node.status)) && referencesSeen === before) unavailable();
      }
      // payloads 是原生正文中的冗余事实，仍需校验，不能成为隐藏的失权来源。
      if (node.payloads !== undefined) collect(node.payloads);
      return;
    }
    const success = ["succeeded", "SUCCEEDED"].includes(String(node.status));
    // 正常失败回执也携带 rows:[]；它没有可复核结果，不能要求 FAILED 任务变成 SUCCEEDED 才允许续问。
    // 成功零行仍须鉴权；失败夹带非空事实、正计数或截断标记时也不能跳过。
    const emptyQueryFailure = queryKinds.has(kind ?? "") && !context.task
      && ["failed", "FAILED", "error", "ERROR", "cancelled", "CANCELLED", "aborted"].includes(String(node.status))
      && factKeys.every(key => node[key] === undefined || Array.isArray(node[key]) && node[key].length === 0)
      && ["row_count", "fact_count"].every(key => node[key] === undefined || node[key] === 0)
      && !node.truncated && !node.facts_truncated;
    let childContext: Context = context;
    if (emptyQueryFailure) {
      childContext = {kind};
    } else if (queryKinds.has(kind ?? "") && (success || hasFacts(node) || context.task)) {
      const ref = add(node.task_id ?? context.task, node.result_id ?? context.result);
      if (context.task && ref.task !== context.task || context.result && ref.result !== context.result) unavailable();
      childContext = {kind, ...ref};
      // 每个 fact 的来源也必须属于这份正式查询，不能将其他任务的数值塞入同一回执。
      if (Array.isArray(node.facts)) for (const value of node.facts) {
        const fact = object(value); if (!fact) unavailable();
        if (fact!.task_id !== undefined && fact!.task_id !== ref.task) unavailable();
      }
    } else if (kind === "metric_calculate" && (success || hasFacts(node) || Array.isArray(node.results))) {
      const inputs = object(node.inputs); if (!inputs || !Object.keys(inputs).length) unavailable();
      const inputTasks = new Set<string>();
      for (const value of Object.values(inputs!)) {
        const input = object(value); if (!input) unavailable();
        if (input!.kind === "user_constant") continue;
        const ref = add(input!.task_id, input!.result_id); inputTasks.add(ref.task);
        if (input!.fact_id !== undefined && !text(input!.fact_id).startsWith(`fact:${ref.task}:`)) unavailable();
      }
      if (!inputTasks.size) unavailable();
      if (node.sources !== undefined) {
        if (!Array.isArray(node.sources) || !node.sources.length) unavailable();
        const declared = new Set<string>();
        for (const value of node.sources as unknown[]) {
          const source = object(value); if (!source) unavailable();
          declared.add(add(source!.task_id, source!.result_id).task);
        }
        if ([...inputTasks].some(task => !declared.has(task))) unavailable();
      }
      childContext = {kind};
    } else if (kind === "data_availability" && success) {
      const codes = object(node.request)?.org_codes;
      if (!Array.isArray(codes) || !codes.length || !codes.every(code => typeof code === "string" && code)) unavailable();
      const scope = codes as string[];
      if (context.scope && JSON.stringify([...context.scope].sort()) !== JSON.stringify([...scope].sort())) unavailable();
      organizationScopes.push(scope); referencesSeen += 1; childContext = {kind, scope};
    } else if (hasFacts(node) || (success && (Array.isArray(node.results) || typeof node.public_answer === "string"))) {
      unavailable();
    }
    const nested = object(node.result);
    if (nested) {
      // 部分旧回执将正式数据放在 result 内；外层身份不能与内层矛盾。
      if (node.task_id !== undefined && nested.task_id !== undefined && node.task_id !== nested.task_id
        || node.result_id !== undefined && nested.result_id !== undefined && node.result_id !== nested.result_id) unavailable();
      collect(nested, {...childContext, kind, ...(typeof node.task_id === "string" ? {task: node.task_id} : {}),
        ...(typeof node.result_id === "string" ? {result: node.result_id} : {})});
    }
    if (node.payloads !== undefined) collect(node.payloads, childContext);
    // 未知包装不能隐藏事实。已识别叶子的行、计算变量等业务字段由上述专用契约处理。
    if (!queryKinds.has(kind ?? "") && !["metric_calculate", "data_availability", "semantic_results"].includes(kind ?? "")) {
      for (const [key, child] of Object.entries(node)) if (!["semantic_task", "result", "payloads"].includes(key)) collect(child);
    }
  };
  const collectSnapshot = (value: unknown): void => {
    const snapshot = object(value);
    if (!snapshot || snapshot.version !== 1 || snapshot.delivery_path !== "direct_query"
      || !Array.isArray(snapshot.sources) || !snapshot.sources.length) unavailable();
    for (const value of snapshot!.sources as unknown[]) {
      const source = object(value); if (!source) unavailable();
      const ref = add(source!.task_id, text(source!.result_id));
      const expected = `query:${encodeURIComponent(ref.task)}:${encodeURIComponent(ref.result!)}`;
      if (source!.result_ref !== expected) unavailable();
    }
  };
  for (const value of values) collect(value);
  return {tasks, organizationScopes, questions};
}

/** 将公开问题引用定向还原为实际展示范围；问题读取不移动焦点，也不执行查询。 */
export async function resolveHistoryOrganizationScopes(sources: HistorySources, reader: HistoryQuestionReader | undefined,
  unavailable: () => never): Promise<string[][]> {
  const scopes = [...sources.organizationScopes];
  if (!sources.questions.length) return scopes;
  if (!reader) unavailable();
  for (const ref of sources.questions) {
    const view = await reader.question(ref.question_id, ref.version);
    if (!view || view.question.question_id !== ref.question_id || view.question.version !== ref.version) unavailable();
    const field = view.question.scope.field;
    if (field !== "organizations" && field !== "comparison_organizations") continue;
    const published = new Set(view.question.options.map(option => option.option_id));
    if (ref.option_ids.some(id => !published.has(id))) unavailable();
    if (!ref.selected && (ref.option_ids.length !== published.size
      || view.question.options.some(option => !ref.option_ids.includes(option.option_id)))) unavailable();
    if (ref.selected && !view.binding.receipts.some(receipt => {
      const ids = receipt.selected_options?.map(option => option.option_id) ?? [];
      return ids.length === ref.option_ids.length && ids.every(id => ref.option_ids.includes(id));
    })) unavailable();
    let codes: string[];
    if (view.binding.reason === "source_confirmation") {
      const condition = view.binding.sourceConfirmation?.organizationCondition as {codes?: unknown} | undefined;
      if (!Array.isArray(condition?.codes)) unavailable();
      codes = condition.codes.filter((code): code is string => typeof code === "string" && !!code);
      if (codes.length !== condition.codes.length) unavailable();
    } else {
      codes = ref.option_ids.map(id => view.binding.options.find(option => option.option_id === id)?.candidate.code)
        .filter((code): code is string => typeof code === "string" && !!code);
      if (codes.length !== ref.option_ids.length) unavailable();
    }
    if (!codes.length) unavailable();
    scopes.push([...new Set(codes)]);
  }
  return scopes;
}
