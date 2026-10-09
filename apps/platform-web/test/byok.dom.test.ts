// @vitest-environment happy-dom
// V3-33 «Свои ключи моделей» in S10: hidden while the feature is off for the org; the owner reads and accepts the
// versioned terms in a modal, adds a key in a masked field (sent once, then cleared from the page), sees «•••• last4»,
// the «не проверена нами» mark and the check verdict, pauses and revokes after a confirmation; a viewer only reads.
import { act, type ComponentProps, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ApiClient } from "../src/api/client.js";
import { PlatformProvider } from "../src/app/context.js";
import { ByokKeys } from "../src/screens/settings/byok/ByokKeys.js";
import type { ByokClient, ByokKey, ByokState } from "../src/screens/settings/byok/client.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ORG = "00000000-0000-0000-0000-000000000001";
const KEY = "sk-dom-canary-0123456789abcdef-KEYZ";
const leaks = () => document.body.innerHTML.includes(KEY);

let container: HTMLDivElement | undefined;
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

const keyView = (over: Partial<ByokKey> = {}): ByokKey => ({
  id: "11111111-1111-4111-8111-111111111111",
  provider: "openai",
  providerName: "OpenAI",
  model: "gpt-x-pro",
  verified: false,
  direct: false,
  gatewayHost: "llm.my-company.example",
  last4: "KEYZ",
  status: "active",
  check: { status: "ok", code: null, message_ru: null, checkedAt: "2026-10-09T09:00:00Z" },
  lastUsedAt: null,
  lastErrorCode: null,
  createdAt: "2026-10-09T09:00:00Z",
  ...over,
});

const state = (over: Partial<ByokState> = {}): ByokState => ({
  available: true,
  consent: {
    version: "2026-10-09.1",
    title: "Условия подключения своих ключей моделей",
    paragraphs: [
      "Риски условий провайдера, счетов и блокировок — на вашей стороне.",
      "ПДн заменяются заглушками.",
    ],
    acceptedAt: null,
  },
  providers: [
    {
      id: "zai",
      name: "Z.ai (GLM)",
      direct: true,
      location: "foreign",
      verifiedModels: ["glm-5.3"],
      suggestedModels: ["glm-5.3"],
    },
    {
      id: "openai",
      name: "OpenAI",
      direct: false,
      location: "foreign",
      verifiedModels: [],
      suggestedModels: [],
    },
  ],
  keys: [],
  callTypes: ["page_compose"],
  ...over,
});

function fakeByok(initial: ByokState) {
  let st = initial;
  const calls: { op: string; args: unknown[] }[] = [];
  const client: ByokClient = {
    get: async () => st,
    accept: async (...args) => {
      calls.push({ op: "accept", args });
      st = {
        ...st,
        consent: { ...(st.consent as NonNullable<ByokState["consent"]>), acceptedAt: "2026-10-09T10:00:00Z" },
      };
      return st;
    },
    add: async (...args) => {
      calls.push({ op: "add", args });
      return { key: keyView() };
    },
    check: async (...args) => {
      calls.push({ op: "check", args });
      return {
        key: keyView({
          check: {
            status: "failed",
            code: "KEY_INVALID",
            message_ru: "Провайдер не принял ключ",
            checkedAt: null,
          },
        }),
      };
    },
    setStatus: async (_o, _k, status) => {
      calls.push({ op: "status", args: [status] });
      return { key: keyView({ status }) };
    },
    revoke: async (...args) => {
      calls.push({ op: "revoke", args });
      return { key: keyView({ status: "revoked" }) };
    },
  };
  return { client, calls };
}

