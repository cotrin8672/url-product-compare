import { err, ok, sequence } from "../../comparison/algebra.js";
import type { Result } from "../../comparison/algebra.js";
import { productsSchema } from "../../comparison/catalog.js";
import { chargerSpecificationSchema } from "../../comparison/charger.js";
import type { ChargerSpecification } from "../../comparison/charger.js";
import { factSchema } from "../../comparison/ranking.js";
import type { Candidate } from "../../comparison/ranking.js";
import { record, valueOf } from "../../comparison/values.js";
import type { Instant } from "../../comparison/values.js";

type Configuration = ChargerSpecification["configurations"][number];
type Port = Configuration["ports"][number];
function port(
  id: string,
  maxPowerW: number,
  pd: ReadonlyArray<readonly [number, number]>,
  pps: ReadonlyArray<readonly [number, number, number]>,
): Port {
  return {
    port: id,
    maxPowerW,
    profiles: [
      ...pd.map(([voltageV, currentA]) => ({ protocol: "pd" as const, voltageV, currentA })),
      ...pps.map(([minVoltageV, maxVoltageV, currentA]) => ({
        protocol: "pps" as const,
        minVoltageV,
        maxVoltageV,
        currentA,
      })),
    ],
  };
}
const models = [
  {
    model: "MPA-ACCP4245WH",
    gtin: "4549550281829",
    color: "ホワイト",
    weightG: 88,
    dimensionsMm: [44, 38, 40.5],
    maxPowerW: 45,
    portCount: 2,
    fingerprint: "32a1e11b007721016011df1cfc4a2c9dadabe7c99e77de11ea0785fccc96f363",
    complete: true,
    configurations: [
      ...["C1", "C2"].map((id) => ({
        maxTotalPowerW: 45,
        ports: [
          port(
            id,
            45,
            [
              [5, 3],
              [9, 3],
              [12, 3],
              [15, 3],
              [20, 2.25],
            ],
            [[3.3, 16, 3]],
          ),
        ],
      })),
      {
        maxTotalPowerW: 45,
        ports: [
          port(
            "C1",
            25,
            [
              [5, 3],
              [9, 2.77],
            ],
            [
              [3.3, 5.9, 3],
              [3.3, 11, 2.75],
            ],
          ),
          port(
            "C2",
            20,
            [
              [5, 3],
              [9, 2.22],
            ],
            [
              [3.3, 5.9, 3],
              [3.3, 11, 2],
            ],
          ),
        ],
      },
    ],
  },
  {
    model: "MPA-ACCP4365BK",
    gtin: "4549550281836",
    color: "ブラック",
    weightG: 106,
    dimensionsMm: [52, 38, 40.5],
    maxPowerW: 65,
    portCount: 2,
    fingerprint: "3ab945815381f20bd8ed6609aa3c69f749f08825bb992d901d3dd6501535e9df",
    complete: true,
    configurations: [
      ...["C1", "C2"].map((id) => ({
        maxTotalPowerW: 65,
        ports: [
          port(
            id,
            65,
            [
              [5, 3],
              [9, 3],
              [12, 3],
              [15, 3],
              [20, 3.25],
            ],
            [[3.3, 21, 3.25]],
          ),
        ],
      })),
      {
        maxTotalPowerW: 65,
        ports: [
          port(
            "C1",
            45,
            [
              [5, 3],
              [9, 3],
              [12, 3],
              [15, 3],
              [20, 2.25],
            ],
            [[3.3, 16, 3]],
          ),
          port(
            "C2",
            20,
            [
              [5, 3],
              [9, 2.22],
            ],
            [
              [3.3, 5.9, 3],
              [3.3, 11, 2],
            ],
          ),
        ],
      },
    ],
  },
  {
    model: "MPA-AC113100BK",
    gtin: "4549550367592",
    color: "ブラック",
    weightG: 185,
    dimensionsMm: [55.5, 40.6, 46.6],
    maxPowerW: 100,
    portCount: 3,
    fingerprint: "b903f6e3eee90620118d5982cc761f330aab71f3148e4ea70e3684b3a1f1ff07",
    // The C2+C3 and three-port 5V modes do not establish PD/PPS negotiation.
    complete: false,
    configurations: [
      ...["C1", "C2", "C3"].map((id) => ({
        maxTotalPowerW: 100,
        ports: [
          port(
            id,
            100,
            [
              [5, 3],
              [9, 3],
              [15, 3],
              [20, 5],
            ],
            [[5, 21, 5]],
          ),
        ],
      })),
      ...["C2", "C3"].map((id) => ({
        maxTotalPowerW: 100,
        ports: [
          port(
            "C1",
            70,
            [
              [5, 3],
              [9, 3],
              [15, 3],
              [20, 3.5],
            ],
            [[5, 11, 5]],
          ),
          port(
            id,
            30,
            [
              [5, 3],
              [9, 3],
              [15, 2],
              [20, 1.5],
            ],
            [[5, 11, 3]],
          ),
        ],
      })),
    ],
  },
  {
    model: "MPA-AC12465BK",
    gtin: "4549550414449",
    color: "ブラック",
    weightG: 100,
    dimensionsMm: [42.5, 41.5, 41.5],
    maxPowerW: 65,
    portCount: 1,
    fingerprint: "b74c4354d282449886d47f722869b2dd0d8c13e661666f9ab2efeb264f8988f9",
    complete: true,
    configurations: [
      {
        maxTotalPowerW: 65,
        ports: [
          port(
            "C1",
            65,
            [
              [5, 3],
              [9, 3],
              [12, 3],
              [15, 3],
              [20, 3.25],
            ],
            [
              [5, 11, 4.05],
              [5, 21, 3.05],
            ],
          ),
        ],
      },
    ],
  },
] satisfies ReadonlyArray<
  Readonly<{
    model: string;
    gtin: string;
    color: string;
    weightG: number;
    dimensionsMm: readonly number[];
    maxPowerW: number;
    portCount: number;
    fingerprint: string;
    complete: boolean;
    configurations: readonly Configuration[];
  }>
