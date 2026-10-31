import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = await realpath(fileURLToPath(new URL("..", import.meta.url)));
const staticOnly = process.argv.includes("--static-only");
assert.ok(
  process.argv.slice(2).every((value) => value === "--static-only"),
  "Unknown package option",
);
function origin(name) {
  const value = process.env[name] ?? "";
  assert.ok(URL.canParse(value), `${name} is required`);
  const url = new URL(value);
  assert.ok(
    url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      /^[a-z0-9.-]+$/.test(url.hostname) &&
      url.hostname.includes(".") &&
      !/^\d+(?:\.\d+){3}$/.test(url.hostname) &&
      !/(?:^|\.)(?:localhost|local|internal)$/.test(url.hostname),
    `${name} must be a public HTTPS origin without credentials, query or fragment`,
  );
  return url.origin;
}
const siteOrigin = origin("SITE_ORIGIN");
const apiOrigin = origin("PUBLIC_API_BASE");
assert.notEqual(siteOrigin, apiOrigin, "Xserver and Lambda must have separate origins");
const build = spawnSync(process.execPath, ["tooling/build-site.mjs"], {
  cwd: root,
  stdio: "inherit",
});
assert.equal(build.error, undefined);
assert.equal(build.status, 0, "Static site build failed");

const output = path.join(root, staticOnly ? "dist/xserver-static" : "dist/xserver");
await mkdir(output, { recursive: true });
assert.equal(await realpath(output), output);
assert.ok(output.startsWith(`${path.join(root, "dist")}${path.sep}`));
await rm(output, { recursive: true });
await mkdir(output, { recursive: true });
await cp(path.join(root, "apps/products/dist"), path.join(output, "public_html"), {
  recursive: true,
});
const headers = (
  await readFile(path.join(root, "infrastructure/lambda/xserver.htaccess.example"), "utf8")
)
  .replace(
    "# Merge into the existing public_html/.htaccess; replace the API origin first.",
    "# Generated for this release; review before merging with existing server rules.",
  )
  .replace("https://YOUR_API_ID.lambda-url.ap-northeast-1.on.aws", apiOrigin);
await writeFile(path.join(output, "public_html/.htaccess"), headers);
await writeFile(
  path.join(output, "INSTALL.txt"),
  `Astro static frontend release\nSite: ${siteOrigin}\nAPI: ${apiOrigin}\n\nNo PHP, Node.js runtime, database or real credentials are included.\n1. Deploy the Lambda/DynamoDB stack and configure its exact allowed origin to ${siteOrigin}.\n2. Confirm AWS provider credentials and actual provider storage permissions are configured.\n3. Back up the destination and review .htaccess before uploading public_html contents.\n4. Open the site and compare a real product URL through the deployed API.\nUpload ONLY public_html contents. Keep this file and manifest.json outside the document root.\nDo not upload .env, source files or Lambda archives. Use a separate document root from WordPress.\n`,
);

const files = [];
async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    assert.equal(entry.isSymbolicLink(), false, "Release must not contain symlinks");
    if (entry.isDirectory()) {
      await inspect(target);
      continue;
    }
    const name = path.relative(output, target).replaceAll(path.sep, "/");
    assert.ok(
      !/(?:^|\/)(?:\.env[^/]*|config\.php|node_modules)(?:\/|$)/.test(name),
      `Private file in release: ${name}`,
    );
    assert.ok(
      !/\.(?:ts|tsx|mjs|map|pem|key)$/.test(name),
      `Source or secret file in release: ${name}`,
    );
    assert.ok(!/\.(?:php|sql)$/.test(name), `Server runtime file in static release: ${name}`);
    const bytes = await readFile(target);
    if (name.endsWith(".html")) {
      assert.ok(bytes.toString("utf8").includes(`name="api-base" content="${apiOrigin}"`));
    }
    files.push({
      path: name,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
}
await inspect(output);
await writeFile(
  path.join(output, "manifest.json"),
  `${JSON.stringify({ mode: "static", siteOrigin, apiOrigin, files }, null, 2)}\n`,
);
console.log(`Xserver release: ${output} (${files.length} verified files; no deployment performed)`);
