export type ConsumerSort = "recommendation" | "price" | "specifications";

type CatalogField = Readonly<{
  id: string;
  label: string;
  unit: string;
  kind: "number" | "text" | "boolean";
  filter: "min" | "max" | "required" | null;
  minimum: number;
  maximum: number;
  presets: readonly number[];
}>;

type CatalogAxis = Readonly<{ id: string; label: string; lowerIsBetter: boolean; weight: number }>;

export type CatalogCategory = Readonly<{
  id: string;
  label: string;
  description: string;
  fields: readonly CatalogField[];
  mainFields: readonly string[];
  axes: readonly CatalogAxis[];
  allowUnknownCondition?: boolean;
}>;

type CatalogProvider = Readonly<{
  id: string;
  label: string;
  urlHosts: readonly string[];
  affiliateHosts: readonly string[];
}>;

export type ProductCatalog = Readonly<{
  categories: readonly CatalogCategory[];
  providers: readonly CatalogProvider[];
}>;

export type ConsumerConditions = Readonly<Record<string, number | boolean>>;

type Value = number | string | boolean | null;

type ConsumerFact = Readonly<{
  field: string;
  value: Exclude<Value, null>;
  quote: string;
  sourceUrl: string;
  method: "pattern" | "jev_choice";
  source: string;
}>;

type ConsumerInformation = Readonly<{
  specs: Readonly<Record<string, Value>>;
  facts: readonly ConsumerFact[];
  conflicts: readonly string[];
}>;

type ConsumerListing = Readonly<{
  mode: "live";
  notice: string;
  provider: string;
  listingId: string;
  title: string;
  shopName: string;
  canonicalUrl: string;
  affiliateUrl: string;
  observedAt: string;
  expiresAt: string;
  condition: "new" | "used" | "refurbished" | "unknown";
  price: Readonly<{ minimum: number; maximum: number; currency: "JPY" }>;
  tax: "included" | "excluded";
  shipping: "included" | "excluded";
  availability: "available" | "unavailable";
  imageUrl: string | null;
  identityVerified: boolean;
  gtin: string | null;
  consumerInformation: ConsumerInformation;
}>;

type ConsumerProduct = ConsumerListing &
  Readonly<{
    status: "eligible" | "excluded" | "pending";
    recommendationPercent: number | null;
    axes: ReadonlyArray<Readonly<{ id: string; label: string; score: number | null }>>;
    reasons: readonly string[];
    rank: number | null;
  }>;

export type ConsumerComparison = Readonly<{
  category: string;
  categoryDefinition: CatalogCategory;
  providerDefinitions: readonly CatalogProvider[];
  conditions: ConsumerConditions;
  sort: ConsumerSort;
  source: ConsumerListing;
  status: "compared" | "ranked" | "needs_information" | "no_match";
  products: readonly ConsumerProduct[];
  storageExpiresAt: string | null;
  aiCalls: Readonly<{ openai: 0; jev: number }>;
  extractionStatus: "not_needed" | "not_configured" | "applied" | "unavailable";
  search: Readonly<{
    pages: number;
    examined: number;
    duplicates: number;
    excluded: number;
    pending: number;
    stopReason:
      | "enough_candidates"
      | "exhausted"
      | "search_limit"
      | "time_limit"
      | "provider_error";
  }>;
}>;

type DetectStatus = "detected" | "needs_confirmation" | "unsupported";

export type DetectResult = Readonly<{
  status: DetectStatus;
  source: ConsumerListing | null;
  categories: readonly string[];
  category: string | null;
}>;

export type ComparisonJobState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type ComparisonJob = Readonly<{
  id: string;
  accessKey: string;
  state: ComparisonJobState;
  revision: number;
  stage: string | null;
  progress: Readonly<{ pages: number; examined: number }> | null;
  expiresAt: string;
  result: ConsumerComparison | null;
  error: Readonly<{ code: string }> | null;
}>;

function record(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function validInstant(input: unknown): input is string {
  return (
    typeof input === "string" &&
    Number.isFinite(Date.parse(input)) &&
    new Date(input).toISOString() === input
  );
}

function publicHttps(input: unknown): input is string {
  if (typeof input !== "string" || !URL.canParse(input)) {
    return false;
  }
  const url = new URL(input);
  return (
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.hash === "" &&
    !input.includes("#") &&
    url.port === "" &&
    publicHost(url.hostname)
  );
}

function publicHost(host: string): boolean {
  return (
    host.includes(".") &&
    !/^(?:localhost|\[|\d+(?:\.\d+){3}$)/i.test(host) &&
    !/(?:^|\.)(?:localhost|local|internal|test\.local)$/i.test(host)
  );
}

function stringArray(input: unknown, max: number, maxItemLength: number): readonly string[] | null {
  if (!Array.isArray(input) || input.length > max) {
    return null;
  }
  const output: string[] = [];
  for (const entry of input) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > maxItemLength) {
      return null;
    }
    output.push(entry);
  }
  return Object.freeze(output);
}

function parseField(input: unknown): CatalogField | null {
  if (
    !record(input) ||
    typeof input["id"] !== "string" ||
    !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(input["id"])
  ) {
    return null;
  }
  const kind = input["kind"];
  const filter = input["filter"];
  if (
    typeof input["label"] !== "string" ||
    input["label"].length === 0 ||
    input["label"].length > 80 ||
    typeof input["unit"] !== "string" ||
    input["unit"].length > 16 ||
    (kind !== "number" && kind !== "text" && kind !== "boolean") ||
    (filter !== null && filter !== "min" && filter !== "max" && filter !== "required") ||
    typeof input["minimum"] !== "number" ||
    !Number.isFinite(input["minimum"]) ||
    typeof input["maximum"] !== "number" ||
    !Number.isFinite(input["maximum"]) ||
    input["minimum"] > input["maximum"]
  ) {
    return null;
  }
  const presetsRaw = input["presets"];
  if (presetsRaw !== undefined && !Array.isArray(presetsRaw)) {
    return null;
  }
  const presets: readonly unknown[] = presetsRaw ?? [];
  const decodedPresets = presets.map((value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return null;
    }
    return value;
  });
  if (decodedPresets.some((value) => value === null)) {
    return null;
  }
  return Object.freeze({
    id: input["id"],
    label: input["label"],
    unit: input["unit"],
    kind,
    filter: filter ?? null,
    minimum: input["minimum"],
    maximum: input["maximum"],
    presets: Object.freeze(
      decodedPresets.flatMap((value) => (typeof value === "number" ? [value] : [])),
    ),
  });
}

