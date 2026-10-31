import site from "../../.generated/site.json" with { type: "json" };

export function GET(): Response {
  const body =
    site.siteOrigin.length > 0
      ? "User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /jobs/\nDisallow: /results/\nSitemap: " +
        site.siteOrigin +
        "/sitemap.xml\n"
      : "User-agent: *\nDisallow: /\n";
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
}
