<script setup lang="ts">
import { computed, onActivated, ref } from "vue"
import { Activity, AlertTriangle, BrainCircuit, Braces, CheckCircle2, Database, History, KeyRound, LoaderCircle, RefreshCw, RotateCcw, Save, ShieldCheck } from "@lucide/vue"

import AppShell from "@/components/AppShell.vue"
import PageHeader from "@/components/PageHeader.vue"
import BaseAlert from "@/components/ui/BaseAlert.vue"
import BaseBadge from "@/components/ui/BaseBadge.vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import BaseSwitch from "@/components/ui/BaseSwitch.vue"
import LoadingSkeleton from "@/components/ui/LoadingSkeleton.vue"
import {
  getSmartConfig,
  listPromptVersions,
  listSqlTemplates,
  listSqlTemplateVersions,
  rollbackPromptConfig,
  rollbackSqlTemplate,
  trialRunSqlTemplate,
  testSmartModel,
  updatePromptConfig,
  updateSmartModel,
  updateSqlTemplate,
  validateSqlTemplate,
} from "@/lib/api"
import type { ConfigVersion, ModelRole, ModelRuntimeConfig, PromptTemplateConfig, SmartConfigResponse, SqlTemplateConfig } from "@/types/api"

type Tab = "model" | "prompts" | "sql"
type PromptField = "system" | "user_template" | "query_prefix" | "query_template"

const activeTab = ref<Tab>("model")
const configResponse = ref<SmartConfigResponse | null>(null)
const modelDraft = ref<ModelRuntimeConfig | null>(null)
const sqlTemplates = ref<SqlTemplateConfig[]>([])
const selectedPromptName = ref("")
const promptDraft = ref<PromptTemplateConfig | null>(null)
const selectedSqlKey = ref("")
const sqlDraft = ref<SqlTemplateConfig | null>(null)
const sqlTrialParameters = ref("{}")
const sqlTrialResult = ref<Record<string, unknown>[] | null>(null)
const versions = ref<ConfigVersion[]>([])
const adminToken = ref("")
const apiKeys = ref<Record<ModelRole, string>>({ chat: "", embedding: "", reranker: "" })
const extraBodyDrafts = ref<Record<ModelRole, string>>({ chat: "{}", embedding: "{}", reranker: "{}" })
const isLoading = ref(true)
const isSaving = ref(false)
const isRefreshing = ref(false)
const testingRole = ref<ModelRole | null>(null)
const message = ref("")
const errorMessage = ref("")

const promptEntries = computed(() => Object.entries(configResponse.value?.prompts.prompts ?? {}))
const stats = computed(() => [
  { label: "Provider", value: configResponse.value?.config.provider ?? "--", detail: "当前模型服务提供方" },
  { label: "Chat 模型", value: configResponse.value?.config.models.chat.model ?? "--", detail: "语义解析与结果总结" },
  { label: "配置写入", value: configResponse.value?.write_enabled ? "已启用" : "只读", detail: "当前后端实例的运行时写入状态" },
])
const promptFields: Array<{ key: PromptField; label: string }> = [
  { key: "system", label: "系统提示词" },
  { key: "user_template", label: "用户提示词模板" },
  { key: "query_prefix", label: "检索前缀" },
  { key: "query_template", label: "查询模板" },
]
const modelRoles: Array<{ key: ModelRole; label: string; description: string }> = [
  { key: "chat", label: "Chat / 语义模型", description: "意图识别、语义结构化与结果总结" },
  { key: "embedding", label: "Embedding 模型", description: "指标和机构候选的向量召回，可独立停用" },
  { key: "reranker", label: "Reranker 模型", description: "对候选指标重新排序，可独立停用" },
]
const visiblePromptFields = computed(() => promptFields.filter((field) => promptDraft.value?.[field.key] != null))
const currentPromptVariables = computed(() => {
  const values = visiblePromptFields.value.flatMap(({ key }) => templateVariables(promptDraft.value?.[key] ?? ""))
  return [...new Set(values)].sort()
})
const canWrite = computed(() => Boolean(
  configResponse.value?.write_enabled
  && (!configResponse.value.write_token_required || adminToken.value.trim()),
))

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function templateVariables(value: string) {
  return [...value.matchAll(/(?<!\{)\{([a-zA-Z_][a-zA-Z0-9_]*)\}(?!\})/g)].map((item) => item[1])
}

