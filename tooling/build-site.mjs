import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const webDist = path.join(root, "apps/web/dist");
const mise = process.platform === "win32" ? "rtk mise" : "mise";

function publicUrl(value, name, originOnly) {
  const text = value?.trim() ?? "";
  if (text.length === 0) {
    return "";
  }
  if (!URL.canParse(text)) {
    throw new Error(`${name} must be a public HTTPS URL`);
  }
  const url = new URL(text);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    text.includes("?") ||
    text.includes("#") ||
    !url.hostname.includes(".") ||
    /^(?:localhost|\[|\d+(?:\.\d+){3}$)/i.test(url.hostname) ||
    /(?:^|\.)(?:localhost|local|internal)$/i.test(url.hostname) ||
    (originOnly && url.pathname !== "/")
  ) {
    throw new Error(
      `${name} must be a public HTTPS ${originOnly ? "origin" : "URL"} without credentials, query or fragment`,
    );
  }
  return originOnly ? url.origin : url.href.replace(/\/$/, "");
}

const siteOrigin = publicUrl(process.env["SITE_ORIGIN"], "SITE_ORIGIN", true);
const apiBase = publicUrl(process.env["PUBLIC_API_BASE"], "PUBLIC_API_BASE", false);
const robots = siteOrigin.length > 0 ? "index,follow" : "noindex,nofollow";
execSync(`${mise} exec -- pnpm --filter @app/backend exec tsc --noEmit false --outDir dist`, {
  cwd: root,
  stdio: "inherit",
});
const { publicConsumerCatalog } = await import(
  pathToFileURL(path.join(root, "packages/backend/dist/comparison/consumer-catalog.js")).href
);
const categories = publicConsumerCatalog();
if (
  !Array.isArray(categories) ||
  categories.length === 0 ||
  categories.some((category) => !/^[a-z][a-z0-9_-]{0,63}$/.test(category.id))
) {
  throw new Error("Public consumer catalog is invalid");
}
execSync(`${mise} exec -- pnpm --filter @app/web build`, { cwd: root, stdio: "inherit" });
const builtHtml = readFileSync(path.join(webDist, "index.html"), "utf8");
const css = builtHtml.match(/href="([^"]+\.css)"/)?.[1];
const script = builtHtml.match(/src="([^"]+\.js)"/)?.[1];
if (css === undefined || script === undefined) {
  throw new Error("Web build did not produce its stylesheet and script");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function scoreLabels(category) {
  return [
    "価格（円）",
    "総合（100点）",
    ...category.axes
      .filter((axis) => axis.id !== "price")
      .map((axis) => {
        if (!category.fields.some((field) => field.id === axis.id && field.kind === "number")) {
          throw new Error(`Unknown numeric score field: ${category.id}.${axis.id}`);
        }
        return `${axis.label}（100点）`;
      }),
  ];
}

const publicRoutes = [];
function writePage(route, title, description, body, breadcrumbs = []) {
  const directory = path.join(webDist, route.slice(1));
  mkdirSync(directory, { recursive: true });
  const prefix = "../".repeat(route.split("/").filter((entry) => entry.length > 0).length) || "./";
  const canonical = siteOrigin.length > 0 ? `${siteOrigin}${route}` : null;
  const breadcrumbJson =
    canonical === null || breadcrumbs.length === 0
      ? ""
      : `<script type="application/ld+json">${JSON.stringify({
          "@context": "https://schema.org",
          "@type": "BreadcrumbList",
          itemListElement: [{ name: "商品比較", route: "/" }, ...breadcrumbs].map(
            (entry, index) => ({
              "@type": "ListItem",
              position: index + 1,
              name: entry.name,
              item: `${siteOrigin}${entry.route}`,
            }),
          ),
        }).replaceAll("<", "\\u003c")}</script>`;
  writeFileSync(
    path.join(directory, "index.html"),
    `<!doctype html>
<html lang="ja"><head>
<meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="api-base" content="${escapeHtml(apiBase)}" />
<title>${escapeHtml(title)}</title><meta name="description" content="${escapeHtml(description)}" />
<meta name="robots" content="${robots}" />
${canonical === null ? "" : `<link rel="canonical" href="${escapeHtml(canonical)}" />`}
<link rel="stylesheet" href="${prefix}${css.replace(/^\.?\//, "")}" />${breadcrumbJson}
</head><body>
<header class="public-site-nav"><nav aria-label="サイト"><a href="/">商品比較</a> · <a href="#public-content">比較ページ</a></nav></header>
<section id="public-content" class="public-content" aria-label="商品比較">${body}</section>
<noscript><p>比較の実行にはJavaScriptを有効にしてください。</p></noscript>
<div id="app"></div><script type="module" src="${prefix}${script.replace(/^\.?\//, "")}"></script>
</body></html>`,
    "utf8",
  );
  publicRoutes.push(route);
}

writePage(
  "/",
  "家電・PCの商品比較",
  "商品URLから、新品の価格と100点の比較スコアを確認できます。",
  `<h1>家電・PCの商品比較</h1>
<p>商品URLから、入力商品と最大5候補を比較できます。</p>
<nav aria-label="カテゴリ"><ul class="public-categories">${categories.map((category) => `<li><a href="/category/${category.id}/">${escapeHtml(category.label)}</a></li>`).join("")}</ul></nav>`,
);

writePage(
  "/methodology/",
  "比較の考え方",
  "価格は円、確認済み数値の比較スコアは100点で表示します。",
  `<h1>比較の考え方</h1>
<p>新品の価格は円、確認済み数値の相対スコアは100点で表示します。未確認の値は「—」です。</p>`,
  [{ name: "比較の考え方", route: "/methodology/" }],
);

const modes = [
  { id: "price", label: "価格比較", heading: "類似商品の価格比較" },
  { id: "recommendation", label: "おすすめ比較", heading: "類似商品のおすすめランキング" },
  { id: "specifications", label: "項目別比較", heading: "類似商品のスコア比較" },
];
for (const category of categories) {
  const route = `/category/${category.id}/`;
  const labels = scoreLabels(category);
  const categoryBody = `<h1>${escapeHtml(category.label)}の比較</h1>
<p>${labels.map(escapeHtml).join("・")}</p>
<nav aria-label="比較方法"><ul>${modes.map((mode) => `<li><a href="/compare/${category.id}/${mode.id}/">${escapeHtml(mode.label)}</a></li>`).join("")}</ul></nav>`;
  writePage(
    route,
    `${category.label}の比較`,
    `${category.label}の新品を、価格と100点の比較スコアで比べられます。`,
    categoryBody,
    [{ name: category.label, route }],
  );
  for (const mode of modes) {
    const compareRoute = `/compare/${category.id}/${mode.id}/`;
    writePage(
      compareRoute,
      `${category.label} · ${mode.label}`,
      `${category.label}の${mode.label}。価格は円、比較スコアは100点で表示します。`,
      `<h1>${mode.heading}（${escapeHtml(category.label)}）</h1>
<p>${labels.map(escapeHtml).join("・")}</p>
<nav aria-label="比較方法"><a href="${route}">${escapeHtml(category.label)}</a> · ${modes.map((entry) => `<a href="/compare/${category.id}/${entry.id}/">${escapeHtml(entry.label)}</a>`).join(" · ")}</nav>`,
      [
        { name: category.label, route },
        { name: mode.label, route: compareRoute },
      ],
    );
  }
}

writeFileSync(
  path.join(webDist, "robots.txt"),
  siteOrigin.length > 0
    ? `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /jobs/\nDisallow: /results/\nSitemap: ${siteOrigin}/sitemap.xml\n`
    : "User-agent: *\nDisallow: /\n",
  "utf8",
);
if (siteOrigin.length > 0) {
  writeFileSync(
    path.join(webDist, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${publicRoutes.map((route) => `  <url><loc>${siteOrigin}${route}</loc></url>`).join("\n")}\n</urlset>\n`,
    "utf8",
  );
}

function verifySite() {
  if (
    new Set(publicRoutes).size !== publicRoutes.length ||
    publicRoutes.length !== 2 + categories.length * 4
  ) {
    throw new Error("Duplicate or missing public route");
  }
  const titles = new Set();
  for (const route of publicRoutes) {
    const html = readFileSync(path.join(webDist, route.slice(1), "index.html"), "utf8");
    const title = html.match(/<title>([^<]+)<\/title>/)?.[1];
    if (
      title === undefined ||
      titles.has(title) ||
      (html.match(/<h1[ >]/g) ?? []).length !== 1 ||
      !html.includes('id="public-content"') ||
      !html.includes("<p>")
    ) {
      throw new Error(`Missing unique title or no-JS content: ${route}`);
    }
    titles.add(title);
    const canonicals = html.match(/<link rel="canonical"/g) ?? [];
    if (
      canonicals.length !== (siteOrigin.length > 0 ? 1 : 0) ||
      (siteOrigin.length > 0 && !html.includes(`href="${siteOrigin}${route}"`)) ||
      (siteOrigin.length === 0 && !html.includes('content="noindex,nofollow"'))
    ) {
      throw new Error(`Invalid canonical or robots metadata: ${route}`);
    }
  }
  const robotsText = readFileSync(path.join(webDist, "robots.txt"), "utf8");
  if (siteOrigin.length > 0) {
    const sitemap = readFileSync(path.join(webDist, "sitemap.xml"), "utf8");
    if (
      (sitemap.match(/<loc>/g) ?? []).length !== publicRoutes.length ||
      /<loc>[^<]*\?/.test(sitemap) ||
      /\/jobs\/|\/results\/|\/api\//.test(sitemap)
    ) {
      throw new Error("Sitemap contains duplicate or private routes");
    }
    for (const route of publicRoutes) {
      if (
        !sitemap.includes(`<loc>${siteOrigin}${route}</loc>`) ||
        (route !== "/" && robotsText.includes(`Disallow: ${route}`))
      ) {
        throw new Error(`Public route absent or blocked: ${route}`);
      }
    }
  }
  for (const category of categories) {
    for (const route of [
      `/category/${category.id}/`,
      ...modes.map((mode) => `/compare/${category.id}/${mode.id}/`),
    ]) {
      const html = readFileSync(path.join(webDist, route.slice(1), "index.html"), "utf8");
      if (!scoreLabels(category).every((label) => html.includes(escapeHtml(label)))) {
        throw new Error(`Score labels missing: ${route}`);
      }
    }
  }
}
verifySite();
console.log(`build-site: verified ${publicRoutes.length} public pages in ${webDist}`);
