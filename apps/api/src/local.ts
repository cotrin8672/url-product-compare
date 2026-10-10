import { createServer } from "node:http";
import type { ServerResponse, IncomingMessage } from "node:http";

import { readPublicAsset } from "../../../packages/backend/src/bootstrap.js";
import { handler } from "./index.js";

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const route = new URL(request.url ?? "/", "http://localhost");
  if (route.pathname !== "/api" && !route.pathname.startsWith("/api/")) {
    const asset = await readPublicAsset(
      `${process.cwd()}/apps/web/dist`,
      route.pathname,
      request.method ?? "GET",
    );
    response.writeHead(asset.statusCode, asset.headers);
    response.end(asset.body);
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    if (!(chunk instanceof Buffer) || size + chunk.length > 4096) {
      response.writeHead(413, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ tag: "err", error: { code: "invalid_request" } }));
      return;
    }
    size += chunk.length;
    chunks.push(chunk);
  }
  const result = await handler(
    {
      path: route.pathname,
      query: route.search.slice(1),
      headers: request.headers,
      method: request.method ?? "GET",
      body: Buffer.concat(chunks).toString("utf8"),
    },
    request.socket.remoteAddress ?? "unknown",
  );
  response.writeHead(result.statusCode, result.headers);
  response.end(result.body);
}

const port = Number(process.env["PORT"] ?? "3001");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}
const pending = new Set<Promise<void>>();
const server = createServer((request, response) => {
  const work = handle(request, response)
    .catch(() => {
      if (!response.headersSent) {
        response.writeHead(500, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
      }
      response.end(JSON.stringify({ tag: "err", error: { code: "internal_error" } }));
    })
    .finally(() => {
      pending.delete(work);
    });
  pending.add(work);
});
server.listen(port, process.env["RENDER"] === "true" ? "0.0.0.0" : "127.0.0.1");
