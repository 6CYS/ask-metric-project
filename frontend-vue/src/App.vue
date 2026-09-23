<script setup lang="ts">
import { RouterView } from "vue-router"
</script>

<template>
  <RouterView v-slot="{ Component, route }">
    <KeepAlive exclude="LoginView,SsoEntryView">
      <component :is="Component" :key="route.name" />
    </KeepAlive>
  </RouterView>
</template>
