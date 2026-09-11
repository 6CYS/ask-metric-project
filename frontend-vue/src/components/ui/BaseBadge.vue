<script setup lang="ts">
withDefaults(
  defineProps<{
    variant?: "default" | "secondary" | "outline" | "success" | "warning" | "destructive"
  }>(),
  { variant: "default" },
)

const variantClasses = {
  default: "border-transparent bg-primary text-primary-foreground",
  secondary: "border-transparent bg-secondary text-secondary-foreground",
  outline: "border-border bg-background text-foreground",
  success: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300",
  warning: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300",
  destructive: "border-destructive/20 bg-destructive/10 text-destructive",
}
</script>

<template>
  <span
    class="inline-flex h-5 items-center rounded-md border px-1.5 text-xs font-medium whitespace-nowrap"
    :class="variantClasses[variant]"
  >
    <slot />
  </span>
</template>
