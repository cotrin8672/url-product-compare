export type ServiceId = "products" | "furusato" | "securities";
export type ServiceOrigins = Readonly<Record<ServiceId, string>>;
export type ServiceLink = Readonly<{ id: ServiceId; label: string; href: string }>;

export const serviceDefinitions = [
  { id: "products", label: "商品", port: 5173 },
  { id: "furusato", label: "ふるさと納税", port: 5174 },
  { id: "securities", label: "証券会社", port: 5175 },
] satisfies ReadonlyArray<Readonly<{ id: ServiceId; label: string; port: number }>>;

function origin(value: unknown): string {
  if (typeof value !== "string" || !URL.canParse(value)) {
    throw new Error("A service origin is required");
  }
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.origin !== value ||
    url.username !== "" ||
    url.password !== "" ||
    (url.protocol !== "https:" && !(local && url.protocol === "http:"))
  ) {
    throw new Error("Expected an HTTPS service origin (HTTP is only allowed on loopback)");
  }
  return url.origin;
}

export const serviceOriginsSchema = {
  parse(input: unknown): ServiceOrigins {
    if (
      typeof input !== "object" ||
      input === null ||
      Array.isArray(input) ||
      !("products" in input) ||
      !("furusato" in input) ||
      !("securities" in input) ||
      Object.keys(input).length !== 3
    ) {
      throw new Error("Expected exactly three service origins");
    }
    const origins = {
      products: origin(input.products),
      furusato: origin(input.furusato),
      securities: origin(input.securities),
    } satisfies ServiceOrigins;
    if (new Set(Object.values(origins)).size !== 3) {
      throw new Error("Services must have distinct origins");
    }
    return origins;
  },
};

export function serviceLinks(origins: ServiceOrigins): readonly ServiceLink[] {
  return serviceDefinitions.map((service) => ({
    id: service.id,
    label: service.label,
    href: origins[service.id] + "/",
  }));
}
