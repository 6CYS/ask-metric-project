import { selectReportSources } from "../analysis/reportSources.js";
import { markPartialAnalysisReport } from "../tools/partialAnalysis.js";
import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentHarnessTool, AgentMessage } from "@earendil-works/pi-agent-core";
import type { AskMetricRequestContext } from "../requestContext.js";
import { BackendApiError } from "../backendClient.js";
import { isCurrentAnalysisEvidence, type EvidenceReference } from "../answerEvidence.js";
import type { AnalysisEvidence } from "../analysis/tools.js";
import {
  narrativeEvidenceRefs,
  normalizeReportNarrative,
  parseNarrativeReference,
  NarrativeReferenceError,
  verifiedNarrativeRefs,
} from "../analysis/narrative.js";
import {
  analysisEvidenceAliases,
  expandFindingRefs,
  findingDependencies,
} from "../analysis/verifiedFindings.js";
import { reportChartHasNarrativeEvidence, reportChartSchema } from "../analysis/reportCharts.js";
import { buildInquiryChart, latestInquiryChart } from "./chartTool.js";
import { currentTurnMessages } from "../tools/turnContract.js";
import { isInquiryCalculation, type InquiryCalculation } from "./calculationTool.js";
import type { TimeAlternative } from "../business-context/types.js";
import { currentInquiryTarget, inquiryTargetCoverage } from "./target.js";

const parameters = Type.Object(
  {
    body: Type.String({
      minLength: 1,
      // 包含引用坐标的传输长度；剥离协议后，正文仍由后端限制为 6000 字符。
      maxLength: 24000,
      description:
        "自然回答原问题。精确数字使用{{e1.v1}}，最终显示该事实的数值和单位；机构、指标、日期按引用所属结果表述。{{e1.v1|cite}}只关联来源，不显示值，也不证明整句判断已经核验。可自然概括已有且口径确认的比例，不为措辞补查、计算或逐段重复引用；新增运算结果仍通过计算工具取得。先给业务结论，再用关键数据说明，不逐项抄表。缺数如实说明，口径未确认的比例暂不用于分析。",
    }),
    chart: Type.Optional(reportChartSchema),
  },
  { additionalProperties: false },
);

type Source = EvidenceReference & {
  evidence: AnalysisEvidence & { time_variants?: TimeAlternative[] };
};

function currentTimeAlternatives(
  sources: Source[],
  request: AskMetricRequestContext,
): TimeAlternative[] {
  if (request.timeOverride) return [];
  const choices = sources
    .filter(({ evidence }) => isCurrentAnalysisEvidence(evidence, request.operationId))
    .map(({ evidence }) => evidence.time_variants ?? []);
  const first = choices[0] ?? [];
  // 页面切换作用于整个问题；多个查询的备选期间不一致时，不把局部备选当成全局条件。
  return choices.every((choice) => JSON.stringify(choice) === JSON.stringify(first)) ? first : [];
}

function availabilityRequests(messages: AgentMessage[], sources: Source[]) {
  const requests = currentTurnMessages(messages).flatMap((message) => {
    if (
      message.role !== "toolResult" ||
      message.isError ||
      message.toolName !== "metric_availability"
    )
      return [];
    const receipt = message.details as
      | {
          kind?: string;
          status?: string;
          request?: {
            dimension?: string;
            metric_codes?: string[];
            org_codes?: string[];
            start?: string;
            end?: string;
          };
        }
      | undefined;
    const spec = receipt?.request;
    const metrics = spec?.metric_codes,
      orgs = spec?.org_codes;
    if (
      receipt?.kind !== "data_availability" ||
      receipt.status !== "succeeded" ||
      spec?.dimension !== "dates" ||
      Boolean(spec.start) !== Boolean(spec.end) ||
      !metrics?.length ||
      !orgs?.length
    )
      return [];
    return sources.some(
      ({ evidence }) =>
        metrics.every((code) =>
          evidence.metric_descriptors?.some((metric) => metric.code === code),
        ) && orgs.every((code) => evidence.org_codes.includes(code)),
    )
      ? [spec]
      : [];
  });
  // 仅传真实工具请求；日期是否可用仍由后端按当前权限重新查询。
  return [...new Map(requests.map((spec) => [JSON.stringify(spec), spec])).values()].slice(-3);
}

