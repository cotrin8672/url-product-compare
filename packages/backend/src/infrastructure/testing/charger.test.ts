import assert from "node:assert/strict";
import { test } from "node:test";

import { ok } from "../../comparison/algebra.js";
import type { Result } from "../../comparison/algebra.js";
import { productsSchema, readProduct } from "../../comparison/catalog.js";
import { chargerUseSchema, compareChargerFeatures } from "../../comparison/charger-comparison.js";
import {
  assessCharging,
  chargerSpecificationSchema,
  chargingContextSchema,
  rankChargers,
} from "../../comparison/charger.js";
import { factSchema } from "../../comparison/ranking.js";
import type { Judge, RankingPolicy } from "../../comparison/ranking.js";
import { instant, valueOf } from "../../comparison/values.js";

function unwrap<T, E>(result: Result<T, E>): T {
  assert.equal(result.tag, "ok");
  return result.value;
}
const observedAt = "2026-10-01T00:00:00.000Z";
const expiresAt = "2026-10-02T00:00:00.000Z";
const now = unwrap(instant("2026-10-01T01:00:00.000Z"));
const evidence = { provider: "example", source: "https://example.com/charger", observedAt };
const rights = {
  fetch: { status: "granted", expiresAt },
  display: { status: "granted", expiresAt },
  store: { status: "denied" },
  ai: { status: "granted", expiresAt },
  affiliate: { status: "denied" },
};
const raw = {
  kind: "ac-usb-c-charger",
  productId: "charger",
  evidence,
  permissions: rights,
  expiresAt,
  input: { plug: "jp-a", minVoltageV: 100, maxVoltageV: 240, frequenciesHz: [50, 60] },
  configurationsComplete: true,
  configurations: [
    {
      maxTotalPowerW: 65,
      ports: [
        { port: "C1", maxPowerW: 65, profiles: [{ protocol: "pd", voltageV: 20, currentA: 3.25 }] },
      ],
    },
    {
      maxTotalPowerW: 65,
      ports: [
        { port: "C1", maxPowerW: 45, profiles: [{ protocol: "pd", voltageV: 20, currentA: 2.25 }] },
        { port: "C2", maxPowerW: 20, profiles: [{ protocol: "pd", voltageV: 5, currentA: 3 }] },
      ],
    },
  ],
};
const laptop = {
  id: "laptop",
  protocol: "pd",
  voltageV: 20,
  currentA: 3.25,
  cable: { maxCurrentA: 5, maxVoltageV: 20 },
};
const phone = {
  id: "phone",
  protocol: "pd",
  voltageV: 5,
  currentA: 3,
  cable: { maxCurrentA: 3, maxVoltageV: 20 },
};