function parseAxis(input: unknown): CatalogAxis | null {
  if (
    !record(input) ||
    typeof input["id"] !== "string" ||
    !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(input["id"]) ||
    typeof input["label"] !== "string" ||
    input["label"].length === 0 ||
    input["label"].length > 24 ||
    typeof input["lowerIsBetter"] !== "boolean" ||
    typeof input["weight"] !== "number" ||
    !Number.isFinite(input["weight"]) ||
    input["weight"] <= 0 ||
    input["weight"] > 100
  ) {
    return null;
  }
  return Object.freeze({
    id: input["id"],
    label: input["label"],
    lowerIsBetter: input["lowerIsBetter"],
    weight: input["weight"],
  });
}

function parseCategory(input: unknown): CatalogCategory | null {
  if (
    !record(input) ||
    typeof input["id"] !== "string" ||
    !/^[a-z][a-z0-9_-]{0,63}$/.test(input["id"]) ||
    typeof input["label"] !== "string" ||
    input["label"].length === 0 ||
    typeof input["description"] !== "string" ||
    (input["allowUnknownCondition"] !== undefined &&
      typeof input["allowUnknownCondition"] !== "boolean") ||
    !Array.isArray(input["fields"]) ||
    input["fields"].length === 0 ||
    input["fields"].length > 64
  ) {
    return null;
  }
  const fieldsRaw: readonly unknown[] = input["fields"];
  const fields = fieldsRaw.map(parseField);
  if (
    fields.some((field) => field === null) ||
    new Set(fields.map((field) => field?.id)).size !== fields.length
  ) {
    return null;
  }
  const mainFields = stringArray(input["mainFields"], 32, 64);
  const axesRaw = input["axes"];
  if (
    mainFields === null ||
    !Array.isArray(axesRaw) ||
    axesRaw.length === 0 ||
    axesRaw.length > 32
  ) {
    return null;
  }
  const axes = axesRaw.map(parseAxis);
  if (
    axes.some((axis) => axis === null) ||
    new Set(axes.map((axis) => axis?.id)).size !== axes.length
  ) {
    return null;
  }
  const fieldIds = new Set(fields.flatMap((field) => (field === null ? [] : [field.id])));
  if (
    mainFields.some((id) => !fieldIds.has(id)) ||
    axes.some((axis) => axis !== null && axis.id !== "price" && !fieldIds.has(axis.id))
  ) {
    return null;
  }
  return Object.freeze({
    id: input["id"],
    label: input["label"],
    description: input["description"],
    fields: Object.freeze(fields.flatMap((field) => (field === null ? [] : [field]))),
    mainFields,
    axes: Object.freeze(axes.flatMap((axis) => (axis === null ? [] : [axis]))),
    ...(typeof input["allowUnknownCondition"] === "boolean"
      ? { allowUnknownCondition: input["allowUnknownCondition"] }
      : {}),
  });
}

function parseProvider(input: unknown): CatalogProvider | null {
  if (
    !record(input) ||
    typeof input["id"] !== "string" ||
    !/^[a-z][a-z0-9_-]{0,63}$/.test(input["id"]) ||
    typeof input["label"] !== "string" ||
    input["label"].length === 0
  ) {
    return null;
  }
  const urlHosts = stringArray(input["urlHosts"], 16, 253);
  const affiliateHosts = stringArray(input["affiliateHosts"], 16, 253);
  if (
    urlHosts === null ||
    affiliateHosts === null ||
    urlHosts.length === 0 ||
    urlHosts.some((host) => !/^[a-z0-9.-]+$/.test(host) || !publicHost(host)) ||
    affiliateHosts.some((host) => !/^[a-z0-9.-]+$/.test(host) || !publicHost(host))
  ) {
    return null;
  }
  return Object.freeze({ id: input["id"], label: input["label"], urlHosts, affiliateHosts });
}

export function parseProductCatalog(input: unknown): ProductCatalog {
  if (record(input) && input["tag"] === "err") {
    throwApiError(input);
  }
  const value = record(input) && input["tag"] === "ok" ? input["value"] : null;
  if (!record(value) || !Array.isArray(value["categories"]) || !Array.isArray(value["providers"])) {
    throw new Error("カタログを検証できませんでした");
  }
  const categoriesRaw: readonly unknown[] = value["categories"];
  const providersRaw: readonly unknown[] = value["providers"];
  const categories = categoriesRaw.map(parseCategory);
  const providers = providersRaw.map(parseProvider);
  if (
    categories.length === 0 ||
    providers.length === 0 ||
    categories.some((category) => category === null) ||
    providers.some((provider) => provider === null) ||
    new Set(categories.map((category) => category?.id)).size !== categories.length ||
    new Set(providers.map((provider) => provider?.id)).size !== providers.length
  ) {
    throw new Error("カタログを検証できませんでした");
  }
  return Object.freeze({
    categories: Object.freeze(
      categories.flatMap((category) => (category === null ? [] : [category])),
    ),
    providers: Object.freeze(
      providers.flatMap((provider) => (provider === null ? [] : [provider])),
    ),
  });
}

export function categoryDefinition(
  catalog: ProductCatalog,
  categoryId: string,
): CatalogCategory | undefined {
  return catalog.categories.find((entry) => entry.id === categoryId);
}

function matchProviderForUrl(
  url: URL,
  providers: readonly CatalogProvider[],
): CatalogProvider | undefined {
  return providers.find((provider) => provider.urlHosts.includes(url.hostname));
}

export function validateProductUrl(urlText: string, providers: readonly CatalogProvider[]): URL {
  if (!URL.canParse(urlText)) {
    throw new Error("商品URLを確認してください");
  }
  const url = new URL(urlText);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.hash !== ""
  ) {
    throw new Error("商品URLを確認してください");
  }
  if (!publicHost(url.hostname)) {
    throw new Error("商品URLを確認してください");
  }
  const provider = matchProviderForUrl(url, providers);
  if (provider === undefined) {
    throw new Error("この商品URLは現在の比較フローでは未対応です");
  }
  return url;
}

