/** @jsxImportSource solid-js */
import { createResource, createSignal, Show } from "solid-js";
import type { JSX } from "solid-js";

import { investigateProduct } from "@app/api-client";
import type { Investigation } from "@app/api-client";

type ViewResult =
  | Readonly<{ tag: "ok"; value: Investigation }>
  | Readonly<{ tag: "err"; message: string }>;

function ProductResult(props: Readonly<{ data: Investigation }>): JSX.Element {
  return (
    <>
      <section class="product" aria-label="同定した商品">
        <div class="thumb" aria-hidden="true">
          DEMO
        </div>
        <div class="product-main">
          <h1>{props.data.title}</h1>
          <p>
            掲載元 {props.data.provider} <span class="separator">·</span> 掲載ID{" "}
            {props.data.listingId}
          </p>
        </div>
        <span class="match">商品を同定</span>
      </section>

      <div class="bar">
        <h2>販売店の比較</h2>
        <span class="count">0件</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>販売店</th>
              <th class="number">送料込み総額</th>
              <th class="number">商品価格</th>
              <th class="number">送料</th>
              <th>在庫・配送</th>
              <th>確認日時</th>
              <th>出典</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td class="empty" colSpan={7}>
                比較データは未接続です。現在のデモでは商品同定だけ確認できます。
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <details class="details">
        <summary>同定情報と出典</summary>
        <dl>
          <div>
            <dt>製品ID</dt>
            <dd>{props.data.productId}</dd>
          </div>
          <div>
            <dt>同定方法</dt>
            <dd>{props.data.matchMethod}</dd>
          </div>
          <div>
            <dt>確認日時</dt>
            <dd>{new Date(props.data.observedAt).toLocaleString("ja-JP")}</dd>
          </div>
          <div>
            <dt>掲載URL</dt>
            <dd>
              <a href={props.data.canonicalUrl} target="_blank" rel="noopener noreferrer">
                {props.data.canonicalUrl}
              </a>
            </dd>
          </div>
        </dl>
      </details>
    </>
  );
}

export function App(): JSX.Element {
  const [url, setUrl] = createSignal("https://item.rakuten.co.jp/demo-shop/demo-product/");
  const [query, setQuery] = createSignal<string | undefined>(undefined, { equals: false });
  const [result] = createResource(query, async (input): Promise<ViewResult> => {
    try {
      return { tag: "ok", value: await investigateProduct(input) };
    } catch (error: unknown) {
      return { tag: "err", message: error instanceof Error ? error.message : "通信に失敗しました" };
    }
  });

  return (
    <>
      <header class="top">
        <div class="top-inner">
          <span class="brand">商品比較</span>
          <form
            class="search"
            onSubmit={(event) => {
              event.preventDefault();
              setQuery(url().trim());
            }}
          >
            <label class="sr-only" for="product-url">
              商品URL
            </label>
            <input
              id="product-url"
              type="url"
              required
              value={url()}
              onInput={(event) => setUrl(event.currentTarget.value)}
            />
            <button type="submit" disabled={result.loading}>
              調べる
            </button>
          </form>
          <span class="demo">架空データ・外部API未接続</span>
        </div>
      </header>
      <main>
        <Show when={result.loading}>
          <p class="status" role="status">
            商品を確認しています…
          </p>
        </Show>
        <Show when={result.loading ? undefined : result()}>
          {(state) => {
            const current = state();
            return current.tag === "ok" ? (
              <ProductResult data={current.value} />
            ) : (
              <p class="status error" role="alert">
                {current.message}
              </p>
            );
          }}
        </Show>
        <Show when={query() === undefined && !result.loading}>
          <p class="status">デモURLを確認するには「調べる」を押してください。</p>
        </Show>
      </main>
    </>
  );
}
