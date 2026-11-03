import { effectScope, nextTick, ref } from "vue"
import { describe, expect, it } from "vitest"

import { useMetricDirectory } from "../src/composables/useMetricDirectory"
import type { MetricItem } from "../src/types/api"

function metric(code: string, overrides: Partial<MetricItem> = {}): MetricItem {
  return {
    metric_code: code,
    metric_name: `指标${code}`,
    unit: "元",
    metric_explanation: "",
    description: "",
    synonyms: [],
    enabled: true,
    ...overrides,
  }
}

describe("指标目录工作区", () => {
  it("万条目录仅提供当前页，精确编码、名称及同义词均可检索", () => {
    const scope = effectScope()
    scope.run(() => {
      const items = ref(Array.from({ length: 10000 }, (_, i) => metric(`M${i}`)))
      items.value[9876] = metric("M9876", { metric_name: "个人存款余额", synonyms: ["储蓄"] })
      const state = useMetricDirectory(items)
      expect(state.pageItems.value).toHaveLength(15)
      expect(state.totalPages.value).toBe(667)
      for (const keyword of ["m9876", "个人存款余额", "储蓄"]) {
        state.search.value = keyword
        expect(state.filteredItems.value.map((item) => item.metric_code)).toEqual(["M9876"])
      }
    })
    scope.stop()
  })

  it("搜索和页码变化不会悄悄替换正在维护的指标", async () => {
    const scope = effectScope()
    const state = scope.run(() => useMetricDirectory(ref([metric("A"), metric("B")])))!
    state.select("B")
    state.search.value = "A"
    await nextTick()
    expect(state.selectedCode.value).toBe("B")
    expect(state.pageItems.value.map((item) => item.metric_code)).toEqual(["A"])
    scope.stop()
  })

  it("从外部链接定位指标时展示所在页，停用指标仍可查看", async () => {
    const scope = effectScope()
    const state = scope.run(() =>
      useMetricDirectory(
        ref(Array.from({ length: 40 }, (_, i) => metric(`M${i}`, { enabled: i !== 35 }))),
      ),
    )!
    state.search.value = "M1"
    state.select("M35")
    await nextTick()
    expect(state.showDisabled.value).toBe(true)
    expect(state.search.value).toBe("")
    expect(state.page.value).toBe(3)
    expect(state.pageItems.value.some((item) => item.metric_code === "M35")).toBe(true)
    scope.stop()
  })

  it("沿关系查看搜索结果外的指标时保留目录条件，并可逐步返回", async () => {
    const scope = effectScope()
    const state = scope.run(() =>
      useMetricDirectory(
        ref([
          ...Array.from({ length: 35 }, (_, i) => metric(`M${i}`)),
          metric("RELATED", { enabled: false }),
          metric("NEXT"),
        ]),
      ),
    )!
    state.search.value = "指标M"
    state.select("M20")
    const originalPage = state.pageItems.value.map((item) => item.metric_code)

    expect(state.inspect("RELATED")).toBe(true)
    await nextTick()
    expect(state.selectedCode.value).toBe("RELATED")
    expect(state.previousMetric.value?.metric_code).toBe("M20")
    expect(state.search.value).toBe("指标M")
    expect(state.showDisabled.value).toBe(false)
    expect(state.page.value).toBe(2)
    expect(state.pageItems.value.map((item) => item.metric_code)).toEqual(originalPage)

    state.inspect("NEXT")
    expect(state.returnToPrevious()).toBe(true)
    expect(state.selectedCode.value).toBe("RELATED")
    expect(state.returnToPrevious()).toBe(true)
    expect(state.selectedCode.value).toBe("M20")
    expect(state.previousMetric.value).toBeNull()
    expect(state.returnToPrevious()).toBe(false)
    expect(state.page.value).toBe(2)
    scope.stop()
  })

  it("无效或重复查看不增加返回记录，重新选择目录指标结束关系浏览", () => {
    const scope = effectScope()
    const state = scope.run(() => useMetricDirectory(ref([metric("A"), metric("B")])))!
    state.select("A")
    expect(state.inspect("A")).toBe(true)
    expect(state.inspect("missing")).toBe(false)
    expect(state.previousMetric.value).toBeNull()
    state.inspect("B")
    state.inspect("B")
    expect(state.previousMetric.value?.metric_code).toBe("A")
    state.select("B")
    expect(state.previousMetric.value).toBeNull()
    scope.stop()
  })

  it("关系浏览期间刷新更新指标名称，并跳过已删除的返回目标", async () => {
    const items = ref([metric("A"), metric("B"), metric("C")])
    const scope = effectScope()
    const state = scope.run(() => useMetricDirectory(items))!
    state.select("A")
    state.inspect("B")
    state.inspect("C")
    items.value = [metric("A", { metric_name: "更新名称" }), metric("C")]
    await nextTick()
    expect(state.previousMetric.value?.metric_name).toBe("更新名称")
    expect(state.returnToPrevious()).toBe(true)
    expect(state.selectedCode.value).toBe("A")
    items.value = [metric("C")]
    await nextTick()
    expect(state.selectedMetric.value).toBeNull()
    expect(state.previousMetric.value).toBeNull()
    scope.stop()
  })

  it("刷新保留当前指标，删除后清空失效选择", async () => {
    const items = ref([metric("A"), metric("B")])
    const scope = effectScope()
    const state = scope.run(() => useMetricDirectory(items))!
    state.select("B")
    items.value = [metric("A"), metric("B", { metric_name: "已修改" })]
    await nextTick()
    expect(state.selectedMetric.value?.metric_name).toBe("已修改")
    items.value = [metric("A")]
    await nextTick()
    expect(state.selectedMetric.value).toBeNull()
    expect(state.select("missing")).toBe(false)
    scope.stop()
  })

  it("更换搜索条件从第一页开始，缩小数据后页码不越界", async () => {
    const items = ref(Array.from({ length: 40 }, (_, i) => metric(`M${i}`)))
    const scope = effectScope()
    const state = scope.run(() => useMetricDirectory(items))!
    state.page.value = 3
    state.search.value = "M2"
    await nextTick()
    expect(state.page.value).toBe(1)
    state.search.value = ""
    await nextTick()
    state.page.value = 3
    items.value = [metric("M0")]
    await nextTick()
    expect(state.page.value).toBe(1)
    scope.stop()
  })
})
