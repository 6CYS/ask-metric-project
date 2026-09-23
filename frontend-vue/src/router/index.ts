import { createRouter, createWebHistory } from "vue-router"

import LlmView from "@/views/LlmView.vue"
import MetricsView from "@/views/MetricsView.vue"
import OrgsView from "@/views/OrgsView.vue"
import QueryRunsView from "@/views/QueryRunsView.vue"
import DatasetsView from "@/views/DatasetsView.vue"
import ChatView from "@/views/ChatView.vue"
import LoginView from "@/views/LoginView.vue"
import SsoEntryView from "@/views/SsoEntryView.vue"
import { getAuthConfig } from "@/lib/api"
import TestCenterView from "@/views/TestCenterView.vue"
import { useAuth } from "@/composables/useAuth"
import { setAuthFailureReason } from "@/lib/authSession"

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: "/sso-entry", name: "sso-entry", component: SsoEntryView },
    {
      path: "/login",
      name: "login",
      component: LoginView,
    },
    {
      path: "/",
      redirect: "/chat",
    },
    { path: "/query-runs", name: "query-runs", component: QueryRunsView, meta: { requiresAuth: true } },
    { path: "/chat", name: "chat", component: ChatView, meta: { requiresAuth: true } },
    { path: "/llm", name: "llm", component: LlmView, meta: { requiresAuth: true } },
    { path: "/metrics", name: "metrics", component: MetricsView, meta: { requiresAuth: true } },
    { path: "/orgs", name: "orgs", component: OrgsView, meta: { requiresAuth: true } },
    { path: "/datasets", name: "datasets", component: DatasetsView, meta: { requiresAuth: true } },
    { path: "/test-center", name: "test-center", component: TestCenterView, meta: { requiresAuth: true } },
  ],
})

router.beforeEach(async (to) => {
  const auth = useAuth()
  const ssoToken = typeof to.query.token === "string" ? to.query.token : ""
  if (ssoToken) {
    const cleanQuery = { ...to.query }
    delete cleanQuery.token
    const cleanLocation = router.resolve({ path: to.path, query: cleanQuery }).fullPath
    // 立即从地址栏移除外部凭证；新平台跳转必须重新验证，不能沿用旧账号。
    window.history.replaceState(window.history.state, "", cleanLocation)
    try {
      await auth.loginWithSso(ssoToken)
      const redirect = typeof to.query.redirect === "string" ? to.query.redirect : ""
      return (redirect.startsWith("/") && !redirect.startsWith("//") && !redirect.includes("\\") ? redirect : "")
        || (["login", "sso-entry"].includes(String(to.name)) ? { path: "/chat" } : { path: to.path, query: cleanQuery })
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "单点登录失败，请稍后重试。"
      setAuthFailureReason(message)
      auth.clearAuth()
      return { name: "sso-entry" }
    }
  }
  await auth.initializeAuth()
  const requiresAuth = Boolean(to.meta.requiresAuth)
  if (!auth.isAuthenticated.value && (requiresAuth || to.name === "login")) {
    try {
      const config = await getAuthConfig()
      if (config.sso_enabled) return { name: "sso-entry" }
    } catch {
      setAuthFailureReason("暂时无法连接问数服务，请稍后重试。")
      return { name: "sso-entry" }
    }
  }
  if (requiresAuth && !auth.isAuthenticated.value) {
    return { name: "login", query: { redirect: to.fullPath } }
  }
  if (["llm", "test-center"].includes(String(to.name)) && auth.user.value?.role_code !== "SYSTEM_ADMIN") {
    return { name: "chat" }
  }
  if (["login", "sso-entry"].includes(String(to.name)) && auth.isAuthenticated.value) return { path: "/chat" }
})

export default router
