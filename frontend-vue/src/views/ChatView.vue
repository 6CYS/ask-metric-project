<script setup lang="ts">
import { computed } from "vue"
import { useRoute } from "vue-router"

import AppShell from "@/components/AppShell.vue"
import BackendNextChatPanel from "@/components/chat/BackendNextChatPanel.vue"

const route = useRoute()

/** 首页带入的问题只预填输入框，不自动调用接口，避免页面跳转产生意外问数请求。 */
const initialMessage = computed(() => typeof route.query.q === "string" ? route.query.q : "")
</script>

<template>
  <AppShell full-bleed :content-padding="false" content-class-name="px-3 pb-3">
    <BackendNextChatPanel :initial-message="initialMessage" />
  </AppShell>
</template>
