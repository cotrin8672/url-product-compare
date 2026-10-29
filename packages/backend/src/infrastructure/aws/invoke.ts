import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";

export function createLambdaDispatcher(
  functionArn: string,
  invoke?: (
    command: InvokeCommand,
    signal: AbortSignal,
  ) => Promise<Readonly<{ StatusCode?: number }>>,
): (id: string) => Promise<void> {
  if (
    !/^arn:aws:lambda:[a-z0-9-]+:\d{12}:function:[a-zA-Z0-9_-]+(?::[a-zA-Z0-9_-]+)?$/.test(
      functionArn,
    )
  ) {
    throw new Error("A fixed Lambda worker ARN is required");
  }
  const client = new LambdaClient({ maxAttempts: 2 });
  const send =
    invoke ??
    (async (command: InvokeCommand, signal: AbortSignal) =>
      await client.send(command, { abortSignal: signal }));
  return async (id) => {
    if (!/^[a-f0-9]{64}$/.test(id)) {
      throw new Error("Invalid job identity");
    }
    const result = await send(
      new InvokeCommand({
        FunctionName: functionArn,
        InvocationType: "Event",
        Payload: new TextEncoder().encode(JSON.stringify({ jobId: id })),
      }),
      AbortSignal.timeout(5000),
    );
    if (result.StatusCode !== 202) {
      throw new Error("Job dispatch unavailable");
    }
  };
}
