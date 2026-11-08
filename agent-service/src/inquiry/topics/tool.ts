import { createHash } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import type { AgentHarnessTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AskMetricRequestContext } from "../../requestContext.js";
import { analysisCandidates, catalogBindingView } from "../../analysis/bindings.js";
import { BackendApiError } from "../../backendClient.js";
import type { DateModelValue, ResolvedOrganizations } from "../../business-context/types.js";
import { businessDate } from "../../business-context/resolvers.js";
import { currentInquiryTarget, inquiryDateCalendarSchema } from "../target.js";
import { loadTopicRegistry, type TopicRegistry } from "./registry.js";
import { knowledgeTopicRegistry, readKnowledgePlan } from "./knowledge.js";
import { record, records, string, topicEvidenceView } from "./view.js";

function declined(code: string, notice: string, pending: string[] = []): AgentToolResult<unknown> {
  const body = {
    kind: "topic_selection",
    status: "not_applicable",
    code,
    notice,
    fallback: {
      tool: "metric_search/metric_query",
      pending_metric_codes: pending,
      rule: "保留已完成目标和证据，仅处理未覆盖部分；不得重做已完成主题或在路径间循环。",
    },
  };
  return { content: [{ type: "text", text: JSON.stringify(body) }], details: body };
}

async function latestCommonDate(
  request: AskMetricRequestContext,
  orgs: ResolvedOrganizations,
  codes: string[],
  pages: number,
  signal?: AbortSignal,
) {
  const sets: Set<string>[] = [];
  const size = Math.max(1, Math.floor(100 / codes.length));
  for (let offset = 0; offset < orgs.codes.length; offset += size) {
    const dates = new Set<string>();
    for (let page = 1; ; page++) {
      const result = await request.backend.dataAvailability(
        {
          dimension: "dates",
          org_codes: orgs.codes.slice(offset, offset + size),
          metric_codes: codes,
          match: "all",
          end: businessDate(),
          start: "1900-01-01",
          page,
          page_size: 50,
        },
        { signal },
      );
      result.groups.flatMap((group) => group.dates).forEach((day) => dates.add(day));
      if (!result.has_more && !result.groups.some((group) => group.has_more)) break;
      if (page >= pages) throw new Error("TOPIC_AVAILABILITY_BUDGET");
    }
    sets.push(dates);
  }
  return [...(sets[0] ?? [])]
    .filter((day) => sets.every((set) => set.has(day)))
    .sort()
    .at(-1);
}