await test("USB-C compatibility uses the active-port table, negotiated output and verified cable", () => {
  const specification = unwrap(chargerSpecificationSchema.parse(raw));
  const assess = (devices: unknown) =>
    assessCharging(specification, unwrap(chargingContextSchema.parse({ devices })), now);
  assert.equal(assess([laptop]).status, "compatible");
  assert.deepEqual(assess([laptop, phone]), {
    status: "incompatible",
    reason: "output_configuration",
  });
  assert.equal(assess([{ ...laptop, currentA: 2.25 }, phone]).status, "compatible");
  assert.deepEqual(assess([{ ...laptop, cable: { maxCurrentA: 3, maxVoltageV: 20 } }]), {
    status: "incompatible",
    reason: "cable_capacity",
  });
  assert.deepEqual(assess([{ ...laptop, cable: null }]), {
    status: "unknown",
    reason: "cable_unknown",
  });
  assert.deepEqual(assess([{ ...laptop, cable: null }, phone]), {
    status: "incompatible",
    reason: "output_configuration",
  });
  const partial = unwrap(
    chargerSpecificationSchema.parse({
      ...raw,
      configurationsComplete: false,
      limits: { maxDevices: 2, maxTotalPowerW: 65 },
    }),
  );
  assert.deepEqual(
    assessCharging(partial, unwrap(chargingContextSchema.parse({ devices: [laptop, phone] })), now),
    { status: "incompatible", reason: "output_configuration" },
  );
  assert.deepEqual(
    assessCharging(
      partial,
      unwrap(
        chargingContextSchema.parse({
          devices: [phone, { ...phone, id: "other" }, { ...phone, id: "third" }],
        }),
      ),
      now,
    ),
    { status: "incompatible", reason: "output_configuration" },
  );
  for (const limits of [
    { maxDevices: 1, maxTotalPowerW: 65 },
    { maxDevices: 2, maxTotalPowerW: 45 },
    { maxDevices: 0, maxTotalPowerW: 65 },
    { maxDevices: 5, maxTotalPowerW: 65 },
    { maxDevices: 2, maxTotalPowerW: -1 },
  ]) {
    assert.equal(chargerSpecificationSchema.parse({ ...raw, limits }).tag, "err");
  }
  assert.deepEqual(assess([{ ...laptop, voltageV: 15 }]), {
    status: "incompatible",
    reason: "output_configuration",
  });
  const pair = unwrap(chargingContextSchema.parse({ devices: [laptop, phone] }));
  assert.deepEqual(
    assessCharging(
      unwrap(chargerSpecificationSchema.parse({ ...raw, configurationsComplete: false })),
      pair,
      now,
    ),
    { status: "unknown", reason: "incomplete_configurations" },
  );
  for (const input of [
    { ...raw.input, plug: "other" },
    { ...raw.input, minVoltageV: 110 },
    { ...raw.input, frequenciesHz: [60] },
  ]) {
    assert.deepEqual(
      assessCharging(unwrap(chargerSpecificationSchema.parse({ ...raw, input })), pair, now),
      { status: "incompatible", reason: "ac_input" },
    );
  }
  assert.deepEqual(assessCharging(specification, pair, unwrap(instant(expiresAt))), {
    status: "unknown",
    reason: "source_not_authorized",
  });
  assert.deepEqual(
    assessCharging(
      unwrap(chargerSpecificationSchema.parse({ ...raw, expiresAt: "2026-10-01T00:30:00.000Z" })),
      pair,
      now,
    ),
    { status: "unknown", reason: "stale_specification" },
  );
  const pps = unwrap(
    chargerSpecificationSchema.parse({
      ...raw,
      configurations: [
        {
          maxTotalPowerW: 45,
          ports: [
            {
              port: "C1",
              maxPowerW: 45,
              profiles: [{ protocol: "pps", minVoltageV: 3.3, maxVoltageV: 11, currentA: 4.05 }],
            },
          ],
        },
      ],
    }),
  );
  const ppsDevice = {
    ...phone,
    protocol: "pps",
    voltageV: 9,
    currentA: 4,
    cable: { maxCurrentA: 5, maxVoltageV: 20 },
  };
  assert.equal(
    assessCharging(pps, unwrap(chargingContextSchema.parse({ devices: [ppsDevice] })), now).status,
    "compatible",
  );
  for (const device of [
    { ...ppsDevice, voltageV: 12 },
    { ...ppsDevice, currentA: 4.1 },
    { ...ppsDevice, protocol: "pd" },
  ]) {
    assert.equal(
      assessCharging(pps, unwrap(chargingContextSchema.parse({ devices: [device] })), now).status,
      "incompatible",
    );
  }
  const overloaded = unwrap(
    chargerSpecificationSchema.parse({
      ...raw,
      configurations: [
        {
          maxTotalPowerW: 70,
          ports: [
            {
              port: "C1",
              maxPowerW: 65,
              profiles: [{ protocol: "pd", voltageV: 20, currentA: 3.25 }],
            },
            { port: "C2", maxPowerW: 15, profiles: [{ protocol: "pd", voltageV: 5, currentA: 3 }] },
          ],
        },
      ],
    }),
  );
  assert.equal(assessCharging(overloaded, pair, now).status, "incompatible");
  const reassigned = assessCharging(
    specification,
    unwrap(chargingContextSchema.parse({ devices: [phone, { ...laptop, currentA: 2.25 }] })),
    now,
  );
  assert.ok(reassigned.status === "compatible");
  assert.deepEqual(reassigned.assignments, [
    { deviceId: "phone", port: "C2" },
    { deviceId: "laptop", port: "C1" },
  ]);
  for (const invalid of [
    { ...raw, kind: "power-bank" },
    { ...raw, configurations: [] },
    { ...raw, configurationsComplete: undefined },
    {
      ...raw,
      configurations: [
        {
          maxTotalPowerW: 65,
          ports: [
            {
              port: "C1",
              maxPowerW: 65,
              profiles: [{ protocol: "pd", voltageV: 20, currentA: Number.NaN }],
            },
          ],
        },
      ],
    },
  ]) {
    assert.equal(chargerSpecificationSchema.parse(invalid).tag, "err");
  }
  for (const devices of [
    [laptop, laptop],
    [{ ...laptop, cable: undefined }],
    [{ ...laptop, currentA: Infinity }],
  ]) {
    assert.equal(chargingContextSchema.parse({ devices }).tag, "err");
  }
});

