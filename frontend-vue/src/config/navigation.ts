import type { Component } from "vue"
import {
  Activity,
  BookOpenText,
  Building2,
  Database,
  MessageSquareText,
  SlidersHorizontal,
  TestTubeDiagonal,
} from "@lucide/vue"

/**
 * 应用主导航配置。
 *
 * 路由、侧边栏和移动端顶部导航共用这一份数据，避免后续新增模块时出现
 * “路由已经存在但导航遗漏”或桌面端、移动端文案不一致的问题。
 */
export type NavigationItem = {
  routeName: string
  href: string
  label: string
  description: string
  icon: Component
  adminOnly?: boolean
}

// 顺序、文案和图标与原 Next.js AppShell 保持一致。
export const navigationItems: NavigationItem[] = [
  { routeName: "chat", href: "/chat", label: "指标问数", description: "自然语言查询", icon: MessageSquareText },
  { routeName: "metrics", href: "/metrics", label: "指标术语", description: "口径与同义词", icon: BookOpenText },
  { routeName: "orgs", href: "/orgs", label: "机构别名", description: "标准名与别名", icon: Building2 },
  { routeName: "datasets", href: "/datasets", label: "数据集", description: "事实表与来源", icon: Database },
  { routeName: "query-runs", href: "/query-runs", label: "问数日志", description: "运行轨迹", icon: Activity },
  { routeName: "llm", href: "/llm", label: "智能配置", description: "模型、提示词与 SQL", icon: SlidersHorizontal, adminOnly: true },
  { routeName: "test-center", href: "/test-center", label: "自动化测试", description: "准确率与质量报告", icon: TestTubeDiagonal, adminOnly: true },
]
