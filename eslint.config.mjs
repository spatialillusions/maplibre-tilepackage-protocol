import globals from "globals";
import pluginJs from "@eslint/js";

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    rules: {
      semi: "error",
      "no-var": "error",
      "prefer-const": "error",
    },
    languageOptions: {
      ecmaVersion: 2017,
      sourceType: "module",
      globals: globals.browser,
    },
    plugins: {
      prettier: {
        "prettier/prettier": "error",
        //"linebreak-style": ["error", "windows"],
        "no-console": ["error", { allow: ["info", "warn", "error"] }],
        "no-unused-vars": ["error", { vars: "all", args: "none" }],
        semi: ["error", "always"],
      },
    },
  },
  pluginJs.configs.recommended,
];
