import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const apiBase = process.env.PUBLIC_API_BASE ?? "";
assert.ok(URL.canParse(apiBase), "Set PUBLIC_API_BASE to the deployed AWS API origin");
const api = new URL(apiBase);
assert.ok(
  api.protocol === "https:" &&
    api.username === "" &&
    api.password === "" &&
    api.port === "" &&
    api.search === "" &&
    api.hash === "" &&
    api.pathname === "/" &&
    /^[a-z0-9.-]+$/u.test(api.hostname) &&
    api.hostname.includes(".") &&
    !/^\d+(?:\.\d+){3}$/u.test(api.hostname) &&
    !/(?:^|\.)(?:localhost|local|internal)$/u.test(api.hostname),
  "PUBLIC_API_BASE must be a public HTTPS origin without credentials or a path",
);
const build = spawnSync(process.execPath, ["tooling/build-site.mjs"], {
  cwd: root,
  stdio: "inherit",
});
assert.equal(build.error, undefined);
assert.equal(build.status, 0, "Pages static build failed");
const output = path.join(root, "apps/web/dist");
const headers = [
  "/*",
  "  X-Content-Type-Options: nosniff",
  "  X-Frame-Options: DENY",
  "  Referrer-Policy: strict-origin-when-cross-origin",
  `  Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https:; connect-src ${api.origin}; font-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'`,
  "",
  "/assets/*",
  "  Cache-Control: public, max-age=31536000, immutable",
  "",
].join("\n");
await writeFile(path.join(output, "_headers"), headers);
assert.ok(
  (await readFile(path.join(output, "404.html"), "utf8")).includes(
    'name="robots" content="noindex,nofollow"',
  ),
);
let files = 0;
async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    assert.equal(entry.isSymbolicLink(), false, "Pages output must not contain symlinks");
    if (entry.isDirectory()) {
      assert.ok(
        !["node_modules", "functions", ".git"].includes(entry.name),
        "Private directory in Pages output",
      );
      await inspect(target);
      continue;
    }
    assert.ok(
      !/^\.env|^_worker\.js$|^\.htaccess$|\.(?:ts|tsx|mjs|map|pem|key|php|sql)$/u.test(entry.name),
      "Unexpected source or runtime file in Pages output",
    );
    files += 1;
  }
}
await inspect(output);
console.log(
  `Pages build: ${files} static files verified; API origin ${api.origin}; no deployment performed`,
);