/** 将本轮可信来源和正文交给后端校验；重试与恢复时机由 inquiry runtime 决定。 */
export function createInquiryReportTool(): AgentHarnessTool<
  AskMetricRequestContext,
  typeof parameters
> {
  return {
    name: "analysis_answer",
    label: "回答业务问题",
    parameters,
    description:
      "完成必要调查后依据真实结果交付自然正文，可同时选一张有助理解的图。来源自动采用本轮成功查询或已鉴权读取的结果；历史结果须先analysis_read。校验错误按所指问题修正，已有数据不重复查询，确实缺少依据时可定向补查。图表只引用现有结果，不提交手写数值。",
    prepareArguments: (args) => {
      if (!args || typeof args !== "object" || Array.isArray(args))
        throw new Error("回答参数必须是对象。");
      // 兼容升级前尚未执行的调用；来源不再由模型重复筛选，其余参数仍交给原 schema 校验。
      const input = { ...(args as Record<string, unknown>) };
      delete input.evidence_refs;
      return input as Static<typeof parameters>;
    },
    execute: (_id, input, _update, request, _invocation, context) =>
      executeInquiryReport(input, request, context.abortSignal),
  };
}

/** 正式交付和预览共享来源、引用及计算身份转换，数值仍由后端统一核验。 */
async function prepareInquiryReport(
  input: Static<typeof parameters>,
  request: AskMetricRequestContext,
  options: { fallback?: boolean; preview?: boolean } = {},
) {
  const { fallback = false, preview = false } = options;
  if (!input.body.trim())
    throw new BackendApiError(422, "请提交完整回答正文。", "ANALYSIS_REPORT_SUMMARY");
  const turnEvidence = (await request.answerEvidence?.()) ?? [];
  const available = turnEvidence.filter(
    (item): item is Source =>
      item.evidence.kind === "analysis_evidence" &&
      item.evidence.status === "succeeded" &&
      typeof (item.evidence as AnalysisEvidence).run_ref === "string",
  );
  if (!available.length)
    throw new BackendApiError(
      422,
      "本轮还没有成功查询或已鉴权读取的来源，请先取得所需数据。",
      "ANALYSIS_REPORT_EVIDENCE",
    );
  const messages = (await request.turnMessages?.()) ?? [];
  const target =
    request.inquiryTargetContext && !request.inquiryAdmission
      ? currentInquiryTarget(messages, request.operationId)
      : undefined;
  const targetCoverage = target ? inquiryTargetCoverage(messages, target) : undefined;
  if (targetCoverage && !targetCoverage.complete && !fallback)
    throw new BackendApiError(
      422,
      "主目标尚有机构或期间未完成查询，请按target_coverage补足缺少部分；已完成的查询不必重复。",
      "INQUIRY_TARGET_INCOMPLETE",
      targetCoverage,
    );
  const calculations = turnEvidence.filter(
    (item): item is EvidenceReference & { evidence: InquiryCalculation } =>
      isInquiryCalculation(item.evidence) &&
      item.evidence.execution_turn_id === request.operationId &&
      item.evidence.run_refs.every((ref) =>
        available.some((source) => source.evidence.run_ref === ref),
      ),
  );
  const sourcesWithCalculations = [...available, ...calculations];
  const aliases = new Map(
    sourcesWithCalculations.flatMap((item) => [
      ...analysisEvidenceAliases(item.ref, item.evidence.evidence_items ?? []),
    ]),
  );
  const known = new Set(
    sourcesWithCalculations.flatMap(
      (item) => item.evidence.evidence_items?.map((atom) => atom.ref) ?? [],
    ),
  );
  const rawRef = (ref: string) => aliases.get(ref) ?? ref;
  const narrative = normalizeReportNarrative({ body: input.body });
  const refs = [...new Set(narrativeEvidenceRefs(narrative.summary).map(rawRef))];
  const prepared = input.chart || preview ? undefined : latestInquiryChart(messages);
  const chartSelection = input.chart ?? prepared?.selection;
  const chartRefs = chartSelection?.evidence_refs.map(rawRef) ?? [];
  const preparedAvailable =
    !prepared ||
    (prepared.run_refs.every((ref) => available.some((item) => item.evidence.run_ref === ref)) &&
      prepared.source_refs.every((ref) => known.has(ref)));
  if ([...refs, ...(input.chart ? chartRefs : [])].some((ref) => !known.has(ref)))
    throw new BackendApiError(
      422,
      "正文或图表包含不属于本轮成功来源的原子，请使用回执中的真实引用。",
      "ANALYSIS_REPORT_REFERENCE",
    );
  const focusRefs = [...new Set([...refs, ...(preparedAvailable ? chartRefs : [])])];
  const referenced = new Set(focusRefs);
  const selectedCalculations = calculations.filter((item) =>
    item.evidence.evidence_items.some((atom) => referenced.has(atom.ref)),
  );
  selectedCalculations.forEach((item) =>
    item.evidence.evidence_items.forEach((atom) => {
      if (referenced.has(atom.ref)) atom.input_refs.forEach((ref) => referenced.add(ref));
    }),
  );
  const {
    sources: usable,
    runRefs,
    contextRunRefs: contextRefs,
  } = selectReportSources(available, request.operationId, referenced);
  const historical = usable.filter((item) => contextRefs.includes(item.evidence.run_ref));
  const reuseOnly = historical.length === usable.length;
  if (reuseOnly && !refs.length)
    throw new BackendApiError(
      422,
      "请用正文中的真实引用明确本次追问关注的指标；数字使用{{e1.v1}}，已写数值紧随{{e1.v1|cite}}关联依据。",
      "ANALYSIS_REPORT_REFERENCE",
    );
  const factBindings: Array<{
    ref: string;
    org_code: string;
    metric_code: string;
    date: string;
  }> = [];
  const summary = narrative.summary.replace(/\{\{([^{}]+)\}\}/gu, (_full, value: string) => {
    const { ref, citation, binding } = parseNarrativeReference(value);
    if (binding) factBindings.push({ ...binding, ref: rawRef(ref) });
    return `{{${rawRef(ref)}${citation ? "|cite" : ""}}}`;
  });
  const availability = preview
    ? []
    : availabilityRequests(
        messages,
        usable.filter((item) => !contextRefs.includes(item.evidence.run_ref)),
      );
  const fallbackFocus: string[] = [];
  if (fallback && !reuseOnly) {
    const atoms = [
      ...usable.flatMap(({ evidence }) => evidence.evidence_items ?? []),
      ...selectedCalculations.flatMap(({ evidence }) => evidence.evidence_items),
    ];
    const dependencies = findingDependencies(atoms);
    let selected: Set<string>;
    try {
      selected = new Set(expandFindingRefs([...referenced], dependencies));
    } catch {
      throw new BackendApiError(
        422,
        "已选历史事实的依据链不完整，请核对真实来源。",
        "ANALYSIS_REPORT_REFERENCE",
      );
    }
    const historyAtoms = new Map(
      historical.flatMap(({ evidence }) =>
        (evidence.evidence_items ?? []).map((atom) => [atom.ref, atom] as const),
      ),
    );
    // 判断保留原引用，由后端展开完整依据；旧计算仅有 fact_id 时仍需转为父事实。
    const judgments = [...referenced]
      .flatMap((ref) => {
        if (!historyAtoms.get(ref)?.judgment_kind) return [];
        const complete = expandFindingRefs([ref], dependencies);
        if (!complete.every((parent) => historyAtoms.has(parent))) return [];
        const original = expandFindingRefs([ref], historyAtoms);
        return original.length === complete.length &&
          original.every((parent) => complete.includes(parent))
          ? [{ ref, references: original }]
          : [];
      })
      .sort((left, right) => right.references.length - left.references.length);
    const covered = new Set<string>();
    // 恢复必须保留具体运算；同一计算回执的其他结果不随计算身份自动入选。
    for (const atom of selectedCalculations.flatMap(({ evidence }) => evidence.evidence_items)) {
      if (!referenced.has(atom.ref)) continue;
      fallbackFocus.push(atom.ref);
      expandFindingRefs([atom.ref], dependencies).forEach((ref) => covered.add(ref));
    }
    for (const judgment of judgments) {
      if (covered.has(judgment.ref)) continue;
      fallbackFocus.push(judgment.ref);
      judgment.references.forEach((ref) => covered.add(ref));
    }
    // 只补未被所选判断覆盖的历史事实，不从单条事实反向选择更宽的判断。
    fallbackFocus.push(
      ...[...historyAtoms.values()]
        .filter((atom) => atom.type === "fact" && selected.has(atom.ref) && !covered.has(atom.ref))
        .map((atom) => atom.ref),
    );
    // 当前查询与历史采用相同的显式选择；恢复不因取数集合较宽而扩展回答。
    fallbackFocus.push(...[...referenced].filter(ref => !historyAtoms.has(ref) && !covered.has(ref)));
  }
  // 服务端重读不可变运行并校验权限、来源、范围、数字、单位和日期。
  const payload = {
    run_refs: runRefs,
    context_run_refs: contextRefs,
    focus_refs: reuseOnly ? focusRefs : fallbackFocus,
    summary,
    fact_bindings: factBindings,
    sections: narrative.sections,
    ...(selectedCalculations.length
      ? {
          calculation_refs: [
            ...new Map(
              selectedCalculations.map((item) => [
                item.evidence.calculation_ref.calculation_id,
                item.evidence.calculation_ref,
              ]),
            ).values(),
          ],
        }
      : {}),
    ...(availability.length ? { availability_requests: availability } : {}),
  };
  return {
    payload,
    refs,
    usable,
    prepared,
    preparedAvailable,
    chartSelection,
    runRefs,
    targetCoverage,
  };
}

