import { readConsumerCategoryCacheEntry } from "../../comparison/consumer-category-cache.js";
import type { ConsumerCategoryCache } from "../../comparison/consumer-category-cache.js";
import { decodeDynamoPayload, encodeDynamoPayload } from "./codec.js";
import type { DynamoDatabase } from "./database.js";

export function createDynamoCategoryCache(
  database: DynamoDatabase,
  table: string,
): ConsumerCategoryCache {
  return Object.freeze({
    read: async (key) => {
      const item = await database.get(table, key);
      if (item?.data === undefined) {
        return null;
      }
      const entry = readConsumerCategoryCacheEntry(decodeDynamoPayload(item.data));
      if (
        entry === null ||
        item.ttl !== Math.ceil(Date.parse(entry.expiresAt) / 1000) ||
        item.freshUntil !== Date.parse(entry.expiresAt)
      ) {
        throw new Error("Invalid persisted category");
      }
      return entry;
    },
    claim: async (key, owner, now, until) => await database.claim(table, key, owner, now, until),
    publish: async (key, owner, entry, now) => {
      const checked = readConsumerCategoryCacheEntry(entry);
      if (
        checked === null ||
        Date.parse(checked.expiresAt) <= now ||
        Date.parse(checked.expiresAt) > now + 86_400_000
      ) {
        throw new Error("Invalid category expiry");
      }
      return await database.put(
        table,
        {
          key,
          revision: 1,
          ttl: Math.ceil(Date.parse(checked.expiresAt) / 1000),
          freshUntil: Date.parse(checked.expiresAt),
          data: encodeDynamoPayload(checked),
        },
        { kind: "lease", owner, now },
      );
    },
    release: async (key, owner) => {
      await database.release(table, key, owner);
    },
  } satisfies ConsumerCategoryCache);
}
