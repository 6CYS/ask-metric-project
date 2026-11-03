<script setup lang="ts">
import { computed, nextTick, ref, useId } from "vue"
import { ArrowDown, ArrowUp, Download, FileUp, Plus, Save, Trash2 } from "@lucide/vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import BaseBadge from "@/components/ui/BaseBadge.vue"
import BaseAlert from "@/components/ui/BaseAlert.vue"
import BaseDisclosure from "@/components/ui/BaseDisclosure.vue"
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue"
import {
  createEvaluationId,
  datasetTurnCount,
  downloadDataset,
  evaluationDate,
  parseDatasetInput,
} from "@/lib/evaluation"
import type { DatasetInput, EvaluationDataset, EvaluationGroup } from "@/types/evaluation"

const props = defineProps<{ datasets: EvaluationDataset[]; busy: boolean }>()
const emit = defineEmits<{
  save: [input: DatasetInput, existing?: EvaluationDataset]
  run: [dataset: EvaluationDataset]
}>()
const selected = ref<EvaluationDataset | undefined>()
const draft = ref<DatasetInput | null>(null)
const dirty = ref(false)
const error = ref("")
const errorId = useId()
const editorForm = ref<HTMLFormElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
type PendingAction =
  | { kind: "open"; dataset?: EvaluationDataset }
  | { kind: "import"; file: File }
  | { kind: "remove-group"; groupId: string }
const pendingAction = ref<PendingAction | null>(null)
const importing = ref(false)
const editorBusy = computed(() => props.busy || importing.value)
const totalTurns = computed(() => (draft.value ? datasetTurnCount(draft.value) : 0))
const newGroup = (): EvaluationGroup => ({
  id: createEvaluationId(),
  name: "新会话",
  turns: [{ id: createEvaluationId(), question: "", expected: "" }],
})
function open(dataset?: EvaluationDataset) {
  if (editorBusy.value || pendingAction.value) return
  if (dirty.value) {
    error.value = ""
    pendingAction.value = { kind: "open", dataset }
    return
  }
  applyOpen(dataset)
}
function applyOpen(dataset?: EvaluationDataset) {
  selected.value = dataset
  draft.value = dataset
    ? parseDatasetInput(dataset)
    : { name: "", description: "", groups: [newGroup()] }
  dirty.value = false
  error.value = ""
}
async function save() {
  if (!draft.value || editorBusy.value) return
  try {
    if (draft.value.name.length > 120) throw new Error("问题集名称不能超过 120 字。")
    emit("save", parseDatasetInput(draft.value), selected.value)
    error.value = ""
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "问题集格式不正确"
    await nextTick()
    editorForm.value?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
  }
}
function saved(dataset: EvaluationDataset) {
  selected.value = dataset
  draft.value = parseDatasetInput(dataset)
  dirty.value = false
}
defineExpose({ saved, isDirty: () => dirty.value })
function addTurn(group: EvaluationGroup) {
  group.turns.push({ id: createEvaluationId(), question: "", expected: "" })
  dirty.value = true
}
function addGroup() {
  draft.value?.groups.push(newGroup())
  dirty.value = true
}
function removeTurn(group: EvaluationGroup, index: number) {
  group.turns.splice(index, 1)
  dirty.value = true
}
function removeGroup(index: number) {
  const group = draft.value?.groups[index]
  if (!group || editorBusy.value || pendingAction.value) return
  error.value = ""
  pendingAction.value = { kind: "remove-group", groupId: group.id }
}
function closeConfirmation() {
  if (!editorBusy.value) pendingAction.value = null
}
async function confirmAction() {
  const action = pendingAction.value
  if (!action || editorBusy.value) return
  if (action.kind === "import") {
    if (await importFile(action.file)) pendingAction.value = null
    return
  }
  pendingAction.value = null
  if (action.kind === "open") applyOpen(action.dataset)
  else {
    const index = draft.value?.groups.findIndex((group) => group.id === action.groupId) ?? -1
    if (index < 0 || !draft.value) return
    draft.value.groups.splice(index, 1)
    dirty.value = true
  }
}
function move<T>(items: T[], index: number, direction: number) {
  const target = index + direction
  if (target < 0 || target >= items.length) return
  const [item] = items.splice(index, 1)
  if (item !== undefined) items.splice(target, 0, item)
  dirty.value = true
}
async function importFile(file: File) {
  if (editorBusy.value) return false
  importing.value = true
  error.value = ""
  try {
    if (file.size > 2 * 1024 * 1024) throw new Error("JSON 文件不能超过 2 MB。")
    const imported = parseDatasetInput(await file.text())
    draft.value = imported
    selected.value = undefined
    dirty.value = true
    return true
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "导入失败"
    return false
  } finally {
    importing.value = false
  }
}
function handleImport(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ""
  if (!file || editorBusy.value || pendingAction.value) return
  error.value = ""
  if (dirty.value) pendingAction.value = { kind: "import", file }
  else
    importFile(file).catch((reason) => {
      error.value = reason instanceof Error ? reason.message : "导入失败"
    })
}
</script>

