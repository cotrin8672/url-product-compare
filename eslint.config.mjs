import js from "@eslint/js";
import next from "@next/eslint-plugin-next";
import formatterConflicts from "eslint-config-prettier/flat";
import boundaries from "eslint-plugin-boundaries";
import reactHooks from "eslint-plugin-react-hooks";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

const root = process.cwd();
const tsFiles = ["**/*.{ts,tsx,mts,cts}"];
const sourceFiles = [
  "apps/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
  "packages/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
];
const local = (type) => ({ to: { element: { type } } });
const external = (source) => ({ to: { module: { origin: ["external", "core"], source } } });

export default defineConfig(
  globalIgnores([
    "**/node_modules/**",
    "**/dist/**",
    "**/.next/**",
    "playwright-report/**",
    "test-results/**",
  ]),
  {
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: "error" },
    rules: {
      "no-warning-comments": [
        "error",
        {
          terms: ["eslint-disable", "eslint-enable", "prettier-ignore", "oxfmt-ignore"],
          location: "anywhere",
        },
      ],
    },
  },
  {
    files: ["**/*.mjs"],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: { process: "readonly", console: "readonly", URL: "readonly", Buffer: "readonly" },
    },
  },
  {
    files: tsFiles,
    extends: [
      js.configs.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: root } },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      "@typescript-eslint/non-nullable-type-assertion-style": "off",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        { "ts-ignore": true, "ts-nocheck": true, "ts-expect-error": true, "ts-check": false },
      ],
      "@typescript-eslint/no-floating-promises": [
        "error",
        { ignoreVoid: false, ignoreIIFE: false, checkThenables: true },
      ],
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: true }],
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/return-await": ["error", "always"],
      "@typescript-eslint/use-unknown-in-catch-callback-variable": "error",
      "@typescript-eslint/only-throw-error": [
        "error",
        { allowThrowingAny: false, allowThrowingUnknown: false, allowRethrowing: true },
      ],
      "@typescript-eslint/prefer-promise-reject-errors": "error",
      "@typescript-eslint/strict-boolean-expressions": [
        "error",
        {
          allowString: false,
          allowNumber: false,
          allowNullableObject: false,
          allowNullableBoolean: false,
          allowNullableString: false,
          allowNullableNumber: false,
          allowAny: false,
        },
      ],
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        {
          considerDefaultExhaustiveForUnions: false,
          allowDefaultCaseForExhaustiveSwitch: true,
          requireDefaultForNonUnion: true,
        },
      ],
      "@typescript-eslint/require-array-sort-compare": ["error", { ignoreStringArrays: false }],
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        {
          allowNumber: true,
          allowBoolean: false,
          allowAny: false,
          allowNullish: false,
          allowRegExp: false,
          allowNever: false,
        },
      ],
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "all",
          argsIgnorePattern: "^_",
          caughtErrors: "all",
          reportUsedIgnorePattern: true,
          ignoreRestSiblings: true,
          ignoreUsingDeclarations: true,
        },
      ],
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "@typescript-eslint/consistent-type-exports": "error",
      "@typescript-eslint/array-type": ["error", { default: "array-simple" }],
      "@typescript-eslint/method-signature-style": ["error", "property"],
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/naming-convention": [
        "error",
        {
          selector: "variableLike",
          format: ["camelCase", "PascalCase", "UPPER_CASE"],
          leadingUnderscore: "allow",
        },
        { selector: "typeLike", format: ["PascalCase"] },
      ],
      eqeqeq: ["error", "always"],
      "prefer-const": "error",
      "no-param-reassign": ["error", { props: true }],
      "no-console": "error",
      "no-eval": "error",
      "no-new-func": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector: "ExportDefaultDeclaration",
          message: "Use named exports. Framework entry points are the only exceptions.",
        },
        {
          selector: "TSImportType",
          message: "Use a separate named import type so dependency checks see it.",
        },
        {
          selector: "ImportExpression[source.type!='Literal']",
          message: "Dynamic imports must have a literal path for dependency checks.",
        },
        {
          selector: "PropertyDefinition[definite=true], VariableDeclarator[definite=true]",
          message: "Validate initialization instead of asserting it with !.",
        },
      ],
    },
  },
  {
    files: sourceFiles,
    plugins: { boundaries },
    settings: {
      "import/resolver": {
        typescript: { project: ["apps/*/tsconfig.json", "packages/*/tsconfig.json"] },
      },
      "boundaries/root-path": root,
      "boundaries/include": [...sourceFiles, "node_modules/.pnpm/**"],
      "boundaries/files": [{ pattern: "packages/backend/src/bootstrap.ts", category: "bootstrap" }],
      "boundaries/elements": [
        { type: "comparison", pattern: "packages/backend/src/comparison" },
        { type: "providers", pattern: "packages/backend/src/providers/*" },
        { type: "infrastructure", pattern: "packages/backend/src/infrastructure/*" },
        { type: "contracts", pattern: "packages/contracts/src" },
        { type: "client", pattern: "packages/api-client/src" },
        { type: "web", pattern: "apps/web/src" },
        { type: "api", pattern: "apps/api/src" },
        { type: "worker", pattern: "apps/worker/src" },
      ],
    },
    rules: {
      "boundaries/no-unknown-files": "error",
      "boundaries/no-unknown-dependencies": "error",
      "boundaries/no-ignored-dependencies": "error",
      "boundaries/dependencies": [
        "error",
        {
          default: "disallow",
          checkAllOrigins: true,
          policies: [
            {
              from: { element: { type: "web" } },
              allow: [
                local("client"),
                external(["solid-js", "solid-js/*"]),
                external(["react", "react-dom", "next", "next/*", "react/*"]),
              ],
            },
            // The Solid build configuration is kept under web/src so it shares typed checks.
            {
              from: { file: { path: "apps/web/src/vite.config.ts" } },
              allow: [external(["vite", "vite-plugin-solid"])],
            },
            { from: { element: { type: "client" } }, allow: [external("openapi-fetch")] },
            // The API client parser uses Node's built-in test runner.
            {
              from: { file: { path: "packages/api-client/src/index.test.ts" } },
              allow: [external(["node:assert", "node:test"])],
            },
            { from: { element: { type: "contracts" } }, allow: [external("zod")] },
            {
              from: { element: { type: "api" } },
              allow: [
                local("contracts"),
                { to: { file: { categories: "bootstrap" } } },
                external("node:http"),
                external(["fastify", "@fastify/*", "fastify-type-provider-zod", "zod"]),
              ],
            },
            {
              from: { element: { type: "worker" } },
              allow: [{ to: { file: { categories: "bootstrap" } } }],
            },
            { from: { element: { type: "comparison" } }, allow: [external("zod")] },
            {
              from: { element: { type: "providers" } },
              allow: [local("comparison"), external("zod")],
            },
            {
              from: { element: { type: "infrastructure" } },
              allow: [
                local("comparison"),
                external([
                  "drizzle-orm",
                  "drizzle-orm/*",
                  "pg",
                  "pg-boss",
                  "pino",
                  "zod",
                  "node:*",
                ]),
              ],
            },
            // Aurora transport uses the approved official SDK; core comparison stays independent.
            {
              from: { file: { path: "packages/backend/src/infrastructure/aws/aurora.ts" } },
              allow: external("@aws-sdk/client-rds-data"),
            },
            {
              from: { file: { categories: "bootstrap" } },
              allow: [
                local(["comparison", "providers", "infrastructure"]),
                external(["drizzle-orm", "drizzle-orm/*", "pg", "pg-boss", "pino", "zod"]),
              ],
            },
            // Tests use the same safety rules; only the runner dependency is added.
            // Transport tests exercise bootstrap wiring and its infrastructure adapters.
            {
              from: { file: { path: "packages/backend/src/infrastructure/testing/aws.test.ts" } },
              allow: [local("infrastructure"), { to: { file: { categories: "bootstrap" } } }],
            },
            { from: { file: { path: "**/*.test.ts" } }, allow: external("vitest") },
            // Cross-package imports must go through the public entry point, including relative imports.
            {
              from: { element: { type: ["web", "api", "worker"] } },
              disallow: {
                to: { element: { type: ["contracts", "client"], fileInternalPath: "!index.ts" } },
              },
            },
            {
              from: { element: { type: "web" } },
              disallow: { to: { module: { source: "@app/api-client/*" } } },
            },
          ],
        },
      ],
    },
  },
  // Application source is TypeScript only; JavaScript must not bypass typed checks.
  {
    files: ["apps/**/*.{js,jsx,mjs,cjs}", "packages/**/*.{js,jsx,mjs,cjs}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        { selector: "Program", message: "Application source must use TypeScript." },
      ],
    },
  },
  {
    files: ["apps/web/**/*.{ts,tsx,mts,cts}"],
    plugins: { "react-hooks": reactHooks, "@next/next": next },
    settings: { next: { rootDir: "apps/web/" } },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...next.configs.recommended.rules,
      ...next.configs["core-web-vitals"].rules,
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
      "@next/next/no-img-element": "error",
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "Use @app/api-client." },
        { name: "XMLHttpRequest", message: "Use @app/api-client." },
      ],
      "no-restricted-properties": [
        "error",
        { object: "globalThis", property: "fetch", message: "Use @app/api-client." },
        { object: "window", property: "fetch", message: "Use @app/api-client." },
      ],
    },
  },
  // These files require default exports in their framework/tool contract.
  {
    files: [
      "apps/web/src/app/**/{page,layout,loading,error,not-found,template,default,global-error}.tsx",
      "apps/web/src/vite.config.ts",
      "*.config.ts",
      "packages/backend/drizzle.config.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        { selector: "TSImportType", message: "Use a separate named import type." },
        {
          selector: "ImportExpression[source.type!='Literal']",
          message: "Dynamic imports must have a literal path.",
        },
        {
          selector: "PropertyDefinition[definite=true], VariableDeclarator[definite=true]",
          message: "Do not assert initialization with !.",
        },
      ],
    },
  },
  // Declaration merging and negative type tests have narrowly scoped exceptions.
  { files: ["**/*.d.ts"], rules: { "@typescript-eslint/consistent-type-definitions": "off" } },
  {
    files: ["**/*.test-d.ts"],
    rules: {
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-ignore": true,
          "ts-nocheck": true,
          "ts-expect-error": "allow-with-description",
          minimumDescriptionLength: 10,
        },
      ],
    },
  },
  formatterConflicts,
  { files: tsFiles, rules: { curly: ["error", "all"] } },
);
