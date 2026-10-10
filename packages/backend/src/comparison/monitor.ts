import { err, ok } from "./algebra.js";
import type { Result } from "./algebra.js";
import { readNumericSpecification } from "./product-information.js";
import { record } from "./values.js";
import type { Schema, SchemaError } from "./values.js";

export type MonitorSpecifications = Readonly<{
  screenSizeInches: number | null;
  resolutionWidthPx: number | null;
  resolutionHeightPx: number | null;
  refreshRateHz: number | null;
  usbCPowerW: number | null;
  usbCVideo: boolean | null;
  hdmiPorts: number | null;
  displayPortPorts: number | null;
  heightAdjustable: boolean | null;
  warrantyMonths: number | null;
}>;
export type MonitorConditions = Readonly<{
  screenSize: 24 | 27 | 32 | null;
  minResolution: "qhd" | "4k" | null;
  usbCPowerW: 0 | 65 | 90;
  heightAdjustable: boolean;
}>;
export const monitorConditionsSchema: Schema<MonitorConditions> = Object.freeze({
  parse(input: unknown): Result<MonitorConditions, SchemaError> {
    if (
      !record(input) ||
      Object.keys(input).length !== 4 ||
      (input["screenSize"] !== null &&
        input["screenSize"] !== 24 &&
        input["screenSize"] !== 27 &&
        input["screenSize"] !== 32) ||
      (input["minResolution"] !== null &&
        input["minResolution"] !== "qhd" &&
        input["minResolution"] !== "4k") ||
      (input["usbCPowerW"] !== 0 && input["usbCPowerW"] !== 65 && input["usbCPowerW"] !== 90) ||
      typeof input["heightAdjustable"] !== "boolean"
    ) {
      return err({ code: "invalid_data", field: "monitor_conditions" } satisfies SchemaError);
    }
    const screenSize = input["screenSize"];
    return ok(
      Object.freeze({
        screenSize,
        minResolution: input["minResolution"],
        usbCPowerW: input["usbCPowerW"],
        heightAdjustable: input["heightAdjustable"],
      }),
    );
  },
});

/** Only explicit, labelled API facts are accepted. Ambiguous values stay unknown. */
export function readMonitorSpecifications(input: string): MonitorSpecifications {
  const text = input.normalize("NFKC");
  const number = (pattern: RegExp, min: number, max: number): number | null => {
    const parsed = [...text.matchAll(pattern)].map((match) => Number(match[1]));
    if (parsed.some((value) => !Number.isFinite(value) || value < min || value > max)) {
      return null;
    }
    const values = new Set(parsed);
    return values.size === 1 ? ([...values][0] ?? null) : null;
  };
  const flag = (pattern: RegExp): boolean | null => {
    const values = new Set(
      [...text.matchAll(pattern)].map(
        (match) => !/非対応|なし|不可|no|false/i.test(match[1] ?? ""),
      ),
    );
    return values.size === 1 ? ([...values][0] ?? null) : null;
  };
  const resolutions = [
    ...text.matchAll(
      /(?:最大解像度|解像度|resolution)\s*[:：]?\s*(\d{3,4})\s*[×x*]\s*(\d{3,4})(?!\d)/gi,
    ),
  ].filter(
    (match) =>
      Number(match[1]) >= 640 &&
      Number(match[1]) <= 7680 &&
      Number(match[2]) >= 480 &&
      Number(match[2]) <= 4320,
  );
  const uniqueResolution = new Set(
    resolutions.map((match) => `${Number(match[1])}x${Number(match[2])}`),
  );
  const resolution = uniqueResolution.size === 1 ? resolutions[0] : undefined;
  return Object.freeze({
    screenSizeInches: number(
      /(?:画面サイズ|パネルサイズ|対角サイズ|screen\s*size)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(?:インチ|型|inch(?:es)?)/gi,
      10,
      100,
    ),
    resolutionWidthPx: resolution === undefined ? null : Number(resolution[1]),
    resolutionHeightPx: resolution === undefined ? null : Number(resolution[2]),
    refreshRateHz: number(
      /(?:最大リフレッシュレート|リフレッシュレート|refresh\s*rate)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*Hz/gi,
      30,
      500,
    ),
    usbCPowerW: number(
      /USB\s*(?:Type\s*)?[- ]?C\s*(?:給電|電力供給|PD|power\s*delivery)\s*[:：]?\s*(?:最大|max\.?\s*)?(\d+(?:\.\d+)?)\s*W/gi,
      0,
      240,
    ),
    usbCVideo: flag(
      /USB\s*(?:Type\s*)?[- ]?C\s*(?:映像入力|映像対応|DisplayPort\s*Alt\s*Mode)\s*[:：]?\s*(非対応|対応|なし|あり|不可|可|yes|no|true|false)(?=[\s。;；,，]|$)/gi,
    ),
    hdmiPorts: number(/HDMI\s*(?:端子数|ポート数|入力数)\s*[:：]?\s*(\d+)(?![\d.])/gi, 0, 8),
    displayPortPorts: number(
      /DisplayPort\s*(?:端子数|ポート数|入力数)\s*[:：]?\s*(\d+)(?![\d.])/gi,
      0,
      8,
    ),
    heightAdjustable: flag(
      /(?:高さ調整|昇降機能|height\s*adjustment)\s*[:：]?\s*(非対応|対応|なし|あり|不可|可|yes|no|true|false)(?=[\s。;；,，]|$)/gi,
    ),
    warrantyMonths: readNumericSpecification("warrantyMonths", text),
  });
}

