import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
const pages = process.argv.includes("--pages");
for (const target of ["products", "furusato", "securities"]) {
  const current = target.toUpperCase();
  const origin = process.env[current + "_SITE_ORIGIN"];
  const result = spawnSync(
    process.execPath,
    [pages ? "tooling/build-cloudflare-pages.mjs" : "tooling/build-site.mjs", target],
    {
      stdio: "inherit",
      env: { ...process.env, ...(origin === undefined ? {} : { SITE_ORIGIN: origin }) },
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, "Static build failed: " + target);
}
