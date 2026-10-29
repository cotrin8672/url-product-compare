import { record } from "../../comparison/values.js";

export function stringValue(input: unknown, maximum = 2048): string | null {
  return typeof input === "string" && input.trim().length > 0 && input.length <= maximum
    ? input
    : null;
}

export function natural(input: unknown): number | null {
  const value = typeof input === "string" && /^\d+(?:\.\d+)?$/.test(input) ? Number(input) : input;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function publicUrl(input: unknown, hosts: readonly string[]): URL | null {
  if (typeof input !== "string" || input.length > 4096) {
    return null;
  }
  try {
    const url = new URL(input);
    return url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      (url.port === "" || url.port === "443") &&
      hosts.includes(url.hostname)
      ? url
      : null;
  } catch {
    return null;
  }
}

export function vcLink(
  input: unknown,
  destination: URL,
  siteId: string,
  spaceId: string,
): string | null {
  const url = publicUrl(input, ["ck.jp.ap.valuecommerce.com"]);
  if (url?.pathname !== "/servlet/referral") {
    return null;
  }
  const parameters = url.searchParams;
  const site = parameters.getAll("sid").length === 1 ? parameters.get("sid") : parameters.get("vs");
  const space =
    parameters.getAll("pid").length === 1 ? parameters.get("pid") : parameters.get("vp");
  if (
    site !== siteId ||
    space !== spaceId ||
    (parameters.has("sid") && parameters.has("vs")) ||
    (parameters.has("pid") && parameters.has("vp")) ||
    ["sid", "vs", "pid", "vp", "vc_url"].some((key) => parameters.getAll(key).length > 1) ||
    parameters.getAll("vc_url").length !== 1 ||
    parameters.get("vc_url") !== destination.href
  ) {
    return null;
  }
  return url.href;
}

export function cleanDescription(input: unknown, maximum = 65536): string | null {
  if (typeof input !== "string" || input.length > maximum) {
    return null;
  }
  return input
    .replace(
      /<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>\s*<td\b[^>]*>([\s\S]*?)<\/td>/gi,
      (_match: string, label: string, value: string) =>
        `${label.replace(/<[^>]*>/g, " ")}: ${value.replace(/<[^>]*>/g, " ")}\n`,
    )
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<(?:br|\/p|\/div|\/tr|\/li)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .trim();
}

export function authorization(input: unknown): Readonly<{ authorizedUntil: string; ai: boolean }> {
  if (
    !record(input) ||
    typeof input["authorizedUntil"] !== "string" ||
    !Number.isFinite(Date.parse(input["authorizedUntil"])) ||
    new Date(input["authorizedUntil"]).toISOString() !== input["authorizedUntil"] ||
    (input["aiAuthorized"] !== undefined && typeof input["aiAuthorized"] !== "boolean")
  ) {
    throw new Error("Invalid commerce authorization settings");
  }
  return Object.freeze({
    authorizedUntil: input["authorizedUntil"],
    ai: input["aiAuthorized"] === true,
  });
}