type Listing = Readonly<{
  listingId: string;
  identityVerified?: boolean;
  tax: "included" | "excluded";
  availability: "available" | "unavailable";
  price: Readonly<{ minimum: number; maximum: number }>;
  monitorSpecifications?: MonitorSpecifications;
}>;

export function compareMonitorListings<T extends Listing>(
  listings: readonly T[],
  conditions: MonitorConditions,
  sort: "price" | "specifications",
): Readonly<{
  status: "compared" | "ranked" | "needs_information" | "no_match";
  products: ReadonlyArray<
    T &
      Readonly<{
        status: "eligible" | "excluded" | "pending";
        rank: number | null;
        reasons: readonly string[];
      }>
  >;
}> {
  const assessed = listings.map((listing) => {
    const specs = listing.monitorSpecifications;
    const missing: string[] = [];
    const excluded: string[] = [];
    if (listing.availability === "unavailable") {
      excluded.push("unavailable");
    }
    const check = (
      value: number | boolean | null | undefined,
      passes: boolean,
      reason: string,
    ): void => {
      if (value === null || value === undefined) {
        missing.push(`${reason}_unknown`);
      } else if (!passes) {
        excluded.push(reason);
      }
    };
    check(listing.identityVerified === true ? true : null, true, "identity");
    check(
      specs?.screenSizeInches,
      specs !== undefined &&
        specs.screenSizeInches !== null &&
        specs.screenSizeInches >= 23 &&
        specs.screenSizeInches <= 32 &&
        (conditions.screenSize === null ||
          Math.abs(specs.screenSizeInches - conditions.screenSize) <= 1),
      "screen_size",
    );
    if (conditions.minResolution !== null) {
      const width = conditions.minResolution === "4k" ? 3840 : 2560;
      const height = conditions.minResolution === "4k" ? 2160 : 1440;
      check(specs?.resolutionWidthPx, (specs?.resolutionWidthPx ?? 0) >= width, "resolution_width");
      check(
        specs?.resolutionHeightPx,
        (specs?.resolutionHeightPx ?? 0) >= height,
        "resolution_height",
      );
    }
    if (conditions.usbCPowerW > 0) {
      check(specs?.usbCVideo, specs?.usbCVideo === true, "usb_c_video");
      check(specs?.usbCPowerW, (specs?.usbCPowerW ?? -1) >= conditions.usbCPowerW, "usb_c_power");
    }
    if (conditions.heightAdjustable) {
      check(specs?.heightAdjustable, specs?.heightAdjustable === true, "height_adjustment");
    }
    return Object.freeze({
      ...listing,
      status:
        excluded.length > 0
          ? ("excluded" as const)
          : missing.length > 0
            ? ("pending" as const)
            : ("eligible" as const),
      reasons: Object.freeze([...excluded, ...missing]),
    });
  });
  const eligible = assessed.filter((listing) => listing.status === "eligible");
  const canRank =
    sort === "price" &&
    eligible.length > 0 &&
    assessed.every((listing) => listing.status !== "pending") &&
    eligible.every(
      (listing) =>
        listing.tax === "included" &&
        listing.price.minimum > 0 &&
        listing.price.minimum === listing.price.maximum,
    );
  return Object.freeze({
    status:
      assessed.some((listing) => listing.status === "pending") ||
      (sort === "price" && eligible.length > 0 && !canRank)
        ? "needs_information"
        : eligible.length === 0
          ? "no_match"
          : canRank
            ? "ranked"
            : "compared",
    products: Object.freeze(
      assessed
        .map((listing) =>
          Object.freeze({
            ...listing,
            rank:
              canRank && listing.status === "eligible"
                ? 1 + eligible.filter((other) => other.price.minimum < listing.price.minimum).length
                : null,
          }),
        )
        .toSorted((a, b) => {
          const difference = (a.rank ?? 100) - (b.rank ?? 100);
          return difference === 0 ? a.listingId.localeCompare(b.listingId) : difference;
        }),
    ),
  });
}
