import { describe, expect, it } from "vitest"

import { formatSqlForDisplay, highlightSql } from "../src/lib/sqlPresentation"

describe("SQL 展示排版", () => {
  it("分行展示字段与查询条件，保留命名绑定参数", () => {
    const original =
      "SELECT org_code, metric_value FROM metric_values WHERE org_code IN :org_codes AND stat_date = :stat_date LIMIT :limit"
    const result = formatSqlForDisplay(original)

    expect(result.formatted).toBe(true)
    expect(result.text).toContain("SELECT\n  org_code,\n  metric_value\nFROM")
    expect(result.text).toContain("\nWHERE\n")
    expect(result.text).toContain("IN :org_codes")
    expect(result.text).toContain("= :stat_date")
    expect(result.text).toContain("\nLIMIT\n  :limit")
  })

  it("按子查询层级缩进，不改函数、精度、字符串或注释内容", () => {
    const original =
      "WITH facts AS (SELECT CAST(value AS DECIMAL(30, 10)) AS amount, IFNULL(name, 'FROM, WHERE  AND') AS name FROM `metric_values` WHERE REGEXP_LIKE(code, '^[0-9]+$')) SELECT amount FROM facts -- WHERE 不是条件\nWHERE amount IS NOT NULL"
    const result = formatSqlForDisplay(original)

    expect(result.formatted).toBe(true)
    expect(result.text).toContain("facts AS (\n    SELECT")
    expect(result.text).toContain("DECIMAL(30, 10)")
    expect(result.text).toMatch(/IFNULL\s*\(name, 'FROM, WHERE {2}AND'\)/)
    expect(result.text).toMatch(/REGEXP_LIKE\s*\(code, '\^\[0-9\]\+\$'\)/)
    expect(result.text).toContain("`metric_values`")
    expect(result.text).toContain("-- WHERE 不是条件\n")
    expect(result.text).toContain("amount IS NOT NULL")
  })

  it("无法排版的历史语句仍完整提供原文", () => {
    const original = "SELECT 'unfinished string"

    expect(formatSqlForDisplay(original)).toEqual({ text: original, formatted: false })
  })

  it("区分 SQL 关键字、字符串、数字与注释", () => {
    const html = highlightSql("SELECT 'text', 10 FROM metrics -- saved query")

    expect(html).toContain('<span class="hljs-keyword">SELECT</span>')
    expect(html).toContain('class="hljs-string"')
    expect(html).toContain('<span class="hljs-number">10</span>')
    expect(html).toContain('<span class="hljs-comment">-- saved query</span>')
  })

  it("SQL 中的 HTML 内容仅作为文本显示", () => {
    const html = highlightSql("SELECT '<img src=x onerror=alert(1)>' -- <script>alert(1)</script>")

    expect(html).not.toContain("<img")
    expect(html).not.toContain("<script>")
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;")
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
  })
})
