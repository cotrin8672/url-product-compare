/** @jsxImportSource solid-js */
import { createEffect, createResource, createSignal, For, onCleanup, Show } from "solid-js";
import type { JSX } from "solid-js";

import { createComparisonRequestScope, fetchCommerceListings } from "@app/api-client";
import type { CommerceListing, CommerceRequest } from "@app/api-client";

function displayRemainingMs(items: readonly CommerceListing[]): number {
  return Math.max(0, Math.min(...items.map((item) => Date.parse(item.expiresAt))) - Date.now());
}

export function ProductDiscovery(
  props: Readonly<{ disabled: boolean; onSelect: (url: string) => void }>,
): JSX.Element {
  const [draft, setDraft] = createSignal("");
  const [request, setRequest] = createSignal<CommerceRequest>({
    source: "rakuten",
    operation: "search",
    query: "新品",
    limit: 8,
    page: 1,
  });
  const [message, setMessage] = createSignal("");
  const [expired, setExpired] = createSignal(false);
  const [hasNext, setHasNext] = createSignal(false);
  const scope = createComparisonRequestScope();
  const [products, { refetch }] = createResource(
    request,
    async (input): Promise<readonly CommerceListing[]> => {
      const current = scope.begin();
      setMessage("");
      try {
        const response = await fetchCommerceListings(input, { signal: current.signal });
        if (current.signal.aborted) {
          return [];
        }
        setHasNext(
          response.total !== null &&
            response.total > response.page * response.limit &&
            response.page < 10,
        );
        return response.listings.filter(
          (item) =>
            item.condition === "new" &&
            item.availability === "available" &&
            item.usage.priceComparison,
        );
      } catch {
        if (!current.signal.aborted) {
          setMessage("商品を取得できませんでした。もう一度お試しください。");
        }
        return [];
      }
    },
  );
  onCleanup(() => {
    scope.invalidate();
  });
  createEffect(() => {
    const items = products() ?? [];
    setExpired(false);
    if (items.length === 0) {
      return;
    }
    const timer = setTimeout(() => setExpired(true), displayRemainingMs(items));
    onCleanup(() => {
      clearTimeout(timer);
    });
  });
  const reload = (): void => {
    Promise.resolve(refetch()).catch(() => setMessage("商品を取得できませんでした。"));
  };
  return (
    <section class="product-discovery" aria-labelledby="discovery-heading">
      <header class="discovery-head">
        <h2 id="discovery-heading">商品から比較</h2>
        <form
          class="discovery-search"
          onSubmit={(event) => {
            event.preventDefault();
            const entered = draft().trim();
            const query = entered.length > 0 ? entered : "新品";
            if (query === request().query && request().page === 1) {
              reload();
            } else {
              setRequest({ source: "rakuten", operation: "search", query, limit: 8, page: 1 });
            }
          }}
        >
          <input
            type="search"
            aria-label="商品名で探す"
            placeholder="商品名・型番で探す"
            value={draft()}
            maxLength={64}
            onInput={(event) => setDraft(event.currentTarget.value)}
          />
          <button type="submit" disabled={products.loading}>
            検索
          </button>
        </form>
      </header>
      <Show when={products.loading}>
        <p role="status">商品を取得しています…</p>
      </Show>
      <Show when={!products.loading}>
        <Show
          when={expired() || message().length > 0}
          fallback={
            <>
              <Show when={(products()?.length ?? 0) === 0}>
                <p role="status">比較できる新品商品が見つかりませんでした。</p>
              </Show>
              <div class="discovery-grid">
                <For each={products()}>
                  {(item) => (
                    <button
                      type="button"
                      class="discovery-product"
                      disabled={props.disabled}
                      onClick={() => {
                        if (Date.parse(item.expiresAt) <= Date.now()) {
                          setExpired(true);
                          return;
                        }
                        props.onSelect(item.url);
                      }}
                      aria-label={`${item.title}を比較する`}
                    >
                      <span
                        class="discovery-image"
                        aria-hidden="true"
                        style={
                          item.imageUrl === null
                            ? {}
                            : { "background-image": "url(" + JSON.stringify(item.imageUrl) + ")" }
                        }
                      >
                        <Show when={item.imageUrl === null}>画像なし</Show>
                      </span>
                      <span class="discovery-name">{item.title}</span>
                      <span class="discovery-price">
                        <Show when={item.amount} fallback="価格未確認">
                          {(amount) => (
                            <>
                              ¥{amount().minimum.toLocaleString("ja-JP")}
                              <Show when={amount().maximum !== amount().minimum}>〜</Show>
                            </>
                          )}
                        </Show>
                      </span>
                      <span class="discovery-action">
                        この商品から比較 <span aria-hidden="true">→</span>
                      </span>
                    </button>
                  )}
                </For>
              </div>
              <footer class="discovery-foot">
                <p>
                  掲載価格（送料・ポイントを含みません）。
                  <Show when={products()?.[0]}>
                    {(item) => (
                      <time dateTime={item().observedAt}>
                        {new Intl.DateTimeFormat("ja-JP", {
                          timeZone: "Asia/Tokyo",
                          month: "numeric",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        }).format(new Date(item().observedAt))}
                        取得
                      </time>
                    )}
                  </Show>
                </p>
                <nav aria-label="商品のページ">
                  <button
                    type="button"
                    disabled={(request().page ?? 1) <= 1}
                    onClick={() => setRequest({ ...request(), page: (request().page ?? 1) - 1 })}
                  >
                    前へ
                  </button>
                  <span>{request().page ?? 1}</span>
                  <button
                    type="button"
                    disabled={!hasNext()}
                    onClick={() => setRequest({ ...request(), page: (request().page ?? 1) + 1 })}
                  >
                    次へ
                  </button>
                </nav>
              </footer>
            </>
          }
        >
          <p role="status">
            {expired() ? "商品情報の表示期限が切れました。" : message()}{" "}
            <button type="button" onClick={reload}>
              再読み込み
            </button>
          </p>
        </Show>
      </Show>
    </section>
  );
}
