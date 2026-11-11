<script setup lang="ts">
import { computed, ref } from "vue"
import { X } from "@lucide/vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import BaseTooltip from "@/components/ui/BaseTooltip.vue"
import EvaluationStatusBadge from "./EvaluationStatusBadge.vue"
import {
  cancellationUnconfirmed,
  evaluationDate,
  evaluationSummary,
  isActiveRun,
} from "@/lib/evaluation"
import type { EvaluationRun } from "@/types/evaluation"
const props = defineProps<{ runs: EvaluationRun[]; selectedId: string; busy: boolean }>()
const emit = defineEmits<{
  select: [id: string]
  cancel: [run: EvaluationRun]
  delete: [run: EvaluationRun]
}>()
const keyword = ref("")
const searchInput = ref<HTMLInputElement | null>(null)
const shown = computed(() =>
  props.runs.filter((run) =>
    `${run.name} ${run.version_label} ${run.dataset.name}`
      .toLocaleLowerCase()
      .includes(keyword.value.trim().toLocaleLowerCase()),
  ),
)

function clearSearch() {
  keyword.value = ""
  searchInput.value?.focus()
}

function handleSearchEscape(event: KeyboardEvent) {
  if (event.isComposing) return
  event.preventDefault()
  clearSearch()
}
</script>
<template>
  <section class="evaluation-panel" aria-label="测评批次列表" tabindex="-1">
    <header class="evaluation-panel-header">
      <div>
        <h2>测评批次</h2>
        <p>执行状态与业务复核分别记录；每次重跑生成新批次。</p>
      </div>
      <div class="relative w-full max-w-64">
        <input
          ref="searchInput"
          v-model="keyword"
          type="text"
          role="searchbox"
          class="form-control pr-9!"
          aria-label="搜索测评批次"
          placeholder="搜索批次、版本或问题集"
          @keydown.esc="handleSearchEscape"
        />
        <BaseTooltip v-if="keyword" content="清空搜索">
          <BaseButton
            variant="ghost"
            size="icon"
            class="absolute top-1/2 right-1 size-7 -translate-y-1/2 text-muted-foreground"
            aria-label="清空搜索"
            @click="clearSearch"
          >
            <X />
          </BaseButton>
        </BaseTooltip>
      </div>
    </header>
    <div v-if="!shown.length" class="evaluation-empty">
      <h3>{{ runs.length ? "没有匹配的批次" : "还没有测评批次" }}</h3>
      <p>{{ runs.length ? "请调整搜索条件。" : "先维护问题集，再使用当前配置发起一次测评。" }}</p>
    </div>
    <div v-else class="overflow-x-auto">
      <table class="evaluation-table min-w-[850px]">
        <thead>
          <tr>
            <th>批次 / 版本</th>
            <th>问题集</th>
            <th>执行状态</th>
            <th>业务复核</th>
            <th>发起时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="run in shown" :key="run.id" :class="{ selected: run.id === selectedId }">
            <td>
              <button
                type="button"
                class="evaluation-link font-medium text-left"
                @click="emit('select', run.id)"
              >
                {{ run.name }}
              </button>
              <p class="evaluation-note">{{ run.version_label || "未登记版本说明" }}</p>
            </td>
            <td>
              {{ run.dataset.name }}
              <p class="evaluation-note">v{{ run.dataset.version }} · {{ run.turns.length }} 轮</p>
            </td>
            <td>
              <EvaluationStatusBadge :status="run.status" batch />
              <p v-if="run.status !== 'deleting'" class="evaluation-note">
                {{ evaluationSummary(run).completed }}/{{ run.turns.length }} 轮执行完成
              </p>
            </td>
            <td>
              <p v-if="run.status === 'deleting'" class="evaluation-note">部分记录可能已清理</p>
              <template v-else
                ><p>
                  {{ evaluationSummary(run).passed }} 通过 ·
                  {{ evaluationSummary(run).failed }} 未通过
                </p>
                <p class="evaluation-note">{{ evaluationSummary(run).pendingReview }} 待复核</p>
              </template>
            </td>
            <td class="text-xs">{{ evaluationDate(run.created_at) }}</td>
            <td>
              <div class="flex gap-2">
                <BaseButton variant="ghost" size="sm" @click="emit('select', run.id)"
                  >查看</BaseButton
                ><BaseButton
                  v-if="isActiveRun(run)"
                  variant="destructive"
                  size="sm"
                  :disabled="busy || (run.status === 'cancelling' && !cancellationUnconfirmed(run))"
                  @click="emit('cancel', run)"
                  >{{
                    cancellationUnconfirmed(run)
                      ? "重新确认停止"
                      : run.status === "cancelling"
                        ? "停止中"
                        : "停止"
                  }}</BaseButton
                >
                <BaseButton
                  v-else
                  variant="ghost"
                  size="sm"
                  class="text-destructive"
                  :disabled="busy"
                  @click="emit('delete', run)"
                  >{{ run.status === "deleting" ? "继续删除" : "删除" }}</BaseButton
                >
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
