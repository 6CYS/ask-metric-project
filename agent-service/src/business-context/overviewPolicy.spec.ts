import {expect, it} from "vitest";
import {comparisonPeriodsOnly, overviewTimeExpression} from "./overviewPolicy.js";

it.each([
  "那只看贷款质量，和上个月、去年同期相比怎么样？",
  "贷款较上月、去年同期变化如何",
  "与上个月和年初对比存款变化如何",
  "那只看贷款质量，和上个月比呢？",
])("比较基期不替代观测期间：%s", question => {
  expect(overviewTimeExpression(question)).toBeUndefined();
  expect(comparisonPeriodsOnly(question)).toBe(true);
});

it.each([
  ["最近贷款和上个月、去年同期相比怎么样", "最近"],
  ["上个月贷款情况，和去年同期相比如何", "上个月"],
  ["2026年7月贷款，和上月及年初相比如何", "2026年7月"],
  ["今年五月到十月贷款情况", "今年五月到十月"],
  ["上月末，我行各项存款净增", "上月末"],
  ["上个月底存款是多少", "上个月底"],
])("明确期间保持原文：%s", (question, expected) => {
  expect(overviewTimeExpression(question)).toBe(expected);
  expect(comparisonPeriodsOnly(question)).toBe(false);
});
