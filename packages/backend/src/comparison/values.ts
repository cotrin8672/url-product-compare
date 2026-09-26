import { andThen, err, map, none, ok, some } from "./algebra.js";
import type { Option, Result } from "./algebra.js";

const validated = Symbol("validatedValue");
export type SchemaError = Readonly<{ code: "invalid_data"; field: string }>;
export type Schema<T> = Readonly<{ parse: (input: unknown) => Result<T, SchemaError> }>;
type Value<Role extends string> = Readonly<{
  [validated]: Readonly<{ role: Role; value: string }>;
}>;
export type ProviderId = Value<"provider">;
export type Instant = Value<"instant">;
export type HttpsUrl = Value<"httpsUrl">;
type ScopedId<Role extends string> = Readonly<{
  [validated]: Readonly<{ role: Role; provider: ProviderId; value: string }>;
}>;
export type ListingId = ScopedId<"listing">;
export type ProductId = ScopedId<"product">;

export function valueOf(value: Value<string> | ScopedId<string>): string {
  return value[validated].value;
}
export function providerOf(value: ListingId | ProductId): ProviderId {
  return value[validated].provider;
}

export function record(input: unknown): input is Readonly<Record<string, unknown>> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

export function text(input: unknown, field: string): Result<string, SchemaError> {
  return typeof input === "string" && input.trim().length > 0
    ? ok(input.trim())
    : err({ code: "invalid_data", field });
}

export function optional<T>(
  input: unknown,
  parse: (input: unknown) => Result<T, SchemaError>,
): Result<Option<T>, SchemaError> {
  return input === undefined || input === null ? ok(none) : map(parse(input), some);
}

export function providerId(input: unknown): Result<ProviderId, SchemaError> {
  return andThen(text(input, "provider"), (value) =>
    /^[a-z][a-z0-9-]{0,63}$/.test(value)
      ? ok(
          Object.freeze({
            [validated]: Object.freeze({ role: "provider", value }),
          } satisfies ProviderId),
        )
      : err({ code: "invalid_data", field: "provider" }),
  );
}

export function listingId(provider: ProviderId, input: unknown): Result<ListingId, SchemaError> {
  return map(text(input, "listingId"), (value) =>
    Object.freeze({
      [validated]: Object.freeze({ role: "listing", provider, value }),
    } satisfies ListingId),
  );
}

export function productId(provider: ProviderId, input: unknown): Result<ProductId, SchemaError> {
  return map(text(input, "productId"), (value) =>
    Object.freeze({
      [validated]: Object.freeze({ role: "product", provider, value }),
    } satisfies ProductId),
  );
}

export function instant(input: unknown): Result<Instant, SchemaError> {
  return andThen(text(input, "timestamp"), (value) => {
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value
    ) {
      return err({ code: "invalid_data", field: "timestamp" });
    }
    return ok(
      Object.freeze({ [validated]: Object.freeze({ role: "instant", value }) } satisfies Instant),
    );
  });
}

export function httpsUrl(input: unknown): Result<HttpsUrl, SchemaError> {
  return andThen(text(input, "url"), (value) => {
    try {
      const url = new URL(value);
      if (
        url.protocol !== "https:" ||
        url.port !== "" ||
        url.username !== "" ||
        url.password !== "" ||
        url.hash !== "" ||
        !url.hostname.includes(".") ||
        url.hostname.endsWith(".localhost") ||
        /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)
      ) {
        return err({ code: "invalid_data", field: "url" });
      }
      return ok(
        Object.freeze({
          [validated]: Object.freeze({ role: "httpsUrl", value: url.href }),
        } satisfies HttpsUrl),
      );
    } catch {
      return err({ code: "invalid_data", field: "url" });
    }
  });
}

export function sameListingId(left: ListingId, right: ListingId): boolean {
  return (
    valueOf(providerOf(left)) === valueOf(providerOf(right)) && valueOf(left) === valueOf(right)
  );
}

export function sameProductId(left: ProductId, right: ProductId): boolean {
  return (
    valueOf(providerOf(left)) === valueOf(providerOf(right)) && valueOf(left) === valueOf(right)
  );
}

export type Evidence = Readonly<{ provider: ProviderId; source: HttpsUrl; observedAt: Instant }>;

export function evidence(input: unknown): Result<Evidence, SchemaError> {
  if (!record(input)) {
    return err({ code: "invalid_data", field: "evidence" });
  }
  return andThen(providerId(input["provider"]), (provider) =>
    andThen(httpsUrl(input["source"]), (source) =>
      map(instant(input["observedAt"]), (observedAt) =>
        Object.freeze({ provider, source, observedAt }),
      ),
    ),
  );
}

export type Permission =
  | Readonly<{ status: "denied" }>
  | Readonly<{ status: "granted"; expiresAt: Instant }>;
export type Permissions = Readonly<{
  fetch: Permission;
  display: Permission;
  store: Permission;
  ai: Permission;
  affiliate: Permission;
}>;

function permission(input: unknown): Result<Permission, SchemaError> {
  if (!record(input)) {
    return err({ code: "invalid_data", field: "permission" });
  }
  if (input["status"] === "denied") {
    return ok(Object.freeze({ status: "denied" }));
  }
  return input["status"] === "granted"
    ? map(instant(input["expiresAt"]), (expiresAt) =>
        Object.freeze({ status: "granted", expiresAt }),
      )
    : err({ code: "invalid_data", field: "permission" });
}

export function permissions(input: unknown): Result<Permissions, SchemaError> {
  if (!record(input)) {
    return err({ code: "invalid_data", field: "permissions" });
  }
  return andThen(permission(input["fetch"]), (fetch) =>
    andThen(permission(input["display"]), (display) =>
      andThen(permission(input["store"]), (store) =>
        andThen(permission(input["ai"]), (ai) =>
          map(permission(input["affiliate"]), (affiliate) =>
            Object.freeze({ fetch, display, store, ai, affiliate }),
          ),
        ),
      ),
    ),
  );
}

export function permitted(permissionValue: Permission, now: Instant): boolean {
  return permissionValue.status === "granted" && valueOf(permissionValue.expiresAt) > valueOf(now);
}
