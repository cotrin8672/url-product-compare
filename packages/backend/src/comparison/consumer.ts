import { err, ok } from "./algebra.js";
import type { Result } from "./algebra.js";
import {
  consumerCategoryDefinition,
  consumerCatalogCategories,
  consumerListingConditionEligible,
  readFieldFlagLabels,
  readFieldNumberPattern,
  readFieldTextLabels,
} from "./consumer-catalog.js";
import type { ConsumerCategoryDefinition, ConsumerListingCondition } from "./consumer-catalog.js";
import { readMonitorSpecifications } from "./monitor.js";
import { relativeSpecificationScore } from "./product-comparison.js";
import { record } from "./values.js";
import type { Schema, SchemaError } from "./values.js";

export type ConsumerCategory = ConsumerCategoryDefinition;
export type ConsumerSort = "recommendation" | "price" | "specifications";
type ConsumerValue = number | string | boolean | null;

export const consumerCategories: readonly ConsumerCategory[] = consumerCatalogCategories;

export function consumerCategory(input: unknown): ConsumerCategory | null {
  return consumerCategoryDefinition(input);
}

export type ConsumerConditions = Readonly<Record<string, number | boolean>>;
export function consumerConditionsSchema(
  category: Pick<ConsumerCategory, "fields">,
): Schema<ConsumerConditions> {
  return Object.freeze({
    parse(input: unknown): Result<ConsumerConditions, SchemaError> {
      if (!record(input)) {
        return err({ code: "invalid_data", field: "consumer_conditions" });
      }
      const parsed: Record<string, number | boolean> = {};
      for (const [id, value] of Object.entries(input)) {
        const definition = category.fields.find((entry) => entry.id === id);
        if (
          definition?.filter === undefined ||
          definition.filter === null ||
          (definition.kind === "boolean"
            ? typeof value !== "boolean"
            : typeof value !== "number" ||
              !Number.isFinite(value) ||
              value < definition.minimum ||
              value > definition.maximum)
        ) {
          return err({ code: "invalid_data", field: "consumer_conditions" });
        }
        if (typeof value === "boolean" || typeof value === "number") {
          parsed[id] = value;
        }
      }
      return ok(Object.freeze(parsed));
    },
  });
}

type ConsumerFact = Readonly<{
  field: string;
  value: Exclude<ConsumerValue, null>;
  quote: string;
  sourceUrl: string;
  method: "pattern" | "jev_choice";
  source: string;
}>;
type ConsumerSpecifications = Readonly<Record<string, ConsumerValue>>;
type ExtractionChoice = Readonly<{
  id: string;
  listingId: string;
  field: string;
  label: string;
  options: ReadonlyArray<Readonly<{ id: string; fact: ConsumerFact }>>;
}>;
export type ConsumerExtraction = (
  choices: readonly ExtractionChoice[],
  options?: Readonly<{ signal?: AbortSignal }>,
) => Promise<Result<Readonly<Record<string, string>>, "unavailable" | "invalid_response">>;
export type ConsumerInformation = Readonly<{
  specs: ConsumerSpecifications;
  facts: readonly ConsumerFact[];
  conflicts: readonly string[];
  choices: readonly ExtractionChoice[];
}>;

