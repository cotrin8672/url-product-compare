import type { DynamoDatabase } from "./database.js";

export function createDynamoRateLimiter(
  database: DynamoDatabase,
  table: string,
  clock: () => number,
  limits: Readonly<{ perMinute: number; perDay: number }>,
): (identity: string) => Promise<boolean> {
  return async (identity) => {
    if (!/^[a-f0-9]{64}$/.test(identity)) {
      throw new Error("Invalid limiter identity");
    }
    const second = Math.floor(clock() / 1000),
      minute = Math.floor(second / 60) * 60,
      day = Math.floor(second / 86400) * 86400;
    return await database.consume(table, [
      { key: `address:${minute}:${identity}`, limit: 6, ttl: minute + 120 },
      { key: `global-minute:${minute}`, limit: limits.perMinute, ttl: minute + 120 },
      { key: `global-day:${day}`, limit: limits.perDay, ttl: day + 86400 + 60 },
    ]);
  };
}
