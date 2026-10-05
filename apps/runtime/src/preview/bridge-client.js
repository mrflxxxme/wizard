// Preview bridge (specs/ui/platform-screens.yaml#preview_contract), served as /_wizard/bridge.js on draft hosts.
// Plain browser script: `wizardBridge(window, {platformOrigin, revision})` is appended by the runtime.
// No record data or PII crosses the bridge: only role, route, style tokens, error text and component metadata
// (element-selected: componentName/file/line from wz-map.json, ui-kit.yaml#wz_id — never the element's text).

// biome-ignore lint/correctness/noUnusedVariables: called by the line the runtime appends
function wizardBridge(win, config) {
  const parent = win.parent;
  if (!parent || parent === win) return; // not framed by the platform
  const origin = config.platformOrigin;
  const ROUTE_RE = /^\/(?![/\\])/;
  const TOKEN_RE = /^--w-[a-z0-9-]{1,64}$/;
  const MODES = ["light", "dark", "auto"];
  const PENDING = "wz-bridge-pending";
  const WZ_ID_RE = /^[0-9a-f]{8}:[0-9]+$/;
  const OVERLAY_COLOR = "#2563eb";

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

  // ---- «Укажи и измени» (M3-01): select-mode / highlight, overlays with pointer-events:none.
  let selecting = false;
  let hoverBox = null;
  let marks = [];
  let marked = null;
  let wzMap = null;
  const loadMap = () => {
    wzMap ??= win
      .fetch("/_wizard/wz-map.json", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((m) => (m && typeof m === "object" ? m : {}));
    return wzMap;
  };
  /** Nearest ancestor-or-self with a plugin wzId (demo:* ids of the fallback are not selectable). */
  const componentOf = (target) => {
    let el = target && target.nodeType === 1 ? target : (target?.parentElement ?? null);
    while (el && typeof el.closest === "function") {
      el = el.closest("[data-wz-component][data-wz-id]");
      if (!el) return null;
      if (WZ_ID_RE.test(el.getAttribute("data-wz-id") || "")) return el;
      el = el.parentElement;
    }
    return null;
  };
  const place = (box, el) => {
    const r = el.getBoundingClientRect();
    box.style.left = `${r.left}px`;
    box.style.top = `${r.top}px`;
    box.style.width = `${r.width}px`;
    box.style.height = `${r.height}px`;
  };
  const overlay = (kind) => {
    const box = win.document.createElement("div");
    box.setAttribute("data-wz-overlay", kind);
    box.setAttribute("aria-hidden", "true");
    const st = box.style;
    st.position = "fixed";
    st.pointerEvents = "none";
    st.zIndex = "2147483647";
    st.boxSizing = "border-box";
    st.borderRadius = "4px";
    st.border = `2px ${kind === "hover" ? "solid" : "dashed"} ${OVERLAY_COLOR}`;
    st.background = kind === "hover" ? "rgba(37, 99, 235, 0.08)" : "transparent";
    if (kind === "hover") {
      const label = win.document.createElement("span");
      const ls = label.style;
      ls.position = "absolute";
      ls.left = "-2px";
      ls.bottom = "100%";
      ls.font = "12px/1.4 system-ui, sans-serif";
      ls.padding = "1px 6px";
      ls.color = "#fff";
      ls.background = OVERLAY_COLOR;
      ls.borderRadius = "4px 4px 0 0";
      ls.whiteSpace = "nowrap";
      box.appendChild(label);
    }
    win.document.body.appendChild(box);
    return box;
  };
  const hover = (el) => {
    if (!el) {
      if (hoverBox) hoverBox.style.display = "none";
      return;
    }
    hoverBox ??= overlay("hover");
    hoverBox.style.display = "block";
    place(hoverBox, el);
    const label = hoverBox.firstChild;
    if (label) label.textContent = el.getAttribute("data-wz-component") || "";
  };
  const highlight = (wzId) => {
    for (const m of marks) m.box.remove();
    marks = [];
    marked = typeof wzId === "string" && WZ_ID_RE.test(wzId) ? wzId : null;
    if (!marked) return;
    for (const el of win.document.querySelectorAll(`[data-wz-id="${marked}"]`)) {
      const box = overlay("selected");
      place(box, el);
      marks.push({ el, box });
    }
  };
  const reposition = () => {
    for (const m of marks) place(m.box, m.el);
  };
  const swallow = (e) => {
    if (!selecting) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const onMove = (e) => {
    if (selecting) hover(componentOf(e.target));
  };
  const onClick = (e) => {
    if (!selecting) return;
    swallow(e);
    const el = componentOf(e.target);
    if (!el) return;
    const wzId = el.getAttribute("data-wz-id");
    const r = el.getBoundingClientRect();
    const rect = { x: r.left, y: r.top, width: r.width, height: r.height };
    void loadMap().then((map) => {
      const entry = Object.hasOwn(map, wzId) ? map[wzId] : null;
      if (!entry || typeof entry.file !== "string" || !selecting) return;
      const componentName = String(entry.componentName || el.getAttribute("data-wz-component") || "").slice(
        0,
        60,
      );
      stopSelect();
      post("element-selected", {
        componentName,
        wzId,
        file: entry.file,
        line: entry.line,
        route: route(),
        rect,
      });
    });
  };
  const onKey = (e) => {
    if (!selecting || e.key !== "Escape") return;
    swallow(e);
    stopSelect();
    post("select-cancelled", {});
  };
  const BLOCKED = ["pointerdown", "mousedown", "pointerup", "mouseup", "dblclick", "auxclick", "submit"];
  let listening = false;
  const startSelect = () => {
    selecting = true;
    void loadMap();
    if (listening) return;
    listening = true;
    win.addEventListener("mousemove", onMove, true);
    win.addEventListener("click", onClick, true);
    win.addEventListener("keydown", onKey, true);
    for (const t of BLOCKED) win.addEventListener(t, swallow, true);
    win.addEventListener("scroll", reposition, true);
    win.addEventListener("resize", reposition);
  };
  const stopSelect = () => {
    selecting = false;
    hover(null);
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
      // M2-42: fonts of the unsaved theme (catalog files of /_wizard/fonts on this origin only).
      if (Array.isArray(p.fontFaces)) {
        const rules = p.fontFaces
          .slice(0, 16)
          .filter(
            (f) =>
              f &&
              /^[A-Za-z][A-Za-z ]{0,40}$/.test(f.family) &&
              /^[a-z0-9-]{1,80}\.woff2$/.test(f.file) &&
              (f.weight === 400 || f.weight === 700) &&
              /^[U+0-9A-Fa-f,-]{1,400}$/.test(f.unicodeRange),
          )
          .map(
            (f) =>
              `@font-face{font-family:"${f.family}";font-weight:${f.weight};font-display:swap;` +
              `src:url(/_wizard/fonts/${f.file}) format("woff2");unicode-range:${f.unicodeRange};}`,
          );
        let style = win.document.getElementById("wz-preview-fonts");
        if (!style) {
          style = win.document.createElement("style");
          style.id = "wz-preview-fonts";
          win.document.head.appendChild(style);
        }
        style.textContent = rules.join("\n");
      }
      post("theme-applied", {}, id);
    },
    "select-mode": (p) => {
      if (p?.enabled === true) startSelect();
      else if (p?.enabled === false) stopSelect();
    },
    highlight: (p) => {
      if (win.document?.body) highlight(p?.wzId ?? null);
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