<template>
  <section class="min-w-0">
    <input
      ref="fileInput"
      type="file"
      accept=".json,application/json"
      class="sr-only"
      aria-label="导入问题集 JSON"
      @change="handleImport"
    />
    <BaseAlert v-if="error" :id="errorId" title="请检查问题集" variant="destructive" class="mb-4">{{
      error
    }}</BaseAlert>
    <div class="evaluation-dataset-layout">
      <aside class="evaluation-dataset-list" aria-label="问题集列表">
        <header class="evaluation-dataset-list-header">
          <div class="flex items-center justify-between gap-2">
            <h2 class="text-sm font-semibold">问题集</h2>
            <BaseButton variant="outline" size="sm" :disabled="editorBusy" @click="open()"
              ><Plus />新建问题集</BaseButton
            >
          </div>
          <p class="field-help">一组为连续会话，组内按顺序追问。</p>
        </header>
        <p v-if="!datasets.length" class="p-5 text-sm leading-6 text-muted-foreground">
          暂无问题集。新建或导入已有业务题集后即可发起测评。
        </p>
        <button
          v-for="dataset in datasets"
          :key="dataset.id"
          type="button"
          class="evaluation-dataset-item"
          :class="{ selected: selected?.id === dataset.id }"
          :aria-current="selected?.id === dataset.id ? 'true' : undefined"
          :disabled="editorBusy"
          @click="open(dataset)"
        >
          <strong>{{ dataset.name }}</strong
          ><span
            >{{ dataset.groups.length }} 组 · {{ datasetTurnCount(dataset) }} 轮 · v{{
              dataset.version
            }}</span
          ><small>{{ evaluationDate(dataset.updated_at) }}</small>
        </button>
        <div class="border-t p-3">
          <BaseButton variant="ghost" size="sm" :disabled="editorBusy" @click="fileInput?.click()"
            ><FileUp />导入 JSON</BaseButton
          >
        </div>
      </aside>
      <div v-if="draft" class="evaluation-panel evaluation-dataset-editor" @input="dirty = true">
        <form ref="editorForm" class="space-y-4" novalidate @submit.prevent="save">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="flex items-center gap-2">
              <h3>{{ selected ? "编辑问题集" : "新建问题集" }}</h3>
              <BaseBadge variant="outline">{{ totalTurns }}/100 轮</BaseBadge
              ><span v-if="dirty" class="text-xs text-amber-700">未保存</span>
            </div>
            <div class="flex gap-2">
              <BaseButton variant="ghost" :disabled="editorBusy" @click="downloadDataset(draft)"
                ><Download />导出 JSON</BaseButton
              ><BaseButton type="submit" :disabled="editorBusy"
                ><Save />{{ busy ? "保存中…" : "保存问题集" }}</BaseButton
              >
            </div>
          </div>
          <div class="grid gap-3">
            <label class="form-field"
              >问题集名称<input
                v-model="draft.name"
                class="form-control"
                maxlength="120"
                :aria-invalid="Boolean(error && (!draft.name.trim() || draft.name.length > 120))"
                :aria-describedby="error ? errorId : undefined"
                required
                :disabled="editorBusy" /></label
            ><label class="form-field"
              >说明<textarea
                v-model="draft.description"
                class="form-control resize-y py-2 leading-6"
                rows="2"
                maxlength="2000"
                :aria-invalid="Boolean(error && draft.description.length > 2000)"
                :aria-describedby="error ? errorId : undefined"
                :disabled="editorBusy"
              />
            </label>
          </div>
          <p class="field-help">
            人工期望仅供复核；保存会生成新版本，已有批次保留原题目与期望。每个问题集最多 100 轮。
          </p>
          <article
            v-for="(group, groupIndex) in draft.groups"
            :key="group.id"
            class="evaluation-group"
          >
            <header class="flex items-center gap-2 rounded-lg bg-muted/50 p-2">
              <span class="shrink-0 text-xs text-muted-foreground">会话 {{ groupIndex + 1 }}</span
              ><input
                v-model="group.name"
                class="form-control min-w-0 flex-1"
                :aria-label="`会话${groupIndex + 1}名称`"
                :aria-invalid="Boolean(error && !group.name.trim())"
                :aria-describedby="error ? errorId : undefined"
                required
                :disabled="editorBusy"
              />
              <BaseButton
                variant="ghost"
                size="icon"
                :disabled="editorBusy || groupIndex === 0"
                aria-label="上移会话"
                @click="move(draft.groups, groupIndex, -1)"
                ><ArrowUp /></BaseButton
              ><BaseButton
                variant="ghost"
                size="icon"
                :disabled="editorBusy || groupIndex === draft.groups.length - 1"
                aria-label="下移会话"
                @click="move(draft.groups, groupIndex, 1)"
                ><ArrowDown /></BaseButton
              ><BaseButton
                variant="ghost"
                size="icon"
                class="text-destructive"
                :disabled="editorBusy"
                aria-label="移除会话"
                @click="removeGroup(groupIndex)"
                ><Trash2
              /></BaseButton>
            </header>
            <div
              v-for="(turn, turnIndex) in group.turns"
              :key="turn.id"
              class="evaluation-turn-editor"
            >
              <div class="flex items-center justify-between gap-2">
                <strong class="text-xs"
                  >第 {{ turnIndex + 1 }} 轮{{
                    turnIndex ? " · 依赖前文" : " · 新会话首问"
                  }}</strong
                >
                <div class="flex gap-1">
                  <BaseButton
                    variant="ghost"
                    size="icon"
                    :disabled="editorBusy || turnIndex === 0"
                    aria-label="上移问题"
                    @click="move(group.turns, turnIndex, -1)"
                    ><ArrowUp /></BaseButton
                  ><BaseButton
                    variant="ghost"
                    size="icon"
                    :disabled="editorBusy || turnIndex === group.turns.length - 1"
                    aria-label="下移问题"
                    @click="move(group.turns, turnIndex, 1)"
                    ><ArrowDown /></BaseButton
                  ><BaseButton
                    variant="ghost"
                    size="icon"
                    :disabled="editorBusy"
                    aria-label="移除问题"
                    @click="removeTurn(group, turnIndex)"
                    ><Trash2
                  /></BaseButton>
                </div>
              </div>
              <label class="form-field"
                >问题<textarea
                  v-model="turn.question"
                  class="form-control resize-y py-2 leading-6"
                  rows="2"
                  :aria-invalid="Boolean(error && !turn.question.trim())"
                  :aria-describedby="error ? errorId : undefined"
                  required
                  :disabled="editorBusy"
                />
              </label>
              <label class="form-field"
                >人工期望（可留空）<textarea
                  v-model="turn.expected"
                  class="form-control resize-y py-2 leading-6"
                  rows="2"
                  :disabled="editorBusy"
                  placeholder="需要核对的机构、期间、来源、数值或回答要点"
                />
              </label>
              <BaseDisclosure class="text-xs text-muted-foreground" content-class="mt-2 break-all">
                <template #trigger>稳定身份</template>
                <p>会话 {{ group.id }} · 轮次 {{ turn.id }}</p>
              </BaseDisclosure>
            </div>
            <BaseButton
              variant="ghost"
              class="m-3"
              :disabled="editorBusy || totalTurns >= 100"
              @click="addTurn(group)"
              ><Plus />添加追问</BaseButton
            >
          </article>
          <div class="flex items-center justify-between gap-3">
            <BaseButton
              variant="outline"
              :disabled="editorBusy || totalTurns >= 100"
              @click="addGroup"
              ><Plus />添加会话</BaseButton
            ><BaseButton
              v-if="selected"
              variant="outline"
              :disabled="editorBusy || dirty"
              @click="emit('run', selected)"
              >用已保存版本发起测评</BaseButton
            >
          </div>
        </form>
      </div>
      <div v-else class="evaluation-panel evaluation-empty">
        <h3>维护可重复验证的问题集</h3>
        <p>从左侧选择已有问题集，或新建一组真实业务问题，按业务目标填写首问、追问与人工期望。</p>
      </div>
    </div>
    <ConfirmDialog
      :open="Boolean(pendingAction)"
      :title="pendingAction?.kind === 'remove-group' ? '移除会话' : '放弃未保存修改'"
      :confirm-label="pendingAction?.kind === 'remove-group' ? '确认移除' : '放弃修改'"
      busy-label="正在导入…"
      :busy="editorBusy"
      @update:open="closeConfirmation"
      @confirm="confirmAction"
    >
      <p>
        {{
          pendingAction?.kind === "remove-group"
            ? "移除这个会话及其全部问题？保存后才会生效。"
            : "当前问题集有未保存修改，确认放弃修改？"
        }}
      </p>
      <BaseAlert v-if="error" title="导入未完成" variant="destructive" class="mt-3">{{
        error
      }}</BaseAlert>
    </ConfirmDialog>
  </section>
</template>
