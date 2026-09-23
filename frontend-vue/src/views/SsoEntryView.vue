<script setup lang="ts">
import { onMounted, ref } from "vue"
import { getAuthConfig } from "@/lib/api"
import { consumeAuthFailureReason } from "@/lib/authSession"

const message = ref(consumeAuthFailureReason())
const portalUrl = ref("")
onMounted(async () => {
  try {
    const config = await getAuthConfig()
    const url = new URL(config.portal_url)
    if (["https:", "http:"].includes(url.protocol)) portalUrl.value = url.href
  } catch { /* 未配置平台地址或服务暂不可用时，仍提供明确的重新进入说明。 */ }
})
function retry() { window.location.replace("/chat") }
</script>

<template>
  <main class="flex min-h-screen items-center justify-center bg-background p-8">
    <section class="max-w-lg space-y-5 text-center">
      <h1 class="text-2xl font-semibold">请从数字农商平台进入问数</h1>
      <p v-if="message" role="alert" class="text-muted-foreground">{{ message }}</p>
      <p>登录已失效或尚未完成验证时，请返回数字农商平台，再次点击问数入口，无需输入问数账号密码。</p>
      <p class="text-sm text-muted-foreground">如果只是网络暂时中断，可以重试恢复当前会话。</p>
      <div class="flex justify-center gap-5">
        <a v-if="portalUrl" :href="portalUrl" class="underline">返回数字农商</a>
        <button type="button" class="underline" @click="retry">重试恢复会话</button>
      </div>
    </section>
  </main>
</template>
