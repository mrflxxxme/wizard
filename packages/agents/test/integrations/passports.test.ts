// V3-22 acceptance: every passport is a valid `wizard.integration/1` contract with documented operations, answers from
// the documentation that pass its own schemas, a safe GET check and Russian notes («уточнить при проверке ключом»);
// contract tests and the key check pass on the deterministic mock; the generated client of all six passports passes
// G0 in both modes with egress exactly the passport's host; the brief → contract path finds a passport by name
// (Russian and English) or link without a model; the key window composes keys; webhooks are trusted only by the rules.
import { type AppSpec, emptySpec, systemBriefSchema } from "@wizard/appspec";
import { checkCode } from "@wizard/gates";
import { describe, expect, test } from "vitest";
import {
  buildRequest,
  checkContractKey,
  contractHash,
  findPassport,
  type IntegrationContract,
  integrationCode,
  integrationEgressIssues,
  integrationLayer,
  mockTransport,
  PASSPORT_IDS,
  PASSPORTS,
  passportById,
  passportContract,
  passportForIntegration,
  passportKey,
  passportOfContract,
  passportTokenRequest,
  passportTokenValue,
  passportWebhook,
  runContractTests,
  sampleInput,
  validateValue,
} from "../../src/integrations/index.js";

const ACCOUNTS = {
  amocrm: { host: "mycompany.amocrm.ru" },
  bitrix24: { host: "mycompany.bitrix24.ru", user: "7" },
} as const;
const contractOf = (id: string): IntegrationContract => {
  const p = passportById(id);
  if (!p) throw new Error(id);
  return passportContract(p, { account: ACCOUNTS[id as keyof typeof ACCOUNTS] ?? null });
};

