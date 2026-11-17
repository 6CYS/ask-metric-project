<script setup lang="ts">
import { Eye, EyeOff, LockKeyhole, ShieldCheck } from "@lucide/vue"
import { computed, onMounted, ref } from "vue"
import { useRoute, useRouter } from "vue-router"

import BaseAlert from "@/components/ui/BaseAlert.vue"
import BaseBadge from "@/components/ui/BaseBadge.vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import { useAuth } from "@/composables/useAuth"
import { consumeAuthFailureReason } from "@/lib/authSession"
import { getLoginOptions } from "@/lib/api"

const route = useRoute()
const router = useRouter()
const { login } = useAuth()
const username = ref("")
const password = ref("")
const showPassword = ref(false)
const loading = ref(false)
const error = ref(consumeAuthFailureReason())
const administrator = computed(() => route.name === "admin-login")
const ssoEnabled = ref(true)
const optionsLoaded = ref(false)
const showPasswordLogin = computed(() => administrator.value || (optionsLoaded.value && !ssoEnabled.value))
const redirect = computed(() => {
  const target = route.query.redirect
  return typeof target === "string" && target.startsWith("/") && !target.startsWith("//")
    ? target : administrator.value ? "/llm" : "/chat"
})

async function loadOptions() {
  try {
    ssoEnabled.value = (await getLoginOptions()).sso_enabled
    optionsLoaded.value = true
  } catch {
    if (!administrator.value) error.value = "登录方式暂时无法读取，请刷新重试；管理员可使用独立入口。"
  }
}

onMounted(loadOptions)

async function submit() {
  if (!username.value.trim() || !password.value || loading.value) return
  loading.value = true
  error.value = ""
  try {
    await login(username.value.trim(), password.value, administrator.value)
    await router.replace(redirect.value)
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "登录失败，请检查账号和密码。"
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <main class="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#f4f7fa] px-4 py-10">
    <div aria-hidden="true" class="absolute inset-0 opacity-60 [background-image:linear-gradient(#dce4ec_1px,transparent_1px),linear-gradient(90deg,#dce4ec_1px,transparent_1px)] [background-size:32px_32px] [mask-image:radial-gradient(circle_at_center,black,transparent_72%)]" />
    <section class="relative grid w-full max-w-4xl overflow-hidden rounded-xl border border-[#d7e0e9] bg-white shadow-[0_18px_60px_rgba(32,52,73,0.10)] md:grid-cols-[1.05fr_0.95fr]">
      <div class="hidden border-r border-[#e2e8ef] bg-[#f8fafc] p-10 md:flex md:flex-col md:justify-between">
        <div>
          <BaseBadge variant="secondary" class="mb-6">安全数据工作台</BaseBadge>
          <h1 class="text-3xl font-semibold tracking-tight text-[#1f3448]">驾驶舱智能问数</h1>
          <p class="mt-4 max-w-sm text-sm leading-7 text-[#647587]">统一指标口径，安全查询经营数据。系统将根据账号所属机构自动控制数据访问范围。</p>
        </div>
        <div class="mt-12 space-y-4 text-sm text-[#526779]">
          <div class="flex items-center gap-3"><ShieldCheck class="size-5 text-[#547793]" />可信身份与机构权限校验</div>
          <div class="flex items-center gap-3"><LockKeyhole class="size-5 text-[#547793]" />单账号单一有效登录会话</div>
        </div>
      </div>
      <div class="p-6 sm:p-10">
        <div class="mb-8 md:hidden">
          <BaseBadge variant="secondary" class="mb-4">驾驶舱智能问数</BaseBadge>
        </div>
        <h2 class="text-2xl font-semibold text-[#203548]">{{ administrator ? "管理员登录" : "用户登录" }}</h2>
        <p class="mt-2 text-sm text-muted-foreground">{{ administrator ? "使用系统管理员账号和密码维护系统" : "通过数字农商进入智能问数，按机构权限访问数据" }}</p>
        <BaseAlert v-if="error" class="mt-5" title="无法登录" variant="destructive">{{ error }}</BaseAlert>
        <form v-if="showPasswordLogin" class="mt-7 space-y-5" @submit.prevent="submit">
          <label class="form-field">用户名
            <input v-model="username" class="form-control h-11" autocomplete="username" autofocus placeholder="请输入用户名">
          </label>
          <label class="form-field">密码
            <span class="relative block">
              <input v-model="password" class="form-control h-11 pr-11" :type="showPassword ? 'text' : 'password'" autocomplete="current-password" placeholder="请输入密码">
              <button type="button" class="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-muted-foreground hover:text-foreground" :aria-label="showPassword ? '隐藏密码' : '显示密码'" @click="showPassword = !showPassword">
                <EyeOff v-if="showPassword" class="size-4" /><Eye v-else class="size-4" />
              </button>
            </span>
          </label>
          <BaseButton class="h-11 w-full" type="submit" :disabled="loading || !username.trim() || !password">
            {{ loading ? "正在安全验证..." : "登录" }}
          </BaseButton>
        </form>
        <p v-else class="mt-7 rounded-lg border bg-muted/30 p-4 text-sm leading-7 text-muted-foreground">
          {{ optionsLoaded ? "请从数字农商工作台打开智能问数，系统将自动验证您的登录身份。" : "正在读取登录方式…" }}
        </p>
        <RouterLink :to="administrator ? '/login' : '/admin/login'" class="mt-6 block text-center text-sm text-primary underline-offset-4 hover:underline">
          {{ administrator ? "返回用户入口" : "管理员入口" }}
        </RouterLink>
        <p class="mt-6 text-center text-xs leading-5 text-muted-foreground">机构权限由系统管理员配置，登录页面不提供机构选择。</p>
      </div>
    </section>
  </main>
</template>
