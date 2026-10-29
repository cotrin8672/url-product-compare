import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";

export type DynamoItem = Readonly<{
  key: string;
  revision: number;
  ttl: number;
  data?: Uint8Array;
  dueAt?: number;
  freshUntil?: number;
  leaseOwner?: string;
  leaseUntil?: number;
  generation?: string;
}>;
type DynamoCondition =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "revision"; revision: number; generation: string }>
  | Readonly<{ kind: "lease"; owner: string; now: number }>;
type DynamoCounter = Readonly<{ key: string; limit: number; ttl: number }>;
export type DynamoDatabase = Readonly<{
  get: (table: string, key: string) => Promise<DynamoItem | null>;
  put: (table: string, item: DynamoItem, condition: DynamoCondition) => Promise<boolean>;
  remove: (table: string, key: string, revision: number, generation: string) => Promise<boolean>;
  claim: (
    table: string,
    key: string,
    owner: string,
    now: number,
    until: number,
  ) => Promise<boolean>;
  release: (table: string, key: string, owner: string) => Promise<void>;
  consume: (table: string, counters: readonly DynamoCounter[]) => Promise<boolean>;
  count: (table: string, key: string, ttl: number) => Promise<void>;
  due: (table: string, now: number, limit: number) => Promise<readonly string[]>;
}>;
type DynamoCommand =
  | GetItemCommand
  | PutItemCommand
  | DeleteItemCommand
  | UpdateItemCommand
  | TransactWriteItemsCommand
  | QueryCommand;
export type DynamoSend = (command: DynamoCommand, signal: AbortSignal) => Promise<unknown>;

