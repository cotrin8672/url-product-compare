/** @jsxImportSource solid-js */
import type { JSX } from "solid-js";

export function SecuritiesAdImpression(props: Readonly<{ url: string }>): JSX.Element {
  return (
    <img src={props.url} width="1" height="1" alt="" referrerpolicy="no-referrer-when-downgrade" />
  );
}
