import {expect, it, vi} from "vitest";
import type {AskMetricRequestContext} from "../requestContext.js";
import {requiresCatalogAction, standaloneConversationReply} from "./turnContract.js";

it.each(["你好？", "您好！", "  Hello! ", "谢谢你", "辛苦了"])("纯问候或致谢不延续上一轮业务：%s", message => {
  expect(standaloneConversationReply(message)).toEqual(expect.any(String));
});

it.each(["你好，帮我查贷款", "谢谢，继续分析", "你好，利润情况怎么样？", "好的", "继续", "再试一次", "那紫金呢？", "在吗，刚才的问题继续"])("业务目标和确认回复不能被问候规则吞掉：%s", message => {
  expect(standaloneConversationReply(message)).toBeUndefined();
});

it.each(["那只看贷款质量，和上个月比呢？", "继续刚才的分析"])("已有焦点的明确续接不依赖本轮再次命中指标或机构：%s", async originalMessage => {
  const request = {originalMessage, backend: {}, frames: {state: async () => ({focusFrameId: "isolated-frame"})}} as unknown as AskMetricRequestContext;
  expect(await requiresCatalogAction(request)).toBe(true);
});

it("正式机构别名与查看表现的请求阻止普通回答，检查按本轮缓存", async () => {
  const searchOrganizations = vi.fn(async () => ({items: [{org_name: "合成总行", aliases: ["合成简称"]}]}));
  const request = {originalMessage: "合成简称最近收入情况怎么样？", backend: {searchOrganizations}} as unknown as AskMetricRequestContext;
  expect(await requiresCatalogAction(request)).toBe(true);
  expect(await requiresCatalogAction(request)).toBe(true);
  expect(searchOrganizations).toHaveBeenCalledTimes(1);
});

it.each(["你好，合成简称", "合成简称"])("非业务目标的输入保留普通回答：%s", async originalMessage => {
  const searchOrganizations = vi.fn();
  const request = {originalMessage, backend: {searchOrganizations}} as unknown as AskMetricRequestContext;
  expect(await requiresCatalogAction(request)).toBe(false);
  expect(searchOrganizations).not.toHaveBeenCalled();
});

it("没有目录匹配的通用解释不因出现分析措辞而被强制取数", async () => {
  const request = {originalMessage: "如何分析问题？", backend: {searchOrganizations: async () => ({items: [{org_name: "合成总行", aliases: []}]})}} as unknown as AskMetricRequestContext;
  expect(await requiresCatalogAction(request)).toBe(false);
});

it("只有用户原文中的正式机构名称才构成依据，不使用模糊返回的其他机构", async () => {
  const request = {originalMessage: "不认识的机构收入情况怎么样？", backend: {searchOrganizations: async () => ({items: [{org_name: "合成总行", aliases: ["合成简称"]}]})}} as unknown as AskMetricRequestContext;
  expect(await requiresCatalogAction(request)).toBe(false);
});