function numeric(value: AttributeValue | undefined): number | undefined {
  if (value?.N === undefined) {
    return undefined;
  }
  const number = Number(value.N);
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}
function record(input: unknown): input is Readonly<Record<string, unknown>> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
function attributes(input: unknown): input is Readonly<Record<string, AttributeValue>> {
  return (
    record(input) &&
    Object.values(input).every(
      (value) =>
        record(value) &&
        ((typeof value["S"] === "string" && Object.keys(value).length === 1) ||
          (typeof value["N"] === "string" && Object.keys(value).length === 1) ||
          (value["B"] instanceof Uint8Array && Object.keys(value).length === 1)),
    )
  );
}
function decode(input: unknown, key: string): DynamoItem {
  if (!attributes(input) || input["key"]?.S !== key) {
    throw new Error("Invalid DynamoDB item");
  }
  const revision = numeric(input["revision"]),
    ttl = numeric(input["ttl"]);
  if (
    revision === undefined ||
    ttl === undefined ||
    (input["data"] !== undefined && !(input["data"].B instanceof Uint8Array)) ||
    (input["dueAt"] !== undefined && numeric(input["dueAt"]) === undefined) ||
    (input["freshUntil"] !== undefined && numeric(input["freshUntil"]) === undefined) ||
    (input["leaseUntil"] !== undefined && numeric(input["leaseUntil"]) === undefined) ||
    (input["leaseOwner"] !== undefined && typeof input["leaseOwner"].S !== "string") ||
    (input["generation"] !== undefined && typeof input["generation"].S !== "string")
  ) {
    throw new Error("Invalid DynamoDB item");
  }
  const data = input["data"]?.B,
    freshUntil = numeric(input["freshUntil"]),
    dueAt = numeric(input["dueAt"]),
    leaseUntil = numeric(input["leaseUntil"]),
    leaseOwner = input["leaseOwner"]?.S;
  return {
    key,
    revision,
    ttl,
    ...(data === undefined ? {} : { data }),
    ...(dueAt === undefined ? {} : { dueAt }),
    ...(freshUntil === undefined ? {} : { freshUntil }),
    ...(leaseUntil === undefined ? {} : { leaseUntil }),
    ...(leaseOwner === undefined ? {} : { leaseOwner }),
    ...(input["generation"]?.S === undefined ? {} : { generation: input["generation"].S }),
  };
}
function encode(item: DynamoItem): Record<string, AttributeValue> {
  return {
    key: { S: item.key },
    revision: { N: String(item.revision) },
    ttl: { N: String(item.ttl) },
    ...(item.data === undefined ? {} : { data: { B: item.data } }),
    ...(item.freshUntil === undefined ? {} : { freshUntil: { N: String(item.freshUntil) } }),
    ...(item.dueAt === undefined
      ? {}
      : { dueAt: { N: String(item.dueAt) }, cleanupGroup: { S: "jobs" } }),
    ...(item.generation === undefined ? {} : { generation: { S: item.generation } }),
  };
}
function conditional(error: unknown): boolean {
  return (
    error instanceof ConditionalCheckFailedException ||
    (record(error) && error["name"] === "ConditionalCheckFailedException")
  );
}
export function createDynamoDatabase(send?: DynamoSend): DynamoDatabase {
  const client = new DynamoDBClient({ maxAttempts: 2 });
  const execute =
    send ??
    (async (command: DynamoCommand, signal: AbortSignal): Promise<unknown> => {
      const options = { abortSignal: signal };
      if (command instanceof GetItemCommand) {
        return await client.send(command, options);
      }
      if (command instanceof PutItemCommand) {
        return await client.send(command, options);
      }
      if (command instanceof DeleteItemCommand) {
        return await client.send(command, options);
      }
      if (command instanceof UpdateItemCommand) {
        return await client.send(command, options);
      }
      if (command instanceof QueryCommand) {
        return await client.send(command, options);
      }
      return await client.send(command, options);
    });
  const call = async (command: DynamoCommand): Promise<unknown> =>
    await execute(command, AbortSignal.timeout(5000));
  const change = async (
    command: PutItemCommand | UpdateItemCommand | DeleteItemCommand,
  ): Promise<boolean> => {
    try {
      await call(command);
      return true;
    } catch (error) {
      if (conditional(error)) {
        return false;
      }
      throw error;
    }
  };
  return Object.freeze({
    get: async (table, key) => {
      const result = await call(
        new GetItemCommand({ TableName: table, Key: { key: { S: key } }, ConsistentRead: true }),
      );
      if (!record(result)) {
        throw new Error("Invalid DynamoDB response");
      }
      return result["Item"] === undefined ? null : decode(result["Item"], key);
    },
    put: async (table, item, condition) =>
      await change(
        new PutItemCommand({
          TableName: table,
          Item: encode(item),
          ConditionExpression:
            condition.kind === "absent"
              ? "attribute_not_exists(#key)"
              : condition.kind === "revision"
                ? "#revision = :revision AND #generation = :generation"
                : "#owner = :owner AND #until > :now",
          ExpressionAttributeNames:
            condition.kind === "absent"
              ? { "#key": "key" }
              : condition.kind === "revision"
                ? { "#revision": "revision", "#generation": "generation" }
                : { "#owner": "leaseOwner", "#until": "leaseUntil" },
          ...(condition.kind === "absent"
            ? {}
            : {
                ExpressionAttributeValues:
                  condition.kind === "revision"
                    ? {
                        ":revision": { N: String(condition.revision) },
                        ":generation": { S: condition.generation },
                      }
                    : { ":owner": { S: condition.owner }, ":now": { N: String(condition.now) } },
              }),
        }),
      ),
    remove: async (table, key, revision, generation) =>
      await change(
        new DeleteItemCommand({
          TableName: table,
          Key: { key: { S: key } },
          ConditionExpression: "#revision = :revision AND #generation = :generation",
          ExpressionAttributeNames: { "#revision": "revision", "#generation": "generation" },
          ExpressionAttributeValues: {
            ":revision": { N: String(revision) },
            ":generation": { S: generation },
          },
        }),
      ),
    claim: async (table, key, owner, now, until) =>
      await change(
        new UpdateItemCommand({
          TableName: table,
          Key: { key: { S: key } },
          UpdateExpression:
            "SET #owner = :owner, #until = :until, #ttl = :ttl, #revision = if_not_exists(#revision, :zero) REMOVE #data, #fresh",
          ConditionExpression:
            "(attribute_not_exists(#until) OR #until <= :now) AND (attribute_not_exists(#data) OR #fresh <= :now)",
          ExpressionAttributeNames: {
            "#owner": "leaseOwner",
            "#until": "leaseUntil",
            "#ttl": "ttl",
            "#revision": "revision",
            "#data": "data",
            "#fresh": "freshUntil",
          },
          ExpressionAttributeValues: {
            ":owner": { S: owner },
            ":until": { N: String(until) },
            ":now": { N: String(now) },
            ":ttl": { N: String(Math.ceil(until / 1000) + 60) },
            ":zero": { N: "0" },
          },
        }),
      ),
    release: async (table, key, owner) => {
      await change(
        new DeleteItemCommand({
          TableName: table,
          Key: { key: { S: key } },
          ConditionExpression: "#owner = :owner",
          ExpressionAttributeNames: { "#owner": "leaseOwner" },
          ExpressionAttributeValues: { ":owner": { S: owner } },
        }),
      );
    },
    consume: async (table, counters) => {
      const command = new TransactWriteItemsCommand({
        ClientRequestToken: crypto.randomUUID(),
        TransactItems: counters.map((counter) => ({
          Update: {
            TableName: table,
            Key: { key: { S: counter.key } },
            UpdateExpression: "SET #ttl = :ttl ADD #hits :one",
            ConditionExpression: "attribute_not_exists(#hits) OR #hits < :limit",
            ExpressionAttributeNames: { "#ttl": "ttl", "#hits": "hits" },
            ExpressionAttributeValues: {
              ":ttl": { N: String(counter.ttl) },
              ":one": { N: "1" },
              ":limit": { N: String(counter.limit) },
            },
          },
        })),
      });
      for (let attempt = 0; ; attempt += 1) {
        try {
          await call(command);
          return true;
        } catch (error) {
          // Only a proven condition rejection is a rate limit; outages propagate and fail closed.
          if (
            record(error) &&
            error["name"] === "TransactionCanceledException" &&
            Array.isArray(error["CancellationReasons"])
          ) {
            const reasons: readonly unknown[] = error["CancellationReasons"];
            if (
              attempt < 3 &&
              reasons.some(
                (reason) => record(reason) && reason["Code"] === "TransactionConflict",
              ) &&
              reasons.every(
                (reason) =>
                  record(reason) &&
                  (reason["Code"] === "None" || reason["Code"] === "TransactionConflict"),
              )
            ) {
              // Keep the same idempotency token for bounded contention retries.
              await new Promise<void>((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
              continue;
            }
            if (
              reasons.some(
                (reason) => record(reason) && reason["Code"] === "ConditionalCheckFailed",
              ) &&
              reasons.every(
                (reason) =>
                  record(reason) &&
                  (reason["Code"] === "None" || reason["Code"] === "ConditionalCheckFailed"),
              )
            ) {
              return false;
            }
          }
          throw error;
        }
      }
    },
    count: async (table, key, ttl) => {
      await call(
        new UpdateItemCommand({
          TableName: table,
          Key: { key: { S: key } },
          UpdateExpression: "SET #ttl = :ttl ADD #hits :one",
          ExpressionAttributeNames: { "#ttl": "ttl", "#hits": "hits" },
          ExpressionAttributeValues: { ":ttl": { N: String(ttl) }, ":one": { N: "1" } },
        }),
      );
    },
    due: async (table, now, limit) => {
      const result = await call(
        new QueryCommand({
          TableName: table,
          IndexName: "cleanup",
          KeyConditionExpression: "#group = :group AND #due <= :now",
          ExpressionAttributeNames: { "#group": "cleanupGroup", "#due": "dueAt", "#key": "key" },
          ExpressionAttributeValues: { ":group": { S: "jobs" }, ":now": { N: String(now) } },
          ProjectionExpression: "#key",
          Limit: limit,
          ScanIndexForward: true,
        }),
      );
      if (!record(result) || !Array.isArray(result["Items"])) {
        throw new Error("Invalid cleanup response");
      }
      const items: readonly unknown[] = result["Items"];
      return items.map((item) => {
        if (
          !attributes(item) ||
          typeof item["key"]?.S !== "string" ||
          !/^[a-f0-9]{64}$/.test(item["key"].S)
        ) {
          throw new Error("Invalid cleanup identity");
        }
        return item["key"].S;
      });
    },
  } satisfies DynamoDatabase);
}
