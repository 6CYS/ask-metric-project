import { Type } from "@earendil-works/pi-ai";
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import { BackendApiError, type AvailabilityResult } from "../backendClient.js";
import type { AskMetricRequestContext } from "../requestContext.js";
import { errorResult, isCalendarDate } from "./shared.js";

const parameters = Type.Object({
  dimension: Type.Union([Type.Literal("metrics"), Type.Literal("dates")], {description: "问有哪些指标有数据选 metrics；问哪些日期有记录选 dates。必须显式选择。"}),
  org_codes: Type.Array(Type.String({minLength: 1}), {minItems: 1, maxItems: 100,
    description: "从机构目录或已确认上下文取得的正式编码。机构不明确先澄清，不得用空数组扩大范围。"}),
  metric_codes: Type.Optional(Type.Array(Type.String({minLength: 1}), {maxItems: 100,
    description: "可选指标过滤，编码来自目录或已确认回执。发现指标名称时不要要求先指定指标。"})),
  start: Type.Optional(Type.String({description: "用户指定范围的开始日期 YYYY-MM-DD；未限定范围才可省略。"})),
  end: Type.Optional(Type.String({description: "用户指定范围的结束日期 YYYY-MM-DD；今天按当前业务日期解析。"})),
  match: Type.Optional(Type.Union([Type.Literal("any"), Type.Literal("all")], {description: "默认 any 表示范围内有记录；all 仅适用于明确指标与机构的共同日期。"})),
  page: Type.Optional(Type.Integer({minimum: 1, maximum: 100000})),
  page_size: Type.Optional(Type.Integer({minimum: 1, maximum: 50})),
}, {additionalProperties: false});

/** 正文和历史共用后端证据生成的答案；不把全目录或分页样本当成完整覆盖。 */
export function availabilityAnswer(result: AvailabilityResult): string {
  const scope = result.org_names.join("、") || "本次授权机构范围";
  const {start, end} = result.request;
  const time = start || end ? `${start ?? "不限起始日期"}至${end ?? "不限结束日期"}` : "未限定日期范围";
  if (result.mode === "metrics") {
    const names = (result.items ?? []).map(item => item.metric_name);
    const filtered = result.request.metric_codes?.length;
    return `${scope}，${time}，${filtered ? `本次核验的${filtered}个指定指标中，` : ""}共有${result.metric_count}个指标有记录。` +
      (names.length ? `第${result.page}页指标：${names.join("、")}。` : "本页没有指标记录。") +
      (result.has_more ? "还有后续结果，可以继续查询下一页。" : "") +
      (filtered ? "本次仅覆盖指定指标，不代表整个指标类别。" : "") + `\n${result.notice}`;
  }
  return `${scope}，${time}。` + (result.metric_names?.length ? `指标：${result.metric_names.join("、")}。` : "") +
    result.groups.map(group => `共有${group.date_count}个有记录的日期，最早${group.earliest ?? "无"}，最新${group.latest ?? "无"}。` +
      (group.dates.length ? `第${result.page}页日期：${group.dates.join("、")}。` : "") +
      (group.has_more ? "还有后续日期，可以继续查询下一页。" : "")).join("\n") + `\n${result.notice}`;
}

export function createDataAvailabilityTool(): AgentHarnessTool<AskMetricRequestContext, typeof parameters> {
  return {
    name: "data_availability", label: "查看数据覆盖范围", parameters,
    description: "用途：发现指定机构、可选日期范围实际有记录的指标（dimension=metrics）或日期（dates）。不适用：全局目录、血缘、具体数值。前提：正式机构编码来自目录或已确认回执；保留完整起止范围，分页只改页码。限定类别须先确认 metric_codes，候选不全先澄清。返回：完整筛选条件、机构名称、指标编码/名称或日期及分页；有记录不代表连续覆盖或数值有效。",
    execute: async (_id, params, _update, request, _invocation, context) => {
      const invalid = (params.start && !isCalendarDate(params.start)) ||
        (params.end && !isCalendarDate(params.end)) ||
        (params.start && params.end && params.start > params.end) ||
        !params.org_codes.length;
      if (invalid) {
        // 参数错误可由 pi 纠正；不生成终止回执，不擅自删除日期或机构限制。
        return errorResult("请使用正式机构编码和有效起止日期，保持用户指定范围。",
          {kind: "data_availability", status: "error", retryable: true});
      }
      try {
        const result = await request.backend.dataAvailability(params, {signal: context.abortSignal});
        return {content: [{type: "text", text: JSON.stringify(result)}],
          details: {kind: "data_availability", ...result, public_answer: availabilityAnswer(result)}};
      } catch (error) {
        if (!(error instanceof BackendApiError)) throw error;
        if (error.status === 422) return errorResult(
          "目录或日期校验失败。请重新检索正式编码并逐字使用目录返回值，保持用户指定机构与时间范围；不得编造编码、删除条件或扩大范围。",
          {kind: "data_availability", status: "error", retryable: true},
        );
        const message = error.status === 401 ? "登录状态已失效，请重新登录。" :
          error.status === 403 ? "无权查看所选机构的数据覆盖情况。" :
          "数据覆盖查询暂时不可用，请稍后重试。";
        return {content: [{type: "text", text: message}],
          details: {kind: "data_availability", status: "error", public_answer: message}};
      }
    },
  };
}
