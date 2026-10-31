/** @jsxImportSource solid-js */
import { render } from "solid-js/web";

import { FurusatoApp } from "./FurusatoApp.js";
const root = document.getElementById("app");
if (root === null) {
  throw new Error("Mount point not found");
}
render(() => <FurusatoApp />, root);
