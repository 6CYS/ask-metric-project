<script setup lang="ts">
import { LogOut, PanelLeftClose, PanelLeftOpen, UserRound } from "@lucide/vue"
import { RouterLink, useRoute } from "vue-router"

import BaseButton from "@/components/ui/BaseButton.vue"
import { useSidebarPreference } from "@/composables/useSidebarPreference"
import { navigationItems } from "@/config/navigation"
import { useAuth } from "@/composables/useAuth"
import { resolveOrganizationBranding } from "@/config/organizationBranding"
import BaseBadge from "@/components/ui/BaseBadge.vue"
import { computed } from "vue"
import { useRouter } from "vue-router"

/**
 * AppShell 同时服务普通内容页和后续问数全屏页。
 * fullBleed 开启后移除内容最大宽度与背景光晕，供聊天等需要占满空间的页面使用。
 */
withDefaults(
  defineProps<{
    fullBleed?: boolean
    contentClassName?: string
    contentPadding?: boolean
  }>(),
  {
    fullBleed: false,
    contentClassName: "",
    contentPadding: true,
  },
)

const route = useRoute()
const router = useRouter()
const auth = useAuth()
const branding = computed(() => resolveOrganizationBranding(auth.user.value?.org_code ?? "", auth.user.value?.org_name ?? ""))
const visibleNavigationItems = computed(() => navigationItems.filter((item) => !item.adminOnly || auth.user.value?.role_code === "SYSTEM_ADMIN"))
const { isSidebarCollapsed, toggleSidebarCollapsed } = useSidebarPreference()

/** 子路由也应高亮所属的一级导航，例如 /metrics/123 仍属于指标术语。 */
function isNavigationActive(href: string) {
  return route.path === href || route.path.startsWith(`${href}/`)
}

async function handleLogout() {
  await auth.logout()
  await router.replace("/login")
}
</script>

