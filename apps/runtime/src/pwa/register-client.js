// /_wizard/pwa.js: registers /sw.js for the top-level document (runtime.yaml#static.pwa). The platform preview
// iframe stays without a service worker, so a rebuilt draft never comes from a stale cache.
(() => {
  if (!("serviceWorker" in navigator) || window.top !== window.self) return;
  const register = () => navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register);
})();
