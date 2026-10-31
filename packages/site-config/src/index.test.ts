import assert from "node:assert/strict";
import { test } from "node:test";

import { serviceLinks, serviceOriginsSchema } from "./index.js";

const origins = {
  products: "https://products.example.com",
  furusato: "https://furusato.example.net",
  securities: "https://securities.example.org",
};

await test("service navigation supports independently hosted domains and loopback development", () => {
  assert.deepEqual(
    serviceLinks(serviceOriginsSchema.parse(origins)).map((link) => link.href),
    [
      "https://products.example.com/",
      "https://furusato.example.net/",
      "https://securities.example.org/",
    ],
  );
  assert.doesNotThrow(() =>
    serviceOriginsSchema.parse({
      products: "http://127.0.0.1:5173",
      furusato: "http://127.0.0.1:5174",
      securities: "http://127.0.0.1:5175",
    }),
  );
});

await test("navigation configuration fails closed for missing, duplicate, or non-origin URLs", () => {
  for (const input of [
    null,
    [],
    {},
    { ...origins, hub: "https://hub.example.com" },
    { ...origins, furusato: origins.products },
  ]) {
    assert.throws(() => serviceOriginsSchema.parse(input));
  }
  for (const products of [
    undefined,
    42,
    "",
    "//example.com",
    "javascript:alert(1)",
    "http://example.com",
    "https://user:secret@example.com",
    "https://example.com/path",
    "https://example.com/",
    "https://example.com?query=1",
    "https://example.com#hash",
  ]) {
    assert.throws(() => serviceOriginsSchema.parse({ ...origins, products }));
  }
});
