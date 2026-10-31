import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { serviceDefinitions, serviceOriginsSchema } from "../packages/site-config/src/index.ts";
import { workspacePnpm } from "./workspace-pnpm.mjs";

const root = path.resolve(import.meta.dirname, "..");

function publicUrl(value, name, originOnly) {
  const text = value?.trim() ?? "";
  if (text.length === 0) return "";
  assert.ok(URL.canParse(text), name + " must be a public HTTPS URL");
  const url = new URL(text);
  assert.ok(
    url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      url.search === "" &&
      url.hash === "" &&
      !text.includes("?") &&
      !text.includes("#") &&
      url.hostname.includes(".") &&
      !/^(?:localhost|\[|\d+(?:\.\d+){3}$)/i.test(url.hostname) &&
      !/(?:^|\.)(?:localhost|local|internal)$/i.test(url.hostname) &&
      (!originOnly || url.pathname === "/"),
    name + " must be a public HTTPS URL without credentials, query or fragment",
  );
  return originOnly ? url.origin : url.href.replace(/\/$/, "");
}

const target = process.argv[2] ?? "products";
assert.ok(["products", "furusato", "securities"].includes(target), "Unknown site target");
const currentService = target;
let categories = [];
if (target === "products") {
  workspacePnpm("build:api-libraries");
  workspacePnpm("--filter", "@app/backend", "exec", "tsc", "--noEmit", "false", "--outDir", "dist");
  const { publicConsumerCatalog } = await import(
    pathToFileURL(path.join(root, "packages/backend/dist/comparison/consumer-catalog.js")).href
  );
  categories = publicConsumerCatalog();
  assert.ok(Array.isArray(categories) && categories.length > 0);
  assert.ok(categories.every((category) => /^[a-z][a-z0-9_-]{0,63}$/.test(category.id)));
}
const siteOrigin = publicUrl(process.env["SITE_ORIGIN"], "SITE_ORIGIN", true);
const apiBase = publicUrl(process.env["PUBLIC_API_BASE"], "PUBLIC_API_BASE", false);
const serviceOrigins = serviceOriginsSchema.parse(
  Object.fromEntries(
    serviceDefinitions.map((service) => {
      const configured = process.env[service.id.toUpperCase() + "_SITE_ORIGIN"];
      assert.ok(
        (siteOrigin.length === 0 && apiBase.length === 0 && process.env.CF_PAGES !== "1") ||
          configured !== undefined,
        "Set all three *_SITE_ORIGIN variables for production builds",
      );
      return [service.id, configured ?? "http://127.0.0.1:" + service.port];
    }),
  ),
);
assert.ok(
  siteOrigin.length === 0 || serviceOrigins[currentService] === siteOrigin,
  "SITE_ORIGIN must match the current service origin",
);
if (siteOrigin.length > 0) {
  assert.ok(
    Object.values(serviceOrigins).every((value) => value.startsWith("https://")),
    "Production service origins must use HTTPS",
  );
}
const modes = [
  { id: "price", label: "価格比較", heading: "類似商品の価格比較" },
  { id: "recommendation", label: "おすすめ比較", heading: "類似商品のおすすめランキング" },
  { id: "specifications", label: "項目別比較", heading: "類似商品のスコア比較" },
];
const pages = [];
function page(
  route,
  title,
  description,
  heading,
  intro,
  kind,
  links = [],
  breadcrumbs = [],
  labels = [],
) {
  pages.push({ route, title, description, heading, intro, kind, links, breadcrumbs, labels });
}
page(
  "/",
  "家電・PCの商品比較",
  "商品URLから、新品の価格と100点の比較スコアを確認できます。",
  "家電・PCの商品比較",
  "商品URLから、入力商品と最大5候補を比較できます。",
  "home",
  categories.map((category) => ({ href: "/category/" + category.id + "/", label: category.label })),
);
// Keep the existing entry point; furusato UI and business logic are outside this migration.
page(
  "/furusato/",
  "ふるさと納税の返礼品比較",
  "楽天ふるさと納税・さとふるの返礼品を、寄付額・内容量・配送条件で比較できます。",
  "ふるさと納税の返礼品比較",
  "楽天ふるさと納税・さとふるの寄付額・内容量・配送条件を比較できます。",
  "furusato",
  [],
  [{ name: "ふるさと納税", route: "/furusato/" }],
);
page(
  "/methodology/",
  "比較の考え方",
  "価格は円、確認済み数値の比較スコアは100点で表示します。",
  "比較の考え方",
  "新品の価格は円、確認済み数値の相対スコアは100点で表示します。未確認の値は「—」です。",
  "methodology",
  [],
  [{ name: "比較の考え方", route: "/methodology/" }],
);
for (const category of categories) {
  const route = "/category/" + category.id + "/";
  const labels = [
    "価格（円）",
    "総合（100点）",
    ...category.axes
      .filter((axis) => axis.id !== "price")
      .map((axis) => {
        assert.ok(category.fields.some((field) => field.id === axis.id && field.kind === "number"));
        return axis.label + "（100点）";
      }),
  ];
  const links = modes.map((mode) => ({
    href: "/compare/" + category.id + "/" + mode.id + "/",
    label: mode.label,
  }));
  const breadcrumbs = [{ name: category.label, route }];
  page(
    route,
    category.label + "の比較",
    category.label + "の新品を、価格と100点の比較スコアで比べられます。",
    category.label + "の比較",
    labels.join("・"),
    "category",
    links,
    breadcrumbs,
    labels,
  );
  for (const mode of modes) {
    const compareRoute = "/compare/" + category.id + "/" + mode.id + "/";
    page(
      compareRoute,
      category.label + " · " + mode.label,
      category.label + "の" + mode.label + "。価格は円、比較スコアは100点で表示します。",
      mode.heading + "（" + category.label + "）",
      labels.join("・"),
      "comparison",
      [{ href: route, label: category.label }, ...links],
      [...breadcrumbs, { name: mode.label, route: compareRoute }],
      labels,
    );
  }
}
// Previously these routes relied on a SPA fallback. Export real files for Apache hosting.
for (const [id, label] of [
  ["charger", "充電器比較"],
  ["monitor", "仕事用モニター比較"],
]) {
  const route = "/compare/" + id + "/";
  page(route, label, label + "の動作確認画面です。", label, "商品URLから比較します。", "legacy");
}
assert.equal(new Set(pages.map((entry) => entry.route)).size, pages.length);
const selectedPages =
  target === "products"
    ? pages.filter((entry) => entry.kind !== "furusato")
    : target === "furusato"
      ? pages
          .filter((entry) => entry.kind === "furusato")
          .map((entry) => ({ ...entry, route: "/", breadcrumbs: [] }))
      : [
          {
            route: "/",
            title: "証券会社の比較｜手数料・NISA・積立ポイント",
            description:
              "SBI・楽天・マネックスの手数料と積立ポイントを、公式の適用条件に基づいて比較できます。",
            heading: "証券会社の比較",
            intro: "条件を入力して手数料・積立ポイントを比較できます。",
            kind: "securities",
            links: [],
            breadcrumbs: [],
            labels: [],
          },
        ];
const generated = path.join(root, "apps", target, ".generated");
mkdirSync(generated, { recursive: true });
writeFileSync(
  path.join(generated, "site.json"),
  JSON.stringify({ siteOrigin, apiBase, serviceOrigins, pages: selectedPages }, null, 2) + "\n",
);
console.log(
  "prepare-site: " +
    target +
    " " +
    selectedPages.length +
    " routes from the backend catalog (no provider requests)",
);
