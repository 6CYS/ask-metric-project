import { computed, readonly, ref } from "vue"

import { getCurrentUser, loginUser, logoutUser, ssoLoginUser } from "@/lib/api"
import {
  clearAccessToken,
  hasAccessToken,
  setAccessToken,
} from "@/lib/authSession"
import type { AuthUser } from "@/types/api"

const user = ref<AuthUser | null>(null)
const initialized = ref(false)
let initialization: Promise<void> | null = null

function clearAuth() {
  clearAccessToken()
  user.value = null
}

async function initializeAuth() {
  if (initialized.value) return
  if (!initialization) {
    initialization = (async () => {
      if (hasAccessToken()) {
        try {
          user.value = await getCurrentUser()
        } catch {
          clearAuth()
        }
      }
      initialized.value = true
    })()
  }
  await initialization
}

async function login(username: string, password: string) {
  const result = await loginUser(username, password)
  setAccessToken(result.access_token)
  user.value = result.user
  initialized.value = true
  return result.user
}

async function loginWithSso(token: string) {
  const result = await ssoLoginUser(token)
  setAccessToken(result.access_token)
  user.value = result.user
  initialized.value = true
  return result.user
}

async function logout() {
  try {
    if (hasAccessToken()) await logoutUser()
  } finally {
    clearAuth()
  }
}

async function validateSession() {
  if (!hasAccessToken()) return false
  try {
    user.value = await getCurrentUser()
    return true
  } catch {
    clearAuth()
    return false
  }
}

export function useAuth() {
  return {
    user: readonly(user),
    initialized: readonly(initialized),
    isAuthenticated: computed(() => Boolean(user.value && hasAccessToken())),
    login,
    loginWithSso,
    logout,
    clearAuth,
    initializeAuth,
    validateSession,
  }
}
