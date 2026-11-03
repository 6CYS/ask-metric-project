import { describe, expect, it } from "vitest"

import { organizationTreeRows } from "../src/lib/organizationTree"
import type { OrgItem } from "../src/types/api"

function org(code: string, parent: string | null, options: Partial<OrgItem> = {}): OrgItem {
  return {
    org_code: code,
    org_name: code,
    parent_org_code: parent,
    hierarchy_level: parent ? "3" : "1",
    enabled: true,
    aliases: [],
    ...options,
  }
}

describe("机构树展示", () => {
  it("按正式父级组树，层级代码不决定缩进，超过原分页数量的下级完整展示", () => {
    const items = [
      org("汇总", null),
      ...Array.from({ length: 60 }, (_, i) => org(`法人${i}`, "汇总")),
    ]
    const result = organizationTreeRows(items)
    expect(result.rows).toHaveLength(61)
    expect(result.rows[0]).toMatchObject({ depth: 0, hasChildren: true, expanded: true })
    expect(result.rows.slice(1).every((row) => row.depth === 1)).toBe(true)
    expect(result.matchedCount).toBe(61)
    expect(
      organizationTreeRows(items, { expanded: new Map([["汇总", false]]) }).rows.map(
        (row) => row.org.org_code,
      ),
    ).toEqual(["汇总"])
  })

  it("搜索编号、名称和别名时保留祖先路径、自动展开且不带入无关兄弟", () => {
    const items = [
      org("root", null),
      org("bank", "root"),
      org("child", "bank", { org_name: "江南支行", aliases: ["小江"] }),
      org("other", "root"),
    ]
    for (const keyword of ["CHILD", "江南", "小江"]) {
      const result = organizationTreeRows(items, {
        keyword,
        expanded: new Map([
          ["root", false],
          ["bank", false],
        ]),
      })
      expect(result.rows.map((row) => row.org.org_code)).toEqual(["root", "bank", "child"])
      expect(result.rows.map((row) => row.isContext)).toEqual([true, true, false])
      expect(result.matchedCount).toBe(1)
      expect(result.rows[1]?.expanded).toBe(true)
    }
    expect(organizationTreeRows(items, { keyword: "不存在" }).rows).toEqual([])
  })

  it("默认折叠更深子树，展开后显示真实第三层，搜索清空后仍沿用展开状态", () => {
    const items = [org("root", null), org("bank", "root"), org("branch", "bank")]
    expect(organizationTreeRows(items).rows.map((row) => row.org.org_code)).toEqual([
      "root",
      "bank",
    ])
    const expanded = new Map([["bank", true]])
    expect(organizationTreeRows(items, { expanded }).rows[2]?.depth).toBe(2)
    organizationTreeRows(items, { keyword: "branch", expanded })
    expect(expanded.size).toBe(1)
  })

  it("启用后代不会因上级停用而消失，上级作为路径展示，其他停用机构按开关过滤", () => {
    const items = [
      org("root", null),
      org("bank", "root", { enabled: false }),
      org("branch", "bank"),
      org("disabled", null, { enabled: false, hierarchy_level: null }),
    ]
    const filtered = organizationTreeRows(items, { expanded: new Map([["bank", true]]) })
    expect(filtered.rows.map((row) => row.org.org_code)).toEqual(["root", "bank", "branch"])
    expect(filtered.rows[1]?.isContext).toBe(true)
    expect(filtered.matchedCount).toBe(2)
    const all = organizationTreeRows(items, { showDisabled: true })
    expect(all.rows.find((row) => row.org.org_code === "disabled")).toMatchObject({
      depth: 0,
      issue: "未关联层级",
    })
  })

  it("不猜测缺失父级，环和自环可见且不会无限递归", () => {
    const items = [
      org("root", null),
      org("orphan", "missing"),
      org("a", "b"),
      org("b", "a"),
      org("self", "self"),
    ]
    const result = organizationTreeRows(items)
    expect(result.rows).toHaveLength(5)
    expect(new Set(result.rows.map((row) => row.org.org_code)).size).toBe(5)
    expect(result.rows.find((row) => row.org.org_code === "orphan")).toMatchObject({
      depth: 0,
      issue: "上级未收录",
    })
    expect(
      result.rows
        .filter((row) => ["a", "b", "self"].includes(row.org.org_code))
        .every((row) => row.issue === "层级关系异常" && row.depth === 0),
    ).toBe(true)
    expect(organizationTreeRows(items, { keyword: "self" }).rows).toHaveLength(1)
  })

  it("旧接口未提供层级时平铺兼容，不修改机构原始信息", () => {
    const item: OrgItem = { org_code: "01", org_name: "机构", aliases: [], enabled: true }
    const before = JSON.stringify(item)
    expect(organizationTreeRows([item]).rows[0]).toMatchObject({
      depth: 0,
      hasChildren: false,
      issue: "未关联层级",
    })
    expect(JSON.stringify(item)).toBe(before)
  })
})
