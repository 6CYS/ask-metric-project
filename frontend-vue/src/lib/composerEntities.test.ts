import { expect, it } from "vitest"
import { selectedClarificationAnswer } from "./composerEntities"
import type { BackendNextClarification } from "@/types/api"

const clarification = { type: "semantic_slots", fields: [{ type: "metric" }] } as BackendNextClarification
const metric = { kind: "metric" as const, code: "M1", name: "演示指标甲" }

it("仅当前缺项的纯目录选择绑定澄清目标", () => {
  expect(selectedClarificationAnswer("演示指标甲", [metric], clarification)?.set).toEqual({ metrics: [{code: "M1", name: "演示指标甲"}] })
  expect(selectedClarificationAnswer("演示指标甲，", [metric], clarification)).toBeDefined()
})
it("自然文本和包含完整查询的目录选择不被旧澄清卡片劫持", () => {
  expect(selectedClarificationAnswer("演示指标甲", [], clarification)).toBeUndefined()
  expect(selectedClarificationAnswer("改查乙机构2026年4月演示指标甲", [metric], clarification)).toBeUndefined()
  expect(selectedClarificationAnswer("乙机构", [{kind: "organization", code: "B", name: "乙机构"}], clarification)).toBeUndefined()
})
