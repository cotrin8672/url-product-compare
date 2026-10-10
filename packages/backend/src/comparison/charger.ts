import { err, ok, sequence } from "./algebra.js";
import type { Result } from "./algebra.js";
import { hasProductIdentity, readProduct } from "./catalog.js";
import { rankProducts } from "./ranking.js";
import type {
  Candidate,
  Judge,
  Preference,
  Ranking,
  RankingError,
  RankingPolicy,
} from "./ranking.js";
import {
  evidence,
  instant,
  permitted,
  permissions,
  productId,
  record,
  sameProductId,
  text,
  valueOf,
} from "./values.js";
import type { Evidence, Instant, Permissions, ProductId, Schema, SchemaError } from "./values.js";

type OutputProfile =
  | Readonly<{ protocol: "pd"; voltageV: number; currentA: number }>
  | Readonly<{ protocol: "pps"; minVoltageV: number; maxVoltageV: number; currentA: number }>;
type PortOutput = Readonly<{ port: string; maxPowerW: number; profiles: readonly OutputProfile[] }>;
type OutputConfiguration = Readonly<{ maxTotalPowerW: number; ports: readonly PortOutput[] }>;
export type ChargerSpecification = Readonly<{
  productId: ProductId;
  evidence: Evidence;
  permissions: Permissions;
  expiresAt: Instant;
  input: Readonly<{
    plug: "jp-a" | "other";
    minVoltageV: number;
    maxVoltageV: number;
    frequenciesHz: readonly number[];
  }>;
  configurationsComplete: boolean;
  limits: Readonly<{ maxDevices: number; maxTotalPowerW: number }> | null;
  configurations: readonly OutputConfiguration[];
}>;
type DeviceDemand = Readonly<{
  id: string;
  protocol: "pd" | "pps";
  voltageV: number;
  currentA: number;
  cable: Readonly<{ maxCurrentA: number; maxVoltageV: number }> | null;
}>;
export type ChargingContext = Readonly<{
  // Initial category: direct use in Japan, without travel adapters.
  devices: readonly DeviceDemand[];
}>;
type Assignment = Readonly<{ deviceId: string; port: string }>;
export type ChargingAssessment =
  | Readonly<{ status: "compatible"; assignments: readonly Assignment[]; evidence: Evidence }>
  | Readonly<{
      status: "incompatible";
      reason: "ac_input" | "cable_capacity" | "output_configuration";
    }>
  | Readonly<{
      status: "unknown";
      reason:
        | "source_not_authorized"
        | "stale_specification"
        | "cable_unknown"
        | "incomplete_configurations";
    }>;

function positive(input: unknown): input is number {
  return typeof input === "number" && Number.isFinite(input) && input > 0;
}
function invalid(field: string): Result<never, SchemaError> {
  return err({ code: "invalid_data", field });
}
function parseProfile(input: unknown): Result<OutputProfile, SchemaError> {
  if (!record(input) || !positive(input["currentA"]) || input["currentA"] > 5) {
    return invalid("output_profile");
  }
  if (input["protocol"] === "pd" && positive(input["voltageV"]) && input["voltageV"] <= 48) {
    return ok(
      Object.freeze({ protocol: "pd", voltageV: input["voltageV"], currentA: input["currentA"] }),
    );
  }
  if (
    input["protocol"] === "pps" &&
    positive(input["minVoltageV"]) &&
    positive(input["maxVoltageV"]) &&
    input["minVoltageV"] <= input["maxVoltageV"] &&
    input["maxVoltageV"] <= 21
  ) {
    return ok(
      Object.freeze({
        protocol: "pps",
        minVoltageV: input["minVoltageV"],
        maxVoltageV: input["maxVoltageV"],
        currentA: input["currentA"],
      }),
    );
  }
  return invalid("output_profile");
}
function parsePort(input: unknown): Result<PortOutput, SchemaError> {
  if (
    !record(input) ||
    !positive(input["maxPowerW"]) ||
    input["maxPowerW"] > 240 ||
    !Array.isArray(input["profiles"]) ||
    input["profiles"].length === 0
  ) {
    return invalid("port_output");
  }
  const port = text(input["port"], "port");
  const profiles = sequence(input["profiles"].map((profile: unknown) => parseProfile(profile)));
  if (port.tag === "err") {
    return port;
  }
  if (profiles.tag === "err") {
    return profiles;
  }
  return ok(
    Object.freeze({
      port: port.value,
      maxPowerW: input["maxPowerW"],
      profiles: Object.freeze(profiles.value),
    }),
  );
}
function parseConfiguration(input: unknown): Result<OutputConfiguration, SchemaError> {
  if (
    !record(input) ||
    !positive(input["maxTotalPowerW"]) ||
    input["maxTotalPowerW"] > 960 ||
    !Array.isArray(input["ports"]) ||
    input["ports"].length < 1 ||
    input["ports"].length > 4
  ) {
    return invalid("output_configuration");
  }
  const ports = sequence(input["ports"].map((port: unknown) => parsePort(port)));
  if (ports.tag === "err") {
    return ports;
  }
  if (new Set(ports.value.map((port) => port.port)).size !== ports.value.length) {
    return invalid("duplicate_port");
  }
  return ok(
    Object.freeze({ maxTotalPowerW: input["maxTotalPowerW"], ports: Object.freeze(ports.value) }),
  );
}