>;

type OfficialInvestigation = Readonly<{
  mode: "official";
  notice: string;
  provider: "elecom";
  listingId: string;
  productId: string;
  title: string;
  canonicalUrl: string;
  observedAt: string;
  expiresAt: string;
  matchMethod: "manufacturer_model_gtin_variant";
  gtin: string;
  color: string;
  weightG: number;
  dimensionsMm: readonly number[];
  maxPowerW: number;
  portCount: number;
}>;
type OfficialCharger = Candidate &
  Readonly<{ specification: ChargerSpecification; investigation: OfficialInvestigation }>;
type OfficialError = Readonly<{
  code:
    | "unsupported_official_url"
    | "official_source_unavailable"
    | "official_specification_changed";
}>;

export function officialChargerUrlStatus(input: string): "supported" | "unsupported" | null {
  if (!URL.canParse(input) || new URL(input).hostname !== "www.elecom.co.jp") {
    return null;
  }
  return models.some((model) => input === `https://www.elecom.co.jp/products/${model.model}.html`)
    ? "supported"
    : "unsupported";
}

export async function loadOfficialCharger(
  input: string,
  now: Instant,
): Promise<Result<OfficialCharger, OfficialError>> {
  const model = models.find(
    (entry) => input === `https://www.elecom.co.jp/products/${entry.model}.html`,
  );
  if (model === undefined) {
    return err({ code: "unsupported_official_url" });
  }
  try {
    const response = await fetch(input, { redirect: "error", signal: AbortSignal.timeout(8_000) });
    if (
      !response.ok ||
      response.body === null ||
      response.headers.get("content-type")?.includes("text/html") !== true
    ) {
      return err({ code: "official_source_unavailable" });
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let html = "";
    let bytes = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      bytes += chunk.value.byteLength;
      if (bytes > 512_000) {
        await reader.cancel();
        return err({ code: "official_source_unavailable" });
      }
      html += decoder.decode(chunk.value, { stream: true });
    }
    html += decoder.decode();
    const jsonProducts: Array<Readonly<Record<string, unknown>>> = [];
    for (const match of html.matchAll(
      /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g,
    )) {
      const value: unknown = JSON.parse(match[1] ?? "null");
      if (record(value) && value["@type"] === "Product") {
        jsonProducts.push(value);
      }
    }
    const product = jsonProducts[0];
    const brand = product?.["brand"];
    const tables = [...html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/g)].filter(
      (match) => match[1]?.includes("定格入力電圧") === true,
    );
    const rows = [
      ...(tables[0]?.[1] ?? "").matchAll(
        /<tr[^>]*>\s*<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/g,
      ),
    ]
      .map((match) => [
        match[1]?.replace(/<[^>]*>/g, "").replace(/\s+/g, "") ?? "",
        match[2]?.replace(/<[^>]*>/g, "").replace(/\s+/g, "") ?? "",
      ])
      .filter(
        ([key]) =>
          key !== undefined &&
          /^(定格|コネクター形状|外形寸法|重量|カラー|コンセントプラグ仕様)/.test(key),
      )
      .toSorted((a, b) => (a[0] ?? "").localeCompare(b[0] ?? "", "en"));
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(rows)),
    );
    const fingerprint = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    if (
      jsonProducts.length !== 1 ||
      product?.["mpn"] !== model.model ||
      !record(brand) ||
      brand["name"] !== "ELECOM" ||
      /JANコード:\s*(\d{13})/.exec(html)?.[1] !== model.gtin ||
      tables.length !== 1 ||
      fingerprint !== model.fingerprint
    ) {
      return err({ code: "official_specification_changed" });
    }
    const observedAt = valueOf(now);
    const expiresAt = new Date(Date.parse(observedAt) + 900_000).toISOString();
    const evidence = { provider: "elecom", source: input, observedAt };
    const permissions = {
      fetch: { status: "granted", expiresAt },
      display: { status: "granted", expiresAt },
      store: { status: "denied" },
      ai: { status: "denied" },
      affiliate: { status: "denied" },
    };
    const products = productsSchema.parse([
      {
        productId: model.model,
        identity: {
          manufacturer: "ELECOM",
          model: model.model,
          gtin: model.gtin,
          variant: { status: "confirmed", color: model.color, capacity: null, packCount: 1 },
        },
        evidence,
        permissions,
      },
    ]);
    const specification = chargerSpecificationSchema.parse({
      kind: "ac-usb-c-charger",
      productId: model.model,
      evidence,
      permissions,
      expiresAt,
      input: { plug: "jp-a", minVoltageV: 100, maxVoltageV: 240, frequenciesHz: [50, 60] },
      limits: { maxDevices: model.portCount, maxTotalPowerW: model.maxPowerW },
      configurationsComplete: model.complete,
      configurations: model.configurations,
    });
    const fact = factSchema.parse({
      productId: model.model,
      key: "plugDesign",
      status: "confirmed",
      value: "folding",
      excerpt: rows.find(([key]) => key === "コンセントプラグ仕様")?.[1],
      evidence,
      permissions,
    });
    const verified = products.tag === "ok" ? products.value[0] : undefined;
    if (verified === undefined || specification.tag === "err" || fact.tag === "err") {
      return err({ code: "official_specification_changed" });
    }
    return ok({
      product: verified,
      specification: specification.value,
      facts: [fact.value],
      investigation: {
        mode: "official",
        notice:
          "メーカー公式仕様で型番・JAN・色と出力表を確認しました。実測速度・発熱・販売在庫は未評価です。",
        provider: "elecom",
        listingId: model.model,
        productId: model.model,
        title: `ELECOM ${model.model} (${model.maxPowerW}W)`,
        canonicalUrl: input,
        observedAt,
        expiresAt,
        matchMethod: "manufacturer_model_gtin_variant",
        gtin: model.gtin,
        color: model.color,
        weightG: model.weightG,
        dimensionsMm: model.dimensionsMm,
        maxPowerW: model.maxPowerW,
        portCount: model.portCount,
      },
    });
  } catch {
    return err({ code: "official_source_unavailable" });
  }
}

export async function loadOfficialChargerCatalog(
  now: Instant,
): Promise<Result<readonly OfficialCharger[], OfficialError>> {
  // ponytail: reviewed SKUs only; review new output tables before expanding coverage.
  return sequence(
    await Promise.all(
      models.map((model) =>
        loadOfficialCharger(`https://www.elecom.co.jp/products/${model.model}.html`, now),
      ),
    ),
  );
}
