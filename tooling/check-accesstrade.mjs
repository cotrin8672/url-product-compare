// A read-only diagnostic. Never print the request URL or upstream response,
// because both can contain the account's ws_id and tracking information.
process.loadEnvFile(".env");
const wsId = process.env.ACCESSTRADE_WS_ID;
if (typeof wsId !== "string" || wsId.length === 0 || /\s/u.test(wsId)) {
  throw new Error("ACCESSTRADE_WS_ID is missing or malformed");
}

const cases = [
  { name: "rice", search: "米" },
  { name: "nisa", search: "NISA" },
  { name: "electronics", category1: "100" },
  { name: "rice_xml", search: "米", xml: true },
  { name: "example_item", item_id: "186182-J000027975" },
  { name: "missing_search" },
  { name: "invalid_ws_id", search: "米", invalid: true },
];
for (const entry of cases) {
  const url = new URL("https://xml.accesstrade.net/at/ws.html");
  const params = new globalThis.URLSearchParams({
    ws_ver: "1",
    ws_type: "searchgoods",
    ws_id: entry.invalid ? "invalid-test-id-000000" : wsId,
    row: "1",
    page: "1",
    option: "1",
    format: "json",
  });
  if (entry.xml) {
    params.delete("format");
  }
  if (entry.search) params.set("search", entry.search);
  if (entry.category1) params.set("category1", entry.category1);
  if (entry.item_id) params.set("item_id", entry.item_id);
  url.search = params.toString();
  try {
    const response = await globalThis.fetch(url, {
      redirect: "error",
      signal: globalThis.AbortSignal.timeout(12000),
    });
    if (entry.xml) {
      const body = await response.text();
      const code = /<ErrorCode>(\d{1,10})<\/ErrorCode>/u.exec(body)?.[1] ?? null;
      const count = /<TotalCount>(\d{1,10})<\/TotalCount>/u.exec(body)?.[1] ?? null;
      console.log(JSON.stringify({ name: entry.name, http: response.status, code, count }));
      if (response.status !== 200 || code !== "000000" || count === null) {
        process.exitCode = 1;
      }
      continue;
    }
    const body = await response.json();
    const result = body?.AllResult?.[0];
    const digits = (value) =>
      typeof value === "string" && /^\d{1,10}$/u.test(value) ? value : null;
    const code = digits(result?.ErrorCode);
    const count = digits(result?.TotalCount);
    console.log(JSON.stringify({ name: entry.name, http: response.status, code, count }));
    const expected = entry.invalid
      ? "010001"
      : entry.name === "missing_search"
        ? "20015"
        : "000000";
    if (response.status !== 200 || code !== expected || (expected === "000000" && count === null)) {
      process.exitCode = 1;
    }
  } catch {
    console.log(JSON.stringify({ name: entry.name, error: "request_failed_or_invalid_response" }));
    process.exitCode = 1;
  }
}