await test("unknown or mismatched charger specifications stop before Jev and compatible configurations reach it", async () => {
  const product = unwrap(
    productsSchema.parse([
      {
        productId: "charger",
        evidence,
        permissions: rights,
        identity: {
          manufacturer: "Example",
          model: "charger",
          gtin: null,
          variant: { status: "confirmed", color: null, capacity: null, packCount: 1 },
        },
      },
    ]),
  )[0];
  assert.ok(product !== undefined);
  const fact = unwrap(
    factSchema.parse({
      productId: "charger",
      key: "portLabeling",
      status: "confirmed",
      value: "Laptop",
      excerpt: "Laptop",
      evidence,
      permissions: rights,
    }),
  );
  const candidate = {
    product,
    facts: [fact],
    specification: unwrap(chargerSpecificationSchema.parse(raw)),
  };
  const policy = {
    version: "test",
    category: "usb-c-wall-charger",
    mode: "overall",
    tieMargin: 0.05,
    minimumConfidence: 0.7,
    criteria: [
      {
        id: "port_operation",
        weight: 1,
        factKeys: ["portLabeling"],
        instructions: "Evaluate port labels",
        levels: ["Unclear role", "Neutral identifier", "Explicit device role"],
      },
    ],
  } satisfies RankingPolicy;
  let calls = 0;
  const judge: Judge = () => {
    calls += 1;
    return Promise.resolve(
      ok({
        model: "jev-test",
        answers: {
          port_operation: {
            score: 2,
            confidence: 1,
            legend: { "0": "Unclear role", "1": "Neutral identifier", "2": "Explicit device role" },
            probabilities: { "0": 0, "1": 0, "2": 1 },
          },
        },
      }),
    );
  };
  const run = (devices: unknown, specification = candidate.specification) =>
    rankChargers(
      [{ ...candidate, specification }],
      unwrap(chargingContextSchema.parse({ devices })),
      [{ id: "port_operation", status: "confirmed", preference: "Dedicated laptop port" }],
      policy,
      judge,
      () => now,
    );
  assert.equal((await run([laptop, phone])).tag, "err");
  assert.equal((await run([{ ...laptop, cable: null }])).tag, "err");
  assert.equal(
    (await run([laptop], unwrap(chargerSpecificationSchema.parse({ ...raw, productId: "other" }))))
      .tag,
    "err",
  );
  assert.equal(calls, 0);
  assert.equal(unwrap(await run([laptop])).ranked[0]?.index, 1);
  assert.equal(calls, 1);
});

