/** @jsxImportSource solid-js */
import { render } from "solid-js/web";

import { SecuritiesApp } from "./SecuritiesApp.js";
const root = document.getElementById("app");
if (root === null) {
  throw new Error("Mount point not found");
}
render(() => <SecuritiesApp />, root);
