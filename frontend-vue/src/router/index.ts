import { createRouter, createWebHistory } from "vue-router"

import LlmView from "@/views/LlmView.vue"
import MetricsView from "@/views/MetricsView.vue"
import OrgsView from "@/views/OrgsView.vue"
import QueryRunsView from "@/views/QueryRunsView.vue"
import DatasetsView from "@/views/DatasetsView.vue"
import ChatView from "@/views/ChatView.vue"
import LoginView from "@/views/LoginView.vue"
import { useAuth } from "@/composables/useAuth"
import { setAuthFailureReason } from "@/lib/authSession"

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
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
  ],
})

router.beforeEach(async (to) => {
  const auth = useAuth()
  await auth.initializeAuth()
  const ssoToken = typeof to.query.token === "string" ? to.query.token : ""
  if (ssoToken) {
    const cleanQuery = { ...to.query }
    delete cleanQuery.token
    const cleanLocation = router.resolve({ path: to.path, query: cleanQuery }).fullPath
    if (auth.isAuthenticated.value) {
      return { path: to.path, query: cleanQuery }
    }
    try {
      await auth.loginWithSso(ssoToken)
      const redirect = typeof to.query.redirect === "string" ? to.query.redirect : ""
      return redirect || (to.name === "login" ? { path: "/chat" } : { path: to.path, query: cleanQuery })
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "单点登录失败，请稍后重试。"
      setAuthFailureReason(message)
      return { name: "login", query: { redirect: cleanLocation } }
    }
  }
  const requiresAuth = Boolean(to.meta.requiresAuth)
  if (requiresAuth && !auth.isAuthenticated.value) {
    return { name: "login", query: { redirect: to.fullPath } }
  }
  if (["llm"].includes(String(to.name)) && auth.user.value?.role_code !== "SYSTEM_ADMIN") {
    return { name: "chat" }
  }
  if (to.name === "login" && auth.isAuthenticated.value) return { path: "/chat" }
})

export default router