function affiliateDestination(input: string): URL | null {
  if (!URL.canParse(input)) {
    return null;
  }
  const url = new URL(input);
  const pc = url.searchParams.getAll("pc");
  const mobile = url.searchParams.getAll("m");
  const [destination] = pc;
  if (
    pc.length !== 1 ||
    mobile.length > 1 ||
    destination === undefined ||
    !URL.canParse(destination) ||
    mobile.some((entry) => entry !== destination)
  ) {
    return null;
  }
  return new URL(destination);
}

function listingAffiliateUrl(
  input: unknown,
  canonicalUrl: string,
  providers: readonly CatalogProvider[],
): input is string {
  if (
    typeof input !== "string" ||
    input.length > 8192 ||
    !publicHttps(input) ||
    !publicHttps(canonicalUrl)
  ) {
    return false;
  }
  const url = new URL(input);
  const canonical = new URL(canonicalUrl);
  const provider = providers.find(
    (entry) =>
      entry.urlHosts.includes(canonical.hostname) && entry.affiliateHosts.includes(url.hostname),
  );
  if (provider === undefined) {
    return false;
  }
  if (provider.id !== "rakuten") {
    return ["pc", "m", "url", "destination", "redirect", "target"].every((key) => {
      const destinations = url.searchParams.getAll(key);
      return (
        destinations.length <= 1 &&
        destinations.every(
          (destination) => publicHttps(destination) && new URL(destination).href === canonical.href,
        )
      );
    });
  }
  if (
    url.origin !== "https://hb.afl.rakuten.co.jp" ||
    !/^\/hgc\/[a-fA-F0-9]{8}(?:\.[a-fA-F0-9]{8}){3}\/$/.test(url.pathname) ||
    ![...url.searchParams.keys()].every((key) => ["pc", "m", "scid", "link_type"].includes(key))
  ) {
    return false;
  }
  const item = affiliateDestination(input);
  if (item === null) {
    return false;
  }
  return (
    provider.urlHosts.includes(item.hostname) &&
    item.protocol === "https:" &&
    item.username === "" &&
    item.password === "" &&
    item.hash === "" &&
    item.port === "" &&
    `${item.origin}${item.pathname.replace(/\/?$/, "/")}` ===
      `${canonical.origin}${canonical.pathname.replace(/\/?$/, "/")}` &&
    [...item.searchParams.keys()].every((key) =>
      [
        "scid",
        "rafcid",
        "s-id",
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_term",
        "utm_content",
      ].includes(key),
    )
  );
}

function validValue(input: unknown, field: CatalogField): input is Value {
  return (
    input === null ||
    (field.kind === "number"
      ? typeof input === "number" &&
        Number.isFinite(input) &&
        input >= field.minimum &&
        input <= field.maximum
      : field.kind === "boolean"
        ? typeof input === "boolean"
        : typeof input === "string" && input.trim().length > 0 && input.length <= 100)
  );
}

function parseInformation(
  input: unknown,
  definition: CatalogCategory,
  canonicalUrl: string,
): ConsumerInformation {
  if (
    !record(input) ||
    !record(input["specs"]) ||
    Object.keys(input["specs"]).length !== definition.fields.length ||
    !Array.isArray(input["facts"]) ||
    input["facts"].length > 200 ||
    !Array.isArray(input["conflicts"])
  ) {
    throw new Error("商品の仕様を検証できませんでした");
  }
  const specs: Record<string, Value> = {};
  for (const field of definition.fields) {
    const value = input["specs"][field.id];
    if (!validValue(value, field)) {
      throw new Error("商品の仕様を検証できませんでした");
    }
    specs[field.id] = value;
  }
  const rawFacts: readonly unknown[] = input["facts"];
  const facts = rawFacts.map((entry): ConsumerFact => {
    if (
      !record(entry) ||
      typeof entry["field"] !== "string" ||
      entry["value"] === null ||
      (entry["method"] !== "pattern" && entry["method"] !== "jev_choice") ||
      typeof entry["source"] !== "string" ||
      entry["source"].length === 0 ||
      entry["source"].length > 64 ||
      typeof entry["quote"] !== "string" ||
      entry["quote"].length === 0 ||
      entry["quote"].length > 300 ||
      entry["sourceUrl"] !== canonicalUrl
    ) {
      throw new Error("仕様の出典を検証できませんでした");
    }
    const field = definition.fields.find((candidate) => candidate.id === entry["field"]);
    const value = entry["value"];
    if (field === undefined || !validValue(value, field) || specs[field.id] !== value) {
      throw new Error("仕様の出典を検証できませんでした");
    }
    return Object.freeze({
      field: field.id,
      value,
      method: entry["method"],
      source: entry["source"],
      quote: entry["quote"],
      sourceUrl: canonicalUrl,
    });
  });
  const rawConflicts: readonly unknown[] = input["conflicts"];
  const conflicts = rawConflicts.map((id): string => {
    if (
      typeof id !== "string" ||
      !definition.fields.some((field) => field.id === id) ||
      specs[id] !== null
    ) {
      throw new Error("仕様の矛盾を検証できませんでした");
    }
    return id;
  });
  if (
    definition.fields.some(
      (field) => specs[field.id] !== null && !facts.some((fact) => fact.field === field.id),
    )
  ) {
    throw new Error("仕様の出典がありません");
  }
  if (
    (specs["widthPx"] === null) !== (specs["heightPx"] === null) &&
    definition.fields.some((field) => field.id === "widthPx")
  ) {
    throw new Error("解像度を検証できませんでした");
  }
  return Object.freeze({
    specs: Object.freeze(specs),
    facts: Object.freeze(facts),
    conflicts: Object.freeze(conflicts),
  });
}

