import js from "@eslint/js"
import { defineConfig } from "eslint/config"
import prettier from "eslint-config-prettier/flat"
import vue from "eslint-plugin-vue"
import globals from "globals"
import tseslint from "typescript-eslint"

export default defineConfig(
  { ignores: ["**/node_modules/**", "**/dist/**", "**/coverage/**"] },
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx,vue}"],
    extends: [js.configs.recommended],
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      eqeqeq: ["error", "always"],
      "no-eval": "error",
      "no-var": "error",
      "prefer-const": "error",
    },
  },
  {
    files: ["**/*.{ts,tsx,vue}"],
    extends: [tseslint.configs.recommendedTypeChecked, vue.configs["flat/essential"]],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        parser: tseslint.parser,
        project: ["./tsconfig.app.json", "./tsconfig.node.json", "./tsconfig.specs.json"],
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: [".vue"],
      },
    },
    rules: {
      // void 只丢弃返回值，不能替代对拒绝结果的处理。
      "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: false }],
      "@typescript-eslint/no-misused-promises": "error",
      "vue/no-lifecycle-after-await": "error",
      "vue/no-watch-after-await": "error",
    },
  },
  {
    files: ["vite.config.ts", "*.mjs", "*.cjs"],
    languageOptions: { globals: globals.node },
  },
  prettier,
)
