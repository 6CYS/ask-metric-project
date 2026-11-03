<script setup lang="ts">
import BaseTooltip from "@/components/ui/BaseTooltip.vue"
import { computed, ref, watch } from "vue"
import { ChevronLeft, ChevronRight } from "@lucide/vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import { metricNeighborhood } from "@/lib/metricRelationships"
import type { MetricItem } from "@/types/api"
import type { MetricRelation } from "@/types/metricRelationships"

const props = defineProps<{
  selected: string
  metrics: MetricItem[]
  relations: MetricRelation[]
  showRetired: boolean
}>()
defineEmits<{ select: [code: string] }>()
const groupSize = 4
const parentPage = ref(1)
const childPage = ref(1)
const byCode = computed(() => new Map(props.metrics.map((metric) => [metric.metric_code, metric])))
const neighborhood = computed(() =>
  metricNeighborhood(props.selected, props.relations, props.showRetired),
)
const relationDirections = {
  classification: { parent: "所属分类", child: "下级分类" },
  composition: { parent: "所属总量", child: "组成分项" },
  ratio: { parent: "参与的占比", child: "分子与分母" },
}

function columnLabel(side: "parent" | "child") {
  const kinds = new Set(
    neighborhood.value.relations
      .filter((relation) => (relation.parent === props.selected) === (side === "child"))
      .map((relation) => relation.kind),
  )
  return [...kinds].map((kind) => relationDirections[kind][side]).join(" · ") || "相关指标"
}

const columns = computed(() =>
  [
    {
      key: "parent",
      label: columnLabel("parent"),
      items: neighborhood.value.parents,
      page: parentPage.value,
    },
    {
      key: "child",
      label: columnLabel("child"),
      items: neighborhood.value.children,
      page: childPage.value,
    },
  ].map((column) => ({
    ...column,
    pages: Math.max(1, Math.ceil(column.items.length / groupSize)),
    visible: column.items.slice((column.page - 1) * groupSize, column.page * groupSize),
  })),
)
const name = (code: string) => byCode.value.get(code)?.metric_name || code

function changePage(key: string, page: number) {
  if (key === "parent") parentPage.value = page
  else childPage.value = page
}

watch(
  () => props.selected,
  () => {
    parentPage.value = 1
    childPage.value = 1
  },
)
watch(neighborhood, ({ parents, children }) => {
  parentPage.value = Math.min(parentPage.value, Math.max(1, Math.ceil(parents.length / groupSize)))
  childPage.value = Math.min(childPage.value, Math.max(1, Math.ceil(children.length / groupSize)))
})
</script>

<template>
  <div
    class="relationship-graph grid min-w-0 grid-cols-[minmax(0,1fr)_var(--connection-width)_minmax(0,1.1fr)_var(--connection-width)_minmax(0,1fr)] items-center gap-y-2 rounded-lg bg-muted/30 px-4 py-5"
    aria-label="指标关系图谱"
  >
    <template v-for="column in columns" :key="column.key">
      <p
        class="row-start-1 text-center text-xs text-muted-foreground"
        :class="column.key === 'parent' ? 'col-start-1' : 'col-start-5'"
      >
        {{ column.label }}
        <span v-if="column.items.length" class="ml-1 tabular-nums">{{ column.items.length }}</span>
      </p>
      <ul
        v-if="column.items.length"
        class="row-start-2 min-w-0"
        :class="
          column.key === 'parent' ? 'graph-parents col-start-1' : 'graph-children col-start-5'
        "
        :aria-label="column.label"
      >
        <li v-for="node in column.visible" :key="node.code" class="graph-neighbor relative py-1.5">
          <BaseTooltip :content="`${name(node.code)} · ${node.code}`"
            ><button
              type="button"
              :data-metric-node="node.code"
              class="relative grid min-h-20 w-full min-w-0 content-center gap-2 rounded-lg border bg-card px-3 py-3 text-center transition-colors hover:border-foreground/30 hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              @click="$emit('select', node.code)"
            >
              <span class="line-clamp-2 break-words text-sm leading-5">{{ name(node.code) }}</span>
              <span class="text-xs text-muted-foreground">{{ node.labels.join(" · ") }}</span>
            </button></BaseTooltip
          >
        </li>
      </ul>
      <p
        v-else
        class="row-start-2 py-5 text-center text-xs text-muted-foreground"
        :class="column.key === 'parent' ? 'col-start-1' : 'col-start-5'"
      >
        暂无关联指标
      </p>
      <div
        v-if="column.pages > 1"
        class="row-start-3 flex flex-wrap items-center justify-center gap-1 text-xs text-muted-foreground"
        :class="column.key === 'parent' ? 'col-start-1' : 'col-start-5'"
      >
        <BaseButton
          size="icon"
          variant="ghost"
          class="size-7"
          :disabled="column.page <= 1"
          :aria-label="`上一组${column.label}`"
          @click="changePage(column.key, column.page - 1)"
          ><ChevronLeft
        /></BaseButton>
        <span>{{ column.page }} / {{ column.pages }} · 共 {{ column.items.length }}</span>
        <BaseButton
          size="icon"
          variant="ghost"
          class="size-7"
          :disabled="column.page >= column.pages"
          :aria-label="`下一组${column.label}`"
          @click="changePage(column.key, column.page + 1)"
          ><ChevronRight
        /></BaseButton>
      </div>
    </template>
    <div
      v-if="neighborhood.parents.length"
      class="col-start-2 row-start-2 h-px w-1/2 justify-self-end bg-foreground/20"
      aria-hidden="true"
    />
    <BaseTooltip :content="`${name(selected)} · ${selected}`"
      ><div
        tabindex="0"
        :data-metric-node="selected"
        class="col-start-3 row-start-2 grid min-h-24 min-w-0 content-center gap-2 rounded-lg border border-foreground/25 bg-accent px-3 py-4 text-center"
      >
        <span class="text-xs text-muted-foreground">当前指标</span>
        <span class="break-words text-sm font-medium">{{ name(selected) }}</span>
      </div></BaseTooltip
    >
    <div
      v-if="neighborhood.children.length"
      class="col-start-4 row-start-2 h-px w-1/2 bg-foreground/20"
      aria-hidden="true"
    />
  </div>
</template>

<style scoped>
.relationship-graph {
  --connection-width: 2rem;
  --branch-width: calc(var(--connection-width) / 2);
}

/* 连线随节点实际高度伸展，首尾止于节点中心，避免长名称换行后错位。 */
.graph-neighbor::before,
.graph-neighbor::after {
  position: absolute;
  pointer-events: none;
  content: "";
  border-color: color-mix(in srgb, var(--foreground) 20%, transparent);
}

.graph-neighbor::before {
  top: 50%;
  width: var(--branch-width);
  border-top-width: 1px;
}

.graph-neighbor::after {
  top: 0;
  bottom: 0;
  border-left-width: 1px;
}

.graph-parents .graph-neighbor::before,
.graph-parents .graph-neighbor::after {
  right: calc(-1 * var(--branch-width));
}

.graph-children .graph-neighbor::before,
.graph-children .graph-neighbor::after {
  left: calc(-1 * var(--branch-width));
}

.graph-neighbor:first-child::after {
  top: 50%;
}

.graph-neighbor:last-child::after {
  bottom: 50%;
}
</style>