function parseConsumerListing(
  input: unknown,
  providers: readonly CatalogProvider[],
  definition?: CatalogCategory,
): ConsumerListing {
  if (!record(input)) {
    throw new Error("APIの応答を読み取れませんでした");
  }
  const condition = input["condition"] ?? "unknown";
  const provider = providers.find((entry) => entry.id === input["provider"]);
  if (
    (input["mode"] !== undefined && input["mode"] !== "live") ||
    (input["notice"] !== undefined && typeof input["notice"] !== "string") ||
    typeof input["provider"] !== "string" ||
    input["provider"].length === 0 ||
    input["provider"].length > 64 ||
    provider === undefined ||
    typeof input["listingId"] !== "string" ||
    input["listingId"].length === 0 ||
    input["listingId"].length > 256 ||
    typeof input["title"] !== "string" ||
    input["title"].trim().length === 0 ||
    input["title"].length > 2000 ||
    typeof input["canonicalUrl"] !== "string" ||
    typeof input["observedAt"] !== "string" ||
    !publicHttps(input["canonicalUrl"]) ||
    !validInstant(input["observedAt"]) ||
    !provider.urlHosts.includes(new URL(input["canonicalUrl"]).hostname) ||
    (condition !== "new" &&
      condition !== "used" &&
      condition !== "refurbished" &&
      condition !== "unknown")
  ) {
    throw new Error("APIの応答を読み取れませんでした");
  }
  const canonicalUrl = input["canonicalUrl"];
  const affiliateUrl = input["affiliateUrl"];
  const expiresAt = input["expiresAt"];
  const price = input["price"];
  const tax = input["tax"];
  const shipping = input["shipping"];
  const availability = input["availability"];
  const imageUrl = input["imageUrl"] ?? null;
  const identityVerified = input["identityVerified"] ?? false;
  const gtin = input["gtin"] ?? null;
  if (
    typeof input["shopName"] !== "string" ||
    input["shopName"].trim().length === 0 ||
    !listingAffiliateUrl(affiliateUrl, canonicalUrl, providers) ||
    !record(price) ||
    price["currency"] !== "JPY" ||
    typeof price["minimum"] !== "number" ||
    !Number.isSafeInteger(price["minimum"]) ||
    price["minimum"] < 0 ||
    typeof price["maximum"] !== "number" ||
    !Number.isSafeInteger(price["maximum"]) ||
    price["maximum"] < price["minimum"] ||
    (tax !== "included" && tax !== "excluded") ||
    (shipping !== "included" && shipping !== "excluded") ||
    (availability !== "available" && availability !== "unavailable") ||
    typeof expiresAt !== "string" ||
    !validInstant(expiresAt) ||
    expiresAt <= input["observedAt"] ||
    (imageUrl !== null &&
      (!publicHttps(imageUrl) ||
        (provider.id === "rakuten" &&
          !new URL(imageUrl).hostname.endsWith(".image.rakuten.co.jp")))) ||
    typeof identityVerified !== "boolean" ||
    (gtin !== null && (typeof gtin !== "string" || !/^(?:\d{8}|\d{12,14})$/.test(gtin)))
  ) {
    throw new Error("APIの応答を読み取れませんでした");
  }
  const consumerInformation =
    definition === undefined
      ? Object.freeze({
          specs: Object.freeze({}),
          facts: Object.freeze([]),
          conflicts: Object.freeze([]),
        })
      : parseInformation(input["consumerInformation"], definition, canonicalUrl);
  if (
    definition !== undefined &&
    (!record(input["consumerInformation"]) ||
      Object.keys(consumerInformation.specs).length !== definition.fields.length)
  ) {
    throw new Error("商品の仕様を検証できませんでした");
  }
  return Object.freeze({
    mode: "live",
    notice: typeof input["notice"] === "string" ? input["notice"] : "",
    provider: input["provider"],
    listingId: input["listingId"],
    title: input["title"],
    shopName: input["shopName"],
    canonicalUrl,
    affiliateUrl,
    observedAt: input["observedAt"],
    expiresAt,
    condition,
    price: Object.freeze({ minimum: price["minimum"], maximum: price["maximum"], currency: "JPY" }),
    tax,
    shipping,
    availability,
    imageUrl,
    identityVerified,
    gtin,
    consumerInformation,
  });
}

export function parseConsumerConditions(
  input: unknown,
  definition: CatalogCategory,
): ConsumerConditions {
  if (!record(input)) {
    throw new Error("比較条件を確認してください");
  }
  const output: Record<string, number | boolean> = {};
  for (const [id, value] of Object.entries(input)) {
    const field = definition.fields.find((entry) => entry.id === id);
    if (
      field?.filter === undefined ||
      field.filter === null ||
      (field.kind === "boolean"
        ? typeof value !== "boolean"
        : typeof value !== "number" ||
          !Number.isFinite(value) ||
          value < field.minimum ||
          value > field.maximum)
    ) {
      throw new Error("比較条件を確認してください");
    }
    if (typeof value === "number" || typeof value === "boolean") {
      output[id] = value;
    }
  }
  return Object.freeze(output);
}

function axisNumeric(listing: ConsumerProduct, axisId: string, allowZero: boolean): number | null {
  if (axisId === "price") {
    return listing.tax === "included" &&
      listing.price.minimum === listing.price.maximum &&
      listing.price.minimum > 0
      ? listing.price.minimum
      : null;
  }
  const spec = listing.consumerInformation.specs[axisId];
  return typeof spec === "number" && (allowZero ? spec >= 0 : spec > 0) ? spec : null;
}

function relativeScore(
  own: number | null,
  values: readonly number[],
  lowerIsBetter: boolean,
): number | null {
  if (own === null || values.length === 0) {
    return null;
  }
  if (own === 0) {
    return lowerIsBetter || Math.max(...values) === 0 ? 100 : 0;
  }
  return Math.round(100 * (lowerIsBetter ? Math.min(...values) / own : own / Math.max(...values)));
}

function parseProviderDefinitions(
  input: unknown,
  catalog: ProductCatalog,
): readonly CatalogProvider[] {
  if (!Array.isArray(input)) {
    throw new Error("プロバイダ定義を検証できませんでした");
  }
  const raw: readonly unknown[] = input;
  const decoded = raw.map((entry) => {
    const provider = parseProvider(entry);
    if (provider === null) {
      return null;
    }
    const known = catalog.providers.find((candidate) => candidate.id === provider.id);
    return known === undefined || JSON.stringify(provider) !== JSON.stringify(known) ? null : known;
  });
  if (
    decoded.some((entry) => entry === null) ||
    decoded.length === 0 ||
    new Set(decoded.map((entry) => entry?.id)).size !== decoded.length
  ) {
    throw new Error("プロバイダ定義を検証できませんでした");
  }
  return Object.freeze(decoded.flatMap((entry) => (entry === null ? [] : [entry])));
}

