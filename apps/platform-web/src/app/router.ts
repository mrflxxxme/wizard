// Minimal History API router (platform-screens.yaml#stack): "/", "/s/:systemId", "/s/:systemId/code".
import { useSyncExternalStore } from "react";

export type Route =
  | { name: "start" }
  | { name: "system"; systemId: string }
  | { name: "code"; systemId: string }
  | { name: "notFound" };

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
  const m = /^\/s\/([A-Za-z0-9-]{1,64})(?:\/(code))?\/?$/.exec(pathname);
  if (m?.[2] === "code") return { name: "code", systemId: m[1] as string };
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
