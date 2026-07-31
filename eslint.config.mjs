import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/coverage/**",
      "spikes/*/captures/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Provider adapters must never console.log upstream payloads; use the
      // observability logger, which redacts.
      "no-console": ["error", { allow: ["error"] }],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSNonNullExpression",
          message: "Avoid non-null assertions outside of index math; narrow explicitly.",
        },
      ],
    },
  },
  {
    // CLI entrypoints and spikes legitimately print to stdout.
    files: ["**/cli/**/*.ts", "spikes/**/*.ts", "**/scripts/**/*.ts"],
    rules: { "no-console": "off" },
  },
  {
    files: ["**/test/**/*.ts", "**/*.test.ts"],
    rules: {
      "no-restricted-syntax": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "no-console": "off",
    },
  },
  {
    // Index math in ids.ts/decoders relies on bounds already proven by loop guards.
    files: ["packages/shared/src/ids.ts", "packages/provider-kiro/src/**/*.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
);