export function parseConsumerComparison(
  input: unknown,
  catalog: ProductCatalog,
): ConsumerComparison {
  if (record(input) && input["tag"] === "err") {
    throwApiError(input);
  }
  const value = record(input) && input["tag"] === "ok" ? input["value"] : null;
  if (!record(value)) {
    throw new Error("商品比較を検証できませんでした");
  }
  const categoryDefinitionRaw = value["categoryDefinition"];
  const parsedCategory = parseCategory(categoryDefinitionRaw);
  const knownCategory =
    typeof value["category"] === "string"
      ? categoryDefinition(catalog, value["category"])
      : undefined;
  if (
    parsedCategory === null ||
    knownCategory === undefined ||
    JSON.stringify(parsedCategory) !== JSON.stringify(knownCategory)
  ) {
    throw new Error("カテゴリ定義を検証できませんでした");
  }
  const providerDefinitions = parseProviderDefinitions(value["providerDefinitions"], catalog);
  if (
    value["category"] !== parsedCategory.id ||
    (value["sort"] !== "price" &&
      value["sort"] !== "specifications" &&
      value["sort"] !== "recommendation") ||
    !["compared", "ranked", "needs_information", "no_match"].includes(String(value["status"])) ||
    !Array.isArray(value["products"]) ||
    value["products"].length < 1 ||
    value["products"].length > 6 ||
    !record(value["aiCalls"]) ||
    value["aiCalls"]["openai"] !== 0 ||
    (value["aiCalls"]["jev"] !== 0 && value["aiCalls"]["jev"] !== 1) ||
    !["not_needed", "not_configured", "applied", "unavailable"].includes(
      String(value["extractionStatus"]),
    )
  ) {
    throw new Error("商品比較を検証できませんでした");
  }
  const definition = parsedCategory;
  const checked = parseConsumerConditions(value["conditions"], definition);
  const axisDefinitions = definition.axes;
  const raw: readonly unknown[] = value["products"];
  const products = raw.map((entry): ConsumerProduct => {
    if (
      !record(entry) ||
      (entry["status"] !== "eligible" &&
        entry["status"] !== "excluded" &&
        entry["status"] !== "pending") ||
      !Array.isArray(entry["reasons"]) ||
      !entry["reasons"].every(
        (reason: unknown) => typeof reason === "string" && reason.length <= 100,
      )
    ) {
      throw new Error("比較対象を検証できませんでした");
    }
    const listing = parseConsumerListing(entry, providerDefinitions, definition);
    if (
      listing.condition !== "new" &&
      !(listing.condition === "unknown" && definition.allowUnknownCondition === true)
    ) {
      throw new Error("比較対象は新品掲載のみです");
    }
    const info = listing.consumerInformation;
    const validScore = (score: unknown): score is number | null =>
      score === null ||
      (typeof score === "number" && Number.isSafeInteger(score) && score >= 0 && score <= 100);
    if (
      !Array.isArray(entry["axes"]) ||
      entry["axes"].length !== axisDefinitions.length ||
      !validScore(entry["recommendationPercent"])
    ) {
      throw new Error("比較スコアを検証できませんでした");
    }
    const rawAxes: readonly unknown[] = entry["axes"];
    const axes = rawAxes.map((axis, index) => {
      const expected = axisDefinitions[index];
      if (
        expected === undefined ||
        !record(axis) ||
        typeof axis["id"] !== "string" ||
        axis["id"] !== expected.id ||
        typeof axis["label"] !== "string" ||
        axis["label"] !== expected.label ||
        !validScore(axis["score"])
      ) {
        throw new Error("評価の内訳を検証できませんでした");
      }
      return Object.freeze({ id: axis["id"], label: axis["label"], score: axis["score"] });
    });
    const recommendationPercent = entry["recommendationPercent"];
    const rank = entry["rank"];
    if (
      rank !== null &&
      (typeof rank !== "number" ||
        !Number.isSafeInteger(rank) ||
        rank < 1 ||
        rank > 6 ||
        value["status"] !== "ranked" ||
        entry["status"] !== "eligible")
    ) {
      throw new Error("価格順位を検証できませんでした");
    }
    if (
      entry["status"] === "eligible" &&
      (listing.availability !== "available" ||
        Object.entries(checked).some(([id, required]) => {
          if (required === false) {
            return false;
          }
          const fact = info.specs[id];
          const field = definition.fields.find((candidate) => candidate.id === id);
          return typeof required === "boolean"
            ? fact !== true
            : typeof fact !== "number" ||
                (field?.filter === "max" ? fact > required : fact < required);
        }))
    ) {
      throw new Error("条件への適合を検証できませんでした");
    }
    const reasons: readonly unknown[] = entry["reasons"];
    return Object.freeze({
      ...listing,
      status: entry["status"],
      rank,
      recommendationPercent,
      axes: Object.freeze(axes),
      reasons: Object.freeze(
        reasons.flatMap((reason) => (typeof reason === "string" ? [reason] : [])),
      ),
    });
  });
  const source = parseConsumerListing(value["source"], providerDefinitions, definition);
  if (
    source.condition !== "new" &&
    !(source.condition === "unknown" && definition.allowUnknownCondition === true)
  ) {
    throw new Error("比較対象は新品掲載のみです");
  }
  const sourceProduct = products.find(
    (product) =>
      product.listingId === source.listingId && product.canonicalUrl === source.canonicalUrl,
  );
  const identities = products.map((product) =>
    product.identityVerified && product.gtin !== null
      ? `gtin:${product.gtin}`
      : `${product.provider}:${product.listingId}`,
  );
  const eligible = products.filter((product) => product.status === "eligible");
  const pending = products.some((product) => product.status === "pending");
  const commonAxes = axisDefinitions
    .map((axis, index) => ({ ...axis, index }))
    .filter(
      (axis) =>
        eligible.length >= 2 &&
        eligible.every((product) => typeof product.axes[axis.index]?.score === "number"),
    );
  const weightTotal = commonAxes.reduce((sum, axis) => sum + axis.weight, 0);
  const hasSpecificationAxis = commonAxes.some((axis) => axis.id !== "price");
  for (const product of products) {
    for (const [index, axis] of product.axes.entries()) {
      const meta = axisDefinitions[index];
      if (meta === undefined) {
        throw new Error("評価軸を検証できませんでした");
      }
      const allowZero = parsedCategory.fields.find((field) => field.id === axis.id)?.minimum === 0;
      const own = axisNumeric(product, axis.id, allowZero);
      const values = eligible
        .map((entry) => axisNumeric(entry, axis.id, allowZero))
        .filter((number): number is number => number !== null);
      const expected =
        product.status === "eligible" && own !== null && values.length >= 2
          ? relativeScore(own, values, meta.lowerIsBetter)
          : null;
      if (axis.score !== expected) {
        throw new Error("比較スコアが仕様と一致しません");
      }
    }
    const expectedPercent =
      product.status === "eligible" && hasSpecificationAxis && weightTotal > 0
        ? Math.round(
            commonAxes.reduce(
              (sum, axis) => sum + (product.axes[axis.index]?.score ?? 0) * axis.weight,
              0,
            ) / weightTotal,
          )
        : null;
    if (product.recommendationPercent !== expectedPercent) {
      throw new Error("総合スコアが内訳と一致しません");
    }
  }
  if (
    sourceProduct === undefined ||
    JSON.stringify(parseConsumerListing(sourceProduct, providerDefinitions, definition)) !==
      JSON.stringify(source) ||
    new Set(identities).size !== products.length ||
    new Set(products.map((product) => `${product.provider}:${product.listingId}`)).size !==
      products.length ||
    new Set(products.map((product) => product.canonicalUrl)).size !== products.length ||
    (products.some((product) => product.status === "pending") &&
      value["status"] !== "needs_information") ||
    (value["status"] === "ranked" &&
      (pending ||
        (value["sort"] !== "price" && value["sort"] !== "recommendation") ||
        eligible.length === 0 ||
        eligible.some((product) =>
          value["sort"] === "price"
            ? product.tax !== "included" ||
              product.price.minimum <= 0 ||
              product.price.minimum !== product.price.maximum ||
              product.rank !==
                1 + eligible.filter((other) => other.price.minimum < product.price.minimum).length
            : product.recommendationPercent === null ||
              product.rank !==
                1 +
                  eligible.filter(
                    (other) =>
                      (other.recommendationPercent ?? 0) > (product.recommendationPercent ?? 0),
                  ).length,
        ))) ||
    (value["status"] === "no_match" && eligible.length !== 0)
  ) {
    throw new Error("比較結果が一致しません");
  }
  const stats = value["search"];
  const pages = record(stats) ? stats["pages"] : null;
  const examined = record(stats) ? stats["examined"] : null;
  const duplicates = record(stats) ? stats["duplicates"] : null;
  const excluded = record(stats) ? stats["excluded"] : null;
  const pendingCount = record(stats) ? stats["pending"] : null;
  const stopReason = record(stats) ? stats["stopReason"] : null;
  if (
    typeof pages !== "number" ||
    !Number.isSafeInteger(pages) ||
    pages < 0 ||
    pages > 90 ||
    typeof examined !== "number" ||
    !Number.isSafeInteger(examined) ||
    examined < 0 ||
    examined > 90 ||
    typeof duplicates !== "number" ||
    !Number.isSafeInteger(duplicates) ||
    duplicates < 0 ||
    duplicates > 90 ||
    typeof excluded !== "number" ||
    !Number.isSafeInteger(excluded) ||
    excluded < 0 ||
    excluded > 90 ||
    typeof pendingCount !== "number" ||
    !Number.isSafeInteger(pendingCount) ||
    pendingCount < 0 ||
    pendingCount > 90 ||
    (stopReason !== "enough_candidates" &&
      stopReason !== "exhausted" &&
      stopReason !== "search_limit" &&
      stopReason !== "time_limit" &&
      stopReason !== "provider_error")
  ) {
    throw new Error("候補探索の結果を検証できませんでした");
  }
  const status = value["status"];
  const extractionStatus = value["extractionStatus"];
  const storageExpiresAt = value["storageExpiresAt"] ?? null;
  if (
    (status !== "compared" &&
      status !== "ranked" &&
      status !== "needs_information" &&
      status !== "no_match") ||
    (extractionStatus !== "not_needed" &&
      extractionStatus !== "not_configured" &&
      extractionStatus !== "applied" &&
      extractionStatus !== "unavailable") ||
    (storageExpiresAt !== null && !validInstant(storageExpiresAt))
  ) {
    throw new Error("比較結果を検証できませんでした");
  }
  if (
    Math.min(
      Date.parse(source.expiresAt),
      ...products.map((product) => Date.parse(product.expiresAt)),
      storageExpiresAt === null ? Infinity : Date.parse(storageExpiresAt),
    ) <= Date.now()
  ) {
    throw new Error("比較結果の有効期限が切れました。再取得してください", {
      cause: { code: "job_expired" },
    });
  }
  return Object.freeze({
    category: definition.id,
    categoryDefinition: definition,
    providerDefinitions,
    conditions: checked,
    sort: value["sort"],
    status,
    source,
    products: Object.freeze(products),
    storageExpiresAt,
    aiCalls: Object.freeze({ openai: 0, jev: value["aiCalls"]["jev"] }),
    extractionStatus,
    search: Object.freeze({
      pages,
      examined,
      duplicates,
      excluded,
      pending: pendingCount,
      stopReason,
    }),
  });
}

