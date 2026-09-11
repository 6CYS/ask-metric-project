<script setup lang="ts">
import { Search, X } from "@lucide/vue"

import BaseAlert from "@/components/ui/BaseAlert.vue"
import BaseBadge from "@/components/ui/BaseBadge.vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import BaseSwitch from "@/components/ui/BaseSwitch.vue"
import LoadingSkeleton from "@/components/ui/LoadingSkeleton.vue"

withDefaults(defineProps<{
  title: string
  description: string
  badge?: string
  isLoading: boolean
  isEmpty: boolean
  blockingError?: string
  refreshError?: string
  errorTitle: string
  refreshErrorTitle: string
  showDisabled: boolean
  search?: string
  searchPlaceholder?: string
  searchLabel?: string
  searchHint?: string
  emptyTitle: string
  emptyDescription: string
}>(), { badge: "Catalog", blockingError: "", refreshError: "", search: undefined, searchPlaceholder: "", searchLabel: "搜索", searchHint: "" })

defineEmits<{
  "update:showDisabled": [value: boolean]
  "update:search": [value: string]
}>()
</script>

<template>
  <section class="rounded-lg border bg-card shadow-sm">
    <header class="flex flex-col gap-3 p-6 sm:flex-row sm:items-start sm:justify-between">
      <div><h2 class="font-semibold">{{ title }}</h2><p class="mt-1 text-sm text-muted-foreground">{{ description }}</p></div>
      <div class="flex shrink-0 flex-wrap items-center gap-3">
        <BaseSwitch :model-value="showDisabled" label="显示已停用" @update:model-value="$emit('update:showDisabled', $event)" />
        <BaseBadge variant="secondary">{{ badge }}</BaseBadge>
      </div>
    </header>
    <div class="px-6 pb-6">
      <BaseAlert v-if="blockingError" :title="errorTitle" variant="destructive"><template #icon><slot name="errorIcon" /></template>{{ blockingError }}</BaseAlert>
      <div v-else class="flex flex-col gap-3">
        <BaseAlert v-if="refreshError" :title="refreshErrorTitle" variant="destructive"><template #icon><slot name="refreshIcon" /></template>{{ refreshError }}</BaseAlert>
        <div v-if="search !== undefined" class="flex flex-col gap-2 rounded-lg border bg-muted/20 p-3 sm:flex-row sm:items-center sm:justify-between">
          <div class="relative w-full sm:max-w-md">
            <Search class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              :value="search"
              :placeholder="searchPlaceholder"
              :aria-label="searchLabel"
              class="h-9 w-full rounded-lg border bg-background pr-9 pl-8 text-sm outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-3 focus:ring-ring/30"
              @input="$emit('update:search', ($event.target as HTMLInputElement).value)"
            />
            <BaseButton v-if="search" variant="ghost" size="icon" class="absolute top-1/2 right-0.5 -translate-y-1/2" :aria-label="`清空${searchLabel}`" @click="$emit('update:search', '')"><X /></BaseButton>
          </div>
          <p class="text-xs text-muted-foreground">{{ searchHint }}</p>
        </div>
        <LoadingSkeleton v-if="isLoading" :rows="6" />
        <div v-else-if="isEmpty" class="flex min-h-80 flex-col items-center justify-center rounded-lg border px-6 text-center">
          <span class="mb-4 flex size-10 items-center justify-center rounded-lg bg-muted"><slot name="emptyIcon" /></span>
          <h3 class="text-sm font-semibold">{{ emptyTitle }}</h3>
          <p class="mt-1 max-w-md text-sm leading-6 text-muted-foreground">{{ emptyDescription }}</p>
          <slot name="empty" />
        </div>
        <slot v-else />
      </div>
    </div>
  </section>
</template>
