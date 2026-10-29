import type { CommerceListing } from "./commerce.js";
import type { ConsumerAssessment } from "./consumer-scoring.js";

export type FurusatoScoring = Readonly<{
  status: "applied" | "not_configured" | "not_authorized" | "needs_information" | "unavailable";
  calls: 0 | 1;
  scope: "overall";
  items: ReadonlyArray<
    Readonly<{ score: number | null; rank: number | null; assessment?: ConsumerAssessment }>
  >;
}>;

type Evidence = Readonly<{ source: "title" | "description"; quote: string }>;
type Candidate = Readonly<{ value: string | number; evidence: Evidence }>;
type FurusatoField = Readonly<{
  id: string;
  label: string;
  status: "known" | "unknown" | "conflict";
  value: string | number | null;
  unit: "g" | "回" | null;
  evidence: readonly Evidence[];
}>;
export type FurusatoComparison = Readonly<{
  scoring?: FurusatoScoring;
  items: ReadonlyArray<
    Readonly<{
      source: "rakuten_furusato" | "satofull";
      id: string;
      category: FurusatoField;
      fields: readonly FurusatoField[];
      donationPerKg: number | null;
    }>
  >;
  pairs: ReadonlyArray<
    Readonly<{
      left: number;
      right: number;
      status: "comparable" | "partial" | "incompatible";
      reasons: readonly string[];
      unitDonationComparable: boolean;
    }>
  >;
}>;

type Fragment = Readonly<{ text: string; evidence: Evidence }>;
const definitions = Object.freeze({
  origin: "産地",
  storage: "保存・配送温度",
  shipment: "発送時期",
  expiry: "賞味・消費期限",
  deliveryMode: "配送形式",
  perDeliveryGrams: "1回の内容量",
  deliveryCount: "配送回数",
  totalGrams: "合計内容量",
  cultivar: "品種",
  milling: "精米区分",
  harvestYear: "産年",
  species: "種類",
  cut: "部位",
  grade: "等級",
  processing: "加工状態",
  municipality: "寄付先自治体",
  provider: "提供事業者",
  packaging: "包装・小分け",
  ingredients: "原材料",
  allergens: "アレルギー表示",
  size: "サイズ・規格",
  applicationDeadline: "申込期限",
});
type FieldId = keyof typeof definitions;

function fragments(listing: CommerceListing): readonly Fragment[] {
  return (
    [
      { source: "title", text: listing.title },
      { source: "description", text: listing.description ?? "" },
    ] satisfies ReadonlyArray<Readonly<{ source: Evidence["source"]; text: string }>>
  ).flatMap(({ source, text }) =>
    text
      .split(/[\n\r。;；]/u)
      .slice(0, 128)
      .flatMap((raw) => {
        const quote = raw.trim();
        // Never join disconnected statements or silently truncate a claim into a different meaning.
        return quote.length > 0 && quote.length <= 2000
          ? [{ text: quote.normalize("NFKC"), evidence: { source, quote } }]
          : [];
      }),
  );
}

function field(
  id: string,
  label: string,
  candidates: readonly Candidate[],
  conflict = false,
): FurusatoField {
  const values = [...new Set(candidates.map((candidate) => candidate.value))];
  const status =
    conflict || values.length > 1 ? "conflict" : values.length === 1 ? "known" : "unknown";
  const evidence = candidates
    .flatMap((candidate, index) =>
      candidates.findIndex(
        (other) =>
          other.evidence.source === candidate.evidence.source &&
          other.evidence.quote === candidate.evidence.quote,
      ) === index
        ? [candidate.evidence]
        : [],
    )
    .slice(0, 16);
  return Object.freeze({
    id,
    label,
    status,
    value: status === "known" ? (values[0] ?? null) : null,
    unit: id.endsWith("Grams") ? "g" : id === "deliveryCount" ? "回" : null,
    evidence: Object.freeze(evidence),
  });
}

function candidate(value: string | number, fragment: Fragment): Candidate {
  return { value, evidence: fragment.evidence };
}

