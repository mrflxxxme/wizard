#!/usr/bin/env node
// Generates packages/gates/test/fixtures/<checkId>/{pass,fail}*.json (gates.yaml#report.rules, backlog M0-10).
// Every case is a delta over the forum baseline: specs/appspec/examples/forum.json + specs/runtime/examples.
//   spec:     [{op: "set"|"push"|"remove", path: JSON Pointer, value?}] applied to forum.json
//   files:    {path: source | null | {prefix, repeat, count, suffix}} over the example sources (null deletes)
//   prevSpec: null | "forum" | patch list over forum.json
//   expect:   "pass" | "fail" | "warn" for the check; `match` — substring of a failing entry's message/evidence
// Run: node packages/gates/scripts/gen-fixtures.mjs   (test/fixtures.test.ts checks the output is fresh)
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../test/fixtures");

const PAGE = (body, imports = 'import { AppShell } from "@wizard/ui-kit";') =>
  `${imports}\n\nexport default function Evil() {\n${body}\n  return <AppShell title="Проверка">Текст</AppShell>;\n}\n`;
const UI = (body) => ({ "ui/Evil.tsx": PAGE(body) });
const FN = (body) => ({
  "functions/lib/evil.ts": `import type { QueryCtx } from "@wizard/sdk";\n\nexport async function evil(ctx: QueryCtx) {\n${body}\n  return ctx.now;\n}\n`,
});
const QUERY = (handlerBody, args = "{}") =>
  `import { query, v } from "@wizard/sdk";\n\nexport default query({\n  args: ${args},\n  handler: async (ctx) => {\n${handlerBody}\n  },\n});\n`;

const fileField = { name: "photo", label: "Фото", type: "file" };

