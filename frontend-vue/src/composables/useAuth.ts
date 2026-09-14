import { computed, readonly, ref } from "vue"

import { ApiError, getCurrentUser, loginUser, logoutUser, restoreBrowserSession, ssoLoginUser } from "@/lib/api"
import {
  clearAccessToken,
  hasAccessToken,
  setAccessToken,
  setAuthFailureReason,
} from "@/lib/authSession"
import type { AuthUser } from "@/types/api"

const user = ref<AuthUser | null>(null)
const initialized = ref(false)
let initialization: Promise<void> | null = null
let authRevision = 0

function clearAuth() {
  authRevision += 1
  clearAccessToken()
  user.value = null
}

async function initializeAuth() {
  if (initialized.value) return
  if (!initialization) {
    const revision = authRevision
    initialization = (async () => {
      try {
        if (hasAccessToken()) {
          const restoredUser = await getCurrentUser()
          if (revision === authRevision) user.value = restoredUser
        } else {
          const session = await restoreBrowserSession()
          // 初始化期间发生退出或新登录时，不让旧响应恢复之前的账号。
          if (revision === authRevision) {
            setAccessToken(session.access_token)
            user.value = session.user
          }
        }
      } catch (error) {
        if (revision !== authRevision) return
        if (!(error instanceof ApiError && error.status === 401)) {
          setAuthFailureReason("恢复登录状态暂时失败，请稍后刷新重试。")
        }
        // 只清理页面内存；网络故障不删除仍有效的服务端恢复凭据。
        clearAuth()
      } finally {
        initialized.value = true
      }
    })()
  }
  await initialization
}

async function login(username: string, password: string) {
  const revision = ++authRevision
  const result = await loginUser(username, password)
  if (revision !== authRevision) return result.user
  setAccessToken(result.access_token)
  user.value = result.user
  initialized.value = true
  return result.user
}

async function loginWithSso(token: string) {
  const revision = ++authRevision
  const result = await ssoLoginUser(token)
  if (revision !== authRevision) return result.user
  setAccessToken(result.access_token)
  user.value = result.user
  initialized.value = true
  return result.user
}

async function logout() {
  const revision = ++authRevision
  try {
    await logoutUser()
  } catch (error) {
    // 401 表示会话已失效；断网或服务故障时不能假装服务端已撤销登录。
    if (!(error instanceof ApiError && error.status === 401)) throw error
  }
  if (revision === authRevision) clearAuth()
}

async function validateSession() {
  if (!hasAccessToken()) return false
  const revision = authRevision
  try {
    const currentUser = await getCurrentUser()
    if (revision !== authRevision) return false
    user.value = currentUser
    return true
  } catch (error) {
    if (revision === authRevision && error instanceof ApiError && error.status === 401) clearAuth()
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
