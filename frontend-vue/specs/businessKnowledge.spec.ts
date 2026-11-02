import { describe, expect, it, vi } from "vitest"

import { ApiError } from "../src/lib/api"
import { knowledgePayload } from "../src/lib/businessKnowledge"
import { useKnowledgeManagement } from "../src/composables/useKnowledgeManagement"
import type { BusinessKnowledgeItem, BusinessKnowledgeList, BusinessKnowledgePayload } from "../src/types/api"

const item: BusinessKnowledgeItem = {
  id: "knowledge-1", title: "贷款结构", text: "按产品结构分析。", enabled: true, updated_at: null,
}
const list = (revision = "r1"): BusinessKnowledgeList => ({ items: [{ ...item }], revision })
const form = () => ({ title: item.title, text: item.text, enabled: item.enabled })
function api() {
  return {
    list: vi.fn(async () => list()),
    create: vi.fn(async (payload: BusinessKnowledgePayload) => ({ item: { ...item, ...payload }, revision: "r2" })),
    update: vi.fn(async (_id: string, payload: BusinessKnowledgePayload) => ({ item: { ...item, ...payload }, revision: "r2" })),
    setEnabled: vi.fn(async (_id: string, payload: { enabled: boolean; revision: string }) => ({ item: { ...item, enabled: payload.enabled }, revision: "r2" })),
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe("业务知识表单", () => {
  it("只提交可编辑字段、去除外围空白并携带打开时的版本", () => {
    expect(knowledgePayload({ ...form(), title: " 贷款结构 ", text: " 分析内容\n " }, "r1")).toEqual({
      title: "贷款结构", text: "分析内容", enabled: true, revision: "r1",
    })
  })

  it.each([
    { title: " " }, { text: " " }, { title: "字".repeat(201) }, { text: "字".repeat(8001) },
  ])("拒绝无效输入 %j", change => {
    expect(() => knowledgePayload({ ...form(), ...change }, "r1")).toThrow()
  })

  it("正文保留使用边界，旧条目附加字段不进入写入请求", () => {
    const legacy = { ...item, text: "贷款结构\n仅作分析参考，不能据此推断下降原因。", topic: "loan", source: "旧资料", role: "旧边界", url: "https://example.com", date: "2026-01-01" }
    expect(knowledgePayload(legacy, "r1")).toEqual({ title: item.title, text: legacy.text, enabled: true, revision: "r1" })
  })
})

describe("业务知识管理状态", () => {
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
    expect(gateway.update).toHaveBeenCalledWith(item.id, expect.objectContaining({ revision: "r1" }))
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
    expect(gateway.create).toHaveBeenCalledWith({ title: "新增知识", text: "知识正文", enabled: true, revision: "r1" })
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
    expect(gateway.update).toHaveBeenCalledWith(item.id, { title: item.title, text: item.text, enabled: false, revision: "r1" })
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
