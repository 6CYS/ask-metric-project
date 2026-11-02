import { readFileSync } from "node:fs";
import { Type, type Static } from "@earendil-works/pi-ai";
import { Check } from "typebox/value";

const keys = Type.Array(Type.String({ minLength: 1 }), {
  minItems: 1,
  maxItems: 24,
  uniqueItems: true,
});
const schema = Type.Object({
  version: Type.String({ minLength: 1 }),
  status: Type.Literal("trial"),
  notice: Type.String({ minLength: 1 }),
  limits: Type.Object({
    max_metrics: Type.Integer({ minimum: 1, maximum: 24 }),
    max_focus_orgs: Type.Integer({ minimum: 1, maximum: 20 }),
    rank_n: Type.Integer({ minimum: 1, maximum: 5 }),
    max_model_bytes: Type.Integer({ minimum: 4000, maximum: 64000 }),
    availability_pages: Type.Integer({ minimum: 1, maximum: 20 }),
  }),
  metrics: Type.Record(
    Type.String(),
    Type.Object({
      key: Type.String(),
      code: Type.String({ minLength: 1 }),
      name: Type.String({ minLength: 1 }),
      unit: Type.String({ minLength: 1 }),
      change: Type.Union([
        Type.Literal("value"),
        Type.Literal("yoy_amount"),
        Type.Literal("mom_amount"),
      ]),
    }),
  ),
  topics: Type.Array(
    Type.Object({
      id: Type.String({ minLength: 1 }),
      name: Type.String({ minLength: 1 }),
      description: Type.String({ minLength: 1 }),
      metric_keys: keys,
      core_keys: keys,
      rank_keys: keys,
      compare_pairs: Type.Optional(
        Type.Array(Type.Tuple([Type.String(), Type.String()]), { maxItems: 6, uniqueItems: true }),
      ),
      date_policy: Type.Union([
        Type.Literal("per_metric_latest"),
        Type.Literal("common_core_snapshot"),
      ]),
    }),
    { minItems: 1, maxItems: 100 },
  ),
});
export type TopicRegistry = Static<typeof schema>;
export type TopicDefinition = TopicRegistry["topics"][number];

export function validateTopicRegistry(value: unknown): TopicRegistry {
  if (!Check(schema, value)) throw new Error("主题配置格式无效");
  const ids = new Set<string>(),
    codes = new Set<string>();
  for (const [key, metric] of Object.entries(value.metrics)) {
    if (key !== metric.key || codes.has(metric.code)) throw new Error("主题指标身份重复或不一致");
    codes.add(metric.code);
  }
  for (const topic of value.topics) {
    if (
      ids.has(topic.id) ||
      topic.metric_keys.length > value.limits.max_metrics ||
      topic.rank_keys.length * value.limits.rank_n > value.limits.max_focus_orgs ||
      topic.metric_keys.some((key) => !value.metrics[key]) ||
      (topic.compare_pairs ?? []).some(
        (pair) =>
          pair.some((key) => !topic.metric_keys.includes(key)) ||
          value.metrics[pair[0]]?.unit !== value.metrics[pair[1]]?.unit ||
          value.metrics[pair[0]]?.change !== value.metrics[pair[1]]?.change,
      ) ||
      [...topic.core_keys, ...topic.rank_keys].some((key) => !topic.metric_keys.includes(key))
    ) {
      throw new Error("主题引用或执行预算无效");
    }
    ids.add(topic.id);
  }
  return value;
}

/** 配置只保存能力和正式身份；每次执行仍从当前用户的目录取得服务端签名。 */
export function loadTopicRegistry(): TopicRegistry {
  return validateTopicRegistry(
    JSON.parse(
      readFileSync(new URL("../../../config/inquiry-topics.json", import.meta.url), "utf8"),
    ),
  );
}