const categoryPatterns = [
  {
    id: "rice",
    pattern:
      /白米|玄米|精米|無洗米|もち米|コシヒカリ|こしひかり|あきたこまち|ひとめぼれ|ゆめぴりか|ななつぼし|つや姫|(?:^|[\s【】「」])米(?:\s|\d|【|】|$)/u,
  },
  { id: "meat", pattern: /牛肉|豚肉|鶏肉|和牛|黒毛和牛|黒豚|地鶏|ハンバーグ|ベーコン|ソーセージ/u },
  {
    id: "fruit",
    pattern:
      /りんご|リンゴ|みかん|ミカン|いちご|イチゴ|ぶどう|ブドウ|シャインマスカット|白桃|黄桃|マンゴー|メロン|さくらんぼ|ラフランス|ラ・フランス|(?:^|[\s【】])(?:桃|梨|柿)(?:\s|\d|【|】|$)/u,
  },
  {
    id: "seafood",
    pattern:
      /鮭|サーモン|いくら|イクラ|ほたて|ホタテ|帆立|まぐろ|マグロ|かに|カニ|蟹|えび|エビ|海老|うなぎ|ウナギ|鰻|干物/u,
  },
] satisfies ReadonlyArray<Readonly<{ id: string; pattern: RegExp }>>;

function classify(parts: readonly Fragment[]): FurusatoField {
  const titles = parts.filter((part) => part.evidence.source === "title");
  const from = (input: readonly Fragment[]): Candidate[] =>
    input.flatMap((part) =>
      categoryPatterns
        .filter((definition) => definition.pattern.test(part.text))
        .map((definition) => candidate(definition.id, part)),
    );
  const titleCandidates = from(titles);
  return field(
    "category",
    "返礼品の種類",
    titleCandidates.length > 0
      ? titleCandidates
      : from(parts.filter((part) => /^(?:品名|名称|商品名)\s*[:：]/u.test(part.text))),
  );
}

function matching(parts: readonly Fragment[], pattern: RegExp, titleAllowed = true): Candidate[] {
  return parts.flatMap((part) => {
    if (
      (!titleAllowed && part.evidence.source === "title") ||
      /栄養成分|アレルギー|原材料|おすすめ|調理例|選べる|選択|変更できます|ではありません|不可|非対応|含みません/u.test(
        part.text,
      )
    ) {
      return [];
    }
    return [...part.text.matchAll(pattern)].flatMap((match) => {
      const value = match[1];
      return value === undefined || value.trim().length === 0
        ? []
        : [candidate(value.trim(), part)];
    });
  });
}

function labelled(parts: readonly Fragment[], labels: string): Candidate[] {
  const pattern = new RegExp(`^\\s*(?:${labels})\\s*[:：]\\s*([^\\n]{1,100})$`, "u");
  return parts.flatMap((part) => {
    const value = pattern.exec(part.text)?.[1]?.trim();
    return value === undefined || value.length === 0 ? [] : [candidate(value, part)];
  });
}