/** 新入口只编排既有受治理查询。原有工具、目标继承和证据存储仍是唯一事实来源。 */
export function createTopicQueryTool(
  query: AgentHarnessTool<AskMetricRequestContext>,
  configuredRegistry?: TopicRegistry,
): AgentHarnessTool<AskMetricRequestContext> {
  const templates = configuredRegistry ?? loadTopicRegistry();
  const parameters = Type.Object(
    {
      topic_id: configuredRegistry
        ? Type.Union(configuredRegistry.topics.map((topic) => Type.Literal(topic.id)))
        : Type.String({
            minLength: 1,
            maxLength: 128,
            description:
              "本轮业务知识中batch_query_enabled=true的条目ID；按标题和内容判断适用性，不编造ID。",
          }),
      scope: Type.Union([Type.Literal("named"), Type.Literal("all_banks")]),
      org_names: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
        maxItems: 100,
        uniqueItems: true,
        description: "named填写本轮全部目标机构；all_banks填空数组。",
      }),
      date: Type.String({
        minLength: 1,
        maxLength: 200,
        description:
          "近期=latest；明确年月日、月份或季度原样填写时间短语（如‘今年三季度’），由服务端解析，不把季度改成季末某一天；追问未改期间=inherit。不得将明确日期替换为latest。",
      }),
      date_calendar: Type.Optional(inquiryDateCalendarSchema),
    },
    { additionalProperties: false },
  );
  return {
    name: "topic_query",
    label: "按分析方案批量取数",
    parameters,
    description:
      "业务分析主题批量取数，一次执行完整指标方案；方案与所需分析范围一致时优先使用，无需先逐项metric_search。明确限定指标或口径时用metric_query批量查询所需指标，不扩大范围。可用主题：" +
      (configuredRegistry
        ? configuredRegistry.topics.map((t) => `${t.id}（${t.name}）：${t.description}`).join("；")
        : "以本轮业务知识中batch_query_enabled=true的条目为可执行方案，topic_id填写其id。根据标题、内容及关联指标判断是否适用；资料不足先business_knowledge_search。未开启的知识仅供参考，不能借内置主题绕过管理员开关。") +
      "。主题不替换原问题确定的具体分析范围、机构和期间。输出正式引用、同日排名、完整范围分布、实际日期、缺口及执行完成标记；正常缺数不重试。完成仅表示批量取数结束，不证明解释成立；依据已有事实回答，不因缺少理想指标重新跑整题。",
    execute: async (id, raw, update, request, invocation, context) => {
      const input = raw as {
        topic_id: string;
        scope: "named" | "all_banks";
        org_names: string[];
        date: string;
        date_calendar?: DateModelValue;
      };
      if (request.inquiryAdmission)
        return declined(
          "TOPIC_CONFIRMED_TARGET",
          "用户已确认的目标使用原metric_query及target_ref；主题不能覆盖可信条件。",
        );
      if (input.scope === "named" ? !input.org_names.length : input.org_names.length > 0)
        return declined("TOPIC_SCOPE_REQUIRED", "named须给全部机构；all_banks不混入手写机构列表。");
      let registry = configuredRegistry;
      let binding: Record<string, unknown> | undefined;
      let managedMissing: string[] = [];
      if (!registry) {
        try {
          // 每次执行重验管理员开关，历史候选或旧复用回执不能恢复已停用的方案。
          const plan = readKnowledgePlan(
            await request.backend.knowledgeAnalysisPlan(input.topic_id, {
              signal: context.abortSignal,
            }),
            input.topic_id,
          );
          binding = await request.backend.analysisBindMetrics(plan.entry.metric_codes, {
            signal: context.abortSignal,
          });
          const compiled = knowledgeTopicRegistry(plan, binding, templates);
          registry = compiled.registry;
          managedMissing = compiled.missing;
          if (!registry)
            return declined(
              "TOPIC_BINDING_UNAVAILABLE",
              "关联指标当前不可查询，请按原目标核对正式目录。",
              managedMissing,
            );
        } catch (cause) {
          if (
            !(cause instanceof BackendApiError) ||
            cause.status !== 404 ||
            context.abortSignal?.aborted
          )
            throw cause;
          return declined(
            "TOPIC_NOT_AVAILABLE",
            "该分析方案不存在、已停用或未开启批量取数，使用自主查询能力。不得改用内置同名方案。",
          );
        }
      }
      const topic = registry.topics.find((item) => item.id === input.topic_id);
      if (!topic) return declined("TOPIC_NOT_FOUND", "主题不存在，使用默认能力处理该目标。");
      const key = createHash("sha256")
        .update(
          JSON.stringify({
            ...input,
            org_names: [...input.org_names].sort(),
            version: registry.version,
          }),
        )
        .digest("hex");
      const messages = (await request.turnMessages?.()) ?? [];
      const prior = [...messages]
        .reverse()
        .find(
          (message) =>
            message.role === "toolResult" &&
            record(record(message.details).topic_execution).key === key &&
            record(record(message.details).topic_execution).completed === true,
        );
      if (prior?.role === "toolResult") {
        const receipt = record(prior.details),
          sources = (await request.answerEvidence?.()) ?? [];
        const source = sources.find(
          (source) => string(record(source.evidence).run_ref) === receipt.run_ref,
        );
        const body = {
          kind: "inquiry_query_reuse",
          status: "succeeded",
          reused: true,
          no_new_evidence: true,
          run_ref: receipt.run_ref,
          evidence_ref: source?.ref,
          topic_execution: receipt.topic_execution,
          notice:
            "完整主题已执行，本次未取数或重复注入证据；使用原事实引用组织回答。缺数是已完成查询的结果，不是重试理由。",
        };
        return { content: [{ type: "text", text: JSON.stringify(body) }], details: body };
      }
      const current = currentInquiryTarget(messages, request.operationId),
        baseline = current ?? request.inquiryTargetContext?.baseline;
      if (input.date === "inherit" && !baseline)
        return declined("TOPIC_PERIOD_REQUIRED", "没有可继承期间，请按用户问题明确期间。");
      try {
        binding ??= await request.backend.analysisBindMetrics(
          topic.metric_keys.map((key) => registry.metrics[key]!.code),
          { signal: context.abortSignal },
        );
      } catch (cause) {
        if (
          !(cause instanceof BackendApiError) ||
          cause.status !== 404 ||
          context.abortSignal?.aborted
        )
          throw cause;
        return declined(
          "TOPIC_BACKEND_NOT_SUPPORTED",
          "当前后端不支持主题批量目录绑定，使用原查询能力；启用主题前须先升级后端。",
        );
      }
      const items = records(binding.items),
        missing: string[] = [...managedMissing];
      const matched = topic.metric_keys.flatMap((key) => {
        const metric = registry.metrics[key]!;
        const item = items.find(
          (item) =>
            item.code === metric.code &&
            item.name === metric.name &&
            (item.value_policy === "source_raw_v1" || item.unit === metric.unit) &&
            typeof item.binding_ref === "string" &&
            item.binding_ref,
        );
        if (!item) {
          missing.push(metric.code);
          return [];
        }
        return [item];
      });
      if (!matched.length)
        return declined(
          "TOPIC_BINDING_UNAVAILABLE",
          "主题配置未匹配当前正式目录；默认路径核对未覆盖指标，不替换为相似指标。",
          missing,
        );
      catalogBindingView(request, { items: matched });
      let selectedDate: string | undefined;
      if (input.date === "latest" && topic.date_policy === "common_core_snapshot") {
        const resolved =
          input.scope === "all_banks"
            ? await request.backend.resolveOrganizationScope(
                {
                  kind: "authorized_cohort",
                  cohort: "rural_commercial_banks",
                  sourceText: request.originalMessage,
                },
                { signal: context.abortSignal },
              )
            : await request.backend.resolveBusinessField("organization", input.org_names, {
                signal: context.abortSignal,
              });
        const organizations = record(resolved.status === "resolved" ? resolved.value : undefined);
        if (
          !Array.isArray(organizations.codes) ||
          !organizations.codes.length ||
          !organizations.codes.every((code): code is string => typeof code === "string") ||
          !Array.isArray(organizations.names) ||
          !organizations.names.every((name): name is string => typeof name === "string") ||
          organizations.codes.length !== organizations.names.length
        )
          return declined(
            "TOPIC_SCOPE_UNRESOLVED",
            "机构尚未唯一确定，请用原目录能力核对当前目标。",
          );
        const core = topic.core_keys
          .map((key) => registry.metrics[key]!.code)
          .filter((code) => matched.some((item) => item.code === code));
        try {
          if (core.length)
            selectedDate = await latestCommonDate(
              request,
              { codes: organizations.codes, names: organizations.names },
              core,
              registry.limits.availability_pages,
              context.abortSignal,
            );
        } catch (cause) {
          if (cause instanceof BackendApiError || context.abortSignal?.aborted) throw cause;
          if (!(cause instanceof Error) || cause.message !== "TOPIC_AVAILABILITY_BUDGET")
            throw cause;
          return declined(
            "TOPIC_DATE_BUDGET",
            "共同日期覆盖超过预算；保留原目标，由默认能力定向确认期间，不猜日期。",
          );
        }
        if (!selectedDate)
          return declined(
            "TOPIC_NO_COMMON_PERIOD",
            "当前核心指标没有覆盖所选全部机构的共同统计日，主题不能静默混合日期。默认能力可保留原目标并分日期定向查询。",
          );
      }
      const selected = new Set(matched.map((item) => item.code));
      const metricRefs = analysisCandidates(request)
        .filter((item) => selected.has(item.code))
        .map((item) => item.binding_ref);
      const date = selectedDate ?? (input.date === "inherit" ? undefined : input.date);
      const dateInput = date
        ? {
            date,
            ...(input.date_calendar && !selectedDate ? { date_calendar: input.date_calendar } : {}),
          }
        : {};
      const targetTime = request.inquiryTargetContext?.time_contract === 2
        ? date
          ? { time: {
              expression: date,
              ...(input.date_calendar && !selectedDate ? { calendar: input.date_calendar } : {}),
            } }
          : {}
        : dateInput;
      const queryInput = {
        purpose: topic.name,
        metric_refs: metricRefs,
        scope: input.scope,
        ...(input.scope === "named" ? { org_names: input.org_names } : {}),
        ...dateInput,
        method: input.scope === "all_banks" ? "ranking" : "observe",
        ...(input.scope === "all_banks" ? { position: "bottom", top_n: 100 } : {}),
        ...(request.inquiryTargetContext && !current
          ? {
              target_change: baseline
                ? {
                    mode: "update",
                    base_ref: baseline.ref,
                    topic: topic.name,
                    organizations: {
                      mode: "replace",
                      scope: input.scope,
                      ...(input.scope === "named" ? { names: input.org_names } : {}),
                    },
                    ...targetTime,
                  }
                : {
                    mode: "new",
                    topic: topic.name,
                    organizations: {
                      mode: "replace",
                      scope: input.scope,
                      ...(input.scope === "named" ? { names: input.org_names } : {}),
                    },
                    ...targetTime,
                  },
            }
          : {}),
      };
      const result = await query.execute(id, queryInput, update, request, invocation, context);
      const details = record(result.details);
      if (details.kind === "inquiry_query_reuse") {
        const body = {
          ...details,
          notice: "主题所需证据已在本轮取得；复用原引用，不重复注入结果或重新取数。",
        };
        return { ...result, content: [{ type: "text", text: JSON.stringify(body) }] };
      }
      if (details.kind !== "analysis_evidence" || details.status !== "succeeded") return result;
      const metricKeys = new Map(
        Object.values(registry.metrics).map((metric) => [metric.code, metric.key]),
      );
      details.evidence_items = records(details.evidence_items).map((atom) => {
        const metric = metricKeys.get(string(atom.metric_code));
        return atom.type === "fact" && metric && atom.org_code && atom.date
          ? { ...atom, topic_alias: `${string(atom.org_code)}.${metric}.${string(atom.date)}` }
          : atom;
      });
      const offset = ((await request.answerEvidence?.()) ?? []).length;
      const execution = {
        key,
        topic_id: topic.id,
        topic_name: topic.name,
        source: configuredRegistry ? "configured_registry" : "business_knowledge",
        date_policy: topic.date_policy,
        version: registry.version,
        completed: true,
        requested_date: input.date,
        selected_date: selectedDate ?? null,
        completed_metric_codes: matched.map((item) => item.code),
        pending_metric_codes: missing,
        data_status: records(details.evidence_items).some((atom) => atom.type === "fact")
          ? "available_or_partial"
          : "no_data",
        no_retry_for_missing_data: true,
      };
      const body = topicEvidenceView(details, `e${offset + 1}`, topic, registry);
      body.topic_execution = execution;
      body.execution_notice =
        "主题已按匹配的正式目录执行，完成标记不证明解释成立。pending_metric_codes为未绑定指标，并非必查清单。日期与机构以原事实为准；缺数、未知比例编码和未覆盖分析原因须披露。默认工具仅处理未完成部分或额外未覆盖目标，保留已有事实，勿整体重做。";
      if (Buffer.byteLength(JSON.stringify(body)) > registry.limits.max_model_bytes) {
        // 不抛弃已取得的事实；有界投影超限时保留正式来源和执行状态，定向回读而非重新取数。
        const bounded = {
          kind: details.kind,
          status: details.status,
          tables: [],
          run_ref: details.run_ref,
          evidence_ref: `e${offset + 1}`,
          topic_execution: execution,
          organizations: record(body.organizations),
          metric_dictionary: body.metric_dictionary,
          notice:
            "主题查询已完成，模型展示超过预算；用analysis_read的focus按机构编码和至多4个指标编码分页读取该run_ref，不得重新查询。",
        };
        return {
          ...result,
          content: [{ type: "text", text: JSON.stringify(bounded) }],
          details: { ...details, topic_execution: execution },
        };
      }
      return {
        ...result,
        content: [{ type: "text", text: JSON.stringify(body) }],
        details: { ...details, topic_execution: execution },
      };
    },
  };
}