/** 每个观察流独立保存已核验前缀；后端仍逐次鉴权，正式报告不复用预览结果。 */
export function createInquiryReportPreview() {
  let previous:
    | {
        operationId: string;
        callSeq: number | undefined;
        backend: AskMetricRequestContext["backend"];
        context: string;
        summary: string;
        text: string;
      }
    | undefined;
  return async (
    body: string,
    request: AskMetricRequestContext,
    signal?: AbortSignal,
  ): Promise<string | undefined> => {
    try {
      signal?.throwIfAborted();
      const { payload } = await prepareInquiryReport({ body }, request, { preview: true });
      const { summary, ...sources } = payload;
      const context = JSON.stringify(sources);
      // 来源、历史焦点和计算依赖变化会影响前文核验，必须回到全文。
      const reusable =
        previous &&
        previous.operationId === request.operationId &&
        previous.callSeq === request.answerStream?.callSeq &&
        previous.backend === request.backend &&
        previous.context === context &&
        summary.startsWith(previous.summary + "\n\n")
          ? previous
          : undefined;
      const delta = reusable ? summary.slice(reusable.summary.length + 2) : summary;
      signal?.throwIfAborted();
      const details = await request.backend.analysisReport(
        { ...payload, summary: delta, preview: true },
        { signal },
      );
      signal?.throwIfAborted();
      if (
        details.kind === "analysis_report_preview" &&
        details.status === "succeeded" &&
        typeof details.preview_text === "string" &&
        details.preview_text.trim()
      ) {
        const text = reusable
          ? reusable.text + "\n\n" + details.preview_text
          : details.preview_text;
        previous = {
          operationId: request.operationId,
          callSeq: request.answerStream?.callSeq,
          backend: request.backend,
          context,
          summary,
          text,
        };
        return text;
      }
      // 响应契约异常不是正文确定性错误，留给观察器按服务失败处理。
      throw new Error("Invalid report preview response");
    } catch (error) {
      if (signal?.aborted) throw error;
      if (
        error instanceof NarrativeReferenceError ||
        (error instanceof BackendApiError &&
          error.status === 422 &&
          [
            "ANALYSIS_REPORT_FORMAT",
            "ANALYSIS_REPORT_NUMBER",
            "ANALYSIS_REPORT_REFERENCE",
            "ANALYSIS_REPORT_SUMMARY",
            "ANALYSIS_REPORT_EVIDENCE",
            "INQUIRY_TARGET_INCOMPLETE",
          ].includes(error.code ?? ""))
      )
        return undefined;
      // 不吞掉鉴权、来源失效和临时故障，避免追加正文时重复触发同一错误。
      previous = undefined;
      throw error;
    }
  };
}

