import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { prepareLambdaDependencies } from "./lambda-dependencies.mjs";

const root = await realpath(fileURLToPath(new URL("..", import.meta.url)));
const bundle = path.join(root, "apps/api/dist/lambda");
const stage = path.join(root, "apps/api/dist/lambda-stage");
function pnpm(...args) {
  const result = spawnSync(
    process.platform === "win32" ? "rtk" : "mise",
    [...(process.platform === "win32" ? ["mise"] : []), "exec", "--", "pnpm", ...args],
    { cwd: root, stdio: "inherit" },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `pnpm ${args.join(" ")} failed`);
}
async function clear(target) {
  assert.ok(target.startsWith(`${path.join(root, "apps/api/dist")}${path.sep}`));
  await mkdir(target, { recursive: true });
  assert.equal(await realpath(target), target);
  await rm(target, { recursive: true });
}
pnpm("build:api-libraries");
await clear(stage);
await clear(bundle);
pnpm("exec", "tsc", "--noEmit", "false", "--outDir", stage);
// AWS CLI expands Windows junctions into copies. An isolated pnpm tree then
// loses transitive resolution at those copied aliases. Deploy an npm-style,
// physical dependency tree so the same archive works on Linux without links.
await prepareLambdaDependencies(root, stage, bundle, pnpm);

// Include only the local module graph reachable from the three Lambda handlers.
const pending = [
  "apps/api/src/lambda.js",
  "apps/worker/src/lambda.js",
  "apps/worker/src/cleanup.js",
];
const seen = new Set();
while (pending.length > 0) {
  const module = pending.pop();
  if (seen.has(module)) {
    continue;
  }
  seen.add(module);
  const source = path.resolve(stage, module);
  assert.ok(source.startsWith(`${stage}${path.sep}`));
  const code = await readFile(source, "utf8");
  assert.equal(
    /firebase-admin|firebase-functions|infrastructure\/firebase/.test(code),
    false,
    module,
  );
  const target = path.resolve(bundle, module);
  assert.ok(target.startsWith(`${bundle}${path.sep}`));
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target);
  for (const match of code.matchAll(/(?:from\s*|import\s*)["'](\.[^"']+)["']/g)) {
    pending.push(path.relative(stage, path.resolve(path.dirname(source), match[1])));
  }
}
// pnpm deploy also copies workspace sources; the production graph above replaces them.
for (const directory of ["src", "dist"]) {
  const target = path.join(bundle, directory);
  assert.ok(target.startsWith(`${bundle}${path.sep}`));
  await rm(target, { recursive: true, force: true });
}
const manifestPath = path.join(bundle, "package.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
delete manifest.devDependencies;
delete manifest.scripts;
delete manifest.exports;
manifest.main = "apps/api/src/lambda.js";
manifest.engines = { node: "24" };
assert.equal(
  Object.keys(manifest.dependencies).some((name) => name.startsWith("firebase")),
  false,
);
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
const check = spawnSync(process.execPath, ["tooling/check-lambda.mjs"], {
  cwd: root,
  stdio: "inherit",
});
assert.equal(check.error, undefined);
assert.equal(check.status, 0, "Lambda package checks failed");
console.log(`Lambda production package: ${bundle}`);