export function parseDetectResult(input: unknown, catalog: ProductCatalog): DetectResult {
  if (record(input) && input["tag"] === "err") {
    throwApiError(input);
  }
  const value = record(input) && input["tag"] === "ok" ? input["value"] : null;
  if (!record(value)) {
    throw new Error("カテゴリ判定を検証できませんでした");
  }
  const status = value["status"];
  if (status !== "detected" && status !== "needs_confirmation" && status !== "unsupported") {
    throw new Error("カテゴリ判定を検証できませんでした");
  }
  const categories = stringArray(value["categories"], 16, 64);
  const category = value["category"];
  if (
    categories === null ||
    categories.some((id) => categoryDefinition(catalog, id) === undefined) ||
    (category !== null &&
      (typeof category !== "string" || categoryDefinition(catalog, category) === undefined))
  ) {
    throw new Error("カテゴリ判定を検証できませんでした");
  }
  let source: ConsumerListing | null = null;
  if (value["source"] !== undefined && value["source"] !== null) {
    source = parseConsumerListing(value["source"], catalog.providers);
  }
  if (status === "detected" && (typeof category !== "string" || source === null)) {
    throw new Error("カテゴリ判定を検証できませんでした");
  }
  return Object.freeze({
    status,
    source,
    categories,
    category: typeof category === "string" ? category : null,
  });
}