await test("confirmed feature axes follow the user's preference, including fixed plugs and numeric labels", () => {
  const candidate = (id: string, port: unknown, plug: unknown) => {
    const product = unwrap(
      productsSchema.parse([
        {
          productId: id,
          evidence,
          permissions: rights,
          identity: {
            manufacturer: "Example",
            model: id,
            gtin: null,
            variant: { status: "confirmed", color: null, capacity: null, packCount: 1 },
          },
        },
      ]),
    )[0];
    assert.ok(product !== undefined);
    return {
      product,
      specification: unwrap(chargerSpecificationSchema.parse({ ...raw, productId: id })),
      facts: [
        unwrap(
          factSchema.parse({
            productId: id,
            key: "printedPortMarking",
            status: "confirmed",
            value: port,
            excerpt: String(port),
            evidence,
            permissions: rights,
          }),
        ),
        unwrap(
          factSchema.parse({
            productId: id,
            key: "plugDesign",
            status: "confirmed",
            value: plug,
            excerpt: String(plug),
            evidence,
            permissions: rights,
          }),
        ),
      ],
    };
  };
  const candidates = [
    candidate("fixed", "numbered", "fixed"),
    candidate("capped", "unmarked", "capped"),
    candidate("folding", "device_role", "folding"),
  ] as const;
  const source = readProduct(candidates[0].product).id;
  const compare = (portPreference: string, plugPreference: string) =>
    unwrap(
      compareChargerFeatures(
        candidates,
        source,
        unwrap(chargerUseSchema.parse({ devices: [laptop], portPreference, plugPreference })),
        now,
      ),
    );
  for (const [port, plug, expected] of [
    ["ignore", "prefer_folding", ["folding", "capped", "fixed"]],
    ["ignore", "prefer_fixed", ["capped", "fixed", "folding"]],
    ["prefer_roles", "ignore", ["folding", "fixed", "capped"]],
    ["prefer_numbers", "ignore", ["fixed", "folding", "capped"]],
  ] as const) {
    const result = compare(port, plug);
    assert.equal(result.status, "ranked");
    assert.deepEqual(
      result.products.map((entry) => valueOf(readProduct(entry.product).id)),
      expected,
    );
    assert.equal(
      result.products.every((entry) => entry.axes.length === 1),
      true,
    );
    assert.equal(result.displayPercent, false);
  }
  assert.deepEqual(
    compare("ignore", "prefer_fixed").products.map((entry) => entry.rank),
    [1, 1, 3],
  );
  const required = compare("prefer_roles", "require_fixed");
  assert.equal(
    required.products.find((entry) => valueOf(readProduct(entry.product).id) === "folding")?.status,
    "excluded",
  );
  assert.equal(
    required.products.find((entry) => valueOf(readProduct(entry.product).id) === "folding")?.rank,
    null,
  );
  assert.deepEqual(
    compare("ignore", "require_folding").products.map((entry) => entry.status),
    ["eligible", "excluded", "excluded"],
  );
  assert.deepEqual(
    compare("require_numbers", "ignore").products.map((entry) => entry.status),
    ["eligible", "excluded", "excluded"],
  );
  assert.equal(compare("require_roles", "require_fixed").status, "no_match");
  const off = compare("ignore", "ignore");
  assert.equal(off.status, "unranked");
  assert.equal(
    off.products.every((entry) => entry.rank === null && entry.axes.length === 0),
    true,
  );
  const reversed = unwrap(
    compareChargerFeatures(
      [...candidates].reverse(),
      source,
      unwrap(
        chargerUseSchema.parse({
          devices: [laptop],
          portPreference: "prefer_roles",
          plugPreference: "prefer_folding",
        }),
      ),
      now,
    ),
  );
  assert.deepEqual(reversed, compare("prefer_roles", "prefer_folding"));
  for (const portPreference of ["bad", null, 1]) {
    assert.equal(
      chargerUseSchema.parse({ devices: [laptop], portPreference, plugPreference: "ignore" }).tag,
      "err",
    );
  }
  const validUse = unwrap(
    chargerUseSchema.parse({
      devices: [laptop],
      portPreference: "ignore",
      plugPreference: "prefer_folding",
    }),
  );
  for (const entries of [
    [],
    [candidates[1]],
    [candidates[0], candidates[0]],
    [{ ...candidates[0], facts: [...candidates[0].facts, ...candidates[0].facts] }],
  ]) {
    assert.deepEqual(compareChargerFeatures(entries, source, validUse, now), {
      tag: "err",
      error: { code: "invalid_request" },
    });
  }
  const unknown = candidate("unknown", "numbered", "Unknown");
  for (const facts of [
    [],
    unknown.facts,
    unknown.facts.map((fact) => ({
      ...fact,
      permissions: { ...fact.permissions, display: { status: "denied" } as const },
    })),
  ]) {
    const entries = [candidates[0], { ...unknown, facts }];
    const result = unwrap(compareChargerFeatures(entries, source, validUse, now));
    assert.equal(result.status, "needs_information");
    assert.equal(
      result.products.every((entry) => entry.rank === null),
      true,
    );
    const ignored = unwrap(
      compareChargerFeatures(
        entries,
        source,
        unwrap(
          chargerUseSchema.parse({
            devices: [laptop],
            portPreference: "ignore",
            plugPreference: "ignore",
          }),
        ),
        now,
      ),
    );
    assert.equal(ignored.status, "unranked");
    assert.equal(
      ignored.products.every((entry) => entry.status === "eligible"),
      true,
    );
  }
  const cableUnknown = unwrap(
    compareChargerFeatures(
      candidates,
      source,
      unwrap(
        chargerUseSchema.parse({
          devices: [{ ...laptop, cable: null }],
          portPreference: "prefer_roles",
          plugPreference: "prefer_folding",
        }),
      ),
      now,
    ),
  );
  assert.equal(cableUnknown.status, "needs_information");
  assert.equal(
    cableUnknown.products.every((entry) => entry.status === "pending" && entry.rank === null),
    true,
  );
});