function clearStatus() {
  message.value = ""
  errorMessage.value = ""
}

function setModelDraft(config: ModelRuntimeConfig) {
  modelDraft.value = clone(config)
  extraBodyDrafts.value = Object.fromEntries(
    modelRoles.map(({ key }) => [key, JSON.stringify(config.models[key].extra_body ?? {}, null, 2)]),
  ) as Record<ModelRole, string>
}

function applyExtraBodyDrafts() {
  if (!modelDraft.value) return
  for (const { key, label } of modelRoles) {
    let parsed: unknown
    try {
      parsed = JSON.parse(extraBodyDrafts.value[key])
    } catch {
      throw new Error(`${label}的附加请求参数不是有效 JSON。`)
    }
    if (parsed == null || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error(`${label}的附加请求参数必须是 JSON 对象。`)
    }
    modelDraft.value.models[key].extra_body = parsed as Record<string, unknown>
  }
}

async function loadAll(refresh = false) {
  if (refresh) isRefreshing.value = true
  else isLoading.value = true
  clearStatus()
  try {
    const [configResult, templatesResult] = await Promise.allSettled([getSmartConfig(), listSqlTemplates()])
    if (configResult.status === "rejected") throw configResult.reason
    const nextConfig = configResult.value
    configResponse.value = nextConfig
    setModelDraft(nextConfig.config)
    selectPrompt(selectedPromptName.value || Object.keys(nextConfig.prompts.prompts)[0] || "")
    if (templatesResult.status === "fulfilled") {
      const templates = templatesResult.value
      sqlTemplates.value = templates
      selectSql(selectedSqlKey.value || (templates[0] ? sqlKey(templates[0]) : ""))
    } else {
      sqlTemplates.value = []
      sqlDraft.value = null
      errorMessage.value = `模型配置已加载，但 SQL 模板加载失败：${templatesResult.reason instanceof Error ? templatesResult.reason.message : "未知错误"}`
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "配置加载失败。"
  } finally {
    isLoading.value = false
    isRefreshing.value = false
  }
}

function selectPrompt(name: string) {
  const value = configResponse.value?.prompts.prompts[name]
  if (!value) return
  selectedPromptName.value = name
  promptDraft.value = clone(value)
  versions.value = []
  clearStatus()
  void loadPromptHistory()
}

function sqlKey(item: SqlTemplateConfig) {
  return `${item.dialect}.${item.template}`
}

function selectSql(key: string) {
  const value = sqlTemplates.value.find((item) => sqlKey(item) === key)
  if (!value) return
  selectedSqlKey.value = key
  sqlDraft.value = clone(value)
  sqlTrialParameters.value = JSON.stringify(Object.fromEntries(value.parameters.map((name) => [name, null])), null, 2)
  sqlTrialResult.value = null
  versions.value = []
  clearStatus()
  void loadSqlHistory()
}

async function saveModel() {
  if (!modelDraft.value || !canWrite.value || isSaving.value) return
  isSaving.value = true
  clearStatus()
  try {
    applyExtraBodyDrafts()
    const changedKeys = Object.fromEntries(
      Object.entries(apiKeys.value).filter(([, value]) => value.trim()),
    ) as Partial<Record<ModelRole, string>>
    configResponse.value = await updateSmartModel(modelDraft.value, adminToken.value, changedKeys)
    setModelDraft(configResponse.value.config)
    apiKeys.value = { chat: "", embedding: "", reranker: "" }
    message.value = "模型配置已保存。"
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "模型配置保存失败。"
  } finally {
    isSaving.value = false
  }
}

async function testModel(role: ModelRole) {
  if (!modelDraft.value || !canWrite.value || testingRole.value) return
  testingRole.value = role
  clearStatus()
  try {
    applyExtraBodyDrafts()
    const changedKeys = Object.fromEntries(
      Object.entries(apiKeys.value).filter(([, value]) => value.trim()),
    ) as Partial<Record<ModelRole, string>>
    const result = await testSmartModel(role, adminToken.value, modelDraft.value, changedKeys)
    message.value = `${modelRoles.find((item) => item.key === role)?.label ?? role}连接成功：${result.summary}，耗时 ${result.duration_ms}ms。`
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "模型连接测试失败。"
  } finally {
    testingRole.value = null
  }
}

async function savePrompt() {
  if (!promptDraft.value || !selectedPromptName.value || !canWrite.value || isSaving.value) return
  isSaving.value = true
  clearStatus()
  try {
    const saved = await updatePromptConfig(selectedPromptName.value, promptDraft.value, adminToken.value)
    configResponse.value!.prompts.prompts[selectedPromptName.value] = saved
    promptDraft.value = clone(saved)
    message.value = "提示词已校验并发布，新版本已记录。"
    await loadPromptHistory()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "提示词发布失败。"
  } finally {
    isSaving.value = false
  }
}

async function saveSql() {
  if (!sqlDraft.value || !canWrite.value || isSaving.value) return
  isSaving.value = true
  clearStatus()
  try {
    const validation = await validateSqlTemplate(sqlDraft.value.sql)
    sqlDraft.value.parameters = validation.parameters
    const saved = await updateSqlTemplate(sqlDraft.value, adminToken.value)
    replaceSql(saved)
    message.value = "SQL 模板已通过只读校验并发布，新版本已记录。"
    await loadSqlHistory()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "SQL 模板发布失败。"
  } finally {
    isSaving.value = false
  }
}

async function checkSql() {
  if (!sqlDraft.value) return
  clearStatus()
  try {
    const result = await validateSqlTemplate(sqlDraft.value.sql)
    sqlDraft.value.parameters = result.parameters
    message.value = "SQL 只读安全校验通过。"
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "SQL 校验失败。"
  }
}

async function trialRunSql() {
  if (!sqlDraft.value || !canWrite.value || isSaving.value) return
  isSaving.value = true
  clearStatus()
  try {
    const parameters = JSON.parse(sqlTrialParameters.value) as Record<string, unknown>
    const result = await trialRunSqlTemplate(sqlDraft.value.sql, parameters, adminToken.value)
    sqlTrialResult.value = result.rows
    message.value = `试运行成功，返回 ${result.row_count} 行预览数据。`
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "SQL 试运行失败。"
  } finally {
    isSaving.value = false
  }
}

async function loadPromptHistory() {
  if (!selectedPromptName.value) return
  versions.value = await listPromptVersions(selectedPromptName.value)
}

async function loadSqlHistory() {
  if (!sqlDraft.value) return
  versions.value = await listSqlTemplateVersions(sqlDraft.value)
}

async function rollbackPrompt(version: ConfigVersion) {
  if (!canWrite.value || isSaving.value) return
  isSaving.value = true
  clearStatus()
  try {
    const restored = await rollbackPromptConfig(selectedPromptName.value, version.id, adminToken.value)
    configResponse.value!.prompts.prompts[selectedPromptName.value] = restored
    promptDraft.value = clone(restored)
    message.value = `已回滚到版本 v${version.version_number}，并生成新的回滚记录。`
    await loadPromptHistory()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "提示词回滚失败。"
  } finally {
    isSaving.value = false
  }
}

async function rollbackSql(version: ConfigVersion) {
  if (!sqlDraft.value || !canWrite.value || isSaving.value) return
  isSaving.value = true
  clearStatus()
  try {
    const restored = await rollbackSqlTemplate(sqlDraft.value, version.id, adminToken.value)
    replaceSql(restored)
    message.value = `已回滚到版本 v${version.version_number}，并生成新的回滚记录。`
    await loadSqlHistory()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "SQL 模板回滚失败。"
  } finally {
    isSaving.value = false
  }
}

function replaceSql(value: SqlTemplateConfig) {
  const index = sqlTemplates.value.findIndex((item) => sqlKey(item) === sqlKey(value))
  if (index >= 0) sqlTemplates.value[index] = value
  sqlDraft.value = clone(value)
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value))
}

