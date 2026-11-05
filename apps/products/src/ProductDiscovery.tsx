/** @jsxImportSource solid-js */
import {
  createEffect,
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import type { JSX } from "solid-js";

import { createComparisonRequestScope, fetchCommerceListings } from "@app/api-client";
import type { CommerceListing, CommerceRequest } from "@app/api-client";

import { productImageUrl } from "./product-image.js";

function displayRemainingMs(items: readonly CommerceListing[]): number {
  return Math.max(0, Math.min(...items.map((item) => Date.parse(item.expiresAt))) - Date.now());
}

function ProductShowcase(props: Readonly<{ children: JSX.Element }>): JSX.Element {
  const [track, setTrack] = createSignal<HTMLDivElement>();
  const [reducedMotion, setReducedMotion] = createSignal(false);
  const [hovered, setHovered] = createSignal(false);
  const [focused, setFocused] = createSignal(false);
  const [visible, setVisible] = createSignal(false);
  const [pageVisible, setPageVisible] = createSignal(!document.hidden);
  const [overflowing, setOverflowing] = createSignal(false);
  const [position, setPosition] = createSignal<
    Readonly<{ first: number; last: number; total: number }>
  >({ first: 1, last: 1, total: 1 });

  const updatePosition = (): void => {
    const element = track();
    const card = element?.firstElementChild;
    if (element === undefined || !(card instanceof HTMLElement)) {
      return;
    }
    const gap = parseFloat(getComputedStyle(element).gap);
    const step = card.getBoundingClientRect().width + gap;
    const first = Math.round(element.scrollLeft / step) + 1;
    const count = Math.max(1, Math.floor((element.clientWidth + gap) / step));
    setPosition({
      first,
      last: Math.min(element.children.length, first + count - 1),
      total: element.children.length,
    });
  };

  const move = (direction: -1 | 1): void => {
    const element = track();
    const card = element?.firstElementChild;
    if (element === undefined || !(card instanceof HTMLElement)) {
      return;
    }
    const maximum = element.scrollWidth - element.clientWidth;
    const step = card.getBoundingClientRect().width + parseFloat(getComputedStyle(element).gap);
    const left = Math.max(0, Math.min(maximum, element.scrollLeft));
    const destination =
      direction === 1
        ? left >= maximum - 2
          ? 0
          : Math.min(maximum, left + step)
        : left <= 2
          ? maximum
          : Math.max(0, left - step);
    element.scrollTo({
      left: destination,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  };

  onMount(() => {
    const element = track();
    if (element === undefined) {
      return;
    }
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(motion.matches);
    const motionChanged = (): void => {
      setReducedMotion(motion.matches);
    };
    const visibilityChanged = (): void => {
      setPageVisible(!document.hidden);
    };
    const resize = new ResizeObserver(() => {
      setOverflowing(element.scrollWidth > element.clientWidth + 1);
      updatePosition();
    });
    const intersection = new IntersectionObserver(
      (entries) => setVisible(entries.some((entry) => entry.isIntersecting)),
      { threshold: 0.5 },
    );
    resize.observe(element);
    intersection.observe(element);
    motion.addEventListener("change", motionChanged);
    document.addEventListener("visibilitychange", visibilityChanged);
    onCleanup(() => {
      resize.disconnect();
      intersection.disconnect();
      motion.removeEventListener("change", motionChanged);
      document.removeEventListener("visibilitychange", visibilityChanged);
    });
  });

  createEffect(() => {
    if (
      reducedMotion() ||
      hovered() ||
      focused() ||
      !visible() ||
      !pageVisible() ||
      !overflowing()
    ) {
      return;
    }
    const timer = setInterval(() => {
      move(1);
    }, 4500);
    onCleanup(() => {
      clearInterval(timer);
    });
  });

  return (
    <div
      class="discovery-showcase"
      role="group"
      aria-roledescription="カルーセル"
      aria-label="商品一覧"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocusIn={() => setFocused(true)}
      onFocusOut={(event) => {
        if (
          !(
            event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)
          )
        ) {
          setFocused(false);
        }
      }}
    >
      <div
        class="discovery-track"
        ref={(element) => {
          setTrack(element);
        }}
        onScroll={updatePosition}
      >
        {props.children}
      </div>
      <Show when={overflowing()}>
        <>
          <button
            type="button"
            class="discovery-arrow discovery-previous"
            aria-label="前の商品を表示"
            onClick={() => {
              move(-1);
            }}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              aria-hidden="true"
            >
              <path d="m14 5-7 7 7 7" />
            </svg>
          </button>
          <button
            type="button"
            class="discovery-arrow discovery-next"
            aria-label="次の商品を表示"
            onClick={() => {
              move(1);
            }}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              aria-hidden="true"
            >
              <path d="m10 5 7 7-7 7" />
            </svg>
          </button>
          <div class="discovery-status">
            <span
              class="discovery-position"
              aria-label={`${position().first}から${position().last}件目、全${position().total}件`}
            >
              {position().first}–{position().last}
              <span> / {position().total}</span>
            </span>
          </div>
        </>
      </Show>
    </div>
  );
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
              <ProductShowcase>
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
                            : {
                                "background-image":
                                  "url(" + JSON.stringify(productImageUrl(item.imageUrl)) + ")",
                              }
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
                        比較する{" "}
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="1.8"
                          aria-hidden="true"
                        >
                          <path d="M4 12h15m-5-5 5 5-5 5" />
                        </svg>
                      </span>
                    </button>
                  )}
                </For>
              </ProductShowcase>
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
                    前の一覧
                  </button>
                  <span>{request().page ?? 1}</span>
                  <button
                    type="button"
                    disabled={!hasNext()}
                    onClick={() => setRequest({ ...request(), page: (request().page ?? 1) + 1 })}
                  >
                    次の一覧
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
