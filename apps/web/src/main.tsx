import "./app.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { MobileConnectionScreen } from "./components/MobileConnectionScreen.tsx";
import { prepareNativeMobileBackend } from "./platform/native-mobile.ts";

const rootElement = document.getElementById("root");
if (rootElement === null) throw new Error("Missing #root element");

const root = createRoot(rootElement);

const EMBED_READY_MESSAGE = Object.freeze({ type: "t4-code:ready", version: 1 });

function notifyEmbeddingParent(): void {
  if (window.parent === window || new URLSearchParams(window.location.search).get("embed") !== "1") return;
  window.parent.postMessage(EMBED_READY_MESSAGE, "*");
}

void prepareNativeMobileBackend().then(async (boot) => {
  if (boot.kind === "setup") {
    root.render(
      <StrictMode>
        <MobileConnectionScreen {...(boot.message === undefined ? {} : { startupMessage: boot.message })} />
      </StrictMode>,
    );
    return;
  }
  const { renderApplication } = await import("./application.tsx");
  renderApplication(root);
  notifyEmbeddingParent();
});
