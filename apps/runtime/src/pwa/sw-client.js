// Service worker of a system (runtime.yaml#static.pwa, M2): the runtime prepends `self.__WZ_SW = {version, precache}`.
// Shell precache; navigations, RoleSpec and the session are network-first with the cached copy offline; hashed
// assets cache-first; /api/* and /_wizard/qr/* always go to the network. The QR offline package lives in IndexedDB
// (ui-kit QrScanner, db "wz-qr", store "manifests", field expiresAt): expired copies are deleted here.
const CONFIG = self.__WZ_SW;
const SHELL = `wz-shell-${CONFIG.version}`;
const DATA = "wz-data";
const DATA_PATHS = new Set(["/_wizard/spec", "/api/auth/me"]);
const LOGOUT_PATHS = new Set(["/api/auth/logout", "/_wizard/dev-logout", "/api/auth/consent/revoke"]);

function purgeQr() {
  return new Promise((resolve) => {
    let open;
    try {
      open = indexedDB.open("wz-qr");
    } catch {
      resolve();
      return;
    }
    // No database yet: abort the implicit creation.
    open.onupgradeneeded = () => open.transaction.abort();
    open.onerror = () => resolve();
    open.onblocked = () => resolve();
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains("manifests")) {
        db.close();
        resolve();
        return;
      }
      const tx = db.transaction("manifests", "readwrite");
      const now = Date.now();
      tx.objectStore("manifests").openCursor().onsuccess = (ev) => {
        const cursor = ev.target.result;
        if (!cursor) return;
        if (!(Date.parse(cursor.value.expiresAt) > now)) cursor.delete();
        cursor.continue();
      };
      const done = () => {
        db.close();
        resolve();
      };
      tx.oncomplete = done;
      tx.onabort = done;
      tx.onerror = done;
    };
  });
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(CONFIG.precache))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith("wz-shell-") && key !== SHELL) await caches.delete(key);
      }
      await self.clients.claim();
      // The page that installed the worker fetched these before it was controlled: warm them for an offline reload.
      const data = await caches.open(DATA);
      await Promise.all(
        [...DATA_PATHS].map((p) =>
          fetch(p, { credentials: "same-origin", headers: { Accept: "application/json" } })
            .then((res) => (res.ok ? data.put(p, res) : undefined))
            .catch(() => undefined),
        ),
      );
      await purgeQr();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "wz-qr-purge") event.waitUntil(purgeQr());
});

const offlineJson = () =>
  new Response(JSON.stringify({ error: { code: "NETWORK", message: "Нет сети", details: {} } }), {
    status: 503,
    headers: { "Content-Type": "application/json" },
  });

async function navigate(request) {
  try {
    return await fetch(request);
  } catch {
    const shell = await caches.match("/", { cacheName: SHELL });
    return (
      shell ??
      new Response("Нет сети", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } })
    );
  }
}

async function cacheFirst(request) {
  const hit = await caches.match(request, { cacheName: SHELL });
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) {
    const copy = res.clone();
    caches.open(SHELL).then((c) => c.put(request, copy));
  }
  return res;
}

async function networkFirst(request, cacheName) {
  const path = new URL(request.url).pathname;
  try {
    const res = await fetch(request);
    const cache = await caches.open(cacheName);
    if (res.ok) await cache.put(request, res.clone());
    else if (res.status === 401 || res.status === 403) await cache.delete(request);
    return res;
  } catch {
    const hit = await caches.match(request, { cacheName, ignoreVary: true });
    if (hit) return hit;
    return path.startsWith("/_wizard/") || path.startsWith("/api/") ? offlineJson() : Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (LOGOUT_PATHS.has(url.pathname)) {
    event.waitUntil(caches.delete(DATA));
    return;
  }
  if (request.method !== "GET") return;
  if (request.mode === "navigate") {
    event.respondWith(navigate(request));
  } else if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirst(request));
  } else if (DATA_PATHS.has(url.pathname)) {
    event.respondWith(networkFirst(request, DATA));
  } else if (CONFIG.precache.includes(url.pathname)) {
    event.respondWith(networkFirst(request, SHELL));
  }
});
