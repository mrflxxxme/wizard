// @vitest-environment happy-dom
// AppShell access states (FU-4): a logged-in role on someone else's page sees «нет доступа» with a way to its
// start page, never the login form; no redirect to /login while the session is still loading.
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import { forum, forumFixture } from "../demo/fixtures.js";
import { AppShell, type DataSource, toRoleSpec, WzProvider, type WzUser } from "../src/index.js";
import { createMemoryDataSource } from "../src/testing/index.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | undefined;
afterEach(() => container?.remove());

const volunteer: WzUser = { id: "u-vol", role: "volunteer", displayName: "Волонтёр", isAdmin: false };

async function mount(o: { pathname: string; role: string | null; user?: WzUser | null; loading?: boolean }) {
  const f = forumFixture();
  const mem = createMemoryDataSource(forum, f.rows, { users: f.users, functions: f.functions });
  const ds: DataSource = o.loading
    ? { ...mem, useUser: () => ({ user: null, isLoading: true, login: () => {}, logout: async () => {} }) }
    : mem;
  const went: string[] = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      h(
        WzProvider,
        {
          spec: toRoleSpec(forum, o.role),
          dataSource: ds,
          applyTheme: false,
          pathname: o.pathname,
          navigate: (to: string) => went.push(to),
          ...(o.user !== undefined ? { user: o.user } : {}),
        },
        h(AppShell, null, h("p", { "data-testid": "page" }, "страница")),
      ),
    ),
  );
  const el = container;
  return { went, has: (id: string) => el.querySelector(`[data-testid="${id}"]`) !== null, el };
}

test("volunteer on /ticket/:id: no-access state with a button to the scanner, no login form", async () => {
  const r = await mount({ pathname: "/ticket/abc", role: "volunteer", user: volunteer });
  expect(r.has("wz-login")).toBe(false);
  expect(r.has("page")).toBe(false);
  expect(r.has("wz-appshell-forbidden")).toBe(true);
  expect(r.el.textContent).toContain("Нет доступа к этой странице");
  const start = forum.pages?.find((p) => p.route === "/scanner");
  const btn = r.el.querySelector<HTMLButtonElement>('[data-testid="wz-appshell-start"]');
  expect(btn?.textContent).toContain(start?.title ?? "");
  await act(async () => btn?.click());
  expect(r.went).toEqual([start?.route]);
});

test("while the session loads, an unknown page waits instead of redirecting to /login", async () => {
  const r = await mount({ pathname: "/ticket/abc", role: "visitor", loading: true });
  expect(r.went).toEqual([]);
  expect(r.has("wz-login")).toBe(false);
});

test("a guest on a login-only page is sent to /login?next=…", async () => {
  const r = await mount({ pathname: "/ticket/abc", role: "visitor", user: null });
  expect(r.went).toEqual([`/login?next=${encodeURIComponent("/ticket/abc")}`]);
});

test("a logged-in user on /login goes on to next instead of seeing the form", async () => {
  const r = await mount({ pathname: "/login?next=/scan", role: "volunteer", user: volunteer });
  expect(r.has("wz-login")).toBe(false);
  expect(r.went).toEqual(["/scan"]);
});
