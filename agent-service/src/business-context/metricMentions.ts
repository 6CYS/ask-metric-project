import {BackendApiError} from "../backendClient.js";
import type {AskMetricRequestContext} from "../requestContext.js";
import type {FieldResolution} from "./types.js";

export interface MetricMention {text: string; start: number; end: number; resolution: FieldResolution}
export interface MetricMentions {mentions: MetricMention[]; status?: "temporary_error"}

/** 一轮只解析一次完整原文；模型仅引用这些片段，不负责切词或生成指标名称。 */
export function metricMentions(request: AskMetricRequestContext): Promise<MetricMentions> {
  return request.metricMentions ??= (async () => {
    try {
      const result = await request.backend.matchMetricQuestion(request.originalMessage);
      if (!result || !Array.isArray(result.mentions) || result.mentions.length > 100
        || !result.mentions.every(mention => typeof mention.text === "string"
          && Number.isInteger(mention.start) && Number.isInteger(mention.end)
          && mention.start >= 0 && mention.end > mention.start
          // Python 的跨度按 Unicode 码点计数，不能用 JS UTF-16 下标校验。
          && Array.from(request.originalMessage).slice(mention.start, mention.end).join("") === mention.text
          && ["resolved", "ambiguous", "needs_confirmation"].includes(mention.resolution?.status)
          && (mention.resolution.status !== "resolved" || validValue(mention.resolution.value)))) {
        throw new Error("INVALID_METRIC_MENTIONS");
      }
      return result;
    } catch (error) {
      if (error instanceof BackendApiError && [401, 403].includes(error.status)) throw error;
      return {mentions: [], status: "temporary_error"};
    }
  })();
}

function validValue(raw: unknown): boolean {
  const value = raw as {codes?: unknown[]; names?: unknown[]} | undefined;
  return !!value && Array.isArray(value.codes) && value.codes.length > 0
    && value.codes.every(code => typeof code === "string" && code.length > 0)
    && Array.isArray(value.names) && value.names.length === value.codes.length
    && value.names.every(name => typeof name === "string");
}
