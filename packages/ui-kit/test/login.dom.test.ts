// @vitest-environment happy-dom
// M1-05: AppShell.Login with the runtime flows — role of a self sign-up, consent at the first login
// (CONSENT_REQUIRED → ConsentCheckbox → the same code again), Telegram OIDC errors and redirect with consent.
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import { forum, forumFixture } from "../demo/fixtures.js";
import { AppShell, type AuthApi, type DataSource, toRoleSpec, WzProvider } from "../src/index.js";
import { createMemoryDataSource } from "../src/testing/index.js";
import { click, type } from "./helpers/dom.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | undefined;
afterEach(() => container?.remove());

const CONSENT = { policyVersion: "pv-1", textHash: "th-1" };

async function mount(pathname: string, o: { auth?: Partial<AuthApi>; planNote?: boolean } = {}) {
  const f = forumFixture();
  const mem = createMemoryDataSource(forum, f.rows, { users: f.users, consentAtLogin: true });
  const ds: DataSource = o.auth ? { ...mem, useAuth: () => ({ ...mem.auth, ...o.auth }) as AuthApi } : mem;
  const went: string[] = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const spec = toRoleSpec(forum, null, {
    policyVersion: CONSENT.policyVersion,
    consentTextHash: CONSENT.textHash,
    ...(o.planNote ? { phoneOtpPlanNote: true } : {}),
  });
  await act(async () =>
    root.render(
      h(
        WzProvider,
        { spec, dataSource: ds, applyTheme: false, pathname, navigate: (to: string) => went.push(to) },
        h(AppShell.Login),
      ),
    ),
  );
  const el = container;
  const q = (id: string) => el.querySelector(`[data-testid="${id}"]`);
  return { mem, went, el, q };
}

test("first login: role goes to start, CONSENT_REQUIRED shows the checkbox, the same code logs in with consent", async () => {
  const r = await mount("/login?role=participant&next=/my");
  await type(r.q("wz-field-email")?.querySelector("input") as Element, "new@example.ru");
  await click(r.q("wz-login-submit") as Element);
  expect(r.mem.calls.find((c) => c.op === "auth.start")?.args).toEqual([
    "email",
    "new@example.ru",
    { role: "participant" },
  ]);
  const code = r.mem.outbox.at(-1)?.code as string;
  await type(r.q("wz-field-code")?.querySelector("input") as Element, code);
  await click(r.q("wz-login-submit") as Element);
  expect(r.q("wz-consent")).not.toBeNull();
  expect(r.el.querySelector('[role="alert"]')?.textContent).toContain("согласие");
  expect(r.went).toEqual([]);
  // Without the checkbox the form does not even call verify.
  await click(r.q("wz-login-submit") as Element);
  expect(r.went).toEqual([]);
  await click(r.q("wz-consent")?.querySelector("input") as Element);
  await click(r.q("wz-login-submit") as Element);
  expect(r.went).toEqual(["/my"]);
});

test("Telegram callback error CONSENT_REQUIRED: checkbox + «Продолжить через Telegram» redirects with consent and role", async () => {
  const redirects: unknown[][] = [];
  const r = await mount("/login?error=CONSENT_REQUIRED&method=telegram&role=participant&next=%2Fmy", {
    auth: { redirect: (...args: unknown[]) => void redirects.push(args) },
  });
  expect(r.q("wz-consent")).not.toBeNull();
  await click(r.q("wz-login-telegram") as Element);
  expect(redirects).toEqual([]);
  await click(r.q("wz-consent")?.querySelector("input") as Element);
  await click(r.q("wz-login-telegram") as Element);
  expect(redirects).toEqual([["telegram", "/my", { role: "participant", consent: CONSENT }]]);
});

test("OIDC errors are shown in Russian; a plain Telegram choice redirects at once", async () => {
  const redirects: unknown[][] = [];
  const r = await mount("/login?error=OIDC_EXPIRED&method=telegram", {
    auth: { redirect: (...args: unknown[]) => void redirects.push(args) },
  });
  expect(r.el.querySelector('[role="alert"]')?.textContent).toBe(
    "Время входа через Telegram истекло. Попробуйте ещё раз",
  );
  await click(r.q("wz-login-telegram") as Element);
  expect(redirects).toEqual([["telegram", "/", {}]]);
});
