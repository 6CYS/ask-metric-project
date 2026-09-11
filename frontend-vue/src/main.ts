import { createApp } from "vue"

import App from "@/App.vue"
import router from "@/router"
import "@/styles/main.css"
import { useAuth } from "@/composables/useAuth"

const auth = useAuth()
const validateVisibleSession = () => {
  if (document.visibilityState === "visible" && auth.isAuthenticated.value) void auth.validateSession()
}
window.addEventListener("focus", validateVisibleSession)
document.addEventListener("visibilitychange", validateVisibleSession)
window.addEventListener("ask-metric:auth-invalid", () => {
  auth.clearAuth()
  if (router.currentRoute.value.name !== "login") {
    void router.replace({ name: "login", query: { redirect: router.currentRoute.value.fullPath } })
  }
})

createApp(App).use(router).mount("#app")
