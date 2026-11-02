<script setup lang="ts">
withDefaults(defineProps<{ title: string; variant?: "default" | "destructive" }>(), { variant: "default" })
</script>

<template>
  <div
    role="alert"
    class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg border p-4 text-sm"
    :class="variant === 'destructive' ? 'border-destructive/40 text-destructive' : 'bg-card text-foreground'"
  >
    <div class="row-span-2 pt-0.5 [&_svg]:size-4"><slot name="icon" /></div>
    <p class="font-medium">{{ title }}</p>
    <div class="min-w-0 break-words text-sm leading-5 opacity-90"><slot /></div>
  </div>
</template>
