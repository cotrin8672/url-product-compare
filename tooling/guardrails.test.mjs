import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ESLint } from "eslint";

const root = process.cwd();
const sandbox = await mkdtemp(path.join(tmpdir(), "compare-guardrails-"));
const eslint = path.join(root, "node_modules/eslint/bin/eslint.js");
const checker = new ESLint({
  cwd: sandbox,
  overrideConfigFile: path.join(root, "eslint.config.mjs"),
  overrideConfig: {
    languageOptions: { parserOptions: { tsconfigRootDir: sandbox } },
    settings: {
      "boundaries/root-path": sandbox,
      next: { rootDir: path.join(sandbox, "apps/web/") },
      "import/resolver": { typescript: { project: path.join(sandbox, "tsconfig.json") } },
    },
  },
});
let checkedCases = 0;
async function put(file, contents) {
  const target = path.join(sandbox, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents);
}
function run(binary, args) {
  const result = spawnSync(process.execPath, [binary, ...args], { cwd: sandbox, encoding: "utf8" });
  assert.equal(result.error, undefined);
  return result;
}
async function check(code, expected = [], file = "apps/api/src/probe.ts") {
  await put(file, code);
  const results = await checker.lintText(code, { filePath: path.join(sandbox, file) });
  const messages = results[0].messages;
  assert.equal(
    messages.some((m) => m.fatal === true),
    false,
    JSON.stringify(messages),
  );
  const rules = messages.map((m) => m.ruleId);
  if (expected.length === 0) {
    assert.deepEqual(rules, []);
  }
  for (const rule of expected) {
    assert.ok(rules.includes(rule), `Expected ${rule}: ${JSON.stringify(messages)}`);
  }
  checkedCases += 1;
}
try {
  await symlink(
    path.join(root, "node_modules"),
    path.join(sandbox, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await put("package.json", '{"type":"module"}');
  await put("tsconfig.base.json", await readFile(path.join(root, "tsconfig.base.json"), "utf8"));
  await put(
    "tsconfig.json",
    JSON.stringify({
      extends: "./tsconfig.base.json",
      compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", noEmit: true },
      include: ["apps/**/*.ts", "packages/**/*.ts"],
    }),
  );
  const tsconfig = JSON.stringify({
    extends: "../../../tsconfig.base.json",
    compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", noEmit: true },
    include: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
  });
  for (const directory of [
    "apps/api/src",
    "apps/web/src",
    "packages/contracts/src",
    "packages/backend/src",
    "packages/api-client/src",
  ]) {
    await put(`${directory}/tsconfig.json`, tsconfig);
  }
  await mkdir(path.join(sandbox, "apps/web/src/app"), { recursive: true });
  await check("export const price = 0;");
  await check("export const state = { status: 'ok' } as const;");
  await check("export const value: any = 1;", ["@typescript-eslint/no-explicit-any"]);
  await check("export const value = 1 as number;", [
    "@typescript-eslint/consistent-type-assertions",
  ]);
  await check("export const value = [1][0]!;", ["@typescript-eslint/no-non-null-assertion"]);
  await check("Promise.resolve();", ["@typescript-eslint/no-floating-promises"]);
  await check("void Promise.resolve();", ["@typescript-eslint/no-floating-promises"]);
  await check(
    "// eslint-disable-next-line @typescript-eslint/no-explicit-any\nexport const value: any = 1;",
    ["@typescript-eslint/no-explicit-any"],
  );
  await check(
    "export function describe(state: 'queued' | 'done'): string { switch(state) { case 'queued': return state; default: return 'other'; } }",
    ["@typescript-eslint/switch-exhaustiveness-check"],
  );
  await check("export const price = 0; if(price) { throw new Error('missing'); }", [
    "@typescript-eslint/strict-boolean-expressions",
  ]);
  await check("// @ts-ignore\nexport const price = 0;", ["@typescript-eslint/ban-ts-comment"]);
  await check("const _hidden = 2; export {};", ["@typescript-eslint/no-unused-vars"]);
  const negatives = [
    [
      "const raw = JSON.parse('{}'); export const value: string = raw;",
      "@typescript-eslint/no-unsafe-assignment",
    ],
    ["const raw = JSON.parse('{}'); raw();", "@typescript-eslint/no-unsafe-call"],
    [
      "const raw = JSON.parse('{}'); export const value = raw.price;",
      "@typescript-eslint/no-unsafe-member-access",
    ],
    [
      "export function load(): string { return JSON.parse('{}'); }",
      "@typescript-eslint/no-unsafe-return",
    ],
    [
      "function use(value: number): number { return value; } use(JSON.parse('{}'));",
      "@typescript-eslint/no-unsafe-argument",
    ],
    [
      "[1].forEach(async () => { await Promise.resolve(); });",
      "@typescript-eslint/no-misused-promises",
    ],
    [
      "export async function load(): Promise<number> { return Promise.resolve(1); }",
      "@typescript-eslint/return-await",
    ],
    [
      "Promise.resolve().catch((error) => { throw error; });",
      "@typescript-eslint/use-unknown-in-catch-callback-variable",
    ],
    ["throw 'failure';", "@typescript-eslint/only-throw-error"],
    [
      "Promise.reject('failure').catch((error: unknown) => { throw error; });",
      "@typescript-eslint/prefer-promise-reject-errors",
    ],
    ["Promise.resolve().catch(() => {});", "@typescript-eslint/no-empty-function"],
    ["export const prices = [3, 12].sort();", "@typescript-eslint/require-array-sort-compare"],
    [
      "export function mutate(input: { price: number }): void { input.price = 2; }",
      "no-param-reassign",
    ],
    ["export function load() { return 1; }", "@typescript-eslint/explicit-module-boundary-types"],
    ["export default 1;", "no-restricted-syntax"],
    ["export type Hidden = typeof import('./helper.js');", "no-restricted-syntax"],
    [
      "export async function load(file: string): Promise<unknown> { return await import(file); }",
      "no-restricted-syntax",
    ],
    ["export class State { value!: number; }", "no-restricted-syntax"],
    ["// prettier-ignore\nexport const price = 0;", "no-warning-comments"],
    ["// oxfmt-ignore\nexport const price = 0;", "no-warning-comments"],
    ["export const price = 0; if (price === 0) throw new Error('zero');", "curly"],
    ["export const same = 1 == 2;", "eqeqeq"],
    ["console.log('failure');", "no-console"],
  ];
  for (const [code, rule] of negatives) {
    await check(code, [rule]);
  }
  await check(
    "export const value: any = 1;",
    ["@typescript-eslint/no-explicit-any"],
    "apps/api/src/probe.test.ts",
  );
  await check(
    "// @ts-expect-error: checking a deliberately invalid assignment\nexport const value: number = 'invalid';",
    [],
    "apps/api/src/probe.test-d.ts",
  );
  await check(
    "// @ts-expect-error\nexport const value: number = 'invalid';",
    ["@typescript-eslint/ban-ts-comment"],
    "apps/api/src/probe.test-d.ts",
  );
  await check(
    "export interface Product { readonly price: number; }",
    [],
    "apps/api/src/declaration-probe.d.ts",
  );
  await check("export interface Product { readonly price: number; }", [
    "@typescript-eslint/consistent-type-definitions",
  ]);
  await check("export const value = 1;", ["no-restricted-syntax"], "apps/web/src/probe.js");
  await put(
    "apps/web/tsconfig.json",
    JSON.stringify({
      extends: "../../tsconfig.base.json",
      compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", noEmit: true },
      include: ["**/*.ts"],
    }),
  );
  await check(
    "export const value = 1;",
    ["boundaries/no-unknown-files"],
    "apps/web/unclassified.ts",
  );
  await check(
    "fetch('/comparison').catch((error: unknown) => { throw error; });",
    ["no-restricted-globals"],
    "apps/web/src/probe.ts",
  );
  await check(
    "globalThis.fetch('/comparison').catch((error: unknown) => { throw error; });",
    ["no-restricted-properties"],
    "apps/web/src/probe.ts",
  );
  await check(
    "import { useState } from 'react'; export function Component(): null { if (Math.random() > 0.5) { useState(0); } return null; }",
    ["react-hooks/rules-of-hooks"],
    "apps/web/src/hooks.ts",
  );
  await check(
    "import { useEffect } from 'react'; export function Component(input: Readonly<{ value: string }>): null { useEffect(() => { if (input.value === '') { throw new Error('empty'); } }, []); return null; }",
    ["react-hooks/exhaustive-deps"],
    "apps/web/src/hooks.ts",
  );
  await check(
    "export function Picture(): unknown { return <img src='/photo.png' alt='Photo' />; }",
    ["@next/next/no-img-element"],
    "apps/web/src/picture.tsx",
  );
  await put("packages/backend/src/bootstrap.ts", "export const backend = 1;");
  await check(
    "import { backend } from '../../../packages/backend/src/bootstrap.js'; export const value = backend;",
  );
  await check(
    "import { backend } from '../../../packages/backend/src/bootstrap.js'; export const value = backend;",
    ["boundaries/dependencies"],
    "apps/web/src/probe.ts",
  );
  await check("import 'pg'; export {};", ["boundaries/dependencies"], "apps/web/src/probe.ts");
  await put("tooling/ignored.mjs", "export const ignored = 1;");
  await check(
    "import '../../../tooling/ignored.mjs'; export {};",
    ["boundaries/no-ignored-dependencies"],
    "apps/web/src/App.tsx",
  );
  await put("packages/contracts/src/private.ts", "export const privateValue = 1;");
  await check(
    "import { privateValue } from '../../../packages/contracts/src/private.js'; export const value = privateValue;",
    ["boundaries/dependencies"],
  );
  await check(
    "export const value = 1;",
    ["boundaries/no-unknown-files"],
    "packages/backend/src/unclassified.ts",
  );
  await check(
    "import 'fastify'; export {};",
    ["boundaries/dependencies"],
    "packages/backend/src/comparison/probe.ts",
  );
  await put("packages/contracts/src/index.ts", "export const value = 1;");
  await check(
    "import { value } from '../../../packages/contracts/src/index.js'; export const price = value;",
  );
  await put("apps/api/src/helper.ts", "export function run(): number { return 1; }");
  await check("import { run } from './helper.js'; run();");
  await put(
    "apps/api/src/helper.ts",
    "export async function run(): Promise<number> { return await Promise.resolve(1); }",
  );
  await put("apps/api/src/probe.ts", "import { run } from './helper.js'; run();");
  const changed = run(eslint, [
    "--config",
    path.join(root, "eslint.config.mjs"),
    "--format",
    "json",
    "apps/api/src/probe.ts",
  ]);
  assert.equal(changed.status, 1, changed.stderr);
  assert.ok(
    JSON.parse(changed.stdout)[0].messages.some(
      (m) => m.ruleId === "@typescript-eslint/no-floating-promises",
    ),
  );
  // Verify fix → format → lint is stable using the real configuration.
  await put("apps/api/src/probe.ts", "export let price=0;\n");
  assert.equal(
    run(eslint, [
      "--config",
      path.join(root, "eslint.config.mjs"),
      "--fix",
      "apps/api/src/probe.ts",
    ]).status,
    0,
  );
  const formatter = path.join(root, "node_modules/oxfmt/bin/oxfmt");
  const formatArgs = [
    "--write",
    "--config",
    path.join(root, ".oxfmtrc.json"),
    "apps/api/src/probe.ts",
  ];
  const firstRun = run(formatter, formatArgs);
  assert.equal(firstRun.status, 0, firstRun.stderr);
  const file = path.join(sandbox, "apps/api/src/probe.ts");
  const first = await readFile(file, "utf8");
  assert.equal(first, "export const price = 0;\n");
  assert.equal(run(formatter, formatArgs).status, 0);
  assert.equal(await readFile(file, "utf8"), first);
  await check(first);
  await put(
    "apps/api/src/probe.ts",
    "import { z } from 'zod';\nimport path from 'node:path';\nimport './second';\nimport './first';\nexport const value={b:1,a:2};\n",
  );
  assert.equal(run(formatter, formatArgs).status, 0);
  const imports = await readFile(file, "utf8");
  assert.ok(imports.indexOf('"node:path"') < imports.indexOf('"zod"'));
  assert.ok(imports.indexOf('"./second"') < imports.indexOf('"./first"'));
  assert.match(imports, /\{\s*b: 1,\s*a: 2,?\s*\}/);
  await put(
    "strict-probes/tsconfig.json",
    JSON.stringify({
      extends: "../tsconfig.base.json",
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        types: [],
      },
      include: ["*.ts"],
    }),
  );
  await put(
    "strict-probes/check.ts",
    `
export const first: number = [1][0];
type Options = { readonly count?: number };
export const options: Options = { count: undefined };
export function partial(flag: boolean) { if (flag) { return 1; } }
type Counts = { [key: string]: number };
const counts: Counts = {};
export const count = counts.item;
class Base { run(): number { return 1; } }
export class Derived extends Base { run(): number { return 2; } }
export enum Phase { Ready }
`,
  );
  const types = run(path.join(root, "node_modules/typescript/bin/tsc"), [
    "--project",
    "strict-probes/tsconfig.json",
    "--pretty",
    "false",
  ]);
  assert.equal(types.status, 2, types.stderr);
  for (const diagnostic of ["TS2322", "TS2375", "TS7030", "TS4111", "TS4114", "TS1294"]) {
    assert.ok(types.stdout.includes(diagnostic), `Expected ${diagnostic}: ${types.stdout}`);
  }
  console.log(
    `Guardrails passed: ${checkedCases} lint cases, cross-file Promise change, 6 TypeScript diagnostics, formatter stability.`,
  );
} finally {
  // sandbox is an absolute directory created by mkdtemp under the OS temp directory.
  await rm(sandbox, { recursive: true });
}
