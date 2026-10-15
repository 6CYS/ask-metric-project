import {expect, it} from "vitest"
import {createSSRApp} from "vue"
import {renderToString} from "@vue/server-renderer"
import CalculationResult from "../../../src/components/chat/CalculationResult.vue"
import type {CalculationDetails} from "@/lib/agentApi"

const result: CalculationDetails = {
  kind: "metric_calculate", status: "succeeded",
  results: [{name: "difference", label: "甲减乙", expression: "a-b", value: "7", display_value: "7.00", unit: "元", variables: ["a", "b"]}],
  inputs: {a: {org_name: "合成甲行", metric_name: "合成指标", date: "2026-07-31", value: "10", unit: "元"},
    b: {org_name: "合成乙行", metric_name: "合成指标", date: "2026-07-31", value: "3", unit: "元"}},
}
const render = (calculation: CalculationDetails) => renderToString(createSSRApp(CalculationResult, {calculation}))

it.each([true, false, undefined])("计算详情保留公式和原值，只有历史快照=%s时注明未刷新", async historical => {
  const sources = historical === undefined ? undefined : [{task_id: "test-task", result_id: "test-result",
    source_scope_id: "test-source", historical}]
  const html = await render({...result, sources})
  expect(html).toContain("a-b")
  expect(html).toContain("合成甲行")
  expect(html).toContain("2026-07-31")
  expect(html).toContain("10元")
  expect(html.includes("未重新查库刷新")).toBe(historical === true)
})

it("快照计算失败明确展示原因，不把输入原值渲染为计算成功", async () => {
  const html = await render({...result, status: "error", message: "所选历史结果已过期"})
  expect(html).toContain("计算未完成：所选历史结果已过期")
  expect(html).not.toContain("查看计算口径和数据来源")
  expect(html).not.toContain("a-b")
})