<template>
  <div class="flex h-full min-h-0 overflow-hidden bg-background text-foreground">
    <!-- 桌面端侧边栏：宽度、留白、边框和动画与原 Next.js 版本逐项对齐。 -->
    <aside
      class="hidden shrink-0 flex-col border-r border-sidebar-border bg-sidebar transition-[width] duration-200 ease-out lg:flex"
      :class="isSidebarCollapsed ? 'w-20' : 'w-64'"
    >
      <div class="border-b border-sidebar-border py-5" :class="isSidebarCollapsed ? 'px-3' : 'px-5'">
        <div class="flex items-center" :class="isSidebarCollapsed ? 'justify-center' : 'justify-between gap-3'">
          <!-- 折叠后悬停或键盘聚焦品牌标识，显示展开按钮。 -->
          <div v-if="isSidebarCollapsed" class="group/brand relative size-10">
            <span
              aria-hidden="true"
              class="absolute inset-0 flex items-center justify-center rounded-lg border bg-background text-sm font-semibold shadow-sm transition-opacity group-hover/brand:opacity-0 group-focus-within/brand:opacity-0"
            >
              AM
            </span>
            <BaseButton
              variant="ghost"
              size="icon"
              class="absolute inset-0 opacity-0 transition-opacity group-hover/brand:opacity-100 group-focus-within/brand:opacity-100"
              aria-label="展开侧边栏"
              :aria-pressed="isSidebarCollapsed"
              @click="toggleSidebarCollapsed"
            >
              <PanelLeftOpen />
            </BaseButton>
          </div>

          <template v-else>
            <RouterLink to="/chat" class="group flex min-w-0 items-center gap-3" aria-label="进入指标问数">
              <span class="flex size-10 items-center justify-center rounded-lg border bg-background text-sm font-semibold shadow-sm">AM</span>
              <span class="min-w-0">
                <span class="block text-base leading-5 font-semibold">Ask Metric</span>
                <span class="block text-xs text-muted-foreground">指标问数工作台</span>
              </span>
            </RouterLink>
            <BaseButton
              variant="ghost"
              size="icon"
              class="text-muted-foreground hover:text-foreground"
              aria-label="折叠侧边栏"
              :aria-pressed="isSidebarCollapsed"
              @click="toggleSidebarCollapsed"
            >
              <PanelLeftClose />
            </BaseButton>
          </template>
        </div>
      </div>

      <!-- 桌面导航使用真实路由状态，不再依赖数组下标模拟选中项。 -->
      <nav class="flex flex-1 flex-col gap-1 p-3" :class="isSidebarCollapsed && 'items-center'" aria-label="主导航">
        <RouterLink
          v-for="item in visibleNavigationItems"
          :key="item.href"
          :to="item.href"
          class="group/nav relative flex items-center rounded-lg text-sm transition-colors"
          :class="[
            isSidebarCollapsed ? 'w-14 flex-col justify-center gap-1 px-1 py-2' : 'w-full gap-3 px-3 py-2.5',
            isNavigationActive(item.href)
              ? 'bg-primary text-primary-foreground shadow-sm'
              : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
          ]"
          :aria-label="isSidebarCollapsed ? item.label : undefined"
          :aria-current="isNavigationActive(item.href) ? 'page' : undefined"
        >
          <component :is="item.icon" class="size-4 shrink-0" />
          <span class="min-w-0" :class="isSidebarCollapsed && 'w-full'">
            <span
              class="block font-medium leading-5"
              :class="isSidebarCollapsed && 'truncate text-center text-[11px] leading-4'"
            >
              {{ item.label }}
            </span>
            <span
              class="block truncate text-xs"
              :class="[
                isSidebarCollapsed && 'hidden',
                isNavigationActive(item.href) ? 'text-primary-foreground/70' : 'text-muted-foreground',
              ]"
            >
              {{ item.description }}
            </span>
          </span>
        </RouterLink>
      </nav>

      <div class="border-t border-sidebar-border p-3">
        <button v-if="isSidebarCollapsed" type="button" class="mx-auto flex size-11 items-center justify-center rounded-lg border bg-background text-muted-foreground hover:text-foreground" :title="`${branding.shortName} · ${auth.user.value?.display_name}`" aria-label="退出登录" @click="handleLogout">
          <UserRound class="size-5" />
        </button>
        <div v-else class="rounded-lg border bg-background p-3">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <BaseBadge variant="secondary">{{ branding.badgeText }}</BaseBadge>
              <p class="mt-2 truncate text-xs font-medium">{{ branding.shortName }}</p>
              <p class="mt-1 truncate text-xs text-muted-foreground">{{ auth.user.value?.display_name }}</p>
              <p class="mt-0.5 text-[11px] text-muted-foreground">{{ auth.user.value?.role_code === 'SYSTEM_ADMIN' ? '系统管理员' : '普通用户' }}</p>
            </div>
            <BaseButton variant="ghost" size="icon" class="size-8 shrink-0" aria-label="退出登录" title="退出登录" @click="handleLogout"><LogOut /></BaseButton>
          </div>
        </div>
      </div>
    </aside>

    <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
      <!-- lg 断点以下切换为原版紧凑顶部导航，当前路由同样提供选中反馈。 -->
      <header class="shrink-0 border-b bg-background/95 lg:hidden">
        <div class="flex items-center justify-between gap-3 px-4 py-3">
          <RouterLink to="/" class="font-semibold">Ask Metric</RouterLink>
          <div class="ml-auto flex items-center gap-2">
            <BaseBadge variant="secondary">{{ branding.badgeText }}</BaseBadge>
            <BaseButton variant="ghost" size="icon" aria-label="退出登录" @click="handleLogout"><LogOut /></BaseButton>
          </div>
          <nav class="flex items-center gap-1" aria-label="移动端导航">
            <RouterLink
              v-for="item in visibleNavigationItems"
              :key="item.href"
              :to="item.href"
              class="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors"
              :class="isNavigationActive(item.href) && 'bg-primary text-primary-foreground'"
              :title="item.label"
              :aria-current="isNavigationActive(item.href) ? 'page' : undefined"
            >
              <component :is="item.icon" class="size-4" />
              <span class="sr-only">{{ item.label }}</span>
            </RouterLink>
          </nav>
        </div>
      </header>

      <!-- 页面内容独立滚动，保证侧边栏和移动端顶部导航固定在应用框架内。 -->
      <main
        class="min-h-0 flex-1 overflow-y-auto"
        :class="fullBleed ? 'flex' : 'app-workspace-bg'"
      >
        <div
          class="min-h-0 w-full"
          :class="[
            fullBleed
              ? ['flex flex-1 flex-col', contentPadding && 'p-3']
              : 'mx-auto flex max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8 lg:py-8',
            contentClassName,
          ]"
        >
          <slot />
        </div>
      </main>
    </div>
  </div>
</template>
