import { investigateDemo, rankDemoWithJev } from "../../../packages/backend/src/bootstrap.js";

const [mode, input, ...extra] = process.argv.slice(2);
if (mode === "--jev-demo" && input === undefined && extra.length === 0) {
  const result = await rankDemoWithJev(
    process.env["TYPESAFE_API_KEY"] ?? "",
    process.env["TYPESAFE_MODEL"] ?? "jev-latest",
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.tag === "ok" ? 0 : 1;
} else if (mode !== "--demo" || extra.length > 0) {
  process.stderr.write(
    "Usage: pnpm --filter @app/worker demo --demo [product-url] | --jev-demo\nArtificial product data only. --jev-demo requires TYPESAFE_API_KEY.\n",
  );
  process.exitCode = 2;
} else {
  const result = await investigateDemo(
    input ?? "https://item.rakuten.co.jp/demo-shop/demo-product/",
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.tag === "ok" ? 0 : 1;
}
