/** Request a display-sized image from Rakuten's thumbnail CDN without changing the source image. */
export function productImageUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return input;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "thumbnail.image.rakuten.co.jp" ||
    url.port.length > 0 ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    !["64x64", "128x128"].includes(url.searchParams.get("_ex") ?? "")
  ) {
    return input;
  }
  url.searchParams.set("_ex", "512x512");
  return url.href;
}
