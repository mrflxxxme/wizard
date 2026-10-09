// @vitest-environment happy-dom
// V3-21 «Окно ключа в чате» on the page: a message with a key is not sent — the composer keeps it masked, the window
// takes the key in memory; the page encrypts it with the window's public key (opened here by the platform's own
// crypto.ts — the ciphertext carries no key) and after saving the message gets secret://name instead; the passport form
// (amoCRM) shows the account's host as it is typed and checks the token's shape; the agent's request shows as «Нужен
// ключ»; a viewer cannot enter keys. The key never appears in the DOM.
import { webcrypto } from "node:crypto";
import { act, type ComponentProps, createElement as h, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
import { openSealedSecret } from "../../platform-api/src/secrets-v3/crypto.js";
import type { ApiClient } from "../src/api/client.js";
import { PlatformProvider } from "../src/app/context.js";
import type {
  KeysClient,
  KeysState,
  KeyWindowWithKey,
  PassportForm,
  SealedSecret,
} from "../src/screens/v3/keys/index.js";
import { useKeyWindows } from "../src/screens/v3/keys/index.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SYS = "33333333-3333-4333-8333-333333333333";
const WIN = "44444444-4444-4444-8444-444444444444";
const KEY = `crm${"-"}${webcrypto.getRandomValues(new Uint8Array(12)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "")}`;
const leaks = () => document.body.innerHTML.includes(KEY);

let container: HTMLDivElement | undefined;
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));
/** Encryption is asynchronous (WebCrypto): settle until the page shows the result. */
async function until(ok: () => boolean) {
  for (let i = 0; i < 100 && !ok(); i++) await act(async () => new Promise((r) => setTimeout(r, 10)));
}
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

const AMO_FORM: PassportForm = {
  passport: "amocrm",
  name: "amoCRM",
  where_ru: "amoCRM → amoМаркет → Внешняя интеграция → «Ключи и доступы»",
  compose: "plain",
  fields: [
    {
      key: "account",
      label_ru: "Адрес аккаунта amoCRM",
      hint_ru: "Адрес из строки браузера",
      example: "mycompany.amocrm.ru",
      pattern: null,
      flags: "",
      error_ru: null,
      secret: false,
    },
    {
      key: "token",
      label_ru: "Долгосрочный токен",
      hint_ru: "Ключи и доступы",
      example: "eyJ0eXAi••••",
      pattern: "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$",
      flags: "",
      error_ru: "Долгосрочный токен amoCRM — длинная строка из трёх частей через точку",
      secret: true,
    },
  ],
  account: {
    label_ru: "Адрес аккаунта amoCRM",
    example: "mycompany.amocrm.ru",
    suffixes: ["amocrm.ru", "amocrm.com"],
    customHost: false,
    reserved: ["www", "api"],
    field: "account",
  },
};

