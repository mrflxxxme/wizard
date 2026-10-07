// Cabinet look v2 (B2-34, ui-kit.yaml#tokens.cabinet): cabinet components mark their root with data-wz-look="cabinet"
// (tokens/cabinet.css maps --w-* to the warm --w-cab-* values there) and, while at least one is mounted, <html> too —
// the page background and the page rhythm (base.css) follow. Attributes only: no <style> is injected (CSP of systems).
import { useLayoutEffect } from "react";
import { CABINET_LOOK } from "../tokens/cabinet.js";

const mounted = new WeakMap<HTMLElement, number>();

/** Root attribute of a cabinet component. */
export const cabinetLook = { "data-wz-look": CABINET_LOOK } as const;

/** Marks <html> with the cabinet look while the calling component is mounted; returns the root attribute. */
export function useCabinetLook(): typeof cabinetLook {
  useLayoutEffect(() => {
    if (typeof document === "undefined") return;
    const html = document.documentElement;
    mounted.set(html, (mounted.get(html) ?? 0) + 1);
    html.setAttribute("data-wz-look", CABINET_LOOK);
    return () => {
      const n = (mounted.get(html) ?? 1) - 1;
      if (n > 0) mounted.set(html, n);
      else {
        mounted.delete(html);
        html.removeAttribute("data-wz-look");
      }
    };
  }, []);
  return cabinetLook;
}
