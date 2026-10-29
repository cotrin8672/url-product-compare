import { buildConsumerCatalog } from "./consumer-catalog.js";
import type { ConsumerCategoryDefinition } from "./consumer-catalog.js";
import { readConsumerCategoryCacheEntry } from "./consumer-category-cache.js";
import type {
  ConsumerCategoryCacheEntry,
  ConsumerCategoryCacheOptions,
} from "./consumer-category-cache.js";
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

function category(
  providerId: string,
  entry: ConsumerCategoryCacheEntry,
  aiCalls: number,
): ConsumerDiscoveredCategory {
  const major = entry.attributes
    .filter((attribute) => entry.majorIds.includes(attribute.id))
    .slice(0, 16);
  const definition: ConsumerCategoryDefinition = {
    id: `${providerId}_${entry.genreId}`,
    label: entry.label,
    description: `${entry.label}の商品を比較`,
    providerBindings: { [providerId]: { genreId: entry.genreId, keyword: entry.label } },
    mainFields: major.map((attribute) => `attribute${attribute.id}`),
    fields: (entry.status === "applied" ? major : entry.attributes).map((attribute) => ({
      id: `attribute${attribute.id}`,
      label: attribute.label,
      unit: "",
      kind: "text",
      filter: null,
      minimum: 0,
      maximum: 0,
      presets: [],
      extraction: { kind: "attribute" },
    })),
    axes: [
      { id: "price", label: "価格", lowerIsBetter: true, weight: 1 },
      ...major.map(
        (attribute) =>
          ({
            id: `attribute${attribute.id}`,
            label: attribute.label,
            lowerIsBetter: false,
            weight: 1,
            method: "jev",
          }) satisfies ConsumerCategoryDefinition["axes"][number],
      ),
    ],
  };
  const checked = buildConsumerCatalog([definition]).categories[0];
  if (checked === undefined) {
    throw new Error("Missing discovered category");
  }
  return Object.freeze({ definition: checked, aiCalls, status: entry.status });
}

async function pause(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const stop = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      reject(new Error("Category discovery aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve();
    }, 100);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted === true) {
      stop();
    }
  });
}

export function createConsumerCategoryDiscovery(
  providerId: string,
  resolveGenre: (id: string, options?: Readonly<{ signal?: AbortSignal }>) => Promise<Genre | null>,
  selectCategory: ConsumerCategorySelection | undefined,
  clock: () => Instant,
  permissions: ConsumerProvider["permissions"],
  shared?: ConsumerCategoryCacheOptions,
): NonNullable<ConsumerProvider["discoverCategory"]> {
  const cache = new Map<string, ConsumerCategoryCacheEntry>();
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
    const ai = rights.ai && selectCategory !== undefined;
    const key = `${providerId}:${genreId}:${shared?.version ?? "memory-v1"}:${ai ? "ai" : "no-ai"}`;
    const permitted = (): boolean => {
      const current = permissions(clock());
      return (
        current.fetch && current.display && (current.ai && selectCategory !== undefined) === ai
      );
    };
    const fresh = (
      entry: ConsumerCategoryCacheEntry | null | undefined,
    ): entry is ConsumerCategoryCacheEntry => {
      const now = Date.parse(valueOf(clock()));
      return (
        entry?.genreId === genreId &&
        Date.parse(entry.expiresAt) > now &&
        Date.parse(entry.expiresAt) <= now + 86_400_000 &&
        permitted()
      );
    };
    const remember = (entry: ConsumerCategoryCacheEntry): void => {
      cache.delete(key);
      cache.set(key, entry);
      if (cache.size > 128) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) {
          cache.delete(oldest);
        }
      }
    };
    const cached = cache.get(key);
    if (fresh(cached)) {
      return category(providerId, cached, 0);
    }
    const pending = discovering.get(key);
    if (pending !== undefined) {
      const result = await pending;
      options?.signal?.throwIfAborted();
      return result === null || !permitted() ? null : { ...result, aiCalls: 0 };
    }
    const work = (async (): Promise<ConsumerDiscoveredCategory | null> => {
      const owner = crypto.randomUUID();
      let claimed = false;
      try {
        if (shared !== undefined) {
          try {
            const entry = await shared.store.read(key);
            options?.signal?.throwIfAborted();
            if (fresh(entry)) {
              remember(entry);
              return category(providerId, entry, 0);
            }
            const now = Date.parse(valueOf(clock()));
            claimed = await shared.store.claim(key, owner, now, now + 30_000);
            if (!claimed) {
              const deadline = Date.now() + (shared.waitMs ?? 15_000);
              do {
                options?.signal?.throwIfAborted();
                const ready = await shared.store.read(key);
                if (fresh(ready)) {
                  remember(ready);
                  return category(providerId, ready, 0);
                }
                if (!permitted()) {
                  return null;
                }
                await pause(options?.signal);
              } while (Date.now() < deadline);
              return null;
            }
          } catch {
            options?.signal?.throwIfAborted();
            // Shared storage failure must not cause unbounded paid re-inference.
            return null;
          }
        }
        const genre = await resolveGenre(genreId, options);
        if (genre?.id !== genreId || genre.label === null || !permitted()) {
          return null;
        }
        const attributes = (genre.attributes ?? [])
          .filter(
            (attribute) =>
              !/カナ|ふりがな|フリガナ|管理番号|商品コード|商品状態|中古状態|特典|キャンペーン|ポイント|^状態$/.test(
                attribute.label,
              ),
          )
          .slice(0, 64);
        let status: ConsumerDiscoveredCategory["status"] =
          genre.attributes === null
            ? "unavailable"
            : attributes.length === 0
              ? "no_attributes"
              : "not_configured";
        let aiCalls = 0;
        let majorIds: readonly number[] = [];
        if (attributes.length > 0 && ai && permitted()) {
          aiCalls = 1;
          const selected = await selectCategory(genre.label, attributes, options);
          status = selected.tag === "ok" ? "applied" : "unavailable";
          if (selected.tag === "ok") {
            majorIds = attributes
              .filter((attribute) => selected.value.includes(attribute.id))
              .slice(0, 16)
              .map((attribute) => attribute.id);
          }
        }
        options?.signal?.throwIfAborted();
        if (!permitted()) {
          return null;
        }
        const entry = readConsumerCategoryCacheEntry({
          genreId,
          label: genre.label,
          attributes,
          majorIds,
          status,
          expiresAt: new Date(
            Date.parse(valueOf(clock())) + (status === "unavailable" ? 300_000 : 86_400_000),
          ).toISOString(),
        });
        if (entry === null) {
          throw new Error("Invalid category cache entry");
        }
        const result = category(providerId, entry, aiCalls);
        if (shared !== undefined) {
          try {
            if (!(await shared.store.publish(key, owner, entry, Date.parse(valueOf(clock()))))) {
              return null;
            }
          } catch {
            return null;
          }
        }
        remember(entry);
        return result;
      } finally {
        if (shared !== undefined && claimed) {
          await shared.store.release(key, owner).catch(() => undefined);
        }
      }
    })();
    discovering.set(key, work);
    try {
      return await work;
    } finally {
      discovering.delete(key);
    }
  };
}
