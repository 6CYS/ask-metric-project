<script setup lang="ts">
defineProps<{
  eyebrow: string
  title: string
  description: string
  stats?: Array<{ label: string; value: string; detail?: string }>
}>()
</script>

<template>
  <section class="grid gap-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
    <div class="max-w-3xl">
      <p class="text-xs font-medium tracking-[0.18em] text-muted-foreground uppercase">{{ eyebrow }}</p>
      <h1 class="mt-3 text-3xl leading-tight font-semibold text-foreground">{{ title }}</h1>
      <p class="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">{{ description }}</p>
    </div>
    <div v-if="$slots.actions" class="flex items-center justify-start gap-2 lg:justify-end">
      <slot name="actions" />
    </div>
  </section>

  <section v-if="stats?.length" class="grid gap-3 sm:grid-cols-3">
    <!--
      Next.js 的 CardTitle 虽传入 text-2xl，但 size="sm" 的 group-data 规则优先级更高，
      浏览器最终计算为 text-sm。这里按最终渲染值对齐，避免数字撑高统计卡片。
    -->
    <article v-for="stat in stats" :key="stat.label" class="flex flex-col gap-3 overflow-hidden rounded-xl bg-card/80 py-3 text-sm ring-1 ring-foreground/10">
      <div class="grid gap-1 px-3">
        <p class="text-sm text-muted-foreground">{{ stat.label }}</p>
        <h2 class="text-sm leading-snug font-medium">{{ stat.value }}</h2>
      </div>
      <p v-if="stat.detail" class="px-3 text-xs leading-5 text-muted-foreground">{{ stat.detail }}</p>
    </article>
  </section>
</template>
