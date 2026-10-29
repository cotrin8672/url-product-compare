import type { ConsumerCategoryAttribute, ConsumerDiscoveredCategory } from "./consumer-provider.js";
import { instant, record } from "./values.js";

export type ConsumerCategoryCacheEntry = Readonly<{
  genreId: string;
  label: string;
  attributes: readonly ConsumerCategoryAttribute[];
  majorIds: readonly number[];
  status: ConsumerDiscoveredCategory["status"];
  expiresAt: string;
}>;

export type ConsumerCategoryCache = Readonly<{
  read: (key: string) => Promise<ConsumerCategoryCacheEntry | null>;
  claim: (key: string, owner: string, now: number, until: number) => Promise<boolean>;
  publish: (
    key: string,
    owner: string,
    entry: ConsumerCategoryCacheEntry,
    now: number,
  ) => Promise<boolean>;
  release: (key: string, owner: string) => Promise<void>;
}>;

export type ConsumerCategoryCacheOptions = Readonly<{
  store: ConsumerCategoryCache;
  version: string;
  waitMs?: number;
}>;

function attribute(input: unknown): input is ConsumerCategoryAttribute {
  return (
    record(input) &&
    typeof input["id"] === "number" &&
    Number.isSafeInteger(input["id"]) &&
    input["id"] >= 0 &&
    typeof input["label"] === "string" &&
    input["label"].length > 0 &&
    input["label"].length <= 256 &&
    !/\p{Cc}/u.test(input["label"])
  );
}

function status(input: unknown): input is ConsumerDiscoveredCategory["status"] {
  return (
    input === "applied" ||
    input === "unavailable" ||
    input === "no_attributes" ||
    input === "not_configured"
  );
}

export function readConsumerCategoryCacheEntry(input: unknown): ConsumerCategoryCacheEntry | null {
  if (
    !record(input) ||
    typeof input["genreId"] !== "string" ||
    !/^\d{1,6}$/.test(input["genreId"]) ||
    typeof input["label"] !== "string" ||
    input["label"].length === 0 ||
    input["label"].length > 256 ||
    !Array.isArray(input["attributes"]) ||
    input["attributes"].length > 64 ||
    !Array.isArray(input["majorIds"]) ||
    input["majorIds"].length > 16 ||
    !status(input["status"]) ||
    typeof input["expiresAt"] !== "string" ||
    instant(input["expiresAt"]).tag !== "ok"
  ) {
    return null;
  }
  const attributes: readonly unknown[] = input["attributes"];
  const majorIds: readonly unknown[] = input["majorIds"];
  if (
    !attributes.every(attribute) ||
    !majorIds.every((id): id is number => typeof id === "number" && Number.isSafeInteger(id)) ||
    new Set(attributes.map((entry) => entry.id)).size !== attributes.length ||
    new Set(majorIds).size !== majorIds.length ||
    majorIds.some((id) => !attributes.some((entry) => entry.id === id)) ||
    (input["status"] !== "applied" && majorIds.length !== 0)
  ) {
    return null;
  }
  return Object.freeze({
    genreId: input["genreId"],
    label: input["label"],
    attributes: Object.freeze(attributes.map((entry) => Object.freeze({ ...entry }))),
    majorIds: Object.freeze([...majorIds]),
    status: input["status"],
    expiresAt: input["expiresAt"],
  });
}