/** Labelled facts only. Conflicting variants and advertised upgrade limits stay unknown. */
export function readConsumerInformation(
  category: ConsumerCategory,
  listingId: string,
  sourceUrl: string,
  input: string,
  productInput = "",
  sources: Readonly<{ listing: string; product: string }> = {
    listing: "listing",
    product: "product",
  },
): ConsumerInformation {
  const normalize = (value: string): string =>
    value
      .slice(0, 18000)
      .replace(/&#(x[0-9a-f]+|\d+);?/gi, (original: string, encoded: string) => {
        const scalar = encoded.toLowerCase().startsWith("x")
          ? Number.parseInt(encoded.slice(1), 16)
          : Number.parseInt(encoded, 10);
        return Number.isFinite(scalar) &&
          scalar > 0 &&
          scalar <= 0x10ffff &&
          !(scalar >= 0xd800 && scalar <= 0xdfff)
          ? String.fromCodePoint(scalar)
          : original;
      })
      .replace(/[™®]/g, "")
      .normalize("NFKC")
      .replace(/<[^>]*>/g, "\n")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&");
  const productText = normalize(productInput);
  const text = `${productText}\n${normalize(input)}`;
  const factSource = (quote: string): ConsumerFact["source"] =>
    productText.includes(quote) ? sources.product : sources.listing;
  const clauses = text
    .split(/[\n。;；|●]/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const specs: Record<string, ConsumerValue> = {};
  const facts: ConsumerFact[] = [];
  const conflicts: string[] = [];
  const choices: ExtractionChoice[] = [];
  const pc = category.id === "laptop" || category.id === "desktop";
  for (const definition of category.fields) {
    const found: ConsumerFact[] = [];
    if (
      pc &&
      ["cpu", "cpuBaseGhz", "cpuBoostGhz", "cpuCacheMb", "cpuCores", "cpuThreads"].includes(
        definition.id,
      ) &&
      (/CPU\s*(?:の\s*)?選択/i.test(text) || (definition.id !== "cpu" && conflicts.includes("cpu")))
    ) {
      conflicts.push(definition.id);
    }
    const add = (value: Exclude<ConsumerValue, null>, quote: string): void => {
      if (
        typeof value === "number" &&
        (!Number.isFinite(value) || value < definition.minimum || value > definition.maximum)
      ) {
        conflicts.push(definition.id);
        return;
      }
      found.push(
        Object.freeze({
          field: definition.id,
          value,
          quote: quote.slice(0, 300),
          sourceUrl,
          method: "pattern",
          source: factSource(quote),
        }),
      );
    };
    const pattern = readFieldNumberPattern(definition);
    if (pattern !== null) {
      for (const clause of clauses) {
        for (const match of clause.matchAll(new RegExp(pattern, "gi"))) {
          // A label boundary can consume the final character of a preceding upgrade or limit.
          const preceding = clause.slice(Math.max(0, match.index - 18), match.index + 1);
          if (
            /最大|増設|拡張|推奨|おすすめ|選択|選べ|オプション|対応|maximum|upgrade|recommended/i.test(
              preceding,
            ) ||
            (!["gpuVramGb", "gpuBoostMhz", "gpuPowerW"].includes(definition.id) &&
              /GPU|VRAM|グラフィック/i.test(preceding)) ||
            (definition.id === "gpuVramGb" && /共有|shared/i.test(preceding))
          ) {
            continue;
          }
          const following = clause.slice(match.index + match[0].length);
          if (
            /^\s*[,，、/〜~・]\s*\d/.test(following) ||
            (/^(?:GB|TB)$/i.test(match[2] ?? "") &&
              /^[\s,，、・/〜~]*\d+(?:\.\d+)?\s*(?:GB|TB)(?![a-z])/i.test(following))
          ) {
            conflicts.push(definition.id);
            continue;
          }
          const raw = Number(match[1]);
          const unit = match[2]?.toLowerCase();
          add(
            raw *
              (unit === "tb" || unit === "kg" || (unit === "ghz" && definition.id === "gpuBoostMhz")
                ? 1000
                : 1),
            clause.slice(Math.max(0, match.index - 80), match.index + match[0].length + 80),
          );
        }
      }
    } else if (definition.extraction?.kind === "resolution") {
      for (const match of text.matchAll(
        /(?:最大解像度|解像度|画素数|resolution)\s*[:：]?\s*(?:FHD|WQHD|UHD|HD)?\s*(\d{3,5})\s*[×x*]\s*(\d{3,4})(?!\d)/gi,
      )) {
        if (
          pc &&
          /外部ディスプレイ|外部モニター|external/i.test(
            text.slice(Math.max(0, match.index - 24), match.index),
          )
        ) {
          continue;
        }
        add(Number(match[definition.id === "widthPx" ? 1 : 2]), match[0]);
      }
    } else if (definition.kind === "boolean") {
      const label = readFieldFlagLabels(definition);
      if (label !== null) {
        for (const match of text.matchAll(
          new RegExp(
            `(?:${label})\\s*[:：]?\\s*(非対応|対応|なし|あり|不可|可|yes|no|true|false)(?=[\\s。;；,，]|$)`,
            "gi",
          ),
        )) {
          add(!/非対応|なし|不可|no|false/i.test(match[1] ?? ""), match[0]);
        }
      }
    } else if (definition.kind === "text") {
      const label = readFieldTextLabels(definition);
      if (label !== null && !(pc && ["cpu", "gpu", "os"].includes(definition.id))) {
        for (const clause of clauses) {
          for (const match of clause.matchAll(
            new RegExp(`(?:^|\\s)(?:${label})\\s*[:：]\\s*([^,，/]{1,100})`, "gi"),
          )) {
            const preceding = clause.slice(Math.max(0, match.index - 18), match.index);
            if (/推奨|おすすめ|選択|選べ|オプション|recommended/i.test(preceding)) {
              continue;
            }
            if (
              (definition.id === "cpu" || definition.id === "gpu") &&
              /^\s*[/,，、・]/.test(clause.slice(match.index + match[0].length)) &&
              !/^\s*[,，、]\s*[^,:：/]{1,100}[:：]/.test(
                clause.slice(match.index + match[0].length),
              )
            ) {
              conflicts.push(definition.id);
              continue;
            }
            const value = match[1]?.trim();
            if (
              definition.id === "cpu" &&
              /^\d+(?:\.\d+)?\s*(?:GHz|MHz)(?:\s|$)/i.test(value ?? "")
            ) {
              continue;
            }
            if (value !== undefined && value.length > 0) {
              add(value, clause);
            }
          }
        }
      }
    }
    if (pc && found.length === 0 && !conflicts.includes(definition.id)) {
      if (["cpu", "gpu", "os"].includes(definition.id)) {
        const label =
          definition.id === "cpu"
            ? "CPU|プロセッサー(?=\\s|[:：])|processor(?=\\s|[:：])"
            : readFieldTextLabels(definition);
        const separator = definition.id === "gpu" ? "\\s*(?:[:：]\\s*|\\s+)" : "\\s*[:：]?\\s*";
        const stop =
          definition.id === "cpu"
            ? "プロセッサー|チップセット|NPU|カラー|メモリ|RAM|ROM|記憶装置|GPU|グラフィック|OS(?=\\s*(?:Windows|Linux|Chrome))|CPU(?:コア数|スレッド数)|インターフェース|インターフェイス|\\d+\\s*コア"
            : definition.id === "gpu"
              ? "NPU|ビデオメモリ|メモリ|インターフェース|インターフェイス|ディスプレイタイプ|CPU(?!\\s*内蔵)|OS(?=\\s*(?:Windows|Linux|Chrome))|GPUメモリ"
              : "形状|ディスプレイ|CPU|プロセッサー|メモリ|RAM|ROM|Office|インターフェース|インターフェイス";
        if (label !== null) {
          for (const match of text.matchAll(
            new RegExp(
              `(?:${label})(?!コア数|スレッド数|メモリ|基本周波数|基本クロック|最大周波数|最大クロック|ベースクロック|ブーストクロック|キャッシュ|消費電力|TGP)${separator}(?!内蔵|チップセット|NPU|補足|VRAM|メモリ|コア数|スレッド数|基本周波数|基本クロック|最大周波数|最大クロック|ベースクロック|ブーストクロック|キャッシュ|消費電力|TGP|インターフェース|インターフェイス|ディスプレイ)${definition.id === "os" ? "(?=Windows|Linux|macOS|Chrome|Ubuntu)" : ""}([\\p{L}][^\\n;,，]{0,99}?)(?=\\s*(?:${stop})|$|[;\\n,，])`,
              "giu",
            ),
          )) {
            const preceding = text.slice(Math.max(0, match.index - 18), match.index);
            if (/推奨|おすすめ|選択|選べ|オプション|recommended/i.test(preceding)) {
              continue;
            }
            const value = match[1]?.trim().replace(/[・+★\s]+$/, "");
            if (
              (definition.id === "cpu" || definition.id === "gpu") &&
              value?.includes("/") === true
            ) {
              conflicts.push(definition.id);
              continue;
            }
            if (value !== undefined && value.length > 0) {
              add(value, match[0]);
            }
          }
        }
      } else if (definition.id === "wifiVersion" || definition.id === "bluetoothVersion") {
        const expression =
          definition.id === "wifiVersion"
            ? /Wi[- ]?Fi\s*(6E|[4-7])(?![a-z\d.])/gi
            : /Bluetooth\s*v?\s*(\d+(?:\.\d+)?)(?![\d.])/gi;
        for (const match of text.matchAll(expression)) {
          const preceding = text.slice(Math.max(0, match.index - 18), match.index);
          if (
            match[1] !== undefined &&
            !/最大|推奨|おすすめ|オプション|recommended/i.test(preceding)
          ) {
            add(match[1], match[0]);
          }
        }
      } else if (definition.id === "usbAPorts" || definition.id === "usbCPorts") {
        const type = definition.id === "usbAPorts" ? "A" : "C";
        for (const match of text.matchAll(
          new RegExp(
            `Type\\s*[- ]?${type}\\s*[:：]?\\s*(?:(?:USB\\s*)?\\d+(?:\\.\\d+)?\\s*(?:Gen\\s*\\d+|Gbps)?\\s*)?(?:\\(\\s*\\d+(?:\\.\\d+)?\\s*Gbps\\s*\\)\\s*)?(?:ポート\\s*)?[×x]\\s*(\\d+)(?![\\d.])`,
            "gi",
          ),
        )) {
          const preceding = text.slice(Math.max(0, match.index - 18), match.index);
          if (/(?:最大|推奨|おすすめ|オプション|maximum|recommended)\s*$/i.test(preceding)) {
            continue;
          }
          if (/^\s*[/〜~、,]\s*\d/.test(text.slice(match.index + match[0].length))) {
            conflicts.push(definition.id);
            continue;
          }
          add(Number(match[1]), match[0]);
        }
      } else if (["widthMm", "depthMm", "heightMm"].includes(definition.id)) {
        for (const match of text.matchAll(
          /(?:本体寸法|サイズ)\s*\(\s*(?:W\s*[×x]\s*D\s*[×x]\s*H|幅\s*[×x]\s*奥行き?\s*[×x]\s*高さ)\s*\)\s*(?:mm)?\s*(?:約\s*)?(\d+(?:\.\d+)?)\s*[×x]\s*(\d+(?:\.\d+)?)\s*[×x]\s*(\d+(?:\.\d+)?(?:\s*[-〜~]\s*\d+(?:\.\d+)?)?)\s*(?:\([^)]{0,20}\))?\s*mm/gi,
        )) {
          const preceding = text.slice(Math.max(0, match.index - 18), match.index);
          if (/(?:最大|推奨|おすすめ|オプション|maximum|recommended)\s*$/i.test(preceding)) {
            continue;
          }
          const raw = match[definition.id === "widthMm" ? 1 : definition.id === "depthMm" ? 2 : 3];
          if (raw !== undefined && /[-〜~]/.test(raw)) {
            conflicts.push(definition.id);
          } else if (raw !== undefined) {
            add(Number(raw), match[0]);
          }
        }
      } else if (definition.id === "batteryWh") {
        for (const match of text.matchAll(
          /バッテリー[^\n;]{0,70}?(\d+(?:\.\d+)?)\s*Whr?(?![a-z])/gi,
        )) {
          const preceding = text.slice(Math.max(0, match.index - 18), match.index);
          if (!/最大|増設|推奨|recommended/i.test(`${preceding}${match[0]}`)) {
            add(Number(match[1]), match[0]);
          }
        }
      } else if (definition.id === "cpuCores" || definition.id === "cpuThreads") {
        for (const match of text.matchAll(
          /(?:CPU|プロセッサー)[^\n;]{0,140}?(\d+)\s*コア\s*\/\s*(\d+)\s*スレッド/gi,
        )) {
          if (!/最大|推奨|recommended/i.test(match[0])) {
            add(Number(match[definition.id === "cpuCores" ? 1 : 2]), match[0]);
          }
        }
      } else if (["widthPx", "heightPx", "brightnessNits"].includes(definition.id)) {
        for (const block of text.matchAll(
          /(?:^|\s)ディスプレイ(?:タイプ)?(?:(?!外部ディスプレイ|外部モニター|CPU|グラフィック|インターフェース|インターフェイス)[^\n;]){0,280}/gi,
        )) {
          const expression =
            definition.id === "brightnessNits"
              ? /(\d+(?:\.\d+)?)\s*nits?(?![a-z])/gi
              : /(\d{3,5})\s*[×x]\s*(\d{3,4})(?!\d)/g;
          for (const match of block[0].matchAll(expression)) {
            add(Number(match[definition.id === "heightPx" ? 2 : 1]), block[0]);
          }
        }
      }
    }
    const values = new Set(found.map((fact) => fact.value));
    specs[definition.id] =
      values.size === 1 && !conflicts.includes(definition.id) ? (found[0]?.value ?? null) : null;
    if (values.size > 1) {
      conflicts.push(definition.id);
    }
    if (values.size === 1 && !conflicts.includes(definition.id)) {
      facts.push(...found.slice(0, 3));
    }
    if (
      values.size === 0 &&
      !conflicts.includes(definition.id) &&
      definition.jevChoiceEligible === true
    ) {
      const options: Array<Readonly<{ id: string; fact: ConsumerFact }>> = [];
      for (const clause of clauses) {
        if (
          /最大|増設|拡張|推奨|おすすめ|選べ|オプション|microSD|VRAM|グラフィック|GPU|maximum|upgrade|recommended/i.test(
            clause,
          )
        ) {
          continue;
        }
        for (const match of clause.matchAll(/(\d+(?:\.\d+)?)\s*(GB|TB)(?![a-z])/gi)) {
          const otherField = definition.id === "ramGb" ? "storageGb" : "ramGb";
          const otherDefinition = category.fields.find((entry) => entry.id === otherField);
          const otherPattern =
            otherDefinition === undefined ? null : readFieldNumberPattern(otherDefinition);
          if (
            otherPattern !== null &&
            [...clause.matchAll(new RegExp(otherPattern, "gi"))].some(
              (other) =>
                match.index >= other.index &&
                match.index + match[0].length <= other.index + other[0].length,
            )
          ) {
            continue;
          }
          const value = Number(match[1]) * (match[2]?.toLowerCase() === "tb" ? 1000 : 1);
          if (value < definition.minimum || value > definition.maximum || clause.length > 300) {
            continue;
          }
          options.push(
            Object.freeze({
              id: `option_${options.length}`,
              fact: Object.freeze({
                field: definition.id,
                value,
                quote: clause,
                sourceUrl,
                method: "jev_choice",
                source: factSource(clause),
              }),
            }),
          );
        }
      }
      if (options.length > 0 && options.length <= 8) {
        choices.push(
          Object.freeze({
            id: `${listingId}_${definition.id}`,
            listingId,
            field: definition.id,
            label: definition.label,
            options: Object.freeze(options),
          }),
        );
      }
    }
  }
  if ("widthPx" in specs && (specs["widthPx"] === null) !== (specs["heightPx"] === null)) {
    specs["widthPx"] = null;
    specs["heightPx"] = null;
    conflicts.push("widthPx", "heightPx");
    for (let index = facts.length - 1; index >= 0; index -= 1) {
      if (facts[index]?.field === "widthPx" || facts[index]?.field === "heightPx") {
        facts.splice(index, 1);
      }
    }
  }
  if (category.id === "monitor") {
    const monitor = readMonitorSpecifications(text);
    for (const [id, value] of Object.entries({
      usbCVideo: monitor.usbCVideo,
      heightAdjustable: monitor.heightAdjustable,
    })) {
      if (specs[id] === null && value !== null) {
        const definition = category.fields.find((entry) => entry.id === id);
        const label = definition === undefined ? null : readFieldFlagLabels(definition);
        const quote = clauses.find(
          (clause) => label !== null && new RegExp(label, "i").test(clause),
        );
        if (quote !== undefined) {
          specs[id] = value;
          facts.push(
            Object.freeze({
              field: id,
              value,
              quote: quote.slice(0, 300),
              sourceUrl,
              method: "pattern",
              source: factSource(quote),
            }),
          );
        }
      }
    }
  }
  return Object.freeze({
    specs: Object.freeze(specs),
    facts: Object.freeze(facts),
    conflicts: Object.freeze([...new Set(conflicts)]),
    choices: Object.freeze(choices),
  });
}

