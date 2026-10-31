import site from "../../.generated/site.json" with { type: "json" };

export function GET(): Response {
  const urls =
    site.siteOrigin.length === 0
      ? []
      : site.pages.filter((page) => page.kind !== "legacy" && page.kind !== "securities");
  const body =
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map((page) => "  <url><loc>" + site.siteOrigin + page.route + "</loc></url>").join("\n") +
    "\n</urlset>\n";
  return new Response(body, { headers: { "content-type": "application/xml; charset=utf-8" } });
}
