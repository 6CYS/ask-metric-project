import { createRouter, createWebHistory } from "vue-router"
import type { Component } from "vue"

import LlmView from "@/views/LlmView.vue"
import MetricsView from "@/views/MetricsView.vue"
import OrgsView from "@/views/OrgsView.vue"
import QueryRunsView from "@/views/QueryRunsView.vue"
import DatasetsView from "@/views/DatasetsView.vue"
import ChatView from "@/views/ChatView.vue"
import LoginView from "@/views/LoginView.vue"
import KnowledgeView from "@/views/KnowledgeView.vue"
import { useAuth } from "@/composables/useAuth"
import { setAuthFailureReason } from "@/lib/authSession"

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: "/login",
      // 保留一期数字农商已登记入口，复用登录页的 token 校验和跳转守卫。
      alias: "/sso-entry",
      name: "login",
      component: LoginView,
    },
    { path: "/admin/login", name: "admin-login", component: LoginView as Component },
    {
      path: "/",
      redirect: "/chat",
    },
    { path: "/query-runs", name: "query-runs", component: QueryRunsView, meta: { requiresAuth: true } },
    { path: "/chat", name: "chat", component: ChatView, meta: { requiresAuth: true } },
    { path: "/evaluations", name: "evaluations", component: () => import("@/views/EvaluationView.vue"), meta: { requiresAuth: true } },
    { path: "/llm", name: "llm", component: LlmView, meta: { requiresAuth: true } },
    { path: "/knowledge", name: "knowledge", component: KnowledgeView, meta: { requiresAuth: true } },
    { path: "/metrics", name: "metrics", component: MetricsView, meta: { requiresAuth: true } },
    { path: "/orgs", name: "orgs", component: OrgsView, meta: { requiresAuth: true } },
    { path: "/datasets", name: "datasets", component: DatasetsView, meta: { requiresAuth: true } },
  ],
})

router.beforeEach(async (to) => {
  const auth = useAuth()
  await auth.initializeAuth()
  const ssoToken = typeof to.query.token === "string" ? to.query.token : ""
  // 独立管理员入口不尝试统一认证，统一认证故障时仍能使用本地账号。
  if (ssoToken && to.name === "admin-login") {
    const cleanQuery = { ...to.query }
    delete cleanQuery.token
    return { name: "admin-login", query: cleanQuery }
  }
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
  if (["llm", "knowledge"].includes(String(to.name)) && auth.user.value?.role_code !== "SYSTEM_ADMIN") {
    return { name: "chat" }
  }
  if (["login", "admin-login"].includes(String(to.name)) && auth.isAuthenticated.value) {
    if (to.name === "admin-login" && auth.user.value?.role_code !== "SYSTEM_ADMIN") return
    return { path: to.name === "admin-login" ? "/llm" : "/chat" }
  }
})

export default router
