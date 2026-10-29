import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

import { workspacePnpm } from "./workspace-pnpm.mjs";

const root = path.resolve(import.meta.dirname, "..");
workspacePnpm("--filter", "@app/web", "build");
const { siteOrigin, apiBase, pages } = JSON.parse(
  readFileSync(path.join(root, "apps/web/.generated/site.json"), "utf8"),
);
const webDist = path.join(root, "apps/web/dist");
const titles = new Set();
const escapeHtml = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
const publicPages = pages.filter((page) => page.kind !== "legacy");
assert.equal(new Set(pages.map((page) => page.route)).size, pages.length, "Duplicate public route");
assert.equal(
  publicPages.length,
  3 + pages.filter((page) => page.kind === "category").length * 4,
  "Missing public route",
);
for (const page of pages) {
  const html = readFileSync(path.join(webDist, page.route.slice(1), "index.html"), "utf8");
  const title = html.match(/<title>([^<]+)<\/title>/)?.[1];
  assert.equal(title, escapeHtml(page.title));
  assert.ok(!titles.has(title), "Page title must be unique: " + page.route);
  titles.add(title);
  assert.equal((html.match(/<h1[ >]/g) ?? []).length, 1, "Missing no-JS heading: " + page.route);
  assert.ok(html.includes('id="public-content"') && html.includes("<p>"));
  const apiMeta = html.match(/<meta name="api-base" content(?:="([^"]*)")?>/);
  assert.notEqual(apiMeta, null, "Missing API configuration: " + page.route);
  assert.equal(
    apiMeta?.[1] ?? "",
    escapeHtml(apiBase),
    "API configuration mismatch: " + page.route,
  );
  assert.equal((html.match(/<link rel="canonical"/g) ?? []).length, siteOrigin.length > 0 ? 1 : 0);
  if (siteOrigin.length > 0) assert.ok(html.includes('href="' + siteOrigin + page.route + '"'));
  if (siteOrigin.length === 0 || page.kind === "legacy")
    assert.ok(html.includes('content="noindex,nofollow"'));
  for (const label of page.labels)
    assert.ok(html.includes(escapeHtml(label)), "Score label missing: " + label);
  // A static host must not need inline bootstrap code or a Node/Astro runtime.
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.ok(
    scripts.some((script) => /type="module"/.test(script[1]) && /src="/.test(script[1])),
    "Missing browser entry",
  );
  for (const script of scripts) {
    assert.ok(
      /src="/.test(script[1]) || /type="application\/ld\+json"/.test(script[1]),
      "Executable inline script conflicts with CSP",
    );
  }
  for (const asset of html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)) {
    assert.ok(
      existsSync(path.join(webDist, asset[1].slice(1))),
      "Missing built asset: " + asset[1],
    );
  }
}
const robots = readFileSync(path.join(webDist, "robots.txt"), "utf8");
const sitemap = readFileSync(path.join(webDist, "sitemap.xml"), "utf8");
assert.ok(!/\/jobs\/|\/results\/|\/api\//.test(sitemap), "Private route in sitemap");
assert.equal(
  (sitemap.match(/<loc>/g) ?? []).length,
  siteOrigin.length > 0 ? publicPages.length : 0,
);
if (siteOrigin.length > 0) {
  assert.ok(robots.includes("Sitemap: " + siteOrigin + "/sitemap.xml"));
  for (const page of publicPages) {
    assert.ok(sitemap.includes("<loc>" + siteOrigin + page.route + "</loc>"));
    if (page.route !== "/") assert.ok(!robots.includes("Disallow: " + page.route));
  }
} else assert.equal(robots, "User-agent: *\nDisallow: /\n");
console.log("build-site: verified " + pages.length + " Astro static pages in " + webDist);
