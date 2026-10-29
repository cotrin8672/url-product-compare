import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

export function workspacePnpm(...args) {
  const cloudflare = process.env.CF_PAGES === "1";
  const pnpmPath = process.env.npm_execpath;
  if (cloudflare) {
    assert.ok(
      typeof pnpmPath === "string" && pnpmPath.length > 0,
      "Run the Pages build through pnpm run build:pages",
    );
  }
  const pnpmScript = typeof pnpmPath === "string" && /\.[cm]?js$/u.test(pnpmPath);
  const executable = cloudflare
    ? pnpmScript
      ? process.execPath
      : pnpmPath
    : process.platform === "win32"
      ? "rtk"
      : "mise";
  const command = cloudflare
    ? pnpmScript
      ? [pnpmPath, ...args]
      : args
    : [...(process.platform === "win32" ? ["mise"] : []), "exec", "--", "pnpm", ...args];
  const result = spawnSync(executable, command, { cwd: root, stdio: "inherit" });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, "Workspace build failed");
}
