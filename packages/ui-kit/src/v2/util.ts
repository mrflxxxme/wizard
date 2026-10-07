// Small helpers shared by the v2 components.

/** Joins truthy class names. */
export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}

/** Root attributes every v2 component sets: data-p-component (PascalCase) and data-testid (`p-<name>` or the testId). */
export function pRoot(component: string, testId: string | undefined, fallback: string) {
  return { "data-p-component": component, "data-testid": testId ?? fallback };
}

/** True when the user asked for less motion (or there is no window, e.g. in SSR). */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Common props of the v2 components. */
export interface PBase {
  className?: string;
  /** data-testid override (default p-<component>). */
  testId?: string;
}
