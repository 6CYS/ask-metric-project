import { fileURLToPath, URL } from "node:url"

import tailwindcss from "@tailwindcss/vite"
import type { Plugin } from "postcss"
import vue from "@vitejs/plugin-vue"
import { defineConfig, loadEnv } from "vite"

function chrome83CssCompatibility(): Plugin {
  return {
    postcssPlugin: "chrome83-css-compatibility",
    OnceExit(root) {
      root.walkAtRules("layer", (atRule) => {
        if (atRule.nodes) {
          atRule.replaceWith(...atRule.nodes)
        } else {
          atRule.remove()
        }
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "")
  // 页面和接口可以使用不同前缀，但都只能是本站路径；禁止把凭据发往构建时的外部地址。
  function basePath(value: string | undefined): string {
    const path = value?.trim() || "/"
    if (!/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]*$/.test(path)) {
      throw new Error("部署前缀必须为以 / 开头的本站路径，不能包含域名、查询参数或相对路径")
    }
    return path.endsWith("/") ? path : `${path}/`
  }
  const appBase = basePath(env.VITE_APP_BASE_PATH)
  const apiBase = basePath(env.VITE_API_BASE_PATH).replace(/\/$/, "")

  return {
    base: appBase,
    define: {
      "import.meta.env.VITE_API_BASE_PATH": JSON.stringify(apiBase),
    },
    plugins: [vue(), tailwindcss()],
    css: {
      postcss: {
        plugins: [chrome83CssCompatibility()],
      },
    },
    build: {
      target: "chrome83",
    },
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    server: {
      port: 5173,
      proxy: {
        [`${apiBase}/api`]: {
          target: env.VITE_BACKEND_NEXT_BASE_URL || "http://localhost:8010",
          // 保留浏览器 Host（含端口），使认证接口能够核对同源请求。
          changeOrigin: false,
          rewrite: (path) => path.slice(apiBase.length),
          cookiePathRewrite: { "/api/v1/auth": `${apiBase}/api/v1/auth` },
        },
      },
    },
  }
})