export const chargerSpecificationSchema: Schema<ChargerSpecification> = Object.freeze({
  parse(input: unknown): Result<ChargerSpecification, SchemaError> {
    if (
      !record(input) ||
      input["kind"] !== "ac-usb-c-charger" ||
      !record(input["input"]) ||
      typeof input["configurationsComplete"] !== "boolean" ||
      !Array.isArray(input["configurations"]) ||
      (input["configurationsComplete"] && input["configurations"].length === 0)
    ) {
      return invalid("charger_specification");
    }
    const ac = input["input"];
    const limits = input["limits"];
    if (
      limits !== undefined &&
      limits !== null &&
      (!record(limits) ||
        !Number.isInteger(limits["maxDevices"]) ||
        typeof limits["maxDevices"] !== "number" ||
        limits["maxDevices"] < 1 ||
        limits["maxDevices"] > 4 ||
        !positive(limits["maxTotalPowerW"]) ||
        limits["maxTotalPowerW"] > 960)
    ) {
      return invalid("charger_limits");
    }
    if (
      (ac["plug"] !== "jp-a" && ac["plug"] !== "other") ||
      !positive(ac["minVoltageV"]) ||
      !positive(ac["maxVoltageV"]) ||
      ac["minVoltageV"] > ac["maxVoltageV"] ||
      !Array.isArray(ac["frequenciesHz"]) ||
      ac["frequenciesHz"].length === 0 ||
      !ac["frequenciesHz"].every((frequency: unknown) => frequency === 50 || frequency === 60)
    ) {
      return invalid("ac_input");
    }
    const source = evidence(input["evidence"]);
    const rights = permissions(input["permissions"]);
    const expiresAt = instant(input["expiresAt"]);
    const configurations = sequence(
      input["configurations"].map((configuration: unknown) => parseConfiguration(configuration)),
    );
    if (source.tag === "err") {
      return source;
    }
    if (rights.tag === "err") {
      return rights;
    }
    if (expiresAt.tag === "err") {
      return expiresAt;
    }
    if (configurations.tag === "err") {
      return configurations;
    }
    if (
      record(limits) &&
      typeof limits["maxDevices"] === "number" &&
      typeof limits["maxTotalPowerW"] === "number"
    ) {
      const maxDevices = limits["maxDevices"];
      const maxTotalPowerW = limits["maxTotalPowerW"];
      if (
        configurations.value.some(
          (configuration) =>
            configuration.ports.length > maxDevices ||
            configuration.maxTotalPowerW > maxTotalPowerW ||
            configuration.ports.some((port) => port.maxPowerW > maxTotalPowerW),
        )
      ) {
        return invalid("inconsistent_charger_limits");
      }
    }
    const target = productId(source.value.provider, input["productId"]);
    if (target.tag === "err") {
      return target;
    }
    if (valueOf(expiresAt.value) <= valueOf(source.value.observedAt)) {
      return invalid("expiresAt");
    }
    return ok(
      Object.freeze({
        productId: target.value,
        evidence: source.value,
        permissions: rights.value,
        expiresAt: expiresAt.value,
        input: Object.freeze({
          plug: ac["plug"],
          minVoltageV: ac["minVoltageV"],
          maxVoltageV: ac["maxVoltageV"],
          frequenciesHz: Object.freeze(
            ac["frequenciesHz"].map((frequency: unknown) => (frequency === 50 ? 50 : 60)),
          ),
        }),
        configurationsComplete: input["configurationsComplete"],
        limits:
          record(limits) &&
          typeof limits["maxDevices"] === "number" &&
          typeof limits["maxTotalPowerW"] === "number"
            ? Object.freeze({
                maxDevices: limits["maxDevices"],
                maxTotalPowerW: limits["maxTotalPowerW"],
              })
            : null,
        configurations: Object.freeze(configurations.value),
      }),
    );
  },
});

