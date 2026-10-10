import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = await realpath(fileURLToPath(new URL("..", import.meta.url)));
const bundle = path.join(root, "apps/api/dist/firebase");
function pnpm(...args) {
  const result = spawnSync(
    process.platform === "win32" ? "rtk" : "mise",
    [...(process.platform === "win32" ? ["mise"] : []), "exec", "--", "pnpm", ...args],
    { cwd: root, stdio: "inherit" },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `pnpm ${args.join(" ")} failed`);
}

pnpm("--filter", "@app/api", "exec", "tsc", "--noEmit", "false");
const site = spawnSync(process.execPath, ["tooling/build-site.mjs"], {
  cwd: root,
  stdio: "inherit",
});
assert.equal(site.error, undefined);
assert.equal(site.status, 0, "Public site generation failed");
await mkdir(bundle, { recursive: true });
// Verify the absolute target, including symlinks, before deleting generated files.
assert.equal(await realpath(bundle), bundle);
await rm(bundle, { recursive: true });
pnpm("--filter", "@app/backend", "deploy", "--legacy", "--prod", bundle);
for (const directory of ["apps", "packages"]) {
  await cp(path.join(root, "apps/api/dist", directory), path.join(bundle, directory), {
    recursive: true,
  });
}
const manifestPath = path.join(bundle, "package.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
manifest.main = "apps/api/src/firebase.js";
manifest.engines = { node: "22" };
manifest.packageManager = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
).packageManager;
delete manifest.exports;
delete manifest.scripts;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
const check = spawnSync(process.execPath, ["tooling/check-firebase.mjs"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, API_CONFIGURATION: JSON.stringify({ rakuten: null, openai: null }) },
});
assert.equal(check.error, undefined);
assert.equal(check.status, 0, "Firebase production package checks failed");
console.log(`Firebase functions package: ${bundle}`);
