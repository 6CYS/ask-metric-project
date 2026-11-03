import { describe, expect, it } from "vitest"

import { organizationConflicts, organizationParentOptions } from "../src/lib/organizationForm"
import type { OrgItem } from "../src/types/api"

const items: OrgItem[] = [
  { org_code: "root", org_name: "汇总", parent_org_code: null, enabled: true, aliases: [] },
  { org_code: "bank", org_name: "甲行", parent_org_code: "root", enabled: true, aliases: ["甲"] },
  {
    org_code: "branch",
    org_name: "甲支行",
    parent_org_code: "bank",
    enabled: true,
    aliases: ["城中"],
  },
  { org_code: "other", org_name: "乙行", parent_org_code: "root", enabled: true, aliases: ["乙"] },
  { org_code: "old", org_name: "旧行", parent_org_code: "root", enabled: false, aliases: ["旧名"] },
]

describe("机构维护候选与重复提示", () => {
  it("上级选择排除自身、全部下级和停用机构", () => {
    expect(organizationParentOptions(items, "bank").map((row) => row.org.org_code)).toEqual([
      "root",
      "other",
    ])
  })

  it("新增时包含真实多层父级，编辑现有停用上级时仍能识别原关系", () => {
    expect(organizationParentOptions(items).map((row) => row.depth)).toEqual([0, 1, 2, 1])
    expect(organizationParentOptions(items, "branch", "old").slice(-1)[0]?.org.org_code).toBe("old")
  })

  it("停用机构的编号仍占用，名称和别名冲突不混作编号重复", () => {
    const result = organizationConflicts(items, {
      org_code: " old ",
      org_name: "甲行",
      aliases: ["城中"],
      enabled: true,
    })
    expect(result.duplicateCode?.org_code).toBe("old")
    expect(result.nameConflicts.map((org) => org.org_code)).toEqual(["bank"])
    expect(result.aliasConflicts.map((entry) => entry.org.org_code)).toEqual(["branch"])
  })

  it("别名与其他机构标准名也会提示，编辑自身不会产生重复提示", () => {
    const own: OrgItem = {
      org_code: "bank",
      org_name: "甲行",
      parent_org_code: "root",
      enabled: true,
      aliases: ["甲"],
    }
    const result = organizationConflicts(
      items,
      { ...own, aliases: ["甲", " 乙行 ", "乙行"] },
      "bank",
    )
    expect(result.duplicateCode).toBeUndefined()
    expect(result.nameConflicts).toEqual([])
    expect(
      result.aliasConflicts.map((entry) => ({ code: entry.org.org_code, terms: entry.terms })),
    ).toEqual([{ code: "other", terms: ["乙行"] }])
  })

  it("机构名称撞上已有别名同样提示，停用别名不参与问数冲突", () => {
    const result = organizationConflicts(items, {
      org_code: "new",
      org_name: "城中",
      aliases: ["旧名"],
      enabled: true,
    })
    expect(result.aliasConflicts.map((entry) => entry.org.org_code)).toEqual(["branch"])
    expect(
      organizationConflicts(items, {
        org_code: "new",
        org_name: "新行",
        aliases: [],
        enabled: true,
      }).aliasConflicts,
    ).toEqual([])
  })
})
