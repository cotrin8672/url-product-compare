import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

import { guides, informationPages } from "../apps/products/src/content/editorial.ts";
import { workspacePnpm } from "./workspace-pnpm.mjs";

const root = path.resolve(import.meta.dirname, "..");
const target = process.argv[2] ?? "products";
assert.ok(["products", "furusato", "securities"].includes(target), "Unknown site target");
workspacePnpm("--filter", "@app/" + target, "build");
const { siteOrigin, apiBase, serviceOrigins, pages } = JSON.parse(
  readFileSync(path.join(root, "apps/" + target + "/.generated/site.json"), "utf8"),
);
const webDist = path.join(root, "apps/" + target + "/dist");
const editorialPages =
  target === "products"
    ? [
        { route: "/guides/", title: "選び方ガイド", kind: "editorial", labels: [] },
        ...guides.map((guide) => ({
          route: `/guides/${guide.slug}/`,
          title: guide.title,
          kind: "editorial",
          labels: [],
        })),
        ...informationPages.map((page) => ({
          route: `/${page.slug}/`,
          title: page.title,
          kind: "editorial",
          labels: [],
        })),
      ]
    : [];
const titles = new Set();
const escapeHtml = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
const publicPages = pages.filter((page) => page.kind !== "legacy" && page.kind !== "securities");
assert.equal(new Set(pages.map((page) => page.route)).size, pages.length, "Duplicate public route");
const allPages = [...pages, ...editorialPages];
assert.equal(
  new Set(allPages.map((page) => page.route)).size,
  allPages.length,
  "Editorial route collision",
);
if (target === "products") {
  assert.equal(guides.length, 10, "Missing buying guides");
  assert.equal(informationPages.length, 4, "Missing permanent information pages");
}
assert.equal(
  publicPages.length,
  target === "products"
    ? 2 + pages.filter((page) => page.kind === "category").length * 4
    : target === "furusato"
      ? 1
      : 0,
  "Missing public route",
);
for (const page of allPages) {
  const html = readFileSync(path.join(webDist, page.route.slice(1), "index.html"), "utf8");
  const title = html.match(/<title>([^<]+)<\/title>/)?.[1];
  assert.equal(title, escapeHtml(page.title));
  assert.ok(!titles.has(title), "Page title must be unique: " + page.route);
  titles.add(title);
  assert.equal((html.match(/<h1[ >]/g) ?? []).length, 1, "Missing no-JS heading: " + page.route);
  assert.ok(html.includes('id="public-content"') && html.includes("<p>"));
  for (const [service, origin] of Object.entries(serviceOrigins)) {
    assert.ok(
      html.includes('name="service-' + service + '" content="' + escapeHtml(origin) + '"'),
      "Missing service configuration: " + service,
    );
    assert.ok(
      html.includes('href="' + escapeHtml(origin) + '/"'),
      "Missing crawlable service link: " + service,
    );
  }
  const apiMeta = html.match(/<meta name="api-base" content(?:="([^"]*)")?>/);
  assert.notEqual(apiMeta, null, "Missing API configuration: " + page.route);
  assert.equal(
    apiMeta?.[1] ?? "",
    escapeHtml(apiBase),
    "API configuration mismatch: " + page.route,
  );
  assert.equal((html.match(/<link rel="canonical"/g) ?? []).length, siteOrigin.length > 0 ? 1 : 0);
  if (siteOrigin.length > 0) assert.ok(html.includes('href="' + siteOrigin + page.route + '"'));
  if (siteOrigin.length === 0 || page.kind === "legacy" || page.kind === "securities")
    assert.ok(html.includes('content="noindex,nofollow"'));
  for (const label of page.labels)
    assert.ok(html.includes(escapeHtml(label)), "Score label missing: " + label);
  // A static host must not need inline bootstrap code or a Node/Astro runtime.
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  // Comparison routes retain the browser entry. Editorial-only pages must remain readable without it.
  if (page.kind !== "editorial" && page.kind !== "methodology")
    assert.ok(
      scripts.some((script) => /type="module"/.test(script[1]) && /src="/.test(script[1])),
      "Missing browser entry",
    );
  if (page.kind === "editorial" || page.kind === "methodology") {
    assert.ok(html.includes("編集・広告掲載方針"), "Missing policy navigation");
    assert.ok(html.includes('id="main-content"'), "Missing editorial content");
    assert.equal(
      html.includes('id="app"'),
      false,
      "Editorial pages must not mount the comparison app",
    );
    assert.equal(
      scripts.some((script) => /type="module"/.test(script[1])),
      false,
      "Editorial content must not depend on the comparison bundle",
    );
  }
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
if (target === "products") {
  assert.equal(
    existsSync(path.join(webDist, "furusato/index.html")),
    false,
    "Furusato must deploy independently",
  );
  assert.equal(
    existsSync(path.join(webDist, "securities/index.html")),
    false,
    "Securities must deploy independently",
  );
} else {
  assert.equal(
    existsSync(path.join(webDist, "category")),
    false,
    "Product routes leaked into a service site",
  );
}
const robots = readFileSync(path.join(webDist, "robots.txt"), "utf8");
const sitemap = readFileSync(path.join(webDist, "sitemap.xml"), "utf8");
assert.ok(!/\/jobs\/|\/results\/|\/api\//.test(sitemap), "Private route in sitemap");
assert.equal(
  (sitemap.match(/<loc>/g) ?? []).length,
  siteOrigin.length > 0 ? publicPages.length + editorialPages.length : 0,
);
if (siteOrigin.length > 0 && target !== "securities") {
  assert.ok(robots.includes("Sitemap: " + siteOrigin + "/sitemap.xml"));
  for (const page of [...publicPages, ...editorialPages]) {
    assert.ok(sitemap.includes("<loc>" + siteOrigin + page.route + "</loc>"));
    if (page.route !== "/") assert.ok(!robots.includes("Disallow: " + page.route));
  }
} else assert.equal(robots, "User-agent: *\nDisallow: /\n");
console.log("build-site: verified " + pages.length + " Astro static pages in " + webDist);
