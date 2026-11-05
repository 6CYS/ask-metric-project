import { describe, expect, it, vi } from "vitest"
import { createSSRApp, type Component } from "vue"
import { renderToString } from "vue/server-renderer"

import BusinessKnowledgeEditor from "../src/components/knowledge/BusinessKnowledgeEditor.vue"
import { ApiError } from "../src/lib/api"
import { knowledgePayload } from "../src/lib/businessKnowledge"
import { useKnowledgeManagement } from "../src/composables/useKnowledgeManagement"
import type {
  BusinessKnowledgeItem,
  BusinessKnowledgeList,
  BusinessKnowledgePayload,
} from "../src/types/api"

// 单独验证表单正文；弹层 Portal 依赖浏览器，焦点与遮罩由共享弹层负责。
vi.mock("../src/components/ui/BaseModal.vue", async () => {
  const { defineComponent, h } = await import("vue")
  return {
    default: defineComponent({
      setup:
        (_, { slots }) =>
        () =>
          h("section", [slots.default?.(), slots.footer?.()]),
    }),
  }
})
// ESLint 不生成 SFC 类型；组件本身由 vue-tsc 检查。
const knowledgeEditor = BusinessKnowledgeEditor as Component

const item: BusinessKnowledgeItem = {
  id: "knowledge-1",
  title: "贷款结构",
  text: "按产品结构分析。",
  enabled: true,
  updated_at: null,
}
const list = (revision = "r1"): BusinessKnowledgeList => ({ items: [{ ...item }], revision })
const form = () => ({
  title: item.title,
  text: item.text,
  enabled: item.enabled,
  metric_codes: [] as string[],
})
function api() {
  return {
    list: vi.fn(() => Promise.resolve(list())),
    create: vi.fn((payload: BusinessKnowledgePayload) =>
      Promise.resolve({ item: { ...item, ...payload }, revision: "r2" }),
    ),
    update: vi.fn((_id: string, payload: BusinessKnowledgePayload) =>
      Promise.resolve({ item: { ...item, ...payload }, revision: "r2" }),
    ),
    setEnabled: vi.fn((_id: string, payload: { enabled: boolean; revision: string }) =>
      Promise.resolve({ item: { ...item, enabled: payload.enabled }, revision: "r2" }),
    ),
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("业务知识表单", () => {
  it("保留显式关联、去除重复编码，并允许主动清空关联", () => {
    const linked = { ...form(), metric_codes: [" ORG_DEPOSIT ", "ORG_LOAN", "ORG_DEPOSIT"] }
    expect(knowledgePayload(linked, "r1").metric_codes).toEqual(["ORG_DEPOSIT", "ORG_LOAN"])
    expect(knowledgePayload({ ...form(), metric_codes: [] }, "r1").metric_codes).toEqual([])
  })
  it("只提交可编辑字段、去除外围空白并携带打开时的版本", () => {
    expect(
      knowledgePayload({ ...form(), title: " 贷款结构 ", text: " 分析内容\n " }, "r1"),
    ).toEqual({
      title: "贷款结构",
      text: "分析内容",
      enabled: true,
      revision: "r1",
      metric_codes: [],
    })
  })

  it.each([
    { title: " " },
    { text: " " },
    { title: "字".repeat(201) },
    { text: "字".repeat(8001) },
  ])("拒绝无效输入 %j", (change) => {
    expect(() => knowledgePayload({ ...form(), ...change }, "r1")).toThrow()
  })

  it("正文保留使用边界，旧条目附加字段不进入写入请求", () => {
    const legacy = {
      ...item,
      text: "贷款结构\n仅作分析参考，不能据此推断下降原因。",
      topic: "loan",
      source: "旧资料",
      role: "旧边界",
      url: "https://example.com",
      date: "2026-01-01",
    }
    expect(knowledgePayload(legacy, "r1")).toEqual({
      title: item.title,
      text: legacy.text,
      enabled: true,
      revision: "r1",
      metric_codes: [],
    })
  })
})

describe("业务知识管理状态", () => {
  it("保存反馈使用服务端确认内容，下一次失败不会残留成功提示", async () => {
    const gateway = api()
    const state = useKnowledgeManagement(gateway)
    await state.load()
    state.openEdit(item)
    state.form.value.title = "  新标题  "
    expect(await state.save()).toBe(true)
    expect(state.notice?.value).toMatchObject({
      action: "saved",
      item: { id: item.id, title: "新标题" },
    })
    gateway.setEnabled.mockRejectedValueOnce(new ApiError("无权操作", 403))
    expect(await state.toggle(item)).toBe(false)
    expect(state.notice?.value).toBeNull()
    expect(state.items.value[0]?.enabled).toBe(true)
  })

  it("停用与启用反馈保留对应条目，支持从提示查看已隐藏内容", async () => {
    const state = useKnowledgeManagement(api())
    await state.load()
    expect(await state.toggle(item)).toBe(true)
    expect(state.notice?.value).toMatchObject({
      action: "disabled",
      item: { id: item.id, enabled: false },
    })
    expect(await state.toggle(item)).toBe(true)
    expect(state.notice?.value).toMatchObject({
      action: "enabled",
      item: { id: item.id, enabled: true },
    })
  })

  it("只有重新打开或成功替换编辑内容才重置草稿基线", async () => {
    const gateway = api()
    const state = useKnowledgeManagement(gateway)
    await state.load()
    state.openEdit(item)
    const first = state.editorVersion?.value
    expect(first).toBeGreaterThan(0)
    state.form.value.text = "未保存"
    await state.load()
    expect(state.editorVersion.value).toBe(first)
    await state.reloadEditor()
    expect(state.editorVersion.value).toBeGreaterThan(first)
    expect(state.form.value.text).toBe(item.text)
    state.openCreate()
    const creating = state.editorVersion.value
    state.form.value.text = "新草稿"
    await state.reloadEditor()
    expect(state.editorVersion.value).toBe(creating)
    expect(state.form.value.text).toBe("新草稿")
  })

  it.each([{ codes: ["ORG_DEPOSIT"] }, { codes: ["ORG_LOAN"] }, { codes: [] }])(
    "新建冲突重读保留完整草稿及当前关联 $codes",
    async ({ codes: metricCodes }) => {
      const gateway = api()
      const state = useKnowledgeManagement(gateway)
      await state.load()
      state.openCreate(["ORG_DEPOSIT"])
      Object.assign(state.form.value, {
        title: "新标题",
        text: "新正文",
        enabled: false,
        metric_codes: [...metricCodes],
      })
      gateway.create.mockRejectedValueOnce(new ApiError("版本冲突", 409))
      expect(await state.save()).toBe(false)
      gateway.list.mockResolvedValue(list("r2"))
      expect(await state.reloadEditor()).toBe(true)
      expect(state.form.value).toEqual({
        title: "新标题",
        text: "新正文",
        enabled: false,
        metric_codes: metricCodes,
      })
      expect(state.hasConflict.value).toBe(false)
      expect(await state.save()).toBe(true)
      expect(gateway.create).toHaveBeenLastCalledWith({
        title: "新标题",
        text: "新正文",
        enabled: false,
        metric_codes: metricCodes,
        revision: "r2",
      })
    },
  )

  it("关联已有知识只追加指标，保留正文、其他关联和启停状态", async () => {
    const gateway = api()
    const original = { ...item, enabled: false, metric_codes: ["ORG_LOAN"] }
    gateway.list.mockResolvedValue({ items: [original], revision: "r1" })
    const state = useKnowledgeManagement(gateway)
    await state.load()
    expect(await state.linkMetric(item.id, "ORG_DEPOSIT")).toBe(true)
    expect(gateway.update).toHaveBeenCalledWith(item.id, {
      title: item.title,
      text: item.text,
      enabled: false,
      revision: "r1",
      metric_codes: ["ORG_LOAN", "ORG_DEPOSIT"],
    })
    expect(state.items.value[0]?.metric_codes).toEqual(["ORG_LOAN", "ORG_DEPOSIT"])
    expect(original.metric_codes).toEqual(["ORG_LOAN"])
    expect(state.editorOpen.value).toBe(false)
  })

  it("已关联指标不重复写入，后续关联使用最新版本", async () => {
    const gateway = api()
    const state = useKnowledgeManagement(gateway)
    await state.load()
    expect(await state.linkMetric(item.id, "ORG_DEPOSIT")).toBe(true)
    expect(await state.linkMetric(item.id, "ORG_DEPOSIT")).toBe(true)
    expect(gateway.update).toHaveBeenCalledTimes(1)
    expect(await state.linkMetric(item.id, "ORG_LOAN")).toBe(true)
    expect(gateway.update).toHaveBeenLastCalledWith(
      item.id,
      expect.objectContaining({
        revision: "r2",
        metric_codes: ["ORG_DEPOSIT", "ORG_LOAN"],
      }),
    )
  })

  it("关联冲突保留之前成功项，停止重复提交，重读后才可继续", async () => {
    const gateway = api()
    const second = { ...item, id: "knowledge-2", metric_codes: ["ORG_OTHER"] }
    gateway.list.mockResolvedValue({ items: [item, second], revision: "r1" })
    const state = useKnowledgeManagement(gateway)
    await state.load()
    await state.linkMetric(item.id, "ORG_DEPOSIT")
    gateway.update.mockRejectedValue(new ApiError("冲突", 409))
    expect(await state.linkMetric(second.id, "ORG_DEPOSIT")).toBe(false)
    expect(state.items.value[0]?.metric_codes).toEqual(["ORG_DEPOSIT"])
    expect(state.items.value[1]?.metric_codes).toEqual(["ORG_OTHER"])
    expect(state.actionConflict.value).toBe(true)
    expect(await state.linkMetric(second.id, "ORG_DEPOSIT")).toBe(false)
    expect(gateway.update).toHaveBeenCalledTimes(2)
    gateway.list.mockResolvedValue({ items: [...state.items.value], revision: "r3" })
    await state.load()
    expect(state.actionConflict.value).toBe(false)
  })

  it("关联权限失败保持已有内容，错误可见且不自动重试", async () => {
    const gateway = api()
    const state = useKnowledgeManagement(gateway)
    await state.load()
    gateway.update.mockRejectedValue(new ApiError("无权维护知识", 403))
    expect(await state.linkMetric(item.id, "ORG_DEPOSIT")).toBe(false)
    expect(state.items.value[0]?.metric_codes).toBeUndefined()
    expect(state.actionError.value).toBe("无权维护知识")
    expect(state.isMutating.value).toBe(false)
    expect(gateway.update).toHaveBeenCalledTimes(1)
  })

  it("新增知识预选当前指标，不继承上一次编辑内容", async () => {
    const state = useKnowledgeManagement(api())
    await state.load()
    state.openEdit(item)
    state.openCreate(["ORG_DEPOSIT"])
    expect(state.form.value).toEqual({
      title: "",
      text: "",
      enabled: true,
      metric_codes: ["ORG_DEPOSIT"],
    })
  })

  it("编辑关联使用独立副本，修改正文不会丢失关联，清空后可保存", async () => {
    const gateway = api()
    const state = useKnowledgeManagement(gateway)
    await state.load()
    const linked = { ...item, metric_codes: ["ORG_DEPOSIT", "ORG_LOAN"] }
    state.openEdit(linked)
    state.form.value.title = "补充说明"
    expect(await state.save()).toBe(true)
    expect(gateway.update).toHaveBeenLastCalledWith(
      item.id,
      expect.objectContaining({ metric_codes: ["ORG_DEPOSIT", "ORG_LOAN"] }),
    )
    state.openEdit(linked)
    state.form.value.metric_codes.splice(0)
    expect(linked.metric_codes).toEqual(["ORG_DEPOSIT", "ORG_LOAN"])
    expect(await state.save()).toBe(true)
    expect(gateway.update).toHaveBeenLastCalledWith(
      item.id,
      expect.objectContaining({ metric_codes: [] }),
    )
  })
  it("编辑后刷新列表不改变本次提交版本，冲突保留输入且禁止自动重试", async () => {
    const gateway = api()
    const state = useKnowledgeManagement(gateway)
    await state.load()
    state.openEdit(item)
    state.form.value.title = "我正在编辑的内容"
    gateway.list.mockResolvedValue(list("r2"))
    await state.load()
    gateway.update.mockRejectedValue(new ApiError("版本冲突", 409))
    expect(await state.save()).toBe(false)
    expect(gateway.update).toHaveBeenCalledWith(
      item.id,
      expect.objectContaining({ revision: "r1" }),
    )
    expect(state.form.value.title).toBe("我正在编辑的内容")
    expect(state.editorOpen.value).toBe(true)
    expect(state.hasConflict.value).toBe(true)
    expect(await state.save()).toBe(false)
    expect(gateway.update).toHaveBeenCalledTimes(1)
    expect(await state.reloadEditor()).toBe(true)
    expect(state.form.value.title).toBe(item.title)
    expect(state.hasConflict.value).toBe(false)
  })

  it("新增默认启用且使用打开表单时的版本", async () => {
    const gateway = api()
    const state = useKnowledgeManagement(gateway)
    await state.load()
    state.openCreate()
    Object.assign(state.form.value, { title: "新增知识", text: "知识正文" })
    expect(await state.save()).toBe(true)
    expect(gateway.create).toHaveBeenCalledWith({
      title: "新增知识",
      text: "知识正文",
      enabled: true,
      revision: "r1",
      metric_codes: [],
    })
    expect(state.editorOpen.value).toBe(false)
    expect(state.revision.value).toBe("r2")
  })

  it("编辑旧条目只展示和保存标题、正文、启停状态", async () => {
    const gateway = api()
    const state = useKnowledgeManagement(gateway)
    await state.load()
    const legacyItem = { ...item, topic: "loan", source: "旧来源" }
    state.openEdit(legacyItem)
    expect(state.form.value).toEqual(form())
    state.form.value.enabled = false
    expect(await state.save()).toBe(true)
    expect(gateway.update).toHaveBeenCalledWith(item.id, {
      title: item.title,
      text: item.text,
      enabled: false,
      revision: "r1",
      metric_codes: [],
    })
  })

  it("启停采用当前列表版本，失败保留原条目并提供列表可见错误", async () => {
    const gateway = api()
    const state = useKnowledgeManagement(gateway)
    await state.load()
    gateway.setEnabled.mockRejectedValue(new ApiError("版本冲突", 409))
    expect(await state.toggle(item)).toBe(false)
    expect(gateway.setEnabled).toHaveBeenCalledWith(item.id, { enabled: false, revision: "r1" })
    expect(state.items.value[0]?.enabled).toBe(true)
    expect(state.actionError.value).toContain("重新读取")
    expect(state.editorOpen.value).toBe(false)
  })

  it("较早发出的刷新不能覆盖后续请求的列表", async () => {
    const gateway = api()
    const earlier = deferred<BusinessKnowledgeList>()
    gateway.list.mockReturnValueOnce(earlier.promise).mockResolvedValueOnce(list("r2"))
    const state = useKnowledgeManagement(gateway)
    const pending = state.load()
    await state.load()
    earlier.resolve(list("r1"))
    await pending
    expect(state.revision.value).toBe("r2")
  })

  it("变更前启动的刷新不能覆盖已成功保存的条目", async () => {
    const gateway = api()
    const state = useKnowledgeManagement(gateway)
    await state.load()
    state.openEdit(item)
    state.form.value.title = "保存后的标题"
    const earlier = deferred<BusinessKnowledgeList>()
    gateway.list.mockReturnValueOnce(earlier.promise)
    const pending = state.load()
    await state.save()
    earlier.resolve(list("r1"))
    await pending
    expect(state.revision.value).toBe("r2")
    expect(state.items.value[0]?.title).toBe("保存后的标题")
  })
})

describe("指标中的知识编辑文案", () => {
  const metric = {
    metric_code: "ORG_DEPOSIT",
    metric_name: "各项存款",
    metric_explanation: "",
    description: "",
    synonyms: [],
    unit: "元",
    enabled: true,
  }
  async function render(metricCodes: string[], editing = false, conflict = false) {
    return renderToString(
      createSSRApp(knowledgeEditor, {
        open: true,
        modelValue: { ...form(), metric_codes: metricCodes },
        metrics: [metric],
        currentMetric: metric,
        editing,
        conflict,
        error: conflict ? "版本冲突" : "",
      }),
    )
  }

  it("仍关联当前指标时才显示保存并关联", async () => {
    expect(await render([metric.metric_code])).toContain("保存并关联")
  })

  it.each([{ codes: [] }, { codes: ["ORG_OTHER"] }])(
    "主动移除当前指标后明确保存结果 $codes",
    async ({ codes: metricCodes }) => {
      const html = await render(metricCodes)
      expect(html).not.toContain("保存并关联")
      expect(html).toContain("保存知识")
      expect(html).toContain("保存后不会在当前指标的知识列表中显示")
    },
  )

  it("新建重读保留草稿，已有知识重读明确放弃本次修改", async () => {
    expect(await render([metric.metric_code], false, true)).toContain("重新读取版本并保留输入")
    expect(await render([metric.metric_code], true, true)).toContain("放弃本次修改并重新读取")
  })
})

describe("查询方案分类与编辑", () => {
  it("新建方案固定类型，冲突重读保留草稿，随后新建知识重置类别", async () => {
    const gateway = api()
    const state = useKnowledgeManagement(gateway)
    await state.load()
    state.openCreate(["ORG_LOAN"], "plan")
    Object.assign(state.form.value, { title: "贷款查询", text: "按贷款指标查询", enabled: false })
    expect(state.form.value.batch_query_enabled).toBe(true)
    gateway.create.mockRejectedValueOnce(new ApiError("版本冲突", 409))
    expect(await state.save()).toBe(false)
    gateway.list.mockResolvedValue(list("r2"))
    expect(await state.reloadEditor()).toBe(true)
    expect(state.form.value).toEqual({
      title: "贷款查询",
      text: "按贷款指标查询",
      enabled: false,
      metric_codes: ["ORG_LOAN"],
      batch_query_enabled: true,
    })
    expect(await state.save()).toBe(true)
    expect(gateway.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ batch_query_enabled: true, enabled: false, revision: "r2" }),
    )
    state.openCreate()
    expect(state.form.value).toEqual({ title: "", text: "", enabled: true, metric_codes: [] })
  })

  it("方案要求1至24个去重指标，普通知识仍可不关联", () => {
    const plan = { ...form(), batch_query_enabled: true }
    expect(() => knowledgePayload(plan, "r1")).toThrow("查询方案须关联 1 至 24 个指标")
    const codes = Array.from({ length: 24 }, (_, i) => `ORG_${i}`)
    expect(
      knowledgePayload({ ...plan, metric_codes: [...codes, codes[0]!] }, "r1").metric_codes,
    ).toEqual(codes)
    expect(() =>
      knowledgePayload({ ...plan, metric_codes: [...codes, "ORG_EXTRA"] }, "r1"),
    ).toThrow("查询方案须关联 1 至 24 个指标")
    expect(knowledgePayload(form(), "r1").metric_codes).toEqual([])
  })

  it("编辑方案重读保留服务端类别，停用只提交enabled", async () => {
    const gateway = api()
    const plan = { ...item, batch_query_enabled: true, metric_codes: ["ORG_LOAN"] }
    gateway.list.mockResolvedValue({ items: [plan], revision: "r1" })
    const state = useKnowledgeManagement(gateway)
    await state.load()
    state.openEdit(plan)
    gateway.update.mockRejectedValueOnce(new ApiError("版本冲突", 409))
    expect(await state.save()).toBe(false)
    gateway.list.mockResolvedValue({ items: [plan], revision: "r2" })
    expect(await state.reloadEditor()).toBe(true)
    expect(state.form.value.batch_query_enabled).toBe(true)
    expect(await state.toggle(plan)).toBe(true)
    expect(gateway.setEnabled).toHaveBeenLastCalledWith(plan.id, { enabled: false, revision: "r2" })
  })

  it.each([false, true])("共享编辑器按实际条目类型展示且不提供类别开关：%s", async (plan) => {
    const html = await renderToString(
      createSSRApp(knowledgeEditor, {
        open: true,
        modelValue: { ...form(), batch_query_enabled: plan, metric_codes: ["ORG_LOAN"] },
        metrics: [],
      }),
    )
    for (const label of plan
      ? ["方案名称", "适用场景与查询说明", "查询指标（必选，1～24 个）", "启用这个方案", "保存方案"]
      : ["知识标题", "知识内容", "相关指标（选填）", "启用这条知识", "保存知识"])
      expect(html).toContain(label)
    expect(html).not.toContain("支持批量取数")
    expect(html).not.toContain('role="checkbox"')
  })
})
