/** @jsxImportSource solid-js */
import { For } from "solid-js";
import type { JSX } from "solid-js";

import "./service-header.css";

import { serviceOriginsSchema, serviceLinks } from "@app/site-config";
import type { ServiceId } from "@app/site-config";

export function ServiceHeader(props: Readonly<{ current: ServiceId }>): JSX.Element {
  const origins = serviceOriginsSchema.parse(
    Object.fromEntries(
      ["products", "furusato", "securities"].map((id) => [
        id,
        document.querySelector<HTMLMetaElement>('meta[name="service-' + id + '"]')?.content,
      ]),
    ),
  );
  const services = serviceLinks(origins);
  return (
    <header class="top site-header">
      <div class="top-inner">
        <a class="brand" href="/">
          <svg class="brand-icon" viewBox="0 0 32 32" fill="none" aria-hidden="true">
            <path
              d="M16 3v25M5 7h22M9 29h14M7 7 2 18h10L7 7Zm18 0-5 11h10L25 7ZM2 18a5 5 0 0 0 10 0m8 0a5 5 0 0 0 10 0"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          商品比較
        </a>
        <nav class="mode-nav site-service-nav" aria-label="比較サービス">
          <For each={services}>
            {(service) => (
              <a
                href={service.href}
                aria-current={props.current === service.id ? "page" : undefined}
              >
                {service.label}
              </a>
            )}
          </For>
        </nav>
      </div>
    </header>
  );
}
