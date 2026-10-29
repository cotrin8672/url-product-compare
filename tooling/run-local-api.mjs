import { existsSync, lstatSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceModules = realpathSync(join(root, "packages/backend/node_modules"));
const compiledBackend = join(root, "apps/api/dist/packages/backend");
const compiledModules = join(compiledBackend, "node_modules");
mkdirSync(compiledBackend, { recursive: true });
// tsc preserves the repository's relative imports in dist. Preserve the backend
// package's dependency scope there too, without duplicating its dependencies.
if (existsSync(compiledModules)) {
  if (
    !lstatSync(compiledModules).isSymbolicLink() ||
    realpathSync(compiledModules) !== sourceModules
  ) {
    throw new Error("Unexpected local API dependency directory");
  }
} else {
  symlinkSync(sourceModules, compiledModules, process.platform === "win32" ? "junction" : "dir");
}
process.chdir(root);
await import(pathToFileURL(join(root, "apps/api/dist/apps/api/src/local.js")).href);
