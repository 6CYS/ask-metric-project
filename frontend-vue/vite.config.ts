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

  return {
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
        "/api": {
          target: env.VITE_BACKEND_NEXT_BASE_URL || "http://localhost:8010",
          // 保留浏览器 Host（含端口），使认证接口能够核对同源请求。
          changeOrigin: false,
        },
        // 仅开发环境代理到本机 agent-service；生产由 Nginx 同源代理 /agent-api。
        // 与 Nginx 的 proxy_pass 行为一致：剥离 /agent-api 前缀后再转发。
        "/agent-api": {
          target: env.VITE_AGENT_SERVICE_BASE_URL || "http://127.0.0.1:8020",
          changeOrigin: false,
          rewrite: (path) => path.replace(/^\/agent-api/, ""),
        },
      },
    },
  }
})
