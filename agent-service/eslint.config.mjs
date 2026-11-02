import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import prettier from "eslint-config-prettier/flat";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["**/node_modules/**", "**/dist/**", "**/coverage/**"] },
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      eqeqeq: ["error", "always"],
      "no-eval": "error",
      "no-var": "error",
      "prefer-const": "error",
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // void 只丢弃返回值，不能替代对拒绝结果的处理。
      "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: false }],
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
  {
    files: ["scripts/tool-governance/browser.js"],
    languageOptions: { globals: globals.browser },
  },
  prettier,
);
