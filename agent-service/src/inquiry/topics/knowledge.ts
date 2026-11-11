import { createHash } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { Check } from "typebox/value";
import { validateTopicRegistry, type TopicRegistry } from "./registry.js";
import { records, string } from "./view.js";
import { reportLayoutSchema, validReportLayout } from "../reportFormat.js";

const planSchema = Type.Object({
  version: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  entry: Type.Object({
    id: Type.String({ minLength: 1, maxLength: 128 }),
    title: Type.String({ minLength: 1, maxLength: 200 }),
    text: Type.String({ minLength: 1, maxLength: 8000 }),
    enabled: Type.Literal(true),
    batch_query_enabled: Type.Literal(true),
    report_layout: Type.Optional(reportLayoutSchema),
    metric_codes: Type.Array(Type.String({ minLength: 1, maxLength: 150 }), {
      minItems: 1,
      maxItems: 24,
      uniqueItems: true,
    }),
  }),
});

export function readKnowledgePlan(value: unknown, id: string) {
  if (
    !Check(planSchema, value) ||
    value.entry.id !== id ||
    (value.entry.report_layout !== undefined && !validReportLayout(value.entry.report_layout))
  )
    throw new Error("INVALID_KNOWLEDGE_ANALYSIS_PLAN");
  return value;
}

/** 关联编码是唯一取数清单；名称、单位和绑定均从本次正式目录取得。 */
export function knowledgeTopicRegistry(
  plan: ReturnType<typeof readKnowledgePlan>,
  binding: Record<string, unknown>,
  templates: TopicRegistry,
): { registry?: TopicRegistry; missing: string[] } {
  const formal = records(binding.items);
  const metrics: TopicRegistry["metrics"] = {};
  const missing: string[] = [];
  for (const code of plan.entry.metric_codes) {
    const item = formal.find((item) => item.code === code);
    if (
      !item ||
      !string(item.name).trim() ||
      !string(item.binding_ref).trim()
    ) {
      missing.push(code);
      continue;
    }
    const preset = Object.values(templates.metrics).find((metric) => metric.code === code);
    const key = preset?.key ?? `metric:${code}`;
    metrics[key] = {
      key,
      code,
      name: string(item.name),
      unit: string(item.unit),
      change: preset && (item.value_policy === "source_raw_v1" || preset.unit === item.unit) ? preset.change : "value",
    };
  }
  const keys = Object.keys(metrics);
  if (!keys.length) return { missing };
  // 存量五类方案只沿用日期、展示策略；可查指标始终由管理页面的关联决定。
  const preset = templates.topics.find((topic) => topic.id === plan.entry.id);
  const core = preset?.core_keys.filter((key) => metrics[key]) ?? [];
  const ranks = preset?.rank_keys.filter((key) => metrics[key]) ?? [];
  const pairs = preset?.compare_pairs?.filter(
    ([left, right]) =>
      metrics[left] &&
      metrics[right] &&
      !!metrics[left].unit &&
      metrics[left].unit === metrics[right].unit &&
      metrics[left].change === metrics[right].change,
  );
  const version = createHash("sha256")
    .update(
      JSON.stringify([
        plan.version,
        formal.map((item) => [item.code, item.name, item.unit, item.metadata_version]),
      ]),
    )
    .digest("hex");
  return {
    registry: validateTopicRegistry({
      ...templates,
      version,
      metrics,
      topics: [
        {
          id: plan.entry.id,
          name: plan.entry.title,
          description: plan.entry.text,
          ...(plan.entry.report_layout ? { report_layout: plan.entry.report_layout } : {}),
          metric_keys: keys,
          core_keys: core.length ? core : keys,
          rank_keys: ranks.length ? ranks : keys.slice(0, 4),
          ...(pairs?.length ? { compare_pairs: pairs } : {}),
          date_policy: core.length ? preset?.date_policy : "per_metric_latest",
        },
      ],
    }),
    missing,
  };
}
