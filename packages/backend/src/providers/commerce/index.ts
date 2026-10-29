import type { CommerceProvider } from "../../comparison/commerce.js";
import { record } from "../../comparison/values.js";
import { createAmazonCommerceProvider } from "./amazon.js";
import { createValueCommerceProvider } from "./valuecommerce.js";
import { createYahooShoppingCommerceProvider } from "./yahoo.js";

export function createExternalCommerceProviders(
  input: unknown,
  clock: () => string,
  fetcher: typeof fetch = fetch,
): readonly CommerceProvider[] {
  if (input === undefined || input === null) {
    return Object.freeze([]);
  }
  if (
    !record(input) ||
    Object.keys(input).some((key) => !["amazon", "yahoo", "satofull"].includes(key))
  ) {
    throw new Error("Invalid external commerce settings");
  }
  const providers: CommerceProvider[] = [];
  if (input["amazon"] !== undefined && input["amazon"] !== null) {
    providers.push(createAmazonCommerceProvider(input["amazon"], clock, fetcher));
  }
  for (const source of ["yahoo", "satofull"] satisfies ReadonlyArray<"yahoo" | "satofull">) {
    if (input[source] !== undefined && input[source] !== null) {
      const settings = input[source];
      providers.push(
        source === "yahoo" && record(settings) && settings["applicationId"] !== undefined
          ? createYahooShoppingCommerceProvider(settings, clock, fetcher)
          : createValueCommerceProvider(source, settings, clock, fetcher),
      );
    }
  }
  return Object.freeze(providers);
}
