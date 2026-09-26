import { createServer } from "node:http";
import type { ServerResponse, IncomingMessage } from "node:http";

import { investigateDemo } from "../../../packages/backend/src/bootstrap.js";

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const route = new URL(request.url ?? "/", "http://localhost");
  if (route.pathname !== "/api/investigate") {
    send(response, 404, { tag: "err", error: { code: "not_found" } });
    return;
  }
  if (request.method !== "GET") {
    send(response, 405, { tag: "err", error: { code: "method_not_allowed" } });
    return;
  }
  const input = route.searchParams.get("url");
  if (input === null || input.length > 2048) {
    send(response, 400, { tag: "err", error: { code: "invalid_url" } });
    return;
  }
  const result = await investigateDemo(input);
  send(response, result.tag === "ok" ? 200 : 422, result);
}

const port = Number(process.env["PORT"] ?? "3001");
const server = createServer((request, response) => {
  handle(request, response).catch(() => {
    if (!response.headersSent) {
      send(response, 500, { tag: "err", error: { code: "internal_error" } });
    } else {
      response.end();
    }
  });
});
server.listen(port, "127.0.0.1");
