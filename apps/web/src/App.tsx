/** @jsxImportSource solid-js */
import { createEffect, createResource, createSignal, onCleanup, Show } from "solid-js";
import type { JSX } from "solid-js";

import { investigateProduct } from "@app/api-client";
import type { Investigation } from "@app/api-client";

type ViewResult =
  | Readonly<{ tag: "ok"; value: Investigation }>
  | Readonly<{ tag: "err"; message: string }>;

function expireAt(expiresAt: string, expire: () => void): () => void {
  const remaining = Date.parse(expiresAt) - Date.now();
  const timer = setTimeout(expire, Math.max(0, Math.min(remaining, 900_000)));
  return () => {
    clearTimeout(timer);
  };
}

function ProductResult(props: Readonly<{ data: Investigation }>): JSX.Element {
  const [expired, setExpired] = createSignal(false);
  createEffect(() => {
    const data = props.data;
    setExpired(false);
    if (data.mode === "live") {
      onCleanup(
        expireAt(data.expiresAt, () => {
          setExpired(true);
        }),
      );
    }
  });
  const yen = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY" });
  return (
    <Show
      when={!expired()}
      fallback={
        <p class="status" role="status">
          表示期限が切れました。「調べる」で再取得してください。
        </p>
      }
    >
      <section class="product" aria-label="確認した掲載">
        <div class="thumb" aria-hidden="true">
          {props.data.mode === "demo" ? "DEMO" : "楽天"}
        </div>
        <div class="product-main">
          <h1>{props.data.title}</h1>
          <p>
            掲載元 {props.data.provider} <span class="separator">·</span> 掲載ID{" "}
            {props.data.listingId}
          </p>
        </div>
        <span class="match">
          {props.data.mode === "demo" ? "商品を同定（デモ）" : "掲載URL一致・製品未確認"}
        </span>
      </section>

      <div class="bar">
        <h2>販売店の比較</h2>
        <span class="count">
          {props.data.mode === "demo" ? "0件" : "入力URLの販売店 1件・他店未接続"}
        </span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>販売店</th>
              <th class="number">送料込み総額</th>
              <th class="number">掲載価格</th>
              <th class="number">送料</th>
              <th>在庫・配送</th>
              <th>確認日時</th>
              <th>出典</th>
            </tr>
          </thead>
          <tbody>
            <Show
              when={props.data.mode === "live" ? props.data : undefined}
              fallback={
                <tr>
                  <td class="empty" colSpan={7}>
                    比較データは未接続です。現在のデモでは商品同定だけ確認できます。
                  </td>
                </tr>
              }
            >
              {(data) => (
                <tr>
                  <td>{data().shopName}</td>
                  <td class="number">未確認</td>
                  <td class="number">
                    {yen.format(data().price.minimum)}
                    {data().price.maximum === data().price.minimum
                      ? ""
                      : `〜${yen.format(data().price.maximum)}`}
                    <small>{data().tax === "included" ? "税込" : "税別"}</small>
                  </td>
                  <td>
                    {data().shipping === "included" ? "API上は送料込み" : "送料別・金額未確認"}
                  </td>
                  <td>
                    {data().availability === "available" ? "購入可能" : "購入不可"}
                    <small>配送日・SKU未確認</small>
                  </td>
                  <td>{new Date(data().observedAt).toLocaleTimeString("ja-JP")}</td>
                  <td>
                    <a href={data().canonicalUrl} target="_blank" rel="noopener noreferrer">
                      楽天
                    </a>
                  </td>
                </tr>
              )}
            </Show>
          </tbody>
        </table>
      </div>
      <details class="details">
        <summary>確認情報と出典</summary>
        <dl>
          <div>
            <dt>製品ID</dt>
            <dd>{props.data.productId ?? "未同定"}</dd>
          </div>
          <div>
            <dt>同定方法</dt>
            <dd>{props.data.matchMethod ?? "掲載URLの一致のみ。製品・バリエーションは未確認"}</dd>
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
    </Show>
  );
}

export function App(): JSX.Element {
  const [url, setUrl] = createSignal("");
  const [keyword, setKeyword] = createSignal("");
  const [accessToken, setAccessToken] = createSignal("");
  const [query, setQuery] = createSignal<
    Readonly<{ url: string; keyword: string; accessToken: string }> | undefined
  >();
  const [result] = createResource(query, async (input): Promise<ViewResult> => {
    try {
      return {
        tag: "ok",
        value: await investigateProduct(input.url, {
          keyword: input.keyword,
          accessToken: input.accessToken,
        }),
      };
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
              setQuery({ url: url().trim(), keyword: keyword(), accessToken: accessToken() });
            }}
          >
            <label class="sr-only" for="product-url">
              商品URL
            </label>
            <input
              id="product-url"
              type="url"
              placeholder="https://item.rakuten.co.jp/…"
              required
              value={url()}
              onInput={(event) => setUrl(event.currentTarget.value)}
            />
            <button type="submit" disabled={result.loading}>
              調べる
            </button>
          </form>
          <span class="demo">動作確認版</span>
        </div>
      </header>
      <main>
        <details class="details connection">
          <summary>接続設定</summary>
          <div class="connection-fields">
            <label for="access-token">動作確認用トークン</label>
            <input
              id="access-token"
              type="password"
              autocomplete="off"
              value={accessToken()}
              onInput={(event) => setAccessToken(event.currentTarget.value)}
            />
            <label for="search-keyword">補助の商品名</label>
            <input
              id="search-keyword"
              type="text"
              placeholder="URLで見つからない場合に入力"
              value={keyword()}
              onInput={(event) => setKeyword(event.currentTarget.value)}
            />
          </div>
        </details>
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
          <p class="status">
            楽天の商品URLを入力してください。
            <button
              class="text-button"
              type="button"
              onClick={() => setUrl("https://item.rakuten.co.jp/demo-shop/demo-product/")}
            >
              架空データのURLを入力
            </button>
          </p>
        </Show>
      </main>
    </>
  );
}
