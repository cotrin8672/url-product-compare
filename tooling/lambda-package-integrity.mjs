import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export async function hashLambdaPackage(directory) {
  const files = [];
  async function collect(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === "node_modules") {
        continue;
      }
      assert.equal(entry.isSymbolicLink(), false, "Package content must not escape through links");
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await collect(target);
      } else {
        files.push(path.relative(directory, target).replaceAll(path.sep, "/"));
      }
    }
  }
  await collect(directory);
  const hash = createHash("sha256");
  for (const name of files.sort()) {
    const bytes = await readFile(path.join(directory, name));
    hash.update(`${name.length}:${name}${bytes.length}:`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}