export function applyConsumerChoices(
  information: ConsumerInformation,
  answers: Readonly<Record<string, string>>,
): ConsumerInformation {
  const specs = { ...information.specs };
  const facts = [...information.facts];
  for (const choice of information.choices) {
    const selected = choice.options.find((option) => option.id === answers[choice.id]);
    if (
      selected !== undefined &&
      specs[choice.field] === null &&
      !information.conflicts.includes(choice.field)
    ) {
      specs[choice.field] = selected.fact.value;
      facts.push(selected.fact);
    }
  }
  return Object.freeze({
    ...information,
    specs: Object.freeze(specs),
    facts: Object.freeze(facts),
  });
}

type Listing = Readonly<{
  listingId: string;
  identityVerified?: boolean;
  availability: "available" | "unavailable";
  tax: "included" | "excluded";
  price: Readonly<{ minimum: number; maximum: number }>;
  consumerInformation: ConsumerInformation;
  condition?: ConsumerListingCondition;
  provider?: string;
}>;

export function assessConsumerListing(
  listing: Listing,
  category: ConsumerCategory,
  conditions: ConsumerConditions,
): Readonly<{ status: "eligible" | "excluded" | "pending"; reasons: readonly string[] }> {
  const missing: string[] = [];
  const excluded: string[] = listing.availability === "unavailable" ? ["unavailable"] : [];
  if (!consumerListingConditionEligible(listing.condition ?? "unknown", category)) {
    excluded.push("condition_not_new");
  }
  for (const [id, required] of Object.entries(conditions)) {
    if (required === false) {
      continue;
    }
    const value = listing.consumerInformation.specs[id];
    const definition = category.fields.find((entry) => entry.id === id);
    if (value === null || value === undefined) {
      missing.push(`${id}_unknown`);
    } else if (
      typeof required === "boolean"
        ? value !== true
        : typeof value !== "number" ||
          (definition?.filter === "max" ? value > required : value < required)
    ) {
      excluded.push(id);
    }
  }
  return Object.freeze({
    status: excluded.length > 0 ? "excluded" : missing.length > 0 ? "pending" : "eligible",
    reasons: Object.freeze([...excluded, ...missing]),
  });
}

