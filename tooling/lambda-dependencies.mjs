import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { hashLambdaPackage } from "./lambda-package-integrity.mjs";

// The legacy hoisted deploy path can re-resolve ranges without reading the
// workspace lockfile. Build from the frozen workspace lockfile inventory and
// pin every dependency edge in an isolated build-only workspace instead.
export async function prepareLambdaDependencies(root, stage, bundle, pnpm) {
  const inventory = spawnSync(
    process.platform === "win32" ? "rtk" : "mise",
    [
      ...(process.platform === "win32" ? ["proxy", "mise"] : []),
      "exec",
      "--",
      "pnpm",
      "--filter",
      "@app/backend",
      "list",
      "--lockfile-only",
      "--prod",
      "--depth",
      "Infinity",
      "--json",
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(inventory.status, 0, "Locked dependency inventory failed");
  const [project] = JSON.parse(inventory.stdout);
  assert.equal(project.name, "@app/backend");
  const metadata = JSON.parse(
    await readFile(path.join(root, "packages/backend/package.json"), "utf8"),
  );
  const runtime = path.join(stage, "runtime");
  await mkdir(runtime, { recursive: true });
  const dependencies = { ...metadata.dependencies };
  const overrides = {};
  const expected = new Set();
  const edges = {};
  const registryPaths = new Map();
  const visit = (item, parent) => {
    for (const [name, value] of Object.entries({
      ...item.dependencies,
      ...item.optionalDependencies,
    })) {
      if (value.version.startsWith("link:")) {
        continue;
      }
      assert.match(value.version, /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/);
      expected.add(`${name}@${value.version}`);
      registryPaths.set(`${name}@${value.version}`, value.path);
      const edge = `${parent ?? metadata.name + "@" + (metadata.version ?? "")}>${name}`;
      assert.ok(edges[edge] === undefined || edges[edge] === `${name}@${value.version}`);
      edges[edge] = `${name}@${value.version}`;
      if (parent !== null) {
        const selector = `${parent}>${name}`;
        assert.ok(
          overrides[selector] === undefined || overrides[selector] === value.version,
          "Ambiguous peer dependency context",
        );
        overrides[selector] = value.version;
      }
      visit(value, `${name}@${value.version}`);
    }
  };
  visit(project, null);
  const hashes = {};
  for (const [identity, directory] of registryPaths) {
    const installed = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
    assert.equal(
      `${installed.name}@${installed.version}`,
      identity,
      "Run a frozen workspace install before packaging",
    );
    hashes[identity] = await hashLambdaPackage(directory);
  }
  for (const [name, value] of Object.entries(project.dependencies)) {
    if (!value.version.startsWith("link:")) {
      continue;
    }
    assert.match(name, /^@app\/[a-z0-9-]+$/);
    const source = path.resolve(value.path);
    assert.ok(source.startsWith(`${path.join(root, "packages")}${path.sep}`));
    const sdk = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"));
    assert.equal(sdk.name, name);
    expected.add(`${name}@${sdk.version}`);
    edges[`${metadata.name}@${metadata.version ?? ""}>${name}`] = `${name}@${sdk.version}`;
    const destination = path.join(runtime, "packages", name.slice(5));
    await mkdir(destination, { recursive: true });
    for (const entry of ["package.json", "README.md", "dist"]) {
      await cp(path.join(source, entry), path.join(destination, entry), { recursive: true });
    }
    dependencies[name] = `file:./packages/${name.slice(5)}`;
    visit(value, `${name}@${sdk.version}`);
  }
  await writeFile(
    path.join(runtime, "package.json"),
    JSON.stringify({
      name: "@app/backend",
      version: "0.0.0",
      private: true,
      type: "module",
      dependencies,
      pnpm: { overrides },
    }),
  );
  await writeFile(path.join(runtime, "pnpm-workspace.yaml"), "packages: []\n");
  pnpm(
    "--dir",
    runtime,
    "install",
    "--prod",
    "--ignore-scripts",
    "--lockfile=false",
    "--config.node-linker=hoisted",
  );
  await mkdir(bundle, { recursive: true });
  await cp(path.join(runtime, "node_modules"), path.join(bundle, "node_modules"), {
    recursive: true,
  });
  await writeFile(path.join(bundle, "package.json"), JSON.stringify(metadata));
  await writeFile(
    path.join(bundle, "dependency-lock-snapshot.json"),
    JSON.stringify({
      lockSha256: createHash("sha256")
        .update(await readFile(path.join(root, "pnpm-lock.yaml")))
        .digest("hex"),
      packages: [...expected].sort(),
      edges,
      hashes,
    }),
  );
}
