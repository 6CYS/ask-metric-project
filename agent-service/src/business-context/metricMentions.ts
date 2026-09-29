import {BackendApiError} from "../backendClient.js";
import type {AskMetricRequestContext} from "../requestContext.js";
import type {FieldResolution} from "./types.js";

export interface MetricMention {text: string; start: number; end: number; resolution: FieldResolution; group?: {id: string}}
export interface MetricMentions {mentions: MetricMention[]; status?: "temporary_error"}

/**
 * 一轮只解析一次完整原文；模型仅引用这些片段，不负责切词或生成指标名称。
 * 只缓存成功结果：临时错误若被缓存，同轮后续调用和重试都只能拿到同一个失败。
 * 传入其他原句（继承重试上一轮临时失败的指标）时不读写本轮缓存。
 */
export function metricMentions(request: AskMetricRequestContext, question = request.originalMessage): Promise<MetricMentions> {
  if (question !== request.originalMessage) return matchMetricMentions(request, question);
  if (request.metricMentions) return request.metricMentions;
  const pending = matchMetricMentions(request, question);
  request.metricMentions = pending;
  const forget = () => { if (request.metricMentions === pending) delete request.metricMentions; };
  pending.then(result => { if (result.status === "temporary_error") forget(); }, forget);
  return pending;
}

async function matchMetricMentions(request: AskMetricRequestContext, question: string): Promise<MetricMentions> {
  try {
    const result = await request.backend.matchMetricQuestion(question);
    if (!result || !Array.isArray(result.mentions) || result.mentions.length > 100
      || !result.mentions.every(mention => typeof mention.text === "string"
        && Number.isInteger(mention.start) && Number.isInteger(mention.end)
        && mention.start >= 0 && mention.end > mention.start
        // Python 的跨度按 Unicode 码点计数，不能用 JS UTF-16 下标校验。
        && Array.from(question).slice(mention.start, mention.end).join("") === mention.text
        && ["resolved", "ambiguous", "needs_confirmation"].includes(mention.resolution?.status)
        && (mention.group === undefined || typeof mention.group?.id === "string")
        && (mention.resolution.status !== "resolved" || validValue(mention.resolution.value)))) {
      throw new Error("INVALID_METRIC_MENTIONS");
    }
    return result;
  } catch (error) {
    if (error instanceof BackendApiError && [401, 403].includes(error.status)) throw error;
    return {mentions: [], status: "temporary_error"};
  }
}

function validValue(raw: unknown): boolean {
  const value = raw as {codes?: unknown[]; names?: unknown[]} | undefined;
  return !!value && Array.isArray(value.codes) && value.codes.length > 0
    && value.codes.every(code => typeof code === "string" && code.length > 0)
    && Array.isArray(value.names) && value.names.length === value.codes.length
    && value.names.every(name => typeof name === "string");
}