/** @type {Record<string, Record<string, object>>} */
const CASES = {
  "G0-SPEC-01": {
    pass: { description: "forum.json проходит ajv и zod" },
    "fail-unknown-key": {
      description: "лишнее свойство верхнего уровня",
      spec: [{ op: "set", path: "/extra", value: true }],
      match: "extra",
    },
    "fail-spec-version": {
      description: 'specVersion не "1"',
      spec: [{ op: "set", path: "/specVersion", value: "2" }],
    },
  },
  "G0-SPEC-02": {
    pass: { description: "forum.json семантически корректна, интеграции проходят validateSpec коннекторов" },
    "fail-unknown-role": {
      description: "право ссылается на несуществующую роль",
      spec: [{ op: "push", path: "/permissions", value: { role: "ghost", entity: "stream", ops: ["read"] } }],
      match: "UNKNOWN_ROLE",
    },
    "fail-connector-config": {
      description: "привязка yookassa ссылается на несуществующее поле",
      spec: [{ op: "set", path: "/integrations/0/config/bindings/0/amountField", value: "no_such_field" }],
      match: "CONFIG_INVALID",
    },
    "fail-index-fields": {
      description: "индекс из 33 полей: Postgres допускает не больше 32 (54011)",
      spec: [
        {
          op: "push",
          path: "/entities",
          value: {
            name: "wide",
            label: "Широкая",
            fields: Array.from({ length: 33 }, (_, i) => ({
              name: `c${i}`,
              label: `Колонка ${i}`,
              type: "int",
            })),
            indexes: [{ fields: Array.from({ length: 33 }, (_, i) => `c${i}`) }],
          },
        },
        { op: "push", path: "/permissions", value: { role: "organizer", entity: "wide", ops: ["read"] } },
      ],
      match: "LIMIT_EXCEEDED",
    },
  },
  "G0-SPEC-03": {
    pass: {
      description: "страница экспортирует компонент через const + export default",
      files: {
        "ui/Scanner.tsx":
          'import { AppShell, QrScanner } from "@wizard/ui-kit";\n\nconst Scanner = () => (\n  <AppShell title="Сканер билетов">\n    <QrScanner integration="qr" />\n  </AppShell>\n);\n\nexport default Scanner;\n',
      },
    },
    "fail-missing-page": {
      description: "файла страницы нет",
      files: { "ui/Scanner.tsx": null },
      match: "ui/Scanner.tsx",
    },
    "fail-missing-function": {
      description: "файла функции нет",
      files: { "functions/partnerQuota.ts": null },
      match: "partnerQuota",
    },
    "fail-no-default-export": {
      description: "страница без default export",
      files: {
        "ui/Scanner.tsx":
          'import { AppShell } from "@wizard/ui-kit";\n\nexport function Scanner() {\n  return <AppShell title="Сканер">Нет</AppShell>;\n}\n',
      },
      match: "по умолчанию",
    },
  },
  "G0-SPEC-04": {
    pass: {
      description: "общий компонент импортируется страницей",
      files: {
        "ui/components/Hint.tsx": "export function Hint() {\n  return <p>Подсказка</p>;\n}\n",
        "ui/Scanner.tsx":
          'import { AppShell, QrScanner } from "@wizard/ui-kit";\nimport { Hint } from "./components/Hint";\n\nexport default function Scanner() {\n  return (\n    <AppShell title="Сканер билетов">\n      <Hint />\n      <QrScanner integration="qr" />\n    </AppShell>\n  );\n}\n',
      },
    },
    "warn-orphan": {
      expect: "warn",
      description: "файл-сирота в ui/components",
      files: {
        "ui/components/Unused.tsx": "export function Unused() {\n  return <p>Не используется</p>;\n}\n",
      },
      match: "ui/components/Unused.tsx",
    },
  },
  "G0-SPEC-05": {
    pass: { description: "роли speaker/participant с selfSignup: запись и ПДн только через rowFilter" },
    "fail-reserved-login": {
      description: "страница на зарезервированном маршруте /login",
      spec: [{ op: "set", path: "/pages/2/route", value: "/login" }],
      match: "RESERVED_NAME",
    },
    "fail-reserved-policy": {
      description: "страница на маршруте compliance.policyPage",
      spec: [{ op: "set", path: "/pages/3/route", value: "/privacy" }],
      match: "RESERVED_NAME",
    },
    "fail-self-signup-write": {
      description: "selfSignup-роль может менять чужие записи (update без rowFilter)",
      spec: [{ op: "set", path: "/permissions/20/ops", value: ["read", "update"] }],
      match: "SELF_SIGNUP_UNSAFE",
    },
    "fail-self-signup-pii": {
      description: "selfSignup-роль читает ПДн без rowFilter",
      spec: [{ op: "remove", path: "/permissions/21/rowFilter" }],
      match: "SELF_SIGNUP_UNSAFE",
    },
    "fail-unreachable-entity": {
      description: "сущность без прав у всех ролей",
      spec: [
        {
          op: "push",
          path: "/entities",
          value: { name: "note", label: "Заметка", fields: [{ name: "text", label: "Текст", type: "text" }] },
        },
      ],
      match: "недоступна",
    },
  },
  "G0-SPEC-06": {
    pass: {
      description: "поле file пишет только isAdmin-роль (organizer)",
      spec: [{ op: "push", path: "/entities/0/fields", value: fileField }],
    },
    "pass-m2": {
      description: "с M2 загрузка есть — правило не действует",
      milestone: "M2",
      spec: [{ op: "push", path: "/entities/3/fields", value: fileField }],
    },
    fail: {
      description: "поле file в заявке спикера, которую спикер создаёт сам",
      spec: [{ op: "push", path: "/entities/3/fields", value: fileField }],
      match: "FILE_FIELD_UNSUPPORTED",
    },
  },
  "G0-MIG-01": {
    pass: {
      description: "prod: аддитивное добавление поля",
      env: "prod",
      prevSpec: "forum",
      spec: [
        { op: "push", path: "/entities/0/fields", value: { name: "hall", label: "Зал", type: "string" } },
      ],
    },
    "pass-draft-destructive": {
      description: "draft: удаление поля допустимо",
      prevSpec: "forum",
      spec: [{ op: "remove", path: "/entities/0/fields/2" }],
    },
    fail: {
      description: "prod: удаление поля → DESTRUCTIVE_IN_PROD",
      env: "prod",
      prevSpec: "forum",
      spec: [{ op: "remove", path: "/entities/0/fields/2" }],
      match: "DESTRUCTIVE_IN_PROD",
    },
  },
  "G0-MIG-02": {
    pass: { description: "DDL+RLS форума применяются к теневой схеме", prevSpec: "forum" },
    fail: {
      // appspec rejects every spec-level cause it knows (e.g. > 32 index fields); the DB side can still fail.
      description: "у роли мигратора нет права CREATE в базе: DDL не применяется (42501)",
      dbRole: "no_create",
      match: "42501",
    },
  },
  "G0-IDX-01": {
    pass: {
      description: "list с where по индексу и limit 1000; paginate по 200",
      files: {
        "functions/ticketAvailability.ts": QUERY(
          "    const a = await ctx.db.ticket_type.list({ where: { active: true }, limit: 1000 });\n    const b = await ctx.db.session.paginate({ where: { stream: a[0]?.id as never } }, { cursor: null, numItems: 200 });\n    return a.length + b.items.length;",
        ),
      },
    },
    "fail-limit-no-where": {
      description: "list без where с limit 500",
      files: { "functions/partnerQuota.ts": QUERY("    return ctx.db.partner_quota.list({ limit: 500 });") },
      match: "не больше 100",
    },
    "fail-limit-with-where": {
      description: "list с where и limit 5000",
      files: {
        "functions/ticketAvailability.ts": QUERY(
          "    return ctx.db.ticket_type.list({ where: { active: true }, limit: 5000 });",
        ),
      },
      match: "не больше 1000",
    },
    "fail-paginate": {
      description: "paginate с numItems 500",
      files: {
        "functions/ticketAvailability.ts": QUERY(
          "    return ctx.db.session.paginate({}, { cursor: null, numItems: 500 });",
        ),
      },
      match: "не больше 200",
    },
    "fail-where-not-indexed": {
      description: "where по полю без индекса (ловит tsc через IndexWhere)",
      files: {
        "functions/partnerQuota.ts": QUERY(
          '    return ctx.db.partner_quota.list({ where: { company: "x" }, limit: 10 });',
        ),
      },
      match: "where",
    },
  },
  "G0-FN-01": {
    pass: { description: "функции форума: default export нужного вида, аргументы через v.*" },
    "fail-kind": {
      description: "в спеке mutation, в коде query",
      spec: [{ op: "set", path: "/functions/1/kind", value: "mutation" }],
      match: "mutation",
    },
    "fail-no-validator": {
      description: "аргумент без валидатора v.*",
      files: {
        "functions/partnerQuota.ts": QUERY(
          "    return args;",
          '{ company: { type: "string" } as never }',
        ).replace("async (ctx)", "async (_ctx, args)"),
      },
      match: "без валидатора",
    },
    "fail-no-define": {
      description: "default export — обычная функция",
      files: {
        "functions/partnerQuota.ts": "export default async function partnerQuota() {\n  return [];\n}\n",
      },
      match: "не экспортирует",
    },
    "fail-undeclared": {
      description: "функция в коде, которой нет в спеке",
      files: { "functions/extra.ts": QUERY("    return 1;") },
      match: "нет в описании",
    },
  },
  "G0-TS-01": {
    pass: { description: "примеры форума компилируются против sdk.d.ts, ui-kit и generateTypes(forum)" },
    "fail-unknown-field": {
      description: "обращение к несуществующему полю сущности",
      files: {
        "functions/partnerQuota.ts": QUERY(
          "    const q = await ctx.db.partner_quota.list({ limit: 10 });\n    return q.map((x) => x.no_such_field);",
        ),
      },
      match: "TS2339",
    },
    "fail-ui-prop": {
      description: "неизвестный проп компонента ui-kit",
      files: {
        "ui/Scanner.tsx":
          'import { AppShell, QrScanner } from "@wizard/ui-kit";\n\nexport default function Scanner() {\n  return (\n    <AppShell title="Сканер" bogus={1}>\n      <QrScanner integration="qr" />\n    </AppShell>\n  );\n}\n',
      },
      match: "ui/Scanner.tsx",
    },
    "fail-unknown-function": {
      description: "useQuery по имени несуществующей функции",
      files: UI('  const q = useQuery("noSuchFunction", {});\n  void q;'),
      patchImports: true,
      match: "noSuchFunction",
    },
  },
  "G0-BUILD-01": {
    pass: { description: "форум собирается через @wizard/build" },
    fail: {
      description: "синтаксическая ошибка в JSX (AST-проверки проходят, esbuild — нет)",
      files: {
        "ui/Scanner.tsx":
          'import { AppShell } from "@wizard/ui-kit";\n\nexport default function Scanner() {\n  return <AppShell title="Сканер">;\n}\n',
      },
      match: "не собирается",
    },
  },
  "G0-IMP-01": {
    pass: {
      description: "только @wizard/sdk, @wizard/ui-kit и относительные импорты внутри своей области",
      files: {
        "ui/components/Hint.tsx":
          'import { useState } from "@wizard/sdk";\n\nexport function Hint() {\n  const [n] = useState(1);\n  return <p>Подсказка {n}</p>;\n}\n',
        "ui/Evil.tsx": PAGE(
          "",
          'import { AppShell } from "@wizard/ui-kit";\nimport { Hint } from "./components/Hint";\nexport { Hint };',
        ),
      },
    },
    "fail-node-fs": {
      description: "functions импортирует node:fs",
      files: {
        "functions/lib/evil.ts":
          'import { readFileSync } from "node:fs";\n\nexport const x = readFileSync;\n',
      },
      match: "node:fs",
    },
    "fail-ui-kit-in-functions": {
      description: "functions импортирует @wizard/ui-kit",
      files: {
        "functions/lib/evil.ts": 'import { Button } from "@wizard/ui-kit";\n\nexport const x = Button;\n',
      },
      match: "@wizard/ui-kit",
    },
    "fail-ui-imports-function": {
      description: "ui импортирует functions/** напрямую",
      files: {
        "ui/Evil.tsx": PAGE(
          "",
          'import { AppShell } from "@wizard/ui-kit";\nimport fn from "../functions/partnerQuota";\nvoid fn;',
        ),
      },
      match: "напрямую",
    },
    "fail-env-raw": {
      description: "escape import_env_raw: import k from '../../../.env?raw'",
      files: {
        "ui/Evil.tsx": PAGE(
          "  void k;",
          'import { AppShell } from "@wizard/ui-kit";\nimport k from "../../../.env?raw";',
        ),
      },
      match: "?raw",
    },
    "fail-path-escape": {
      description: "escape build_path_escape: абсолютный путь",
      files: { "functions/lib/evil.ts": 'import x from "/etc/passwd";\n\nexport const y = x;\n' },
      match: "/etc/passwd",
    },
    "fail-reference": {
      description: "/// <reference path> на файл хоста",
      files: { "functions/lib/evil.ts": '/// <reference path="../../../.env" />\nexport const y = 1;\n' },
      match: "reference",
    },
    "fail-react": {
      description: "прямой импорт react",
      files: {
        "ui/Evil.tsx": PAGE(
          "",
          'import { AppShell } from "@wizard/ui-kit";\nimport { useState } from "react";\nvoid useState;',
        ),
      },
      match: "react",
    },
    "fail-attributes": {
      description: "импорт с атрибутами",
      files: {
        "ui/Evil.tsx": PAGE(
          "",
          'import { AppShell } from "@wizard/ui-kit";\nimport data from "./data.json" with { type: "json" };\nvoid data;',
        ),
      },
      match: "атрибут",
    },
  },
  "G0-SEC-01": {
    pass: {
      description: "похожие, но разрешённые конструкции",
      files: {
        ...UI(
          [
            "  const top = 1;",
            "  const rect = { top: 2, parent: 3 };",
            '  document.title = "Форум " + String(top + rect.top + rect.parent);',
            "  const tid = setTimeout(() => {}, 10);",
            "  clearTimeout(tid);",
            '  const key = "title";',
            "  const obj: Record<string, number> = { a: 1 };",
            "  void obj[key];",
            '  void document["title"];',
            '  if (Math.random() > 2) window.open("/ticket/1");',
          ].join("\n"),
        ),
        ...FN(
          '  ctx.log.info("ok", { n: 1 });\n  const items = await ctx.db.stream.list({ limit: 10 });\n  void items;',
        ),
      },
    },
    ...Object.fromEntries(
      [
        ["eval", UI('  eval("1+1");'), "eval"],
        ["new-function", UI('  new Function("return 1");'), "Function"],
        ["dynamic-import", UI('  void import("@wizard/sdk");'), "import()"],
        ["require", FN('  require("fs");'), "require"],
        ["process", FN("  void process.env;"), "process"],
        ["fetch", UI('  void fetch("https://example.com");'), "fetch"],
        ["websocket", UI('  new WebSocket("wss://example.com");'), "WebSocket"],
        ["with", FN("  // @ts-ignore\n  with (ctx) { void now; }"), "with"],
        ["proto", UI("  const o: Record<string, unknown> = {};\n  void o.__proto__;"), "__proto__"],
        [
          "constructor-chain",
          FN(
            '  void (ctx as never as { constructor: { constructor: (s: string) => unknown } }).constructor.constructor("return 1");',
          ),
          "constructor.constructor",
        ],
        ["string-timeout", UI('  setTimeout("alert(1)", 10);'), "setTimeout"],
        ["global-computed", UI('  void (globalThis as never)["ev" + "al"];'), "globalThis[…]"],
        [
          "document-computed",
          UI('  const k = "coo" + "kie";\n  void document[k as "title"];'),
          "document[…]",
        ],
        [
          "navigator-computed",
          UI('  const k = "send" + "Beacon";\n  void navigator[k as "language"];'),
          "navigator[…]",
        ],
        ["location-computed", UI('  const k = "hr" + "ef";\n  void location[k as "href"];'), "location[…]"],
        ["window-computed", UI('  const k = "op" + "en";\n  void window[k as "name"];'), "window[…]"],
        ["reflect", UI('  void Reflect.get(document, "cookie");'), "Reflect"],
        ["reflect-computed", UI('  const k = "get";\n  void (Reflect as never)[k];'), "Reflect[…]"],
        [
          "get-own-property-descriptor",
          UI('  void Object.getOwnPropertyDescriptor(Document.prototype, "cookie");'),
          "getOwnPropertyDescriptor",
        ],
        ["parent", UI("  void parent;"), "parent"],
        ["top", UI("  void top;"), "top"],
        ["opener", UI("  void window.opener;"), "opener"],
        ["post-message", UI('  window.postMessage("x", "*");'), "postMessage"],
        ["window-name", UI("  void window.name;"), "window.name"],
        ["fn-globalthis", FN("  void globalThis.Math;"), "globalThis"],
        ["fn-console", FN('  console.log("x");'), "console"],
        [
          "fn-sql",
          FN('  await ctx.db.stream.list({ where: "SELECT * FROM platform.users" as never });'),
          "SQL",
        ],
        ["fn-hook", FN("  useState(1);"), "useState"],
        [
          "ui-dangerous-html",
          UI('  void <div dangerouslySetInnerHTML={{ __html: "<b>x</b>" }} />;'),
          "dangerouslySetInnerHTML",
        ],
        ["ui-inner-html", UI('  document.body.innerHTML = "x";'), "innerHTML"],
        ["ui-document-write", UI('  document.write("x");'), "document.write"],
        ["ui-cookie", UI("  void document.cookie;"), "document.cookie"],
        ["ui-send-beacon", UI('  navigator.sendBeacon("/x");'), "sendBeacon"],
        ["ui-storage-pii", UI('  localStorage.setItem("holder_email", "x");'), "localStorage"],
        ["ui-window-open", UI('  window.open("https://evil.example");'), "window.open"],
        ["ui-form-action", UI('  void <form action="https://evil.example" />;'), "action"],
        ["ui-script", UI("  void <script />;"), "<script>"],
        ["ui-iframe", UI('  void <iframe src="/x" />;'), "<iframe>"],
        [
          "ui-define-query",
          {
            "ui/Evil.tsx": PAGE(
              "  void query({ args: {}, handler: async () => 1 });",
              'import { query } from "@wizard/sdk";\nimport { AppShell } from "@wizard/ui-kit";',
            ),
          },
          "query",
        ],
        [
          "fn-size",
          {
            "functions/lib/evil.ts": {
              prefix: 'export const big = "',
              repeat: "x",
              count: 205 * 1024,
              suffix: '";\n',
            },
          },
          "200 КБ",
        ],
      ].map(([name, files, match]) => [`fail-${name}`, { description: `запрещено: ${name}`, files, match }]),
    ),
  },
};