async function mount(byok: ByokClient, owner = true): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const api = {
    getMe: async () => {
      throw new Error("no /me");
    },
    getOrgSettings: async () => ({}),
    byok,
  } as unknown as ApiClient;
  act(() =>
    root?.render(
      h(
        PlatformProvider,
        { api } as ComponentProps<typeof PlatformProvider>,
        h(ByokKeys, { orgId: ORG, owner }),
      ),
    ),
  );
  await settle();
  return container;
}

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const q = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.querySelector<T>(`[data-testid="${id}"]`);
const click = async (el: HTMLElement | null) => {
  await act(async () => el?.click());
  await settle();
};
function type(el: HTMLInputElement | null, value: string) {
  if (!el) throw new Error("no input");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function choose(el: HTMLSelectElement | null, value: string) {
  if (!el) throw new Error("no select");
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("S10 «Свои ключи моделей»", () => {
  test("off for the org → no section; an API client without byok (older fakes) → no section", async () => {
    const off = fakeByok({ available: false });
    const el = await mount(off.client);
    expect(el.querySelector('[data-testid="settings-byok"]')).toBeNull();
    act(() => root?.unmount());
    container?.remove();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const api = { getMe: async () => ({}), getOrgSettings: async () => ({}) } as unknown as ApiClient;
    act(() =>
      root?.render(
        h(
          PlatformProvider,
          { api } as ComponentProps<typeof PlatformProvider>,
          h(ByokKeys, { orgId: ORG, owner: true }),
        ),
      ),
    );
    await settle();
    expect(container.querySelector('[data-testid="settings-byok"]')).toBeNull();
  });

  test("terms: a modal with the text; accept only after the checkbox; Esc closes; then the add form", async () => {
    const f = fakeByok(state());
    await mount(f.client);
    expect(q("settings-byok")?.textContent).toContain("Свои ключи моделей");
    expect(q("byok-add")).toBeNull();
    await click(q("byok-consent-open"));
    const dialog = q("byok-consent");
    expect(dialog?.getAttribute("role")).toBe("dialog");
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(q("byok-consent-text")?.textContent).toContain("Риски условий провайдера");
    expect(document.activeElement).toBe(q("byok-consent-check"));
    expect(q<HTMLButtonElement>("byok-consent-yes")?.disabled).toBe(true);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(q("byok-consent")).toBeNull();
    await click(q("byok-consent-open"));
    await click(q("byok-consent-check"));
    expect(q<HTMLButtonElement>("byok-consent-yes")?.disabled).toBe(false);
    await click(q("byok-consent-yes"));
    expect(f.calls).toEqual([{ op: "accept", args: [ORG, "2026-10-09.1"] }]);
    expect(q("byok-consent")).toBeNull();
    expect(q("byok-consent-accepted")?.textContent).toContain("Условия приняты");
    expect(q("byok-add")).not.toBeNull();
  });

  test("adding a key: masked field, gateway only for providers blocking RF; the key leaves the page after saving", async () => {
    const f = fakeByok(
      state({
        consent: {
          ...(state().consent as NonNullable<ByokState["consent"]>),
          acceptedAt: "2026-10-09T10:00:00Z",
        },
      }),
    );
    await mount(f.client);
    // Z.ai accepts requests from RF: no gateway field.
    expect(q("byok-gateway")).toBeNull();
    choose(q<HTMLSelectElement>("byok-provider"), "openai");
    expect(q("byok-gateway")).not.toBeNull();
    const input = q<HTMLInputElement>("byok-key-input");
    expect(input?.type).toBe("password");
    expect(input?.getAttribute("autocomplete")).toBe("off");
    await click(q("byok-key-reveal"));
    expect(q<HTMLInputElement>("byok-key-input")?.type).toBe("text");
    expect(q("byok-key-reveal")?.getAttribute("aria-pressed")).toBe("true");
    await click(q("byok-key-reveal"));
    expect(q<HTMLButtonElement>("byok-add-submit")?.disabled).toBe(true);
    type(q<HTMLInputElement>("byok-gateway"), "https://llm.my-company.example/v1");
    type(q<HTMLInputElement>("byok-model"), "gpt-x-pro");
    type(q<HTMLInputElement>("byok-key-input"), KEY);
    expect(q<HTMLButtonElement>("byok-add-submit")?.disabled).toBe(false);
    await act(async () => {
      q<HTMLFormElement>("byok-add")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(f.calls.length).toBe(1);
    const sent = f.calls[0]?.args[1] as Record<string, string>;
    expect(sent.key === KEY, "the key went to the API").toBe(true);
    expect({ ...sent, key: "…" }).toEqual({
      provider: "openai",
      model: "gpt-x-pro",
      key: "…",
      gatewayUrl: "https://llm.my-company.example/v1",
    });
    expect(q<HTMLInputElement>("byok-key-input")?.value).toBe("");
    expect(leaks(), "the key stays in the page").toBe(false);
    expect(q("byok-key-last4")?.textContent).toBe("•••• KEYZ");
    expect(q("byok-unverified")?.textContent).toBe("не проверена нами");
    expect(q("byok-key-status")?.textContent).toBe("Работает");
    expect(q("byok-notice")?.textContent).toBe("Ключ сохранён");
  });

  test("check verdict, pause, revoke after a confirmation", async () => {
    const accepted = {
      ...(state().consent as NonNullable<ByokState["consent"]>),
      acceptedAt: "2026-10-09T10:00:00Z",
    };
    const f = fakeByok(state({ consent: accepted, keys: [keyView()] }));
    await mount(f.client);
    await click(q("byok-key-check-btn"));
    expect(q("byok-key-check")?.textContent).toBe("Провайдер не принял ключ");
    expect(q("byok-key-status")?.textContent).toBe("Ошибка проверки");
    await click(q("byok-key-use"));
    expect(f.calls.at(-1)).toEqual({ op: "status", args: ["paused"] });
    expect(q("byok-key-status")?.textContent).toBe("Пауза");
    await click(q("byok-key-revoke"));
    expect(q("byok-revoke")?.textContent).toContain("Отозвать ключ OpenAI •••• KEYZ?");
    expect(document.activeElement).toBe(q("byok-revoke-no"));
    await click(q("byok-revoke-yes"));
    expect(f.calls.at(-1)?.op).toBe("revoke");
    expect(q("byok-key")).toBeNull();
    expect(q("byok-empty")).not.toBeNull();
  });

  test("viewer: reads keys, no form, the consent button disabled, the owner hint", async () => {
    const f = fakeByok(state({ keys: [keyView()] }));
    const spy = vi.spyOn(f.client, "add");
    await mount(f.client, false);
    expect(q<HTMLButtonElement>("byok-consent-open")?.disabled).toBe(true);
    expect(q("byok-add")).toBeNull();
    expect(q("byok-key-revoke")).toBeNull();
    expect(q("settings-byok")?.textContent).toContain(
      "Подключать и отзывать ключи может владелец организации",
    );
    expect(q("byok-key-last4")?.textContent).toBe("•••• KEYZ");
    expect(spy).not.toHaveBeenCalled();
  });
});
