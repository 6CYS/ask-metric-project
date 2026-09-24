import {expect, it, vi} from "vitest";
import {metricMentions} from "./metricMentions.js";
import type {AskMetricRequestContext} from "../requestContext.js";
import {BackendApiError} from "../backendClient.js";

it("同轮并发模型/工具读取只匹配一次，Unicode 跨度保持原文", async () => {
  const matchMetricQuestion = vi.fn(async () => ({mentions: [{text: "指标甲", start: 1, end: 4,
    resolution: {status: "resolved", value: {codes: ["M"], names: ["指标甲"]}}}]}));
  const request = {originalMessage: "📈指标甲", backend: {matchMetricQuestion}} as unknown as AskMetricRequestContext;
  const [a, b] = await Promise.all([metricMentions(request), metricMentions(request)]);
  expect(a).toEqual(b); expect(a.mentions[0]?.text).toBe("指标甲");
  expect(matchMetricQuestion).toHaveBeenCalledTimes(1);
});
it.each([
  {mentions: [{text: "其他指标", start: 0, end: 4, resolution: {status: "resolved", value: {codes: ["M"], names: ["M"]}}}]},
  {mentions: [{text: "指标甲", start: 0, end: 3, resolution: {status: "resolved"}}]},
  {mentions: [{text: "指标甲", start: 0, end: 3, resolution: {status: "invented"}}]},
])("不合法的算法结果不能被当作成功或回退模型提取", async result => {
  const request = {originalMessage: "指标甲", backend: {matchMetricQuestion: async () => result}} as unknown as AskMetricRequestContext;
  expect(await metricMentions(request)).toEqual({mentions: [], status: "temporary_error"});
});
it("权限撤回不吞成普通未命中", async () => {
  const denied = new BackendApiError(403, "denied");
  const request = {originalMessage: "指标甲", backend: {matchMetricQuestion: async () => {throw denied;}}} as unknown as AskMetricRequestContext;
  await expect(metricMentions(request)).rejects.toBe(denied);
});