export function fixtureCases() {
  const out = [];
  for (const [check, cases] of Object.entries(CASES)) {
    for (const [name, c] of Object.entries(cases)) {
      const expect =
        c.expect ?? (name.startsWith("fail") ? "fail" : name.startsWith("warn") ? "warn" : "pass");
      const { patchImports, ...rest } = c;
      const files = rest.files ? { ...rest.files } : undefined;
      if (patchImports && files) {
        for (const k of Object.keys(files)) {
          if (files[k]) files[k] = `import { useQuery } from "@wizard/sdk";\n${files[k]}`;
        }
      }
      out.push({ check, name, case: { check, expect, ...rest, ...(files ? { files } : {}) } });
    }
  }
  return out;
}

export function writeFixtures(dir = FIXTURES_DIR) {
  // G2 fixtures live next to these (scripts/gen-g2-fixtures.mjs): only G0 folders are regenerated here.
  mkdirSync(dir, { recursive: true });
  for (const d of readdirSync(dir).filter((x) => x.startsWith("G0-")))
    rmSync(join(dir, d), { recursive: true, force: true });
  for (const { check, name, case: c } of fixtureCases()) {
    mkdirSync(join(dir, check), { recursive: true });
    writeFileSync(join(dir, check, `${name}.json`), `${JSON.stringify(c, null, 2)}\n`);
  }
  return readdirSync(dir).filter((x) => x.startsWith("G0-"));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dirs = writeFixtures();
  console.log(`fixtures: ${dirs.length} checks → ${FIXTURES_DIR}`);
}