export const chargingContextSchema: Schema<ChargingContext> = Object.freeze({
  parse(input: unknown): Result<ChargingContext, SchemaError> {
    if (
      !record(input) ||
      !Array.isArray(input["devices"]) ||
      input["devices"].length < 1 ||
      input["devices"].length > 4
    ) {
      return invalid("devices");
    }
    const devices: DeviceDemand[] = [];
    for (const device of input["devices"]) {
      if (
        !record(device) ||
        typeof device["id"] !== "string" ||
        device["id"].trim().length === 0 ||
        (device["protocol"] !== "pd" && device["protocol"] !== "pps") ||
        !positive(device["voltageV"]) ||
        device["voltageV"] > (device["protocol"] === "pps" ? 21 : 48) ||
        !positive(device["currentA"]) ||
        device["currentA"] > 5
      ) {
        return invalid("device_demand");
      }
      const cable = device["cable"];
      let verifiedCable: DeviceDemand["cable"] = null;
      if (cable !== null) {
        if (!record(cable)) {
          return invalid("cable");
        }
        const maxCurrentA = cable["maxCurrentA"];
        const maxVoltageV = cable["maxVoltageV"];
        if (
          !positive(maxCurrentA) ||
          maxCurrentA > 5 ||
          !positive(maxVoltageV) ||
          maxVoltageV > 48
        ) {
          return invalid("cable");
        }
        verifiedCable = Object.freeze({ maxCurrentA, maxVoltageV });
      }
      devices.push(
        Object.freeze({
          id: device["id"].trim(),
          protocol: device["protocol"],
          voltageV: device["voltageV"],
          currentA: device["currentA"],
          cable: verifiedCable,
        }),
      );
    }
    if (new Set(devices.map((device) => device.id)).size !== devices.length) {
      return invalid("duplicate_device");
    }
    return ok(Object.freeze({ devices: Object.freeze(devices) }));
  },
});

function supports(port: PortOutput, device: DeviceDemand): boolean {
  return (
    device.voltageV * device.currentA <= port.maxPowerW &&
    port.profiles.some(
      (profile) =>
        profile.protocol === device.protocol &&
        device.currentA <= profile.currentA &&
        (profile.protocol === "pd"
          ? device.voltageV === profile.voltageV
          : device.voltageV >= profile.minVoltageV && device.voltageV <= profile.maxVoltageV),
    )
  );
}
function assign(
  devices: readonly DeviceDemand[],
  ports: readonly PortOutput[],
): readonly Assignment[] | null {
  const device = devices[0];
  if (device === undefined) {
    return [];
  }
  for (const port of ports) {
    if (!supports(port, device)) {
      continue;
    }
    const remaining = assign(
      devices.slice(1),
      ports.filter((other) => other.port !== port.port),
    );
    if (remaining !== null) {
      return [Object.freeze({ deviceId: device.id, port: port.port }), ...remaining];
    }
  }
  return null;
}

