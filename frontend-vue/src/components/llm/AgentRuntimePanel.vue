<script setup lang="ts">
import { onMounted, ref } from "vue"
import BaseAlert from "@/components/ui/BaseAlert.vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import BaseNumberField from "@/components/ui/BaseNumberField.vue"
import { getAgentRuntime, updateAgentRuntime } from "@/lib/api"
import type { AgentRuntimeSnapshot } from "@/types/api"

const props = defineProps<{ canWrite: boolean; adminToken: string }>()
const snapshot = ref<AgentRuntimeSnapshot | null>(null)
const loading = ref(false)
const saving = ref(false)
const error = ref("")
const message = ref("")

async function load() {
  loading.value = true
  error.value = ""
  try {
    snapshot.value = await getAgentRuntime()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "问数模型配置读取失败。"
  } finally {
    loading.value = false
  }
}

async function save() {
  if (!snapshot.value || !props.canWrite || saving.value) return
  saving.value = true
  error.value = ""
  message.value = ""
  try {
    snapshot.value = await updateAgentRuntime(
      snapshot.value.document,
      snapshot.value.revision,
      props.adminToken,
    )
    message.value = "已保存到共享应用库，将用于新的问数轮次。"
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "问数模型配置保存失败。"
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<template>
  <section class="space-y-5 rounded-lg border p-5">
    <header class="flex items-center justify-between gap-3">
      <div>
        <h2 class="font-semibold">问数 Agent 模型</h2>
        <p class="mt-1 text-sm text-muted-foreground">
          各实例共用应用库中的配置。模型未配置时仍可管理系统，问数将提示补齐参数。
        </p>
      </div>
      <BaseButton variant="outline" :disabled="loading || saving" @click="load">刷新</BaseButton>
    </header>
    <BaseAlert v-if="error" title="操作未完成" variant="destructive">{{ error }}</BaseAlert>
    <BaseAlert v-if="message" title="保存成功">{{ message }}</BaseAlert>
    <p v-if="loading" class="text-sm text-muted-foreground">正在读取模型配置…</p>
    <form v-if="snapshot" class="space-y-5" @submit.prevent="save">
      <fieldset :disabled="!canWrite || saving" class="grid gap-4 md:grid-cols-2">
        <label class="form-field"
          >模型服务地址<input
            v-model="snapshot.document.model.baseUrl"
            class="form-control"
            placeholder="请输入模型服务的基础地址"
        /></label>
        <label class="form-field"
          >模型名称<input
            v-model="snapshot.document.model.name"
            class="form-control"
            placeholder="请输入实际模型名称"
        /></label>
        <label class="form-field"
          >认证头名称<input v-model="snapshot.document.model.authHeader" class="form-control"
        /></label>
        <label class="form-field"
          >认证前缀<input
            v-model="snapshot.document.model.authPrefix"
            class="form-control"
            placeholder="无前缀时留空"
        /></label>
        <label class="form-field"
          >上下文窗口<BaseNumberField v-model="snapshot.document.model.contextWindow" :min="1"
        /></label>
        <label class="form-field"
          >最大输出预算<BaseNumberField v-model="snapshot.document.model.maxTokens" :min="1"
        /></label>
      </fieldset>
      <p class="text-xs leading-5 text-muted-foreground">
        认证密钥继续使用部署时的安全配置，此处不展示密钥。保存地址和名称不会改变已有密钥。
      </p>
      <BaseButton type="submit" :disabled="!canWrite || saving">{{
        saving ? "正在保存…" : "保存问数模型配置"
      }}</BaseButton>
    </form>
  </section>
</template>
