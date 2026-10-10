import { readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";

type StaticResponse = Readonly<{
  statusCode: number;
  headers: Readonly<Record<string, string>>;
  body: Buffer;
}>;

const contentTypes: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

function response(
  statusCode: number,
  body = Buffer.alloc(0),
  contentType = "text/plain; charset=utf-8",
): StaticResponse {
  return {
    statusCode,
    headers: {
      "content-type": contentType,
      "content-length": String(body.byteLength),
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
    },
    body,
  };
}

export async function readPublicAsset(
  directory: string,
  pathname: string,
  method: string,
): Promise<StaticResponse> {
  if (method !== "GET" && method !== "HEAD") {
    const denied = response(405);
    return { ...denied, headers: { ...denied.headers, allow: "GET, HEAD" } };
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return response(400);
  }
  if (
    !decoded.startsWith("/") ||
    /[\\\0]/.test(decoded) ||
    decoded.split("/").some((segment) => segment.startsWith("."))
  ) {
    return response(404);
  }
  const extension = extname(decoded);
  if (extension !== "" && contentTypes[extension] === undefined) {
    return response(404);
  }
  const root = await realpath(directory);
  let target: string;
  try {
    target = await realpath(resolve(root, `.${decoded}`, extension === "" ? "index.html" : ""));
  } catch (error: unknown) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      (error.code !== "ENOENT" && error.code !== "ENOTDIR")
    ) {
      throw error;
    }
    if (extension !== "") {
      return response(404);
    }
    target = await realpath(resolve(root, "index.html"));
  }
  const inside = relative(root, target);
  if (inside.startsWith("..") || isAbsolute(inside)) {
    return response(404);
  }
  const contentType = contentTypes[extname(target)];
  if (contentType === undefined) {
    return response(404);
  }
  const result = response(200, await readFile(target), contentType);
  return method === "HEAD" ? { ...result, body: Buffer.alloc(0) } : result;
}
