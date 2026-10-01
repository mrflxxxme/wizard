// Minimal History API router (platform-screens.yaml#stack, ≤ 10 routes): "/", "/login", "/invite/:token",
// "/s/:systemId", "/s/:systemId/code", "/s/:systemId/settings", "/s/:systemId/import/:importId", "/legal/:doc",
// "/billing" (S-billing, M2-11), "/abuse" (public complaint form) and "/admin" (staff console, M2-08; the ticket is
// ?report=<id>, so the console stays one route), "/welcome" (S-welcome, pilot onboarding, M2-09).
import { useSyncExternalStore } from "react";

export type Route =
  | { name: "start" }
  | { name: "system"; systemId: string }
  | { name: "code"; systemId: string }
  | { name: "settings"; systemId: string }
  | { name: "import"; systemId: string; importId: string }
  | { name: "login" }
  | { name: "invite"; token: string }
  | { name: "legal"; doc: string }
  | { name: "billing" }
  | { name: "welcome" }
  | { name: "abuse" }
  | { name: "admin" }
  | { name: "notFound" };

/** Routes reachable without a session (S-auth, S-invite, documents, «Пожаловаться»). */
export const PUBLIC_ROUTES: ReadonlySet<Route["name"]> = new Set(["login", "invite", "legal", "abuse"]);

/** next after login: only a path of this origin (^/(?![/\\]), platform-screens.yaml S-auth). */
export function safeNext(next: string | null | undefined): string {
  return next && /^\/(?![/\\])/.test(next) ? next : "/";
}

const EVENT = "wz:navigate";

function subscribe(cb: () => void): () => void {
  window.addEventListener("popstate", cb);
  window.addEventListener(EVENT, cb);
  return () => {
    window.removeEventListener("popstate", cb);
    window.removeEventListener(EVENT, cb);
  };
}

const snapshot = () => window.location.pathname + window.location.search;

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  if (opts.replace) window.history.replaceState(null, "", to);
  else window.history.pushState(null, "", to);
  window.dispatchEvent(new Event(EVENT));
}

export function useLocationKey(): string {
  return useSyncExternalStore(subscribe, snapshot, () => "/");
}

export function matchRoute(pathname: string): Route {
  if (pathname === "/" || pathname === "") return { name: "start" };
  if (pathname === "/login") return { name: "login" };
  if (pathname === "/billing" || pathname === "/billing/") return { name: "billing" };
  if (pathname === "/welcome" || pathname === "/welcome/") return { name: "welcome" };
  if (pathname === "/abuse" || pathname === "/abuse/") return { name: "abuse" };
  if (pathname === "/admin" || pathname === "/admin/") return { name: "admin" };
  const inv = /^\/invite\/([A-Za-z0-9_-]{32,128})\/?$/.exec(pathname);
  if (inv) return { name: "invite", token: inv[1] as string };
  const legal = /^\/legal\/(offer|pd-consent|privacy)\/?$/.exec(pathname);
  if (legal) return { name: "legal", doc: legal[1] as string };
  const imp = /^\/s\/([A-Za-z0-9-]{1,64})\/import\/([A-Za-z0-9-]{1,64})\/?$/.exec(pathname);
  if (imp) return { name: "import", systemId: imp[1] as string, importId: imp[2] as string };
  const m = /^\/s\/([A-Za-z0-9-]{1,64})(?:\/(code|settings))?\/?$/.exec(pathname);
  if (m?.[2] === "code") return { name: "code", systemId: m[1] as string };
  if (m?.[2] === "settings") return { name: "settings", systemId: m[1] as string };
  if (m) return { name: "system", systemId: m[1] as string };
  return { name: "notFound" };
}

export function useRoute(): { route: Route; search: URLSearchParams } {
  const key = useLocationKey();
  const [path, query] = key.split("?");
  return { route: matchRoute(path ?? "/"), search: new URLSearchParams(query ?? "") };
}

/** Sets or removes one query parameter of the current URL (replaceState). */
export function setQueryParam(name: string, value: string | null): void {
  const u = new URL(window.location.href);
  if (value === null) u.searchParams.delete(name);
  else u.searchParams.set(name, value);
  navigate(u.pathname + u.search, { replace: true });
}

/**
 * Leaves the platform for a payment page (YooKassa confirmationUrl, S-billing). Only http(s) URLs: a confirmation URL
 * comes from the API, but a javascript: or data: URL must never be navigated to (L3-17).
 */
export function goExternal(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  externalNavigation.assign(u.toString());
  return true;
}

/** The browser navigation behind goExternal (DOM tests replace it: happy-dom does not leave the page). */
export const externalNavigation = { assign: (url: string): void => window.location.assign(url) };
