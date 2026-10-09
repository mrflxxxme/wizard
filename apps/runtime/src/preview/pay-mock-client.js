// Confirmation button of the draft mock payment page (/_wizard/pay-mock): POST with the runtime CSRF header.
(() => {
  const button = document.getElementById("wz-pay-confirm");
  const error = document.getElementById("wz-pay-error");
  if (!button) return;
  button.addEventListener("click", () => {
    button.disabled = true;
    fetch("/_wizard/pay-mock", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Wizard-Request": "1" },
      body: JSON.stringify({
        binding: button.dataset.binding,
        id: button.dataset.id,
        ...(button.dataset.token ? { token: button.dataset.token } : {}),
      }),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((out) => {
        const url =
          typeof out.returnUrl === "string" && /^\/(?![/\\])/.test(out.returnUrl) ? out.returnUrl : "/";
        window.location.assign(url);
      })
      .catch(() => {
        button.disabled = false;
        if (error) error.hidden = false;
      });
  });
})();