export function parseComparisonJob(
  input: unknown,
  catalog: ProductCatalog,
  knownAccessKey?: string,
): ComparisonJob {
  if (record(input) && input["tag"] === "err") {
    throwApiError(input);
  }
  const value = record(input) && input["tag"] === "ok" ? input["value"] : null;
  if (
    !record(value) ||
    typeof value["id"] !== "string" ||
    value["id"].length === 0 ||
    value["id"].length > 128 ||
    typeof value["revision"] !== "number" ||
    !Number.isSafeInteger(value["revision"]) ||
    value["revision"] < 0 ||
    !validInstant(value["expiresAt"])
  ) {
    throw new Error("比較ジョブを検証できませんでした");
  }
  const accessKey = value["accessKey"] ?? knownAccessKey;
  if (
    typeof accessKey !== "string" ||
    !/^[a-zA-Z0-9_-]{32,256}$/.test(accessKey) ||
    (knownAccessKey !== undefined && accessKey !== knownAccessKey)
  ) {
    throw new Error("比較ジョブの鍵を検証できませんでした");
  }
  if (Date.parse(value["expiresAt"]) <= Date.now()) {
    throw new Error("比較結果の有効期限が切れました。再取得してください", {
      cause: { code: "job_expired" },
    });
  }
  const state = value["state"];
  if (
    state !== "queued" &&
    state !== "running" &&
    state !== "succeeded" &&
    state !== "failed" &&
    state !== "cancelled"
  ) {
    throw new Error("比較ジョブを検証できませんでした");
  }
  const stage = value["stage"];
  const progressRaw = value["progress"];
  let progress: ComparisonJob["progress"] = null;
  if (progressRaw !== undefined && progressRaw !== null) {
    if (
      !record(progressRaw) ||
      typeof progressRaw["pages"] !== "number" ||
      !Number.isSafeInteger(progressRaw["pages"]) ||
      progressRaw["pages"] < 0 ||
      typeof progressRaw["examined"] !== "number" ||
      !Number.isSafeInteger(progressRaw["examined"]) ||
      progressRaw["examined"] < 0
    ) {
      throw new Error("比較ジョブを検証できませんでした");
    }
    progress = Object.freeze({ pages: progressRaw["pages"], examined: progressRaw["examined"] });
  }
  let result: ConsumerComparison | null = null;
  if (value["result"] !== undefined && value["result"] !== null) {
    result = parseConsumerComparison({ tag: "ok", value: value["result"] }, catalog);
  }
  let error: ComparisonJob["error"] = null;
  if (value["error"] !== undefined && value["error"] !== null) {
    if (!record(value["error"]) || typeof value["error"]["code"] !== "string") {
      throw new Error("比較ジョブを検証できませんでした");
    }
    error = Object.freeze({ code: value["error"]["code"] });
  }
  if (state === "succeeded" && result === null) {
    throw new Error("比較ジョブを検証できませんでした");
  }
  if (state === "failed" && error === null) {
    throw new Error("比較ジョブを検証できませんでした");
  }
  return Object.freeze({
    id: value["id"],
    accessKey,
    state,
    revision: value["revision"],
    stage: typeof stage === "string" ? stage : null,
    progress,
    expiresAt: value["expiresAt"],
    result,
    error,
  });
}

const errorMessages: Readonly<Record<string, string>> = {
  unauthorized: "比較サービスに接続できません",
  invalid_request: "商品URLと補助の商品名（UTF-8で128バイト以内）を確認してください",
  invalid_url: "商品URLを確認してください",
  unsupported_url: "この商品URLは現在の比較フローでは未対応です",
  unsupported_category:
    "入力商品とカテゴリの一致を確認できませんでした。カテゴリと商品名を確認してください",
  job_not_found: "比較ジョブが見つかりません。最初からやり直してください",
  job_expired: "比較結果の有効期限が切れました。再取得してください",
  job_conflict: "同じ操作キーで入力内容が変わっています。やり直してください",
  idempotency_conflict: "同じ操作キーで入力内容が変わっています。やり直してください",
  result_storage_denied: "比較サービスを利用できません。時間をおいて再度お試しください",
  consumer_rate_limited: "少し待ってからもう一度比較してください",
  provider_rate_limited: "楽天の商品取得が混み合っています。1分ほど待ってから再度お試しください",
  provider_unavailable: "楽天から商品情報を取得できませんでした。時間をおいて再度お試しください",
  provider_unauthorized: "商品取得の接続設定を確認できません。管理者による確認が必要です",
  listing_not_found: "楽天APIにこの商品の掲載が見つかりませんでした。別の商品URLをお試しください",
  lookup_incomplete: "このURLの商品を楽天APIで特定できませんでした。別の商品URLをお試しください",
  listing_not_eligible: "この商品は比較対象外です。中古品・再生品は比較できません",
  source_not_authorized: "商品情報の利用期限が切れています。管理者による更新が必要です",
  cancelled: "比較をキャンセルしました",
  origin_forbidden: "比較サービスに接続できません",
  method_not_allowed: "APIの呼び出し方法が対応していません",
};

export function comparisonErrorMessage(code: string): string {
  return errorMessages[code] ?? "商品を確認できませんでした";
}

function throwApiError(input: Record<string, unknown>): never {
  const error = input["error"];
  const code = record(error) ? error["code"] : null;
  throw new Error(
    typeof code === "string" ? comparisonErrorMessage(code) : "APIの応答を読み取れませんでした",
    { cause: { code } },
  );
}

