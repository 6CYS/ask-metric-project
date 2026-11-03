import { computed, ref, watch, type Ref } from "vue"

import type { MetricItem } from "@/types/api"

export function useMetricDirectory(items: Ref<MetricItem[]>) {
  const pageSize = 15
  const search = ref("")
  const showDisabled = ref(false)
  const page = ref(1)
  const selectedCode = ref("")
  const relatedHistory = ref<string[]>([])
  const byCode = computed(() => new Map(items.value.map((item) => [item.metric_code, item])))
  // 目录刷新时构建搜索文本，输入时不重复拼装上万条指标说明。
  const searchEntries = computed(() =>
    items.value.map((item) => ({
      item,
      text: [
        item.metric_code,
        item.metric_name,
        item.unit ?? "",
        item.metric_explanation,
        item.description,
        ...item.synonyms,
      ]
        .join(" ")
        .toLowerCase(),
    })),
  )
  const filteredItems = computed(() => {
    const keyword = search.value.trim().toLowerCase()
    return searchEntries.value
      .filter(
        ({ item, text }) =>
          (showDisabled.value || item.enabled) && (!keyword || text.includes(keyword)),
      )
      .map(({ item }) => item)
  })
  const totalPages = computed(() => Math.max(1, Math.ceil(filteredItems.value.length / pageSize)))
  const pageItems = computed(() =>
    filteredItems.value.slice((page.value - 1) * pageSize, page.value * pageSize),
  )
  const selectedMetric = computed(() => byCode.value.get(selectedCode.value) ?? null)
  const previousMetric = computed(
    () => byCode.value.get(relatedHistory.value[relatedHistory.value.length - 1] ?? "") ?? null,
  )

  watch(
    [search, showDisabled],
    () => {
      page.value = 1
    },
    { flush: "sync" },
  )
  watch(totalPages, (total) => {
    page.value = Math.min(page.value, total)
  })
  watch(byCode, (index) => {
    if (!index.has(selectedCode.value)) {
      selectedCode.value = ""
      relatedHistory.value = []
    } else relatedHistory.value = relatedHistory.value.filter((code) => index.has(code))
  })

  function select(code: string) {
    const metric = byCode.value.get(code)
    if (!metric) return false
    relatedHistory.value = []
    if (!metric.enabled) showDisabled.value = true
    if (!filteredItems.value.some((item) => item.metric_code === code)) search.value = ""
    selectedCode.value = code
    const index = filteredItems.value.findIndex((item) => item.metric_code === code)
    page.value = Math.floor(index / pageSize) + 1
    return true
  }

  // 关系浏览只切换详情，不改变用户正在使用的目录筛选和分页。
  function inspect(code: string) {
    if (!byCode.value.has(code)) return false
    if (selectedCode.value === code) return true
    if (selectedMetric.value) relatedHistory.value.push(selectedCode.value)
    selectedCode.value = code
    return true
  }

  function returnToPrevious() {
    const metric = previousMetric.value
    if (!metric) return false
    relatedHistory.value.pop()
    selectedCode.value = metric.metric_code
    return true
  }

  return {
    search,
    showDisabled,
    page,
    pageSize,
    selectedCode,
    selectedMetric,
    previousMetric,
    filteredItems,
    totalPages,
    pageItems,
    select,
    inspect,
    returnToPrevious,
  }
}