function measurements(parts: readonly Fragment[]): ReadonlyMap<FieldId, FurusatoField> {
  const per: Candidate[] = [],
    total: Candidate[] = [],
    counts: Candidate[] = [],
    modes: Candidate[] = [];
  const issues: Candidate[] = [];
  let quantityConflict = false;
  const negative = /ではありません|不可|非対応|含みません/u;
  const subscription = parts.some(
    (part) =>
      !negative.test(part.text) &&
      /定期便|毎月|隔月|毎回|各回|全\s*\d+\s*回|\d+\s*回お届け/u.test(part.text),
  );
  for (const part of parts) {
    const text = part.text;
    if (negative.test(text)) {
      continue;
    }
    const repeating = /定期便|毎月|隔月|毎回|各回|全\s*\d+\s*回|\d+\s*回お届け/u.test(text);
    if (repeating) {
      modes.push(candidate("subscription", part));
    }
    if (/単発|一括配送|1回のみ|一度にお届け/u.test(text)) {
      modes.push(candidate("single", part));
    }
    if (
      /栄養|当たり|当り|あたり|目安|調理|おすすめ|おまけ|増量|選べる|選択|変更|たれ|タレ|ソース|骨を含|殻を含/u.test(
        text,
      )
    ) {
      if (
        /内容量|総量|合計|\d\s*(?:kg|g|キログラム|グラム)/iu.test(text) &&
        /選べる|選択|変更|たれ|タレ|ソース|おまけ|殻を含|骨を含/u.test(text)
      ) {
        quantityConflict = true;
        issues.push(candidate(0, part));
      }
      continue;
    }
    for (const match of text.matchAll(
      /(?:全|計|合計)\s*(\d+)\s*回|([\d]+)\s*回(?:お届け|配送|発送|定期便)/gu,
    )) {
      const count = Number(match[1] ?? match[2]);
      if (Number.isSafeInteger(count) && count > 0 && count <= 120) {
        counts.push(candidate(count, part));
      }
    }
    const scoped =
      part.evidence.source === "title" ||
      /内容量|容量|重量|総量|合計|1回|毎回|各回|毎月|お届け/u.test(text);
    if (!scoped) {
      continue;
    }
    const matches = [
      ...text.matchAll(
        /(?<![\da-zA-Z.,+-])((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*(kg|g|キログラム|グラム)(?:\s*[×x*]\s*(\d+)\s*(袋|パック|個|本|玉|箱|回))?(?:\s*[×x*]\s*(\d+)\s*回)?/giu,
      ),
    ];
    const weights = matches.flatMap((match) => {
      const unit = match[2]?.toLowerCase();
      const grams =
        Number(match[1]?.replaceAll(",", "")) * (unit === "kg" || unit === "キログラム" ? 1000 : 1);
      const multiplier = match[3] === undefined || match[4] === "回" ? 1 : Number(match[3]);
      const deliveryCount =
        match[4] === "回" ? Number(match[3]) : match[5] === undefined ? null : Number(match[5]);
      if (
        !Number.isSafeInteger(grams) ||
        grams <= 0 ||
        !Number.isSafeInteger(multiplier) ||
        multiplier < 1 ||
        multiplier > 1000 ||
        (deliveryCount !== null &&
          (!Number.isSafeInteger(deliveryCount) ||
            deliveryCount < 1 ||
            deliveryCount > 120 ||
            (match[4] === "回" && match[5] !== undefined))) ||
        grams * multiplier > 1_000_000_000
      ) {
        quantityConflict = true;
        issues.push(candidate(0, part));
        return [];
      }
      return [{ grams, multiplier, deliveryCount, match }];
    });
    // Multiple components, ranges, variants and approximate weights cannot become an exact total.
    if (
      /(?:約|以上|以下|前後|程度|最大|最小|~|〜|～|から|[\d]\s*[-–]\s*[\d])/u.test(text) ||
      weights.some((weight) =>
        /^\s*[×x*+＋]/iu.test(text.slice(weight.match.index + weight.match[0].length)),
      )
    ) {
      if (weights.length > 0) {
        quantityConflict = true;
        issues.push(candidate(0, part));
      }
      continue;
    }
    if (weights.length > 1) {
      quantityConflict = true;
      issues.push(candidate(0, part));
      continue;
    }
    const weight = weights[0];
    if (weight === undefined) {
      continue;
    }
    if (weight.deliveryCount !== null) {
      per.push(candidate(weight.grams * weight.multiplier, part));
      counts.push(candidate(weight.deliveryCount, part));
      total.push(candidate(weight.grams * weight.multiplier * weight.deliveryCount, part));
      modes.push(candidate("subscription", part));
    } else if (/総量|合計|総計|総重量|総内容量/u.test(text)) {
      total.push(candidate(weight.grams * weight.multiplier, part));
    } else if (subscription) {
      if (/1回|毎回|各回|毎月|隔月/u.test(text)) {
        per.push(candidate(weight.grams * weight.multiplier, part));
      }
    } else {
      total.push(candidate(weight.grams * weight.multiplier, part));
      if (/単発|一括配送|1回のみ|一度にお届け/u.test(text)) {
        per.push(candidate(weight.grams * weight.multiplier, part));
      }
    }
  }
  let perField = field(
    "perDeliveryGrams",
    definitions.perDeliveryGrams,
    [...per, ...issues],
    quantityConflict,
  );
  let countField = field(
    "deliveryCount",
    definitions.deliveryCount,
    [...counts, ...issues],
    quantityConflict,
  );
  let totalField = field(
    "totalGrams",
    definitions.totalGrams,
    [...total, ...issues],
    quantityConflict,
  );
  const mode = field("deliveryMode", definitions.deliveryMode, modes);
  if (mode.value === "single" && countField.status === "unknown") {
    countField = field(
      "deliveryCount",
      definitions.deliveryCount,
      modes.filter((value) => value.value === "single").map((value) => ({ ...value, value: 1 })),
    );
  }
  if (
    mode.value === "single" &&
    perField.status === "unknown" &&
    typeof totalField.value === "number"
  ) {
    perField = field(
      "perDeliveryGrams",
      definitions.perDeliveryGrams,
      totalField.evidence.map((evidence) => ({ value: totalField.value ?? 0, evidence })),
    );
  }
  if (typeof perField.value === "number" && typeof countField.value === "number") {
    const computed = perField.value * countField.value;
    const evidence = [...perField.evidence, ...countField.evidence].map((item) => ({
      value: computed,
      evidence: item,
    }));
    totalField = field(
      "totalGrams",
      definitions.totalGrams,
      [...total, ...evidence, ...issues],
      quantityConflict || computed > 1_000_000_000,
    );
  }
  if (
    totalField.status === "conflict" ||
    perField.status === "conflict" ||
    countField.status === "conflict" ||
    mode.status === "conflict"
  ) {
    totalField = { ...totalField, status: "conflict", value: null };
    perField = { ...perField, status: "conflict", value: null };
    countField = { ...countField, status: "conflict", value: null };
  }
  return new Map<FieldId, FurusatoField>([
    ["deliveryMode", mode],
    ["perDeliveryGrams", perField],
    ["deliveryCount", countField],
    ["totalGrams", totalField],
  ]);
}

function analyse(listing: CommerceListing): FurusatoComparison["items"][number] | null {
  if (listing.source !== "rakuten_furusato" && listing.source !== "satofull") {
    return null;
  }
  const parts = fragments(listing);
  const category = classify(parts);
  const quantities = measurements(parts);
  const candidates = new Map<FieldId, readonly Candidate[]>([
    ["origin", matching(parts, /(?:原産地|産地|原産国)\s*[:：]\s*([^、,。\n]{1,60})/gu)],
    ["storage", matching(parts, /(冷凍|冷蔵|常温)/gu)],
    [
      "shipment",
      matching(parts, /(?:発送時期|発送予定|配送時期|お届け時期)\s*[:：]\s*([^。\n]{1,100})/gu),
    ],
    ["expiry", matching(parts, /(?:賞味期限|消費期限)\s*[:：]\s*([^。\n]{1,100})/gu)],
    ["municipality", labelled(parts, "自治体|寄付先自治体|寄附先自治体")],
    ["provider", labelled(parts, "提供元|提供事業者|事業者")],
    ["packaging", labelled(parts, "包装|包装形態|梱包|小分け|荷姿")],
    ["ingredients", labelled(parts, "原材料|原材料名")],
    ["allergens", labelled(parts, "アレルギー|アレルギー表示|アレルギー品目|特定原材料(?:等)?")],
    ["size", labelled(parts, "サイズ|規格|サイズ・規格")],
    ["applicationDeadline", labelled(parts, "申込期限|申し込み期限|申込期間|受付期限")],
  ]);
  const ids: FieldId[] = [
    "origin",
    "storage",
    "shipment",
    "expiry",
    "deliveryMode",
    "perDeliveryGrams",
    "deliveryCount",
    "totalGrams",
    "municipality",
    "provider",
    "packaging",
    "ingredients",
    "allergens",
    "size",
    "applicationDeadline",
  ];
  if (category.value === "rice") {
    ids.push("cultivar", "milling", "harvestYear");
    candidates.set(
      "cultivar",
      matching(
        parts,
        /(コシヒカリ|こしひかり|あきたこまち|ひとめぼれ|ゆめぴりか|ななつぼし|つや姫|ミルキークイーン)/gu,
      ).map((item) => ({
        ...item,
        value: item.value === "こしひかり" ? "コシヒカリ" : item.value,
      })),
    );
    candidates.set("milling", matching(parts, /(無洗米|白米|玄米|もち米)/gu));
    candidates.set("harvestYear", matching(parts, /((?:20\d{2}|令和\s*\d+)年産)/gu));
  } else if (category.value === "meat") {
    ids.push("species", "cut", "grade", "processing");
    candidates.set(
      "species",
      matching(parts, /(牛肉|和牛|豚肉|黒豚|鶏肉|地鶏)/gu).map((item) => ({
        ...item,
        value: String(item.value).includes("牛")
          ? "牛"
          : String(item.value).includes("豚")
            ? "豚"
            : "鶏",
      })),
    );
    candidates.set(
      "cut",
      matching(
        parts,
        /(肩ロース|サーロイン|リブロース|ロース|ヒレ|バラ|もも|モモ|むね|ムネ|切り落とし|ひき肉)/gu,
      ),
    );
    candidates.set("grade", matching(parts, /(A[1-5]|[1-5]等級)/gu));
    candidates.set(
      "processing",
      matching(parts, /(ハンバーグ|ベーコン|ソーセージ|スライス|ステーキ|焼肉用|しゃぶしゃぶ用)/gu),
    );
  } else if (category.value === "fruit" || category.value === "seafood") {
    ids.push("species", "cultivar", "processing");
    candidates.set(
      "species",
      matching(
        parts,
        category.value === "fruit"
          ? /(りんご|リンゴ|みかん|ミカン|いちご|イチゴ|ぶどう|ブドウ|桃|梨|柿|マンゴー|メロン|さくらんぼ)/gu
          : /(鮭|サーモン|いくら|イクラ|ほたて|ホタテ|帆立|まぐろ|マグロ|かに|カニ|蟹|えび|エビ|海老|うなぎ|ウナギ|鰻)/gu,
      ),
    );
    candidates.set("cultivar", matching(parts, /(?:品種)\s*[:：]\s*([^、,。\n]{1,40})/gu));
    candidates.set(
      "processing",
      matching(parts, /(生食用|加熱用|刺身用|ボイル|むき身|殻付き|干物|訳あり|秀品|優品)/gu),
    );
  }
  const fields = ids.map(
    (id) => quantities.get(id) ?? field(id, definitions[id], candidates.get(id) ?? []),
  );
  const grams = fields.find((item) => item.id === "totalGrams")?.value;
  const amount = listing.amount;
  const donationPerKg =
    category.status === "known" &&
    typeof grams === "number" &&
    listing.usage.priceComparison &&
    listing.availability !== "unavailable" &&
    amount?.kind === "donation" &&
    amount.minimum === amount.maximum
      ? Math.round(((amount.minimum * 1000) / grams) * 100) / 100
      : null;
  return Object.freeze({
    source: listing.source,
    id: listing.id,
    category,
    fields: Object.freeze(fields),
    donationPerKg,
  });
}

export function compareFurusatoListings(listings: readonly CommerceListing[]): FurusatoComparison {
  const items = listings.flatMap((listing) => {
    const item = analyse(listing);
    return item === null ? [] : [item];
  });
  const pairs: Array<FurusatoComparison["pairs"][number]> = [];
  for (const [left, first] of items.entries()) {
    for (const [right, second] of items.entries()) {
      if (right <= left) {
        continue;
      }
      const reasons: string[] = [];
      const differentCategory =
        first.category.status === "known" &&
        second.category.status === "known" &&
        first.category.value !== second.category.value;
      if (first.category.status !== "known" || second.category.status !== "known") {
        reasons.push("category_unknown_or_conflicting");
      }
      if (differentCategory) {
        reasons.push("different_category");
      }
      const required = [
        "deliveryMode",
        "storage",
        ...(first.category.value === "rice"
          ? ["milling", "cultivar"]
          : first.category.value === "meat"
            ? ["species", "cut", "processing"]
            : ["species", "processing"]),
      ];
      for (const id of required) {
        const a = first.fields.find((item) => item.id === id),
          b = second.fields.find((item) => item.id === id);
        if (a?.status !== "known" || b?.status !== "known") {
          reasons.push(`${id}_unknown_or_conflicting`);
        } else if (a.value !== b.value) {
          reasons.push(`${id}_different`);
        }
      }
      if (first.donationPerKg === null || second.donationPerKg === null) {
        reasons.push("unit_donation_unavailable");
      }
      const status = differentCategory
        ? "incompatible"
        : reasons.length === 0
          ? "comparable"
          : "partial";
      pairs.push(
        Object.freeze({
          left,
          right,
          status,
          reasons: Object.freeze(reasons),
          unitDonationComparable: status === "comparable",
        }),
      );
    }
  }
  return Object.freeze({ items: Object.freeze(items), pairs: Object.freeze(pairs) });
}
