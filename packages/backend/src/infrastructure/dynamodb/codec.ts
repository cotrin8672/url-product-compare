import { gzipSync, gunzipSync } from "node:zlib";

// Leave ample room for keys/index attributes below DynamoDB's 400 KiB item limit.
const maximumDynamoPayloadBytes = 360_000;
export function encodeDynamoPayload(value: unknown): Uint8Array {
  const source: unknown = JSON.stringify(value);
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > 600_000) {
    throw new Error("Invalid stored payload");
  }
  const compressed = gzipSync(source);
  if (compressed.byteLength > maximumDynamoPayloadBytes) {
    throw new Error("Stored payload too large");
  }
  return compressed;
}
export function decodeDynamoPayload(value: Uint8Array): unknown {
  if (value.byteLength > maximumDynamoPayloadBytes) {
    throw new Error("Stored payload too large");
  }
  const text = gunzipSync(value, { maxOutputLength: 600_000 }).toString("utf8");
  const parsed: unknown = JSON.parse(text);
  return parsed;
}
