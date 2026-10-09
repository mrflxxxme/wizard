// Browser entry of apps/platform-web: design system v2 (fonts, --p-* tokens) and the document base of the v2 screens.
// zod-csp first: no zod module may parse before its JIT probe is switched off (CSP, see the file).
import "./zod-csp.js";
import "@wizard/ui-kit/v2/theme.css";
import "./style/platform.css";
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
