// Preview bridge (specs/ui/platform-screens.yaml#preview_contract), served as /_wizard/bridge.js on draft hosts.
// Plain browser script: `wizardBridge(window, {platformOrigin, revision})` is appended by the runtime.
// No record data or PII crosses the bridge: only role, route, style tokens and error text.

// biome-ignore lint/correctness/noUnusedVariables: called by the line the runtime appends
function wizardBridge(win, config) {
  const parent = win.parent;
  if (!parent || parent === win) return; // not framed by the platform
  const origin = config.platformOrigin;
  const ROUTE_RE = /^\/(?![/\\])/;
  const TOKEN_RE = /^--w-[a-z0-9-]{1,64}$/;
  const MODES = ["light", "dark", "auto"];
  const PENDING = "wz-bridge-pending";

  const post = (type, payload, id) => {
    const m = { wz: 1, type, payload };
    if (typeof id === "string") m.id = id;
    parent.postMessage(m, origin);
  };
  const route = () => win.location.pathname + win.location.search;
  const storage = () => {
    try {
      return win.sessionStorage || null;
    } catch (_e) {
      return null;
    }
  };

  const handlers = {
    "set-role": (p, id) => {
      if (typeof p?.url !== "string") return;
      let u;
      try {
        u = new win.URL(p.url, win.location.href);
      } catch (_e) {
        return;
      }
      if (u.origin !== win.location.origin) return;
      u.searchParams.set("next", route());
      const s = storage();
      if (s && id) {
        try {
          s.setItem(PENDING, id);
        } catch (_e) {}
      }
      win.location.replace(u.pathname + u.search);
    },
    "apply-theme-tokens": (p, id) => {
      if (typeof p?.tokens !== "object" || p.tokens === null) return;
      const root = win.document.documentElement;
      for (const [k, v] of Object.entries(p.tokens)) {
        if (TOKEN_RE.test(k) && typeof v === "string" && v.length <= 200) root.style.setProperty(k, v);
      }
      if (MODES.includes(p.mode)) root.setAttribute("data-wz-mode", p.mode);
      post("theme-applied", {}, id);
    },
    navigate: (p) => {
      if (typeof p?.route !== "string" || !ROUTE_RE.test(p.route) || p.route.length > 2000) return;
      win.history.pushState(null, "", p.route);
      win.dispatchEvent(new win.PopStateEvent("popstate"));
    },
  };

  win.addEventListener("message", (e) => {
    if (e.origin !== origin || e.source !== parent) return;
    const m = e.data;
    if (!m || typeof m !== "object" || m.wz !== 1 || typeof m.type !== "string") return;
    if (!Object.hasOwn(handlers, m.type)) return;
    const id = typeof m.id === "string" && m.id.length <= 100 ? m.id : undefined;
    handlers[m.type](m.payload, id);
  });

  let last = route();
  const changed = () => {
    const r = route();
    if (r === last) return;
    last = r;
    post("route-changed", { route: r });
  };
  for (const k of ["pushState", "replaceState"]) {
    const orig = win.history[k];
    win.history[k] = function (...args) {
      const out = orig.apply(this, args);
      changed();
      return out;
    };
  }
  win.addEventListener("popstate", changed);

  const fail = (message) => post("error", { message: String(message || "Ошибка превью").slice(0, 300) });
  win.addEventListener("error", (e) => fail(e?.message));
  win.addEventListener("unhandledrejection", (e) => {
    const r = e?.reason;
    fail(r && typeof r === "object" && "message" in r ? r.message : r);
  });

  const ready = () => {
    let pendingId;
    const s = storage();
    if (s) {
      try {
        pendingId = s.getItem(PENDING) || undefined;
        s.removeItem(PENDING);
      } catch (_e) {}
    }
    win
      .fetch("/_wizard/spec", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((spec) => {
        const role = typeof spec?.role?.name === "string" ? spec.role.name : null;
        post("ready", { protocol: 1, route: route(), role, revision: config.revision }, pendingId);
      });
  };
  if (win.document.readyState === "complete") ready();
  else win.addEventListener("load", ready);
}
