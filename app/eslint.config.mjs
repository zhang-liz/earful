// Run from the top of the repo. See .github/workflows/weekly-check.yml.
import js from "@eslint/js";
import html from "eslint-plugin-html";
import globals from "globals";

export default [
  js.configs.recommended,
  { files: ["**/*.html"], plugins: { html } },
  {
    languageOptions: { sourceType: "script" },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-unused-vars": ["error", { caughtErrors: "none" }],
    },
  },
  {
    files: ["app/**", "extension/**"],
    languageOptions: { globals: { ...globals.browser, ...globals.webextensions } },
  },
  {
    files: ["editor-extension/**"],
    languageOptions: { globals: globals.node },
  },
];