export function comparisonJobCannotResume(error: unknown): boolean {
  return (
    error instanceof Error &&
    record(error.cause) &&
    (error.cause["code"] === "job_expired" || error.cause["code"] === "job_not_found")
  );
}

export type ApiRequestOptions = Readonly<{
  accessToken?: string;
  signal?: AbortSignal;
  comparisonKey?: string;
  apiBase?: string;
}>;

export function resolveApiBase(apiBase?: string): string {
  const checked = (input: string): string => {
    const text = input.trim();
    if (text.length === 0) {
      return "";
    }
    if (!publicHttps(text) || text.includes("?") || new URL(text).search !== "") {
      throw new Error("API接続先は公開HTTPS URLを指定してください（認証情報やクエリは含めません）");
    }
    return text.replace(/\/$/, "");
  };
  if (apiBase !== undefined && apiBase.length > 0) {
    return checked(apiBase);
  }
  if (typeof document !== "undefined") {
    const meta = document.querySelector('meta[name="api-base"]');
    const content = meta?.getAttribute("content") ?? "";
    if (content.trim().length > 0) {
      return checked(content);
    }
  }
  return "";
}

export async function readJsonResponse(response: Response): Promise<unknown> {
  if (response.headers.get("content-type")?.includes("application/json") !== true) {
    throw new Error("商品APIが未接続です。APIの公開と /api/* の接続設定を確認してください");
  }
  const body: unknown = await response.json();
  if (!response.ok) {
    if (record(body) && body["tag"] === "err") {
      throwApiError(body);
    }
    throw new Error(`商品APIへの接続に失敗しました（HTTP ${response.status}）`);
  }
  return body;
}

export function authHeaders(options: ApiRequestOptions): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = options.accessToken ?? "";
  if (token.length > 0) {
    if (!/^[a-zA-Z0-9_-]{32,256}$/.test(token)) {
      throw new Error("動作確認用トークンの形式を確認してください");
    }
    headers["authorization"] = `Bearer ${token}`;
  }
  if (options.comparisonKey !== undefined) {
    if (!/^[a-zA-Z0-9_-]{32,256}$/.test(options.comparisonKey)) {
      throw new Error("比較ジョブの鍵を確認してください");
    }
    headers["x-comparison-key"] = options.comparisonKey;
  }
  return headers;
}

export type ComparisonOperation = Readonly<{ idempotencyKey: string; accessKey: string }>;

export function createComparisonOperation(): ComparisonOperation {
  const randomKey = (): string =>
    [...globalThis.crypto.getRandomValues(new Uint8Array(32))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  return Object.freeze({ idempotencyKey: randomKey(), accessKey: randomKey() });
}

export function parsePublicCompareRoute(
  pathname: string,
): Readonly<{ category: string | null; sort: ConsumerSort | null }> {
  const normalized = pathname.endsWith("/") ? pathname : `${pathname}/`;
  const match =
    /^\/compare\/([a-z][a-z0-9_-]{0,63})\/(price|recommendation|specifications)\/$/.exec(
      normalized,
    );
  if (match === null) {
    const categoryMatch = /^\/category\/([a-z][a-z0-9_-]{0,63})\/$/.exec(normalized);
    return Object.freeze({ category: categoryMatch?.[1] ?? null, sort: null });
  }
  const sort = match[2];
  return Object.freeze({
    category: match[1] ?? null,
    sort: sort === "price" || sort === "recommendation" || sort === "specifications" ? sort : null,
  });
}

function comparisonJobSessionKey(category: string): string {
  return `url-product-compare:job:${category}`;
}

const activeComparisonCategoryKey = "url-product-compare:active-category";

export type StoredComparisonSession = Readonly<{
  jobId: string;
  accessKey: string;
  expiresAt: string;
  revision: number;
}>;

export function readComparisonSession(category: string): StoredComparisonSession | null {
  if (typeof sessionStorage === "undefined") {
    return null;
  }
  try {
    const raw = sessionStorage.getItem(comparisonJobSessionKey(category));
    if (raw === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (
      !record(parsed) ||
      typeof parsed["jobId"] !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(parsed["jobId"]) ||
      typeof parsed["accessKey"] !== "string" ||
      !/^[a-zA-Z0-9_-]{32,256}$/.test(parsed["accessKey"]) ||
      typeof parsed["expiresAt"] !== "string" ||
      typeof parsed["revision"] !== "number" ||
      !Number.isSafeInteger(parsed["revision"]) ||
      parsed["revision"] < 0
    ) {
      return null;
    }
    if (!validInstant(parsed["expiresAt"]) || parsed["expiresAt"] <= new Date().toISOString()) {
      clearComparisonSession(category);
      return null;
    }
    return Object.freeze({
      jobId: parsed["jobId"],
      accessKey: parsed["accessKey"],
      expiresAt: parsed["expiresAt"],
      revision: parsed["revision"],
    });
  } catch {
    return null;
  }
}

export function readActiveComparisonCategory(): string | null {
  if (typeof sessionStorage === "undefined") {
    return null;
  }
  try {
    const category = sessionStorage.getItem(activeComparisonCategoryKey);
    if (category === null) {
      return null;
    }
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(category) || readComparisonSession(category) === null) {
      sessionStorage.removeItem(activeComparisonCategoryKey);
      return null;
    }
    return category;
  } catch {
    return null;
  }
}

export function writeComparisonSession(category: string, session: StoredComparisonSession): void {
  if (typeof sessionStorage === "undefined") {
    return;
  }
  try {
    sessionStorage.setItem(
      comparisonJobSessionKey(category),
      JSON.stringify({
        jobId: session.jobId,
        accessKey: session.accessKey,
        expiresAt: session.expiresAt,
        revision: session.revision,
      }),
    );
    sessionStorage.setItem(activeComparisonCategoryKey, category);
  } catch {
    // Storage can be disabled; the current operation still works in memory.
  }
}

export function clearComparisonSession(category: string): void {
  if (typeof sessionStorage === "undefined") {
    return;
  }
  try {
    sessionStorage.removeItem(comparisonJobSessionKey(category));
    if (sessionStorage.getItem(activeComparisonCategoryKey) === category) {
      sessionStorage.removeItem(activeComparisonCategoryKey);
    }
  } catch {
    // Storage can be disabled; the current operation still works in memory.
  }
}