describe("passports are reviewed contracts", () => {
  test("six passports, ids and names as in D77_v3 (15)", () => {
    expect(PASSPORTS.map((p) => p.id)).toEqual([...PASSPORT_IDS]);
    expect(PASSPORTS.map((p) => p.name).join(", ")).toBe(
      "ЮKassa, СДЭК, Telegram Bot API, amoCRM, Битрикс24, МойСклад",
    );
  });

  test.each(PASSPORT_IDS)("%s: valid contract, documented operations, safe check, Russian notes", (id) => {
    const p = passportById(id);
    if (!p) throw new Error(id);
    const c = contractOf(id);
    expect(c.source).toMatchObject({ kind: "passport", url: p.docsUrl, version: p.reviewed });
    expect(c.hosts).toEqual([new URL(c.baseUrl).hostname]);
    expect(c.auth.secret).toBe(`secret://${id}_key`);
    expect(c.operations.length).toBe(p.operations.length);
    const check = c.operations.find((o) => o.id === c.check?.operation);
    expect(check?.method).toBe("GET");
    for (const op of c.operations) {
      expect(p.docs[op.id], `${id}.${op.id} docs`).toMatch(/^https:\/\//);
      expect(validateValue(op.response.schema, op.response.example), `${id}.${op.id} answer`).toEqual([]);
      if (op.body?.schema.example !== undefined)
        expect(validateValue(op.body.schema, op.body.schema.example), `${id}.${op.id} body`).toEqual([]);
      for (const prm of op.params)
        if (prm.schema.example !== undefined)
          expect(validateValue(prm.schema, prm.schema.example), `${id}.${op.id}.${prm.name}`).toEqual([]);
    }
    // Every check param has a documented example: the key check sends realistic values, never random filler.
    for (const prm of check?.params ?? [])
      expect(prm.schema.example, `${id} check ${prm.name}`).toBeDefined();
    expect(Object.keys(p.docs).sort()).toEqual(p.operations.map((o) => o.id).sort());
    expect(c.notes.length).toBeLessThanOrEqual(20);
    expect(c.notes.filter((n) => n.startsWith("Уточнить при проверке ключом")).length).toBe(
      p.verify_ru.length,
    );
    expect(c.notes.join("\n")).toContain(p.limits_ru);
    expect(c.mapping.length).toBeGreaterThan(0);
    expect(c.mapping.every((m) => m.by === "name" && c.operations.some((o) => o.id === m.operation))).toBe(
      true,
    );
    expect(p.key.fields.length).toBeGreaterThan(0);
    expect(p.key.fields.every((f) => /[а-я]/i.test(f.label_ru) && f.hint_ru.length > 10)).toBe(true);
    expect(passportOfContract(c)).toBe(p);
    expect(contractHash(contractOf(id))).toBe(contractHash(c));
  });

  test.each(PASSPORT_IDS)(
    "%s: contract tests and the key check pass on the deterministic mock",
    async (id) => {
      const c = contractOf(id);
      const report = await runContractTests(c, mockTransport(c));
      expect(report.results.filter((r) => !r.ok)).toEqual([]);
      expect(report.ok).toBe(true);
      const check = await checkContractKey(c, mockTransport(c));
      expect(check).toMatchObject({ ok: true, verified: true, code: "OK" });
      // The mock serves the documentation's answers.
      const op = c.operations[1] ?? c.operations[0];
      if (!op) throw new Error(id);
      const r = await mockTransport(c)(buildRequest(c, op.id, sampleInput(c, op)));
      expect(JSON.parse(r.text || "null")).toEqual(op.response.example);
    },
  );
});

describe("hosts and keys (D37)", () => {
  test("egress is exactly the passport's host: fixed API, the owner's account, the test environment", () => {
    expect(contractOf("yookassa").hosts).toEqual(["api.yookassa.ru"]);
    expect(contractOf("telegram").hosts).toEqual(["api.telegram.org"]);
    expect(contractOf("moysklad").hosts).toEqual(["api.moysklad.ru"]);
    expect(contractOf("cdek").hosts).toEqual(["api.cdek.ru"]);
    const cdek = passportById("cdek");
    if (!cdek) throw new Error("cdek");
    const sandbox = passportContract(cdek, { sandbox: true });
    expect(sandbox.hosts).toEqual(["api.edu.cdek.ru"]);
    expect(sandbox.baseUrl).toBe("https://api.edu.cdek.ru/v2");
    expect(contractOf("amocrm")).toMatchObject({
      hosts: ["mycompany.amocrm.ru"],
      baseUrl: "https://mycompany.amocrm.ru/api/v4",
    });
    expect(contractOf("bitrix24")).toMatchObject({
      hosts: ["mycompany.bitrix24.ru"],
      baseUrl: "https://mycompany.bitrix24.ru/rest/7",
    });
    const amo = passportById("amocrm");
    if (!amo) throw new Error("amocrm");
    const placeholder = passportContract(amo);
    expect(placeholder.hosts).toEqual(["your-account.amocrm.ru"]);
    expect(placeholder.notes.join("\n")).toMatch(/заглушка your-account\.amocrm\.ru/);
  });

  test("the key goes where the API wants it: Basic header, Bearer, the path segment", () => {
    const yk = buildRequest(contractOf("yookassa"), "getShop", {});
    expect(yk.headers.Authorization).toBe("secret://yookassa_key");
    const tg = buildRequest(contractOf("telegram"), "getMe", {});
    expect(tg.url).toBe("https://api.telegram.org/botsecret://telegram_key/getMe");
    const b24 = buildRequest(contractOf("bitrix24"), "getLead", { id: 5 });
    expect(b24.url).toBe("https://mycompany.bitrix24.ru/rest/7/secret://bitrix24_key/crm.lead.get.json?id=5");
    const ms = buildRequest(contractOf("moysklad"), "listOrganizations", { limit: 1 });
    expect(ms.headers.Authorization).toBe("Bearer secret://moysklad_key");
  });

  test("the mock refuses a path-key request without the key segment", async () => {
    const c = contractOf("telegram");
    const r = await mockTransport(c)({ method: "GET", url: "https://api.telegram.org/getMe", headers: {} });
    expect(r.status).toBe(401);
  });
});

const baseSpec = (): AppSpec =>
  ({
    ...emptySpec("Магазин"),
    roles: [{ name: "owner", label: "Владелец", access: "login", isAdmin: true }],
  }) as AppSpec;

describe("generated client of the six passports", () => {
  const contracts = PASSPORT_IDS.map(contractOf);
  const systemOf = (mode: "mock" | "live") => {
    const files: Record<string, string> = {};
    const functions: NonNullable<AppSpec["functions"]> = [];
    for (const c of contracts) {
      const code = integrationCode(c, mode, `contract://${c.id}@1#${contractHash(c).slice(0, 12)}`);
      expect(code.skipped, c.id).toEqual([]);
      Object.assign(files, code.files);
      functions.push(...code.functions);
    }
    return { spec: { ...baseSpec(), functions } as AppSpec, files: new Map(Object.entries(files)) };
  };

  test("mock mode: G0 passes, no network code, no egress, no key", async () => {
    const { spec, files } = systemOf("mock");
    expect([...files.values()].join("\n")).not.toMatch(/http\.fetch|secret:\/\//);
    expect(spec.functions?.every((f) => f.egress === undefined && f.secretRefs === undefined)).toBe(true);
    expect(await checkCode({ spec, files })).toEqual([]);
  }, 120_000);

  test("live mode: G0 passes; each function reaches exactly its passport's host with its key", async () => {
    const { spec, files } = systemOf("live");
    expect(await checkCode({ spec, files })).toEqual([]);
    expect(integrationEgressIssues(spec, contracts)).toEqual([]);
    for (const c of contracts) {
      const fns = (spec.functions ?? []).filter((f) => f.file.startsWith(`functions/integrations/${c.id}/`));
      expect(fns.length).toBe(c.operations.length);
      for (const f of fns) {
        expect(f.egress).toEqual(c.hosts);
        expect(f.secretRefs).toEqual([c.auth.secret]);
      }
    }
    const auth = ["$", "{AUTH}"].join("");
    const tg = files.get("functions/integrations/telegram/client.ts");
    expect(tg).toContain('const AUTH = "secret://telegram_key";');
    expect(tg).toContain(`\`https://api.telegram.org/bot${auth}/sendMessage\``);
    expect(files.get("functions/integrations/bitrix24/client.ts")).toContain(
      `\`https://mycompany.bitrix24.ru/rest/7/${auth}/crm.lead.add.json\``,
    );
    // A path key stands once, in the AUTH constant, away from the URLs (G2-SECRET-01 reads a secret:// reference next
    // to a long host with digits as a secret).
    for (const id of ["telegram", "bitrix24"]) {
      const lines = (files.get(`functions/integrations/${id}/client.ts`) ?? "").split("\n");
      expect(lines.filter((l) => /["`/]secret:\/\/[a-z]/.test(l))).toEqual([
        `const AUTH = "secret://${id}_key";`,
      ]);
    }
    expect(files.get("functions/integrations/yookassa/client.ts")).toContain(
      '"Idempotence-Key": text(input.idempotenceKey)',
    );
  }, 120_000);
});

describe("brief → contract picks a passport without a model", () => {
  test.each([
    ["Оплата через ЮKassa", "yookassa"],
    ["ЮКасса", "yookassa"],
    ["YooKassa payments", "yookassa"],
    ["Яндекс Касса", "yookassa"],
    ["Доставка СДЭК", "cdek"],
    ["CDEK delivery", "cdek"],
    ["Telegram-бот для записи", "telegram"],
    ["Уведомления в Телеграм", "telegram"],
    ["Заявки в amoCRM", "amocrm"],
    ["АмоСРМ", "amocrm"],
    ["amo CRM", "amocrm"],
    ["Битрикс24", "bitrix24"],
    ["Битрикс 24: сделки", "bitrix24"],
    ["Bitrix24 CRM", "bitrix24"],
    ["Остатки из МойСклад", "moysklad"],
    ["Мой склад", "moysklad"],
    ["MoySklad stock", "moysklad"],
  ])("%s → %s", (name, id) => {
    expect(findPassport(name)?.id).toBe(id);
    expect(passportForIntegration({ name })?.passport.id).toBe(id);
  });

  test("unknown, ambiguous and look-alike names give no passport; the need is the fallback", () => {
    expect(findPassport("Партнёрская CRM")).toBeNull();
    expect(findPassport("ЮKassa и СДЭК")).toBeNull();
    expect(findPassport("Клуб24")).toBeNull();
    expect(findPassport("1С-Битрикс: управление сайтом")).toBeNull();
    expect(passportForIntegration({ name: "Оплата", need: "платежи через ЮKassa" })?.passport.id).toBe(
      "yookassa",
    );
  });

  test("a link decides: provider domains pick the passport and the account; other links go to the documentation", () => {
    expect(
      passportForIntegration({ name: "CRM", url: "https://yookassa.ru/developers/api" })?.passport.id,
    ).toBe("yookassa");
    expect(
      passportForIntegration({ name: "x", url: "https://api-docs.cdek.ru/29923741.html" })?.passport.id,
    ).toBe("cdek");
    expect(
      passportForIntegration({ name: "CRM", url: "https://mycompany.amocrm.ru/leads/pipeline" }),
    ).toMatchObject({
      passport: { id: "amocrm" },
      account: { host: "mycompany.amocrm.ru" },
    });
    expect(
      passportForIntegration({ name: "CRM", url: "https://www.amocrm.ru/developers/content/crm_platform" }),
    ).toMatchObject({
      passport: { id: "amocrm" },
      account: null,
    });
    const b24 = passportForIntegration({
      name: "CRM",
      url: "https://mycompany.bitrix24.ru/rest/7/abcdef123456/",
    });
    expect(b24).toMatchObject({
      passport: { id: "bitrix24" },
      account: { host: "mycompany.bitrix24.ru", user: "7" },
    });
    const box = passportForIntegration({
      name: "CRM",
      url: "https://crm.example-company.ru/rest/1/abcdef123456/",
    });
    expect(box).toMatchObject({
      passport: { id: "bitrix24" },
      account: { host: "crm.example-company.ru", user: "1" },
    });
    expect(passportForIntegration({ name: "ЮKassa", url: "https://partner-crm.ru/docs" })).toBeNull();
  });

  test("the layer of a brief builds from passport contracts; the webhook code never reaches the contract", () => {
    const brief = systemBriefSchema.parse({
      integrations: [
        { id: "payments", name: "Оплата ЮKassa", direction: "out" },
        { id: "crm", name: "Битрикс24", direction: "out" },
      ],
    });
    const stored = brief.integrations.map((i, n) => {
      const found = passportForIntegration({
        name: i.name,
        ...(n === 1 ? { url: "https://mycompany.bitrix24.ru/rest/7/abcdef123456/" } : {}),
      });
      if (!found) throw new Error(i.name);
      const contract = passportContract(found.passport, { id: i.id, name: i.name, account: found.account });
      return { contract, version: 1, sha256: contractHash(contract), mode: "mock" as const };
    });
    expect(JSON.stringify(stored)).not.toContain("abcdef123456");
    expect(stored[0]?.contract.auth.secret).toBe("secret://payments_key");
    const layer = integrationLayer({ brief, contracts: stored });
    expect(layer.functions.map((f) => f.name)).toContain("paymentsCreatePayment");
    expect(layer.functions.map((f) => f.name)).toContain("crmAddLead");
    expect(layer.notes.join("\n")).not.toMatch(/нет контракта/);
  });

  test("brief data is mapped by code on top of the hints; operations can be narrowed, the check stays", () => {
    const p = passportById("cdek");
    if (!p) throw new Error("cdek");
    const c = passportContract(p, {
      data: [{ entity: "Заказ", fields: [{ name: "Комментарий" }] }],
      operations: ["calculateTariff", "POST /orders"],
    });
    expect(c.operations.map((o) => o.id)).toEqual(["listCities", "calculateTariff", "createOrder"]);
    expect(c.mapping).toContainEqual(
      expect.objectContaining({
        entity: "Заказ",
        field: "Комментарий",
        pointer: "/body/comment",
        by: "name",
      }),
    );
    expect(c.mapping.some((m) => m.operation === "getOrder")).toBe(false);
  });
});

describe("the key window: what the owner pastes", () => {
  const p = (id: string) => {
    const x = passportById(id);
    if (!x) throw new Error(id);
    return x;
  };

  test("ЮKassa: Basic shopId:secretKey, the test shop is marked; wrong shapes — Russian problems", () => {
    const r = passportKey(p("yookassa"), { shop_id: "100001", secret_key: "test_abcdefgh12345" });
    expect(r).toEqual({
      ok: true,
      value: `Basic ${Buffer.from("100001:test_abcdefgh12345").toString("base64")}`,
      account: null,
      test: true,
    });
    const bad = passportKey(p("yookassa"), { shop_id: "shop", secret_key: "" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.problems_ru.join("\n")).toMatch(/shopId.*\n.*Секретный ключ/s);
  });

  test("Telegram token, МойСклад token: the value as is", () => {
    const token = "123456:test-only-not-a-real-bot-token-0000";
    expect(passportKey(p("telegram"), { bot_token: token })).toMatchObject({ ok: true, value: token });
    expect(passportKey(p("telegram"), { bot_token: "123" })).toMatchObject({ ok: false });
    expect(passportKey(p("moysklad"), { token: "a".repeat(40) })).toMatchObject({
      ok: true,
      value: "a".repeat(40),
    });
  });

  test("amoCRM: the account address and the long-lived token", () => {
    const r = passportKey(p("amocrm"), {
      account: "https://MyCompany.amocrm.ru/leads",
      token: "aaa.bbb.ccc",
    });
    expect(r).toEqual({
      ok: true,
      value: "aaa.bbb.ccc",
      account: { host: "mycompany.amocrm.ru" },
      test: null,
    });
    expect(passportKey(p("amocrm"), { account: "mycompany", token: "aaa.bbb.ccc" })).toMatchObject({
      account: { host: "mycompany.amocrm.ru" },
    });
    expect(passportKey(p("amocrm"), { account: "www.amocrm.ru", token: "aaa.bbb.ccc" })).toMatchObject({
      ok: false,
    });
  });

  test("Битрикс24: the webhook URL gives the portal, the user and the secret code", () => {
    const r = passportKey(p("bitrix24"), {
      webhook_url: "https://mycompany.bitrix24.ru/rest/7/q8bzjAbc123/",
    });
    expect(r).toEqual({
      ok: true,
      value: "q8bzjAbc123",
      account: { host: "mycompany.bitrix24.ru", user: "7" },
      test: null,
    });
    expect(passportKey(p("bitrix24"), { webhook_url: "https://mycompany.bitrix24.ru/" })).toMatchObject({
      ok: false,
    });
  });

  test("СДЭК: OAuth client credentials — one oauth2cc: key; the token request in the form body", () => {
    const fields = { client_id: "clientid123", client_secret: "secret12345" };
    const key = passportKey(p("cdek"), fields);
    expect(key).toMatchObject({ ok: true, account: null, test: false });
    const decoded = key.ok
      ? JSON.parse(Buffer.from(key.value.slice("oauth2cc:".length), "base64url").toString("utf8"))
      : null;
    expect(decoded).toEqual({
      token_url: "https://api.cdek.ru/v2/oauth/token",
      client_id: "clientid123",
      client_secret: "secret12345",
    });
    expect(passportKey(p("cdek"), fields, { sandbox: true })).toMatchObject({ test: true });
    const req = passportTokenRequest(p("cdek"), fields, { sandbox: true });
    expect(req).toMatchObject({ method: "POST", url: "https://api.edu.cdek.ru/v2/oauth/token" });
    expect(req?.url).not.toContain("secret12345");
    expect(new URLSearchParams(req?.body).get("grant_type")).toBe("client_credentials");
    expect(passportTokenRequest(p("telegram"), {})).toBeNull();
    expect(
      passportTokenValue('{"access_token":"eyJhbGciOi.x.y","token_type":"bearer","expires_in":3599}'),
    ).toEqual({
      value: "eyJhbGciOi.x.y",
      expiresIn: 3599,
    });
    expect(passportTokenValue('{"error":"invalid_client"}')).toBeNull();
  });
});

describe("webhooks", () => {
  const p = (id: string) => {
    const x = passportById(id);
    if (!x) throw new Error(id);
    return x;
  };

  test("ЮKassa: no signature — the payment is re-read by getPayment", () => {
    const body = {
      type: "notification",
      event: "payment.succeeded",
      object: { id: "2d3fa9b1-000f-5000-8000-1c2b3a4d5e6f" },
    };
    expect(passportWebhook(p("yookassa"), { body: JSON.stringify(body) })).toEqual({
      ok: true,
      reason_ru: null,
      event: "payment.succeeded",
      refetch: { operation: "getPayment", input: { paymentId: "2d3fa9b1-000f-5000-8000-1c2b3a4d5e6f" } },
    });
    expect(passportWebhook(p("yookassa"), { body: { event: "x" } }).ok).toBe(false);
  });

  test("Telegram: the secret_token header must match", () => {
    const body = { update_id: 1, message: { message_id: 1 } };
    const headers = { "X-Telegram-Bot-Api-Secret-Token": "hook-secret" };
    expect(passportWebhook(p("telegram"), { body, headers, token: "hook-secret" })).toMatchObject({
      ok: true,
      event: "message",
    });
    expect(passportWebhook(p("telegram"), { body, headers, token: "other" })).toMatchObject({ ok: false });
    expect(passportWebhook(p("telegram"), { body, headers })).toMatchObject({ ok: false });
  });

  test("Битрикс24: application_token of the form, then the lead is re-read", () => {
    const form = "event=ONCRMLEADADD&data%5BFIELDS%5D%5BID%5D=1024&auth%5Bapplication_token%5D=apptoken";
    expect(passportWebhook(p("bitrix24"), { body: form, token: "apptoken" })).toMatchObject({
      ok: true,
      event: "ONCRMLEADADD",
      refetch: { operation: "getLead", input: { id: 1024 } },
    });
    expect(passportWebhook(p("bitrix24"), { body: form, token: "wrong" }).ok).toBe(false);
  });

  test("amoCRM, СДЭК, МойСклад: the object is re-read by its id", () => {
    expect(
      passportWebhook(p("amocrm"), {
        body: "leads%5Bstatus%5D%5B0%5D%5Bid%5D=3912171&account%5Bsubdomain%5D=mycompany",
      }),
    ).toMatchObject({
      ok: true,
      event: "leads.status",
      refetch: { operation: "getLead", input: { id: 3912171 } },
    });
    expect(
      passportWebhook(p("cdek"), {
        body: { type: "ORDER_STATUS", uuid: "72753031-0f6b-4a5c-8d2e-1b3c5d7e9f01" },
      }),
    ).toMatchObject({
      refetch: { operation: "getOrder", input: { uuid: "72753031-0f6b-4a5c-8d2e-1b3c5d7e9f01" } },
    });
    const ms = {
      events: [
        {
          meta: {
            type: "customerorder",
            href: "https://api.moysklad.ru/api/remap/1.2/entity/customerorder/36ac1a8c-6f2e-11ee-0a80-0d4e0012a3b5",
          },
          action: "UPDATE",
          accountId: "84e60e93-f504-11e5-8a84-bae500000008",
        },
      ],
    };
    expect(passportWebhook(p("moysklad"), { body: ms })).toMatchObject({
      event: "customerorder.UPDATE",
      refetch: { operation: "getCustomerOrder", input: { id: "36ac1a8c-6f2e-11ee-0a80-0d4e0012a3b5" } },
    });
  });
});
