<script setup lang="ts">
import { computed } from "vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import BaseDisclosure from "@/components/ui/BaseDisclosure.vue"
import BaseBadge from "@/components/ui/BaseBadge.vue"
import EvaluationStatusBadge from "./EvaluationStatusBadge.vue"
import {
  cancellationUnconfirmed,
  evaluationDate,
  evaluationSummary,
  isActiveRun,
  reviewLabel,
  turnDuration,
} from "@/lib/evaluation"
import type { EvaluationRun } from "@/types/evaluation"
const props = defineProps<{ run: EvaluationRun; selectedTurnId: string; busy: boolean }>()
const emit = defineEmits<{ select: [id: string]; cancel: []; rerun: [] }>()
const summary = computed(() => evaluationSummary(props.run))
function turnNumber(groupId: string, turnId: string) {
  return (
    (props.run.dataset.groups
      .find((group) => group.id === groupId)
      ?.turns.findIndex((turn) => turn.id === turnId) ?? -1) + 1
  )
}
function groupName(id: string) {
  return props.run.dataset.groups.find((group) => group.id === id)?.name || id
}
</script>
<template>
  <section class="evaluation-panel">
    <header class="evaluation-panel-header">
      <div>
        <div class="flex items-center gap-3">
          <h2>{{ run.name }}</h2>
          <EvaluationStatusBadge :status="run.status" batch />
        </div>
        <p>
          {{ run.dataset.name }} · 冻结 v{{ run.dataset.version }} ·
          {{ run.version_label || "未登记版本说明" }}
        </p>
      </div>
      <div class="flex gap-2">
        <BaseButton variant="outline" :disabled="busy" @click="emit('rerun')"
          >新建批次重跑</BaseButton
        ><BaseButton
          v-if="isActiveRun(run)"
          variant="destructive"
          :disabled="busy || (run.status === 'cancelling' && !cancellationUnconfirmed(run))"
          @click="emit('cancel')"
          >{{
            cancellationUnconfirmed(run)
              ? "重新确认停止"
              : run.status === "cancelling"
                ? "停止中…"
                : "停止测评"
          }}</BaseButton
        >
      </div>
    </header>
    <p v-if="cancellationUnconfirmed(run)" class="evaluation-note px-5 py-3" role="status">
      尚未确认当前操作已停止，暂不能发起新的测评。请重新确认停止。
    </p>
    <div class="evaluation-stat-grid">
      <div>
        <span>执行完成</span><strong>{{ summary.completed }} / {{ summary.total }}</strong>
      </div>
      <div>
        <span>业务通过</span><strong>{{ summary.passed }}</strong>
      </div>
      <div>
        <span>业务未通过</span><strong>{{ summary.failed }}</strong>
      </div>
      <div>
        <span>待复核</span><strong>{{ summary.pendingReview }}</strong>
      </div>
      <div>
        <span>执行失败</span><strong>{{ summary.executionFailed }}</strong>
      </div>
    </div>
    <BaseDisclosure class="border-y bg-muted/20 px-5 py-3 text-xs" trigger-class="text-muted-foreground">
      <template #trigger>查看实际模型、配置与数据条件</template>
      <dl class="evaluation-metadata mt-3">
        <div>
          <dt>实际模型</dt>
          <dd>{{ run.model || "服务未记录" }}</dd>
        </div>
        <div>
          <dt>运行配置摘要</dt>
          <dd>{{ run.config_hash }}</dd>
        </div>
        <div>
          <dt>问题集内容摘要</dt>
          <dd>{{ run.dataset_hash }}</dd>
        </div>
        <div>
          <dt>数据条件（人工登记）</dt>
          <dd>{{ run.data_label || "未登记；不代表数据环境相同" }}</dd>
        </div>
        <div>
          <dt>发起人</dt>
          <dd>{{ run.actor.name }} · {{ run.actor.org_code }}</dd>
        </div>
        <div>
          <dt>时间</dt>
          <dd>{{ evaluationDate(run.created_at) }} → {{ evaluationDate(run.finished_at) }}</dd>
        </div>
      </dl>
    </BaseDisclosure>
    <p class="evaluation-note px-5 py-3">
      执行完成仅表示本轮执行结束。通过数只计入执行完成且人工判定通过的轮次。
    </p>
    <div class="overflow-x-auto">
      <table class="evaluation-table min-w-[650px]">
        <thead>
          <tr>
            <th>会话 / 轮次</th>
            <th>原始问题</th>
            <th>执行</th>
            <th>业务复核</th>
            <th>实际耗时</th>
            <th>详情</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="turn in run.turns"
            :key="turn.id"
            :class="{ selected: selectedTurnId === turn.id }"
          >
            <td class="text-xs">
              {{ groupName(turn.group_id) }}
              <p class="evaluation-note">组内第 {{ turnNumber(turn.group_id, turn.id) }} 轮</p>
            </td>
            <td class="max-w-sm whitespace-pre-wrap break-words">{{ turn.question }}</td>
            <td><EvaluationStatusBadge :status="turn.status" /></td>
            <td>
              <BaseBadge
                :variant="
                  turn.status === 'completed' && turn.review?.verdict === 'passed'
                    ? 'success'
                    : turn.review?.verdict === 'failed'
                      ? 'destructive'
                      : 'outline'
                "
                >{{ reviewLabel(turn) }}</BaseBadge
              >
            </td>
            <td class="whitespace-nowrap text-xs">{{ turnDuration(turn) }}</td>
            <td>
              <BaseButton variant="ghost" size="sm" @click="emit('select', turn.id)"
                >查看并复核</BaseButton
              >
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
