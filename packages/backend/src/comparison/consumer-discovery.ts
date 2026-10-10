import { buildConsumerCatalog } from "./consumer-catalog.js";
import type { ConsumerCategoryDefinition } from "./consumer-catalog.js";
import type {
  ConsumerCategoryAttribute,
  ConsumerCategorySelection,
  ConsumerDiscoveredCategory,
  ConsumerProvider,
} from "./consumer-provider.js";
import { valueOf } from "./values.js";
import type { Instant } from "./values.js";

type Genre = Readonly<{
  id: string;
  label: string | null;
  attributes: readonly ConsumerCategoryAttribute[] | null;
}>;

export function createConsumerCategoryDiscovery(
  providerId: string,
  resolveGenre: (id: string, options?: Readonly<{ signal?: AbortSignal }>) => Promise<Genre | null>,
  selectCategory: ConsumerCategorySelection | undefined,
  clock: () => Instant,
  permissions: ConsumerProvider["permissions"],
): NonNullable<ConsumerProvider["discoverCategory"]> {
  // shortcut: cache lives in this process; use a shared store when running multiple instances.
  const cache = new Map<
    string,
    Readonly<{ result: ConsumerDiscoveredCategory; expires: number }>
  >();
  const discovering = new Map<string, Promise<ConsumerDiscoveredCategory | null>>();
  return async (genreId, options) => {
    options?.signal?.throwIfAborted();
    const rights = permissions(clock());
    if (
      genreId === undefined ||
      genreId === null ||
      !/^\d{1,6}$/.test(genreId) ||
      !rights.fetch ||
      !rights.display
    ) {
      return null;
    }
    const cached = cache.get(genreId);
    if (cached !== undefined && cached.expires > Date.parse(valueOf(clock()))) {
      return { ...cached.result, aiCalls: 0 };
    }
    const pending = discovering.get(genreId);
    if (pending !== undefined) {
      const result = await pending;
      options?.signal?.throwIfAborted();
      return result === null ? null : { ...result, aiCalls: 0 };
    }
    const work = (async (): Promise<ConsumerDiscoveredCategory | null> => {
      const genre = await resolveGenre(genreId, options);
      if (genre === null) {
        return null;
      }
      if (genre.label === null) {
        return null;
      }
      const attributes = (genre.attributes ?? []).filter(
        (attribute) =>
          !/カナ|ふりがな|フリガナ|管理番号|商品コード|特典|キャンペーン|ポイント/.test(
            attribute.label,
          ),
      );
      let status: ConsumerDiscoveredCategory["status"] =
        genre.attributes === null
          ? "unavailable"
          : attributes.length === 0
            ? "no_attributes"
            : "not_configured";
      let aiCalls = 0;
      let majorIds: readonly number[] = [];
      if (attributes.length > 0 && selectCategory !== undefined && permissions(clock()).ai) {
        aiCalls = 1;
        const selected = await selectCategory(genre.label, attributes, options);
        status = selected.tag === "ok" ? "applied" : "unavailable";
        if (selected.tag === "ok") {
          majorIds = selected.value;
        }
      }
      options?.signal?.throwIfAborted();
      if (!permissions(clock()).display) {
        return null;
      }
      const major = attributes.filter((attribute) => majorIds.includes(attribute.id)).slice(0, 16);
      const fields = (status === "applied" ? major : attributes.slice(0, 64)).map((attribute) =>
        Object.freeze({
          id: `attribute${attribute.id}`,
          label: attribute.label,
          unit: "",
          kind: "text",
          filter: null,
          minimum: 0,
          maximum: 0,
          presets: Object.freeze([]),
          extraction: Object.freeze({ kind: "attribute" }),
        } satisfies ConsumerCategoryDefinition["fields"][number]),
      );
      const definition: ConsumerCategoryDefinition = {
        id: `${providerId}_${genre.id}`,
        label: genre.label,
        description: `${genre.label}の商品を比較`,
        providerBindings: { [providerId]: { genreId: genre.id, keyword: genre.label } },
        mainFields: major.map((attribute) => `attribute${attribute.id}`),
        fields,
        // Attribute names do not establish numeric units or which direction is better.
        axes: [{ id: "price", label: "価格", lowerIsBetter: true, weight: 1 }],
        allowUnknownCondition: true,
      };
      const checked = buildConsumerCatalog([definition]).categories[0];
      if (checked === undefined) {
        throw new Error("Missing discovered category");
      }
      const result = Object.freeze({ definition: checked, aiCalls, status });
      cache.delete(genreId);
      cache.set(genreId, {
        result,
        expires: Date.parse(valueOf(clock())) + (status === "unavailable" ? 300_000 : 86_400_000),
      });
      if (cache.size > 128) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) {
          cache.delete(oldest);
        }
      }
      return result;
    })();
    discovering.set(genreId, work);
    try {
      return await work;
    } finally {
      discovering.delete(genreId);
    }
  };
}
