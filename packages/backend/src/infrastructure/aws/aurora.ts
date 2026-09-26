import { ExecuteStatementCommand, RDSDataClient } from "@aws-sdk/client-rds-data";
import type { ExecuteStatementCommandInput } from "@aws-sdk/client-rds-data";

import { err, ok } from "../../comparison/algebra.js";
import type { Result } from "../../comparison/algebra.js";

type RunStatus = "succeeded" | "failed";
export type RunStore = (
  status: RunStatus,
) => Promise<Result<null, Readonly<{ code: "storage_unavailable" }>>>;

export function createAuroraRunStore(
  resourceArn: string,
  secretArn: string,
  database: string,
  execute: (input: ExecuteStatementCommandInput) => Promise<unknown> = async (input) => {
    const client = new RDSDataClient({ maxAttempts: 3 });
    return await client.send(new ExecuteStatementCommand(input), {
      abortSignal: AbortSignal.timeout(20_000),
    });
  },
): RunStore {
  return async (status) => {
    try {
      await execute({
        resourceArn,
        secretArn,
        database,
        // Only operational metadata. Product data has independent storage permissions.
        sql: "INSERT INTO investigation_runs (mode, status) VALUES ('demo', :status)",
        parameters: [{ name: "status", value: { stringValue: status } }],
      });
      return ok(null);
    } catch {
      return err({ code: "storage_unavailable" });
    }
  };
}