// App.vue 会缓存管理页面；每次重新进入时都需要重新读取后端运行时状态，
// 否则后端重启或切换环境后仍会显示上一次的“只读”快照。
onActivated(() => loadAll())
</script>

<template>
  <AppShell>
    <PageHeader eyebrow="Runtime Configuration" title="智能配置" description="集中管理模型、业务提示词与只读 SQL 模板。配置发布前经过约束校验，并保留可审计、可回滚的版本记录。" :stats="stats">
      <template #actions><BaseButton variant="outline" :disabled="isRefreshing" @click="loadAll(true)"><RefreshCw :class="isRefreshing && 'animate-spin'" />刷新</BaseButton></template>
    </PageHeader>

    <div class="mb-5 flex flex-wrap items-center justify-between gap-3 border-b">
      <div class="flex gap-1" role="tablist">
        <button v-for="tab in [{ key: 'model', label: '模型配置', icon: BrainCircuit }, { key: 'prompts', label: '提示词配置', icon: Braces }, { key: 'sql', label: 'SQL 模板', icon: Database }]" :key="tab.key" type="button" class="flex h-10 items-center gap-2 border-b-2 px-3 text-sm font-medium" :class="activeTab === tab.key ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'" @click="activeTab = tab.key as Tab"><component :is="tab.icon" class="size-4" />{{ tab.label }}</button>
      </div>
      <label v-if="configResponse?.write_enabled && configResponse.write_token_required" class="mb-2 flex items-center gap-2 text-xs text-muted-foreground"><KeyRound class="size-4" />管理令牌<input v-model="adminToken" type="password" class="h-8 w-52 rounded-md border bg-background px-2 text-sm" placeholder="保存或回滚时必填" /></label>
      <BaseBadge v-else-if="configResponse?.write_enabled" variant="success" class="mb-2">本机管理员可直接写入</BaseBadge>
      <BaseBadge v-else variant="outline" class="mb-2">后端未启用配置写入</BaseBadge>
    </div>

    <BaseAlert v-if="errorMessage" class="mb-4" title="操作失败" variant="destructive"><template #icon><AlertTriangle /></template>{{ errorMessage }}</BaseAlert>
    <BaseAlert v-if="message" class="mb-4" title="操作成功"><template #icon><CheckCircle2 /></template>{{ message }}</BaseAlert>
    <BaseAlert v-if="configResponse && !configResponse.write_enabled" class="mb-4" title="配置当前为只读">请在后端启用 MODEL_ADMIN_WRITE_ENABLED；本机开发可同时设置 MODEL_ADMIN_TOKEN_REQUIRED=false，生产环境必须使用管理令牌。</BaseAlert>
    <LoadingSkeleton v-if="isLoading" :rows="6" row-class="h-14" />

    <section v-else-if="activeTab === 'model' && modelDraft" class="grid gap-5">
      <div class="grid gap-4 border-b pb-5 md:grid-cols-2">
        <label class="form-field">Provider 标识<input v-model="modelDraft.provider" class="form-control" placeholder="openai_compatible" /></label>
        <div class="flex items-end text-xs leading-5 text-muted-foreground">三个模型角色相互独立，可分别接入统一网关、底层模型服务或停用。密钥只写入外部环境文件，不保存到此配置。</div>
      </div>

      <article v-for="role in modelRoles" :key="role.key" class="grid gap-4 rounded-lg border p-5">
        <header class="flex flex-wrap items-start justify-between gap-3">
          <div><h2 class="font-semibold">{{ role.label }}</h2><p class="mt-1 text-xs text-muted-foreground">{{ role.description }}</p></div>
          <div class="flex items-center gap-3"><BaseButton variant="outline" size="sm" :disabled="!canWrite || !modelDraft.models[role.key].enabled || testingRole != null" @click="testModel(role.key)"><LoaderCircle v-if="testingRole === role.key" class="animate-spin" /><Activity v-else />连接测试</BaseButton><BaseBadge :variant="configResponse?.api_key_configured[role.key] ? 'success' : 'outline'">{{ modelDraft.models[role.key].authentication.type === 'none' ? '无需密钥' : (configResponse?.api_key_configured[role.key] ? '密钥已配置' : '密钥未配置') }}</BaseBadge><BaseSwitch v-model="modelDraft.models[role.key].enabled" label="启用" /></div>
        </header>
        <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <label class="form-field xl:col-span-2">Base URL<input v-model="modelDraft.models[role.key].base_url" class="form-control" placeholder="http://model-gateway.internal" /></label>
          <label class="form-field">接口路径<input v-model="modelDraft.models[role.key].path" class="form-control" placeholder="/v1/..." /></label>
          <label class="form-field">模型名称<input v-model="modelDraft.models[role.key].model" class="form-control" /></label>
          <BaseSwitch v-model="modelDraft.models[role.key].send_model" label="发送 model 字段" />
          <label class="form-field">鉴权方式<select v-model="modelDraft.models[role.key].authentication.type" class="form-control"><option value="none">无鉴权</option><option value="bearer">Bearer Token</option><option value="header">自定义请求头</option></select></label>
          <label class="form-field">鉴权请求头<input v-model="modelDraft.models[role.key].authentication.header" class="form-control" :disabled="modelDraft.models[role.key].authentication.type === 'none'" placeholder="accessKey" /></label>
          <label class="form-field">值前缀<input v-model="modelDraft.models[role.key].authentication.prefix" class="form-control" :disabled="modelDraft.models[role.key].authentication.type === 'none'" placeholder="Bearer " /></label>
          <label class="form-field">密钥环境变量<input v-model="modelDraft.models[role.key].api_key_env" class="form-control" :disabled="modelDraft.models[role.key].authentication.type === 'none'" placeholder="MODEL_CHAT_API_KEY" /></label>
          <label class="form-field">请求超时（秒）<input v-model.number="modelDraft.models[role.key].timeout_seconds" type="number" min="1" max="600" class="form-control" /></label>
          <label class="form-field md:col-span-2">API Key<span class="text-xs font-normal text-muted-foreground">连接测试会直接使用当前输入；点击“保存全部模型配置”后才会持久化。</span><input v-model="apiKeys[role.key]" type="password" class="form-control" :disabled="modelDraft.models[role.key].authentication.type === 'none'" :placeholder="configResponse?.api_key_configured[role.key] ? '留空则使用已保存密钥' : '输入 API Key'" /></label>
        </div>
        <div v-if="role.key === 'chat'" class="grid gap-4 border-t pt-4 md:grid-cols-4">
          <label class="form-field">Temperature<input v-model.number="modelDraft.models.chat.temperature" type="number" min="0" max="2" step="0.1" class="form-control" /></label>
          <label class="form-field">Max tokens<input v-model.number="modelDraft.models.chat.max_tokens" type="number" min="1" class="form-control" /></label>
          <label class="form-field">响应格式<select v-model="modelDraft.models.chat.response_format" class="form-control"><option value="json_object">JSON Object</option><option value="text">Text</option></select></label>
          <BaseSwitch v-model="modelDraft.models.chat.send_response_format" label="发送 response_format 参数" />
          <BaseSwitch v-model="modelDraft.models.chat.chat_template_kwargs.enable_thinking" label="Chat Template 深度思考" />
          <BaseSwitch v-model="modelDraft.models.chat.send_enable_thinking" label="兼容旧接口：发送顶层 enable_thinking" />
          <label class="form-field md:col-span-2">用户消息后缀<input v-model="modelDraft.models.chat.user_message_suffix" class="form-control" placeholder="例如：&#10;/no_think" /></label>
        </div>
        <div v-else-if="role.key === 'embedding'" class="grid gap-4 border-t pt-4 md:grid-cols-2">
          <label class="form-field">向量维度（可留空）<input v-model.number="modelDraft.models.embedding.dimensions" type="number" min="1" class="form-control" /></label>
          <label class="form-field">编码格式<select v-model="modelDraft.models.embedding.encoding_format" class="form-control"><option value="float">float</option><option value="base64">base64</option></select></label>
          <label class="form-field">User 字段（可留空）<input v-model="modelDraft.models.embedding.user" class="form-control" placeholder="user" /></label>
        </div>
        <div v-else class="grid gap-4 border-t pt-4 md:grid-cols-2">
          <label class="form-field">候选字段名<select v-model="modelDraft.models.reranker.documents_field" class="form-control"><option value="documents">documents</option><option value="texts">texts（行内 bge 接口）</option></select></label>
          <label class="form-field">Rerank Top N<input v-model.number="modelDraft.models.reranker.top_n" type="number" min="1" max="1000" class="form-control" /></label>
          <BaseSwitch v-model="modelDraft.models.reranker.send_top_n" label="发送 top_n 字段" />
          <BaseSwitch v-model="modelDraft.models.reranker.send_return_documents" label="发送 return_documents 字段" />
        </div>
        <label class="form-field border-t pt-4">附加请求参数（JSON）
          <span class="text-xs font-normal text-muted-foreground">用于 top_p、seed、frequency_penalty、stop、repetition_penalty 和厂商扩展字段；系统管理的核心字段不可覆盖。</span>
          <textarea v-model="extraBodyDrafts[role.key]" class="form-control min-h-28 resize-y py-2 font-mono text-xs leading-5" spellcheck="false" placeholder="{}" />
        </label>
      </article>
      <div class="flex items-center justify-between gap-3"><div class="flex gap-2 text-xs text-muted-foreground"><ShieldCheck class="size-4 shrink-0" />模型只参与语义解析和候选匹配，SQL 仍由受控模板生成并经过只读校验。</div><BaseButton :disabled="!canWrite || isSaving" @click="saveModel"><LoaderCircle v-if="isSaving" class="animate-spin" /><Save v-else />保存全部模型配置</BaseButton></div>
    </section>

    <section v-else-if="activeTab === 'prompts'" class="grid min-h-[560px] gap-5 lg:grid-cols-[260px_minmax(0,1fr)_300px]">
      <nav class="border-r pr-4">
        <button v-for="[name, prompt] in promptEntries" :key="name" type="button" class="mb-1 w-full border-l-2 px-3 py-2 text-left" :class="selectedPromptName === name ? 'border-primary bg-muted' : 'border-transparent hover:bg-muted/60'" @click="selectPrompt(name)"><span class="block text-sm font-medium">{{ prompt.display_name || name }}</span><span class="mt-1 block text-xs text-muted-foreground">{{ name }}</span></button>
      </nav>
      <div v-if="promptDraft" class="grid content-start gap-4">
        <div><div class="flex flex-wrap items-center gap-2"><h2 class="font-semibold">{{ promptDraft.display_name }}</h2><BaseBadge variant="outline">{{ promptDraft.version }}</BaseBadge></div><p class="mt-1 text-sm text-muted-foreground">{{ promptDraft.description }}</p></div>
        <BaseSwitch v-if="promptDraft.system != null || promptDraft.user_template != null" v-model="promptDraft.enable_thinking" label="开启该节点的深度思考" />
        <label v-for="field in visiblePromptFields" :key="field.key" class="form-field">{{ field.label }}
          <span v-if="!promptDraft.editable_fields.includes(field.key)" class="text-xs font-normal text-muted-foreground">核心约束，只读保护</span>
          <textarea v-model="promptDraft[field.key]" class="form-control min-h-40 resize-y py-2 font-mono text-xs leading-5" :disabled="!promptDraft.editable_fields.includes(field.key)" />
        </label>
        <div class="flex flex-wrap items-center justify-between gap-3 border-t pt-4"><div class="flex flex-wrap gap-1"><BaseBadge v-for="variable in currentPromptVariables" :key="variable" variant="secondary">{{ variable }}</BaseBadge></div><BaseButton :disabled="!canWrite || isSaving || !promptDraft.editable_fields.length" @click="savePrompt"><Save />校验并发布</BaseButton></div>
      </div>
      <aside class="border-l pl-4"><h2 class="flex items-center gap-2 text-sm font-semibold"><History class="size-4" />版本记录</h2><p v-if="!versions.length" class="mt-4 text-xs text-muted-foreground">首次发布时将自动保存系统基线。</p><div class="mt-3 grid gap-2"><div v-for="version in versions" :key="version.id" class="rounded-md border p-3 text-xs"><div class="flex items-center justify-between gap-2"><span class="font-medium">v{{ version.version_number }} · {{ version.action === 'rollback' ? '回滚' : '发布' }}</span><BaseButton variant="ghost" size="sm" :disabled="!canWrite || isSaving" @click="rollbackPrompt(version)"><RotateCcw />回滚</BaseButton></div><p class="mt-1 text-muted-foreground">{{ version.created_by }} · {{ formatDate(version.created_at) }}</p></div></div></aside>
    </section>

    <section v-else-if="activeTab === 'sql'" class="grid min-h-[560px] gap-5 lg:grid-cols-[280px_minmax(0,1fr)_300px]">
      <nav class="border-r pr-4"><button v-for="item in sqlTemplates" :key="sqlKey(item)" type="button" class="mb-1 w-full border-l-2 px-3 py-2 text-left" :class="selectedSqlKey === sqlKey(item) ? 'border-primary bg-muted' : 'border-transparent hover:bg-muted/60'" @click="selectSql(sqlKey(item))"><span class="block text-sm font-medium">{{ item.template }}</span><span class="mt-1 block text-xs text-muted-foreground">{{ item.dialect }} · {{ item.enabled ? '启用' : '停用' }}</span></button></nav>
      <div v-if="sqlDraft" class="grid content-start gap-4"><div class="flex flex-wrap items-center justify-between gap-3"><div><h2 class="font-semibold">{{ sqlDraft.template }}</h2><p class="text-sm text-muted-foreground">{{ sqlDraft.dialect }} 方言</p></div><BaseSwitch v-model="sqlDraft.enabled" label="启用模板" :disabled="!sqlDraft.editable" /></div><textarea v-model="sqlDraft.sql" class="form-control min-h-[330px] resize-y py-3 font-mono text-xs leading-5" spellcheck="false" :disabled="!sqlDraft.editable" /><div class="flex flex-wrap items-center justify-between gap-3"><div class="flex flex-wrap gap-1"><BaseBadge v-for="parameter in sqlDraft.parameters" :key="parameter" variant="secondary">:{{ parameter }}</BaseBadge></div><div class="flex gap-2"><BaseButton variant="outline" @click="checkSql"><ShieldCheck />安全校验</BaseButton><BaseButton variant="outline" :disabled="!canWrite || isSaving" @click="trialRunSql"><Database />试运行</BaseButton><BaseButton :disabled="!canWrite || isSaving || !sqlDraft.editable" @click="saveSql"><Save />校验并发布</BaseButton></div></div><label class="form-field">试运行参数（JSON）<textarea v-model="sqlTrialParameters" class="form-control min-h-28 resize-y py-2 font-mono text-xs" /></label><pre v-if="sqlTrialResult" class="max-h-48 overflow-auto rounded-md border bg-muted p-3 text-xs">{{ JSON.stringify(sqlTrialResult, null, 2) }}</pre></div>
      <aside class="border-l pl-4"><h2 class="flex items-center gap-2 text-sm font-semibold"><History class="size-4" />版本记录</h2><p class="mt-2 text-xs leading-5 text-muted-foreground">发布前强制执行只读校验，禁止 DDL 和数据写操作。</p><div class="mt-3 grid gap-2"><div v-for="version in versions" :key="version.id" class="rounded-md border p-3 text-xs"><div class="flex items-center justify-between gap-2"><span class="font-medium">v{{ version.version_number }} · {{ version.action === 'rollback' ? '回滚' : '发布' }}</span><BaseButton variant="ghost" size="sm" :disabled="!canWrite || isSaving" @click="rollbackSql(version)"><RotateCcw />回滚</BaseButton></div><p class="mt-1 text-muted-foreground">{{ version.created_by }} · {{ formatDate(version.created_at) }}</p></div></div></aside>
    </section>
  </AppShell>
</template>