export type ConsumerComparisonProduct<T extends Listing> = T &
  Readonly<{
    status: "eligible" | "excluded" | "pending";
    reasons: readonly string[];
    rank: number | null;
    recommendationPercent: number | null;
    axes: ReadonlyArray<Readonly<{ id: string; label: string; score: number | null }>>;
  }>;

export function compareConsumerListings<T extends Listing>(
  listings: readonly T[],
  category: ConsumerCategory,
  conditions: ConsumerConditions,
  sort: ConsumerSort,
): Readonly<{
  status: "ranked" | "compared" | "needs_information" | "no_match";
  products: ReadonlyArray<ConsumerComparisonProduct<T>>;
}> {
  const assessed = listings.map((listing) =>
    Object.freeze({ ...listing, ...assessConsumerListing(listing, category, conditions) }),
  );
  const eligible = assessed.filter((listing) => listing.status === "eligible");
  const pending = assessed.some((listing) => listing.status === "pending");
  const value = (listing: Listing, id: string): number | null => {
    if (id === "price") {
      return listing.tax === "included" &&
        listing.price.minimum === listing.price.maximum &&
        listing.price.minimum > 0
        ? listing.price.minimum
        : null;
    }
    const spec = listing.consumerInformation.specs[id];
    return typeof spec === "number" ? spec : null;
  };
  const axisDefinitions = category.axes;
  const allowsZero = (id: string): boolean =>
    category.fields.some(
      (field) => field.id === id && field.kind === "number" && field.minimum === 0,
    );
  const axisValues = axisDefinitions.map((axis) =>
    eligible
      .map((listing) => value(listing, axis.id))
      .filter(
        (entry): entry is number =>
          entry !== null &&
          Number.isFinite(entry) &&
          (entry > 0 || (entry === 0 && allowsZero(axis.id))),
      ),
  );
  const scored = assessed.map((listing) => {
    const axes = axisDefinitions.map((axis, index) => {
      const known = axisValues[index] ?? [];
      return Object.freeze({
        id: axis.id,
        label: axis.label,
        score:
          listing.status === "eligible" && known.length >= 2
            ? relativeSpecificationScore(
                value(listing, axis.id),
                known,
                axis.lowerIsBetter,
                allowsZero(axis.id),
              )
            : null,
      });
    });
    return Object.freeze({ ...listing, axes: Object.freeze(axes) });
  });
  const commonAxes = axisDefinitions
    .map((axis, index) => ({ ...axis, index }))
    .filter(
      (axis) =>
        eligible.length >= 2 &&
        scored.every(
          (listing) =>
            listing.status !== "eligible" || typeof listing.axes[axis.index]?.score === "number",
        ),
    );
  const totalWeight = commonAxes.reduce((sum, axis) => sum + axis.weight, 0);
  const hasSpecificationAxis = commonAxes.some((axis) => axis.id !== "price");
  const withTotals = scored.map((listing) => {
    const recommendationPercent =
      listing.status === "eligible" && hasSpecificationAxis && totalWeight > 0
        ? Math.round(
            commonAxes.reduce(
              (sum, axis) => sum + (listing.axes[axis.index]?.score ?? 0) * axis.weight,
              0,
            ) / totalWeight,
          )
        : null;
    return Object.freeze({ ...listing, recommendationPercent });
  });
  const recommendationReady =
    eligible.length >= 2 &&
    withTotals
      .filter((listing) => listing.status === "eligible")
      .every((listing) => listing.recommendationPercent !== null);
  const rankable =
    !pending &&
    (sort === "recommendation"
      ? recommendationReady
      : sort === "price" &&
        eligible.length > 0 &&
        eligible.every(
          (listing) =>
            listing.tax === "included" &&
            listing.price.minimum > 0 &&
            listing.price.minimum === listing.price.maximum,
        ));
  return Object.freeze({
    status:
      pending || (sort === "recommendation" && eligible.length >= 2 && !recommendationReady)
        ? "needs_information"
        : eligible.length === 0
          ? "no_match"
          : rankable
            ? "ranked"
            : "compared",
    products: Object.freeze(
      withTotals
        .map((listing) =>
          Object.freeze({
            ...listing,
            rank:
              rankable && listing.status === "eligible"
                ? 1 +
                  withTotals.filter(
                    (other) =>
                      other.status === "eligible" &&
                      (sort === "recommendation"
                        ? (other.recommendationPercent ?? 0) > (listing.recommendationPercent ?? 0)
                        : other.price.minimum < listing.price.minimum),
                  ).length
                : null,
          }),
        )
        .toSorted((left, right) =>
          sort === "recommendation" ? (left.rank ?? 100) - (right.rank ?? 100) : 0,
        ),
    ),
  });
}