export function assessCharging(
  specification: ChargerSpecification,
  context: ChargingContext,
  now: Instant,
): ChargingAssessment {
  if (!permitted(specification.permissions.display, now)) {
    return Object.freeze({ status: "unknown", reason: "source_not_authorized" });
  }
  if (
    valueOf(specification.evidence.observedAt) > valueOf(now) ||
    valueOf(specification.expiresAt) <= valueOf(now)
  ) {
    return Object.freeze({ status: "unknown", reason: "stale_specification" });
  }
  const ac = specification.input;
  if (
    ac.plug !== "jp-a" ||
    ac.minVoltageV > 100 ||
    ac.maxVoltageV < 100 ||
    ![50, 60].every((frequency) => ac.frequenciesHz.includes(frequency))
  ) {
    return Object.freeze({ status: "incompatible", reason: "ac_input" });
  }
  if (
    context.devices.some(
      (device) =>
        device.cable !== null &&
        (device.currentA > device.cable.maxCurrentA || device.voltageV > device.cable.maxVoltageV),
    )
  ) {
    return Object.freeze({ status: "incompatible", reason: "cable_capacity" });
  }
  const powerW = context.devices.reduce(
    (sum, device) => sum + device.voltageV * device.currentA,
    0,
  );
  if (
    specification.limits !== null &&
    (context.devices.length > specification.limits.maxDevices ||
      powerW > specification.limits.maxTotalPowerW)
  ) {
    return Object.freeze({ status: "incompatible", reason: "output_configuration" });
  }
  for (const configuration of specification.configurations) {
    // Configurations describe the exact active-port combination; a single-port maximum cannot prove simultaneous output.
    if (
      configuration.ports.length !== context.devices.length ||
      powerW > configuration.maxTotalPowerW
    ) {
      continue;
    }
    const assignments = assign(context.devices, configuration.ports);
    if (assignments !== null) {
      if (context.devices.some((device) => device.cable === null)) {
        return Object.freeze({ status: "unknown", reason: "cable_unknown" });
      }
      return Object.freeze({
        status: "compatible",
        assignments: Object.freeze(assignments),
        evidence: specification.evidence,
      });
    }
  }
  return specification.configurationsComplete
    ? Object.freeze({ status: "incompatible", reason: "output_configuration" })
    : Object.freeze({ status: "unknown", reason: "incomplete_configurations" });
}

export async function rankChargers(
  candidates: ReadonlyArray<Candidate & { specification: ChargerSpecification }>,
  context: ChargingContext,
  preferences: readonly Preference[],
  policy: RankingPolicy,
  judge: Judge,
  clock: () => Instant,
): Promise<Result<Ranking, RankingError>> {
  if (
    policy.category !== "usb-c-wall-charger" ||
    candidates.length < 1 ||
    candidates.length > 6 ||
    candidates.some(
      (candidate) =>
        !sameProductId(readProduct(candidate.product).id, candidate.specification.productId) ||
        !hasProductIdentity(readProduct(candidate.product).identity),
    ) ||
    candidates.some((candidate, index) =>
      candidates
        .slice(index + 1)
        .some((other) =>
          sameProductId(readProduct(candidate.product).id, readProduct(other.product).id),
        ),
    )
  ) {
    return err({ code: "invalid_request" });
  }
  const now = clock();
  if (
    candidates.some(
      (candidate) =>
        !permitted(readProduct(candidate.product).permissions.display, now) ||
        valueOf(readProduct(candidate.product).evidence.observedAt) > valueOf(now),
    )
  ) {
    return err({ code: "source_not_authorized" });
  }
  const assessed = candidates.map((candidate) => ({
    candidate,
    assessment: assessCharging(candidate.specification, context, now),
  }));
  if (assessed.some(({ assessment }) => assessment.status === "unknown")) {
    return err({ code: "insufficient_evidence" });
  }
  const eligible = assessed.filter(({ assessment }) => assessment.status === "compatible");
  if (eligible.length === 0) {
    return err({ code: "insufficient_evidence" });
  }
  const ranking = await rankProducts(
    eligible.map(({ candidate }) => candidate),
    [],
    preferences,
    policy,
    judge,
    now,
    clock,
  );
  if (ranking.tag === "err") {
    return ranking;
  }
  const completedAt = clock();
  if (
    candidates.some(
      (candidate) => !permitted(readProduct(candidate.product).permissions.display, completedAt),
    )
  ) {
    return err({ code: "source_not_authorized" });
  }
  if (
    assessed.some(
      ({ candidate }) =>
        assessCharging(candidate.specification, context, completedAt).status === "unknown",
    )
  ) {
    return err({ code: "insufficient_evidence" });
  }
  return ok(
    Object.freeze({
      ...ranking.value,
      excluded: Object.freeze([
        ...assessed
          .filter(({ assessment }) => assessment.status === "incompatible")
          .map(({ candidate }) => candidate.product),
        ...ranking.value.excluded,
      ]),
    }),
  );
}
