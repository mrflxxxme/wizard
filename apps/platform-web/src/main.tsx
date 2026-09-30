// Browser entry of apps/platform-web.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.js";
import { PlatformProvider } from "./app/context.js";

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(
    <StrictMode>
      <PlatformProvider>
        <App />
      </PlatformProvider>
    </StrictMode>,
  );
}