/** A window with a real P-256 key pair: the test keeps the private half to open what the page sends. */
async function windowPair(form: PassportForm | null, requestedBy: "agent" | "user" = "user") {
  const kp = (await webcrypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as webcrypto.CryptoKeyPair;
  const jwk = await webcrypto.subtle.exportKey("jwk", kp.publicKey);
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", kp.privateKey));
  const context = `wz-key-window/v1:${WIN}:${SYS}:draft:crm_key`;
  const win: KeyWindowWithKey = {
    id: WIN,
    env: "draft",
    name: form ? "amo_key" : "crm_key",
    secretRef: form ? "secret://amo_key" : "secret://crm_key",
    integrationId: form ? "amo" : "crm",
    integrationName: form ? "amoCRM" : "Partner CRM",
    hosts: form ? ["your-account.amocrm.ru"] : ["api.partner-crm.ru"],
    purpose: "Отправлять заявки с сайта",
    requestedBy,
    status: "open",
    expiresAt: "2026-10-10T09:00:00Z",
    createdAt: "2026-10-09T09:00:00Z",
    alg: "ECDH-ES+HKDF-SHA256+A256GCM",
    publicKey: { kty: "EC", crv: "P-256", x: jwk.x as string, y: jwk.y as string },
    context,
    form,
  };
  return { win, open: (s: SealedSecret) => openSealedSecret(pkcs8, s, WIN, context) };
}

function fakeKeys(st: KeysState, win: KeyWindowWithKey) {
  const submitted: SealedSecret[] = [];
  const client: KeysClient = {
    list: async () => st,
    open: async () => ({ window: win }),
    window: async () => ({ window: win }),
    submit: async (_s, _w, sealed) => {
      submitted.push(sealed);
      return {
        saved: true,
        secret: {
          name: win.name,
          secretRef: win.secretRef,
          env: "draft",
          integrationId: win.integrationId,
          integrationName: win.integrationName,
          hosts: win.hosts,
          last4: "abcd",
          version: 1,
          status: "ok",
          check: { code: "OK", message_ru: "Ключ принят", checkedAt: "2026-10-09T09:00:00Z" },
          rotatedAt: null,
          createdAt: "2026-10-09T09:00:00Z",
        },
        checks: [{ integrationId: "crm", ok: true, status: "live", message_ru: "Ключ принят" }],
        message_ru: "Ключ сохранён: ••••abcd и проверен. Ключ принят",
      };
    },
    cancel: async () => ({ window: win }),
    check: async () => {
      throw new Error("not used");
    },
    remove: async () => ({ removed: true }),
  };
  return { client, submitted };
}

const needed = (over: Partial<KeysState["needed"][number]> = {}): KeysState["needed"][number] => ({
  integrationId: "crm",
  integrationName: "Partner CRM",
  name: "crm_key",
  secretRef: "secret://crm_key",
  hosts: ["api.partner-crm.ru"],
  present: false,
  keyless: false,
  account: null,
  ...over,
});

const sent: string[] = [];
function Harness(p: { editable: boolean; message: string }) {
  const [text, setText] = useState("");
  const keys = useKeyWindows({
    systemId: SYS,
    enabled: true,
    editable: p.editable,
    live: false,
    refresh: "1",
    composer: text,
    setComposer: setText,
    announce: () => {},
  });
  return h(
    "div",
    null,
    h("output", { "data-testid": "composer" }, text),
    h(
      "button",
      {
        type: "button",
        "data-testid": "send",
        onClick: () => {
          setText(p.message);
          if (!keys.intercept(p.message)) sent.push(p.message);
        },
      },
      "send",
    ),
    keys.card,
    keys.row,
  );
}

async function mount(keys: KeysClient, o: { editable?: boolean; message?: string } = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const api = {
    getMe: async () => {
      throw new Error("no /me");
    },
    getOrgSettings: async () => ({}),
    keys,
  } as unknown as ApiClient;
  act(() =>
    root?.render(
      h(
        PlatformProvider,
        { api } as ComponentProps<typeof PlatformProvider>,
        h(Harness, { editable: o.editable ?? true, message: o.message ?? "" }),
      ),
    ),
  );
  await settle();
}

describe("the key window on the page", () => {
  test("a typed key is not sent: masked in the composer, encrypted in the window, back as secret://name", async () => {
    const { win, open } = await windowPair(null);
    const fake = fakeKeys({ items: [], windows: [], needed: [needed()] }, win);
    await mount(fake.client, { message: `Подключи CRM, ключ API: ${KEY}` });
    await click(q("send"));
    expect(sent).toEqual([]);
    expect(q("composer")?.textContent).toBe("Подключи CRM, ключ API: [ключ скрыт]");
    expect(q("key-intercept")?.getAttribute("role")).toBe("alert");
    expect(leaks()).toBe(false);
    await click(q("key-intercept-open"));
    const input = q<HTMLInputElement>("key-input");
    expect(input?.type).toBe("password");
    expect(input?.value === KEY).toBe(true);
    expect(q("key-hosts")?.textContent).toContain("api.partner-crm.ru");
    expect(q("key-window-who")?.textContent).toBe("Окно ключа");
    expect(leaks()).toBe(false);
    await act(async () => input?.form?.requestSubmit());
    await until(() => q("key-result-text") !== null);
    expect(fake.submitted).toHaveLength(1);
    const sealed = fake.submitted[0] as SealedSecret;
    expect(JSON.stringify(sealed).includes(KEY)).toBe(false);
    expect((await open(sealed)) === KEY).toBe(true);
    expect(q("key-result-text")?.textContent).toMatch(/^Ключ сохранён: ••••abcd/);
    expect(q("composer")?.textContent).toBe("Подключи CRM, ключ API: secret://crm_key");
    expect(leaks()).toBe(false);
  });

  test("«Убрать ключ из сообщения» drops it; an ordinary message is sent", async () => {
    const { win } = await windowPair(null);
    await mount(fakeKeys({ items: [], windows: [], needed: [] }, win).client, { message: `токен ${KEY}` });
    await click(q("send"));
    expect(q("key-intercept")?.textContent).toContain("напишите в чате, к какому сервису");
    await click(q("key-intercept-strip"));
    expect(q("key-intercept")).toBeNull();
    expect(q("composer")?.textContent).toBe("токен [ключ скрыт]");
    act(() => root?.unmount());
    container?.remove();
    await mount(fakeKeys({ items: [], windows: [], needed: [] }, win).client, { message: "Заявки — в CRM" });
    await click(q("send"));
    expect(sent).toEqual(["Заявки — в CRM"]);
  });

  test("a passport window (amoCRM): the account's host as typed, the token's shape, the fields encrypted together", async () => {
    const { win, open } = await windowPair(AMO_FORM, "agent");
    const fake = fakeKeys(
      {
        items: [],
        windows: [win],
        needed: [
          needed({
            integrationId: "amo",
            integrationName: "amoCRM",
            name: "amo_key",
            secretRef: "secret://amo_key",
            hosts: ["your-account.amocrm.ru"],
            account: { label_ru: "Адрес аккаунта amoCRM", suffixes: ["amocrm.ru", "amocrm.com"] },
          }),
        ],
      },
      win,
    );
    await mount(fake.client);
    expect(q("key-needed-item")?.querySelector("p")?.textContent).toBe(
      "«amoCRM» — ключ уйдёт только на ваш аккаунт (*.amocrm.ru, *.amocrm.com) · попросил агент сборки",
    );
    await click(q("key-needed-enter"));
    expect(q("key-window-who")?.textContent).toBe("Агент сборки просит ключ");
    expect(q("key-hosts")).toBeNull();
    expect(q("key-hosts-account")?.textContent).toContain("*.amocrm.ru");
    expect(q<HTMLInputElement>("key-field-account")?.type).toBe("text");
    expect(q<HTMLInputElement>("key-field-token")?.type).toBe("password");
    type(q<HTMLInputElement>("key-field-account"), "https://mycompany.amocrm.ru/leads");
    expect(q("key-hosts")?.textContent).toBe("mycompany.amocrm.ru");
    type(q<HTMLInputElement>("key-field-token"), "not-a-token");
    await act(async () => q<HTMLInputElement>("key-field-token")?.form?.requestSubmit());
    expect(q("key-error")?.textContent).toBe(
      "Долгосрочный токен amoCRM — длинная строка из трёх частей через точку",
    );
    expect(fake.submitted).toHaveLength(0);
    const token = `${KEY}.abc.def`;
    type(q<HTMLInputElement>("key-field-token"), token);
    await act(async () => q<HTMLInputElement>("key-field-token")?.form?.requestSubmit());
    await until(() => fake.submitted.length > 0);
    expect(fake.submitted).toHaveLength(1);
    const plain = JSON.parse(await open(fake.submitted[0] as SealedSecret)) as {
      fields: Record<string, string>;
    };
    expect(plain.fields.account).toBe("https://mycompany.amocrm.ru/leads");
    expect(plain.fields.token === token).toBe(true);
    expect(leaks()).toBe(false);
  });

  test("a viewer sees the request but cannot enter a key; saved keys show as one line with their last 4", async () => {
    const { win } = await windowPair(null, "agent");
    const fake = fakeKeys(
      {
        items: [
          {
            name: "pay_key",
            secretRef: "secret://pay_key",
            env: "draft",
            integrationId: "pay",
            integrationName: "Оплата",
            hosts: ["api.pay.ru"],
            last4: "wxyz",
            version: 2,
            status: "ok",
            check: { code: "OK", message_ru: null, checkedAt: null },
            rotatedAt: "2026-10-09T09:00:00Z",
            createdAt: "2026-10-09T08:00:00Z",
          },
        ],
        windows: [win],
        needed: [needed()],
      },
      win,
    );
    await mount(fake.client, { editable: false });
    expect(q("key-needed")).not.toBeNull();
    expect(q("key-needed-enter")).toBeNull();
    expect(q("key-row")?.textContent).toContain("Оплата: ••••wxyz · проверен");
    await click(q("key-needed-later"));
    expect(q("key-needed")).toBeNull();
  });
});
