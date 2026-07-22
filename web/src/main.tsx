/* @refresh reload */
import { render } from "solid-js/web";
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/jetbrains-mono";
import "./styles/tokens.css";
import "./styles.css";
import App from "./App.tsx";

const root = document.getElementById("root");
if (root) render(() => <App />, root);
