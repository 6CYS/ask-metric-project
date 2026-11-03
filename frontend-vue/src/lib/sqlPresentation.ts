import hljs from "highlight.js/lib/core"
import sqlLanguage from "highlight.js/lib/languages/sql"
import { formatDialect, sql } from "sql-formatter"

hljs.registerLanguage("sql", sqlLanguage)

export function highlightSql(sqlText: string): string {
  return hljs.highlight(sqlText, { language: "sql" }).value
}

export function formatSqlForDisplay(sqlText: string): { text: string; formatted: boolean } {
  try {
    return {
      text: formatDialect(sqlText, {
        dialect: sql,
        tabWidth: 2,
        paramTypes: { named: [":"], positional: true },
      }),
      formatted: true,
    }
  } catch {
    // 排版器不支持的历史语法仍可核验原文，不影响执行记录的读取。
    return { text: sqlText, formatted: false }
  }
}
