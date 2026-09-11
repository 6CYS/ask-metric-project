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
          changeOrigin: true,
        },
      },
    },
  }
})