/** 事实恢复复用同一来源转换；fallback 只由内部运行模块传入，不属于模型参数。 */
export async function executeInquiryReport(
  input: Static<typeof parameters>,
  request: AskMetricRequestContext,
  signal?: AbortSignal,
  fallback = false,
) {
  try {
    const {
      payload,
      refs,
      usable,
      prepared,
      preparedAvailable,
      chartSelection,
      runRefs,
      targetCoverage,
    } = await prepareInquiryReport(input, request, { fallback });
    let details = await request.backend.analysisReport(
      fallback
        ? { ...payload, summary: "", sections: [], fact_bindings: [], fallback: true }
        : payload,
      { signal },
    );
    if (
      details.kind !== "business_report" ||
      details.status !== "succeeded" ||
      typeof details.public_answer !== "string" ||
      !details.public_answer.trim() ||
      !details.report ||
      typeof details.report !== "object" ||
      Array.isArray(details.report)
    )
      throw new Error("INVALID_ANALYSIS_REPORT");
    const verifiedRefs = verifiedNarrativeRefs(details.report, refs) ?? [];
    const preparedInScope =
      preparedAvailable && (!prepared || prepared.run_refs.every((ref) => runRefs.includes(ref)));
    const generated =
      chartSelection &&
      (!preparedInScope || !reportChartHasNarrativeEvidence(usable, chartSelection, verifiedRefs))
        ? { charts: [], notice: "所选图表与本次回答的数据范围或指标口径不一致，暂未展示。" }
        : await buildInquiryChart(usable, chartSelection, request, verifiedRefs, signal);
    const report = details.report as Record<string, unknown>;
    const gaps = Array.isArray(details.gaps) ? Array.from<unknown>(details.gaps) : [];
    if (targetCoverage && !targetCoverage.complete) {
      const missing = targetCoverage.missing_queries.map(({ org_name, time }) => {
        const period =
          time.date_selection === "latest_snapshot"
            ? `截至${time.anchor_date}的最新可用数据`
            : (time.dates?.join("、") ??
              (time.start === time.end ? time.start : `${time.start}至${time.end}`));
        return `${org_name}（${period}）`;
      });
      gaps.push(`尚未完成${missing.join("、")}的查询，当前结果仅代表已查询部分。`);
    }
    const reportSummary =
      typeof report.summary === "string" ? report.summary : details.public_answer;
    let publicAnswer = details.public_answer;
    if (generated.notice) publicAnswer += `\n\n${generated.notice}`;
    const timeAlternatives = currentTimeAlternatives(usable, request);
    delete details.time_variants;
    details = {
      ...details,
      public_answer: publicAnswer,
      ...(targetCoverage ? { target_coverage: targetCoverage, gaps } : {}),
      ...(timeAlternatives.length ? { time_variants: timeAlternatives } : {}),
      ...(generated.notice ? { partial_analysis: true, gaps: [...gaps, generated.notice] } : {}),
      report: {
        ...report,
        charts: generated.charts,
        ...(generated.notice ? { summary: `${reportSummary}\n\n${generated.notice}` } : {}),
      },
    };
    if (fallback) details = markPartialAnalysisReport(details, "corrections_exhausted");
    return {
      content: [{ type: "text" as const, text: details.public_answer as string }],
      details,
      terminate: true,
    };
  } catch (caught) {
    const error =
      caught instanceof NarrativeReferenceError
        ? new BackendApiError(422, caught.message, "ANALYSIS_REPORT_FORMAT")
        : caught;
    if (signal?.aborted || (error instanceof BackendApiError && [401, 403].includes(error.status)))
      throw error;
    const invalid = error instanceof BackendApiError && error.status === 422;
    if (!(error instanceof BackendApiError)) {
      // 原始异常可能含 SQL 或凭据，只记录请求关联与调用帧；已知后端异常由后端审计。
      console.error(
        JSON.stringify({
          event: "inquiry_report_failed",
          request_id: request.requestId,
          operation_id: request.operationId,
          error_type: error instanceof Error ? error.constructor.name : "UnknownError",
          stack:
            error instanceof Error
              ? error.stack
                  ?.split("\n")
                  .filter((line) => line.trimStart().startsWith("at "))
                  .slice(0, 12)
              : undefined,
        }),
      );
    }
    return {
      content: [
        {
          type: "text" as const,
          text:
            error instanceof BackendApiError
              ? error.code === "INQUIRY_TARGET_INCOMPLETE"
                ? JSON.stringify({ message: error.message, target_coverage: error.details })
                : error.message
              : "回答校验未完成，请稍后重试。",
        },
      ],
      details: {
        kind: "analysis_answer",
        status: invalid ? "ARGUMENT_ERROR" : "error",
        retryable: invalid,
        ...(error instanceof BackendApiError && error.code === "INQUIRY_TARGET_INCOMPLETE"
          ? { validation_stage: "prerequisite", target_coverage: error.details }
          : {}),
        error_code:
          error instanceof BackendApiError
            ? (error.code ?? "INQUIRY_REPORT_FAILED")
            : "INQUIRY_REPORT_FAILED",
      },
    };
  }
}
