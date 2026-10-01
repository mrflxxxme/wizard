// @vitest-environment happy-dom
// M2-05: «Мои данные» in CabinetLayout and the policy link of AppShell lead to runtime pages (security/compliance.yaml
// #system_package.consent.withdrawal, #policy_page): plain browser navigation, never an SPA route.
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import { forum, forumFixture } from "../demo/fixtures.js";
import { AppShell, CabinetLayout, toRoleSpec, WzProvider, type WzUser } from "../src/index.js";
import { createMemoryDataSource } from "../src/testing/index.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | undefined;
afterEach(() => container?.remove());

const participant: WzUser = { id: "u-p", role: "participant", displayName: "Участник", isAdmin: false };

async function mount(child: ReturnType<typeof h>) {
  const f = forumFixture();
  const ds = createMemoryDataSource(forum, f.rows, { users: f.users, functions: f.functions });
  const went: string[] = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      h(
        WzProvider,
        {
          spec: toRoleSpec(forum, "participant"),
          dataSource: ds,
          applyTheme: false,
          pathname: "/my",
          navigate: (to: string) => went.push(to),
          user: participant,
        },
        child,
      ),
    ),
  );
  const el = container;
  return { went, $: (id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`) };
}

test("CabinetLayout appends «Мои данные» with the policy and /_wizard/privacy links", async () => {
  const r = await mount(
    h(CabinetLayout, { sections: [{ id: "tickets", label: "Мои билеты", content: h("p", null, "билеты") }] }),
  );
  const tab = r.$("wz-cabinet-tab-mydata");
  expect(tab?.textContent).toBe("Мои данные");
  await act(async () => tab?.click());
  expect(r.$("wz-cabinet-mydata")).not.toBeNull();
  expect(r.$("wz-cabinet-mydata-policy")?.getAttribute("href")).toBe("/privacy");
  expect(r.$("wz-cabinet-mydata-privacy")?.getAttribute("href")).toBe("/_wizard/privacy");
});

test("CabinetLayout keeps an own «mydata» section instead of adding a second one", async () => {
  const r = await mount(
    h(CabinetLayout, { sections: [{ id: "mydata", label: "Данные", content: h("p", null, "своё") }] }),
  );
  expect(container?.querySelectorAll('[data-testid="wz-cabinet-tab-mydata"]')).toHaveLength(1);
  expect(r.$("wz-cabinet-tab-mydata")?.textContent).toBe("Данные");
});

test("AppShell policy link navigates the browser (runtime page), not the SPA router", async () => {
  const r = await mount(h(AppShell, null, h("p", null, "страница")));
  const link = r.$("wz-appshell-policy-link") as HTMLAnchorElement;
  expect(link.getAttribute("href")).toBe("/privacy");
  const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
  link.addEventListener("click", (e) => e.preventDefault()); // keep happy-dom from navigating
  await act(async () => {
    link.dispatchEvent(ev);
  });
  expect(r.went).not.toContain("/privacy");
  expect(r.$("wz-appshell-privacy-link")?.getAttribute("href")).toBe("/_wizard/privacy");
});
