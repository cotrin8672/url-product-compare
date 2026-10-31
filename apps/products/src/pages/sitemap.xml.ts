import site from "../../.generated/site.json" with { type: "json" };
import { guides, informationPages } from "../content/editorial.js";

export function GET(): Response {
  const urls =
    site.siteOrigin.length === 0
      ? []
      : [
          ...site.pages.filter((page) => page.kind !== "legacy"),
          { route: "/guides/" },
          ...guides.map((guide) => ({ route: `/guides/${guide.slug}/` })),
          ...informationPages.map((page) => ({ route: `/${page.slug}/` })),
        ];
  const body =
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map((page) => "  <url><loc>" + site.siteOrigin + page.route + "</loc></url>").join("\n") +
    "\n</urlset>\n";
  return new Response(body, { headers: { "content-type": "application/xml; charset=utf-8" } });
}
