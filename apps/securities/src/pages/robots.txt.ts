export function GET(): Response {
  // Preserve the existing launch hold until the securities conditions are reviewed.
  return new Response("User-agent: *\nDisallow: /\n", {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
