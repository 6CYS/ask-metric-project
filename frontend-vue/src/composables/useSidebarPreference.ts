import { ref } from "vue"

// 模块级响应式状态复刻 Next.js 的会话偏好：路由切换后保留，刷新页面后恢复默认值。
const isSidebarCollapsed = ref(false)

/**
 * 提供应用侧边栏的共享折叠状态。
 * 将状态放在 AppShell 外部，能够避免路由切换导致组件重建时宽度突然恢复。
 */
export function useSidebarPreference() {
  /** 在展开与折叠宽度之间切换。 */
  function toggleSidebarCollapsed() {
    isSidebarCollapsed.value = !isSidebarCollapsed.value
  }

  return {
    isSidebarCollapsed,
    toggleSidebarCollapsed,
  }
}
