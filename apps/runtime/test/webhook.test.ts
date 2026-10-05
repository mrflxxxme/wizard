// M2-53 (D71): incoming webhooks on their own route — secret address, HMAC over the raw body with a time window or a
// shared secret, replay protection, allowlisted fields, webhook-trigger workflows under __system, journal
// _w_webhook_events, size and rate limits, logs without body, signature or token.
import { createHmac, randomBytes } from "node:crypto";
import { type AppSpec, quoteIdent } from "@wizard/appspec";
import { staticSecretReader, webhookHookToken, webhookKeyFromEnv } from "@wizard/connectors";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type Harness, harness } from "./helpers.js";

const SECRET = "hook-secret-0123456789abcdef";
const TILDA = "tilda-shared-0123456789";

const spec = (): AppSpec =>
  ({
    specVersion: "1",
    app: { name: "Заявки с сайта", locale: "ru" },
    entities: [
      {
        name: "lead",
        label: "Заявка",
        fields: [
          {
            name: "name",
            label: "Имя",
            type: "string",
            required: true,
            maxLength: 120,
            pii: "basic",
            piiKind: "fio",
          },
          { name: "phone", label: "Телефон", type: "phone", pii: "basic", piiKind: "phone" },
          { name: "comment", label: "Комментарий", type: "text", maxLength: 2000 },
          {
            name: "status",
            label: "Статус",
            type: "enum",
            required: true,
            default: "new",
            enum: [
              { value: "new", label: "Новая" },
              { value: "paid", label: "Оплачена" },
            ],
          },
        ],
        retention: { deleteAfterDays: 365 },
      },
    ],
    roles: [
      { name: "owner", label: "Владелец", access: "login", isAdmin: true, loginMethods: ["email_otp"] },
      { name: "visitor", label: "Посетитель", access: "public" },
    ],
    permissions: [
      { role: "owner", entity: "lead", ops: ["read", "create", "update", "delete"] },
      { role: "visitor", entity: "lead", ops: ["create"] },
    ],
    workflows: [
      {
        name: "lead_from_site",
        trigger: { type: "webhook", integration: "site", entity: "lead" },
        steps: [{ type: "notify", params: { integration: "mail", to: "$owner", template: "lead_new" } }],
      },
    ],
    integrations: [
      {
        name: "site",
        connector: "webhook",
        config: {
          verify: "hmac",
          secret: "secret://webhook_site",
          header: "X-Signature",
          prefix: "sha256=",
          timestampHeader: "X-Timestamp",
          eventIdField: "id",
          entity: "lead",
          fields: { name: "contact.name", phone: "contact.phone", comment: "message" },
        },
        secretRefs: ["secret://webhook_site"],
      },
      {
        // Event id in an unsigned header (most CRMs): a replay may come with another id.
        name: "crm",
        connector: "webhook",
        config: {
          verify: "hmac",
          secret: "secret://webhook_crm",
          header: "X-Crm-Signature",
          eventIdHeader: "X-Event-Id",
          entity: "lead",
          fields: { name: "name", comment: "note" },
        },
        secretRefs: ["secret://webhook_crm"],
      },
      {
        name: "tilda",
        connector: "webhook",
        config: {
          verify: "shared_secret",
          secret: "secret://webhook_tilda",
          header: "X-Tilda-Token",
          entity: "lead",
          fields: { name: "Name", phone: "Phone", comment: "Comments" },
        },
        secretRefs: ["secret://webhook_tilda"],
      },
      {
        name: "mail",
        connector: "email",
        config: {
          templates: {
            lead_new: { subject: "Новая заявка с сайта", body: "{{name}}, {{phone}}: {{comment}}" },
          },
        },
      },
    ],
    compliance: {
      consentText: "Я соглашаюсь на обработку имени и телефона для ответа на заявку.",
      policyPage: "/privacy",
      operatorName: "ИП Пример",
      operatorContact: "owner@example.ru",
      operatorAddress: "г. Москва, ул. Примерная, 1",
    },
  }) as unknown as AppSpec;

let h: Harness;
let schema = "";
let key = "";
const slug = `hook${randomBytes(3).toString("hex")}`;
const HOST = `${slug}--draft.localhost:4100`;
const logs: Record<string, unknown>[] = [];

const token = (integration: string) =>
  webhookHookToken(webhookKeyFromEnv(), { systemId: key, env: "draft", integration });
const T = (t: string) => `${quoteIdent(schema)}.${quoteIdent(t)}`;
const leads = async () => h.sql.unsafe(`select * from ${T("lead")} order by created_at`);

function signed(body: unknown, o: { ts?: number; secret?: string } = {}) {
  const raw = JSON.stringify(body);
  const ts = String(o.ts ?? Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", o.secret ?? SECRET)
    .update(`${ts}.${raw}`)
    .digest("hex");
  return {
    raw,
    headers: { "x-timestamp": ts, "x-signature": `sha256=${sig}`, "content-type": "application/json" },
  };
}

/** Raw POST as a sending service makes it: no Origin, no X-Wizard-Request, its own Content-Type. */
const post = (path: string, raw: string, headers: Record<string, string>) =>
  h.rt.fetch(
    new Request(`http://127.0.0.1:4100${path}`, {
      method: "POST",
      headers: { host: HOST, ...headers },
      body: raw,
    }),
  );

beforeAll(async () => {
  h = await harness(
    {},
    {
      secrets: () => staticSecretReader({ webhook_site: SECRET, webhook_crm: SECRET, webhook_tilda: TILDA }),
      log: (l) => logs.push(l),
    },
  );
  ({ schema, key } = await h.system(slug, spec()));
});
afterAll(async () => {
  await h.close();
});

describe("hmac webhook", () => {
  test("a valid signature creates the record from allowlisted fields and queues the webhook workflow", async () => {
    const { raw, headers } = signed({
      id: "evt-1",
      contact: { name: "Анна", phone: "+79991234567" },
      message: "Перезвоните",
      status: "paid",
      created_by: "00000000-0000-0000-0000-000000000000",
    });
    const res = await post(`/_wizard/hooks/webhook/site/${token("site")}`, raw, headers);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const rows = await leads();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "Анна",
      phone: "+79991234567",
      comment: "Перезвоните",
      status: "new",
    });
    expect(rows[0]?.created_by).toBeNull();
    const ev = await h.sql.unsafe(
      `select integration, event_key, body_hash, status, record_id from ${T("_w_webhook_events")}`,
    );
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      integration: "site",
      event_key: "id:evt-1",
      status: "accepted",
      record_id: rows[0]?.id,
    });
    expect((ev[0]?.body_hash as Buffer | undefined)?.length).toBe(32);
    // The webhook workflow runs on the next pass: the owner gets the lead (outbox, draft).
    const before = h.rt.outbox().length;
    await h.rt.runJobs({ slug, env: "draft" });
    const sent = h.rt.outbox().slice(before);
    expect(
      sent.some(
        (m) => m.integration === "mail" && (m.payload as { recipient?: unknown }).recipient === "owner",
      ),
    ).toBe(true);
  });

  test("the same event again → 200 without a second record", async () => {
    const { raw, headers } = signed({ id: "evt-1", contact: { name: "Анна" } });
    const res = await post(`/_wizard/hooks/webhook/site/${token("site")}`, raw, headers);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, duplicate: true });
    expect(await leads()).toHaveLength(1);
  });

  test("wrong signature, wrong secret, old timestamp → 401 without a record", async () => {
    const path = `/_wizard/hooks/webhook/site/${token("site")}`;
    const good = signed({ id: "evt-2", contact: { name: "Борис" } });
    expect((await post(path, good.raw.replace("Борис", "Вадим"), good.headers)).status).toBe(401);
    const other = signed({ id: "evt-3", contact: { name: "Борис" } }, { secret: "another-secret" });
    expect((await post(path, other.raw, other.headers)).status).toBe(401);
    const old = signed(
      { id: "evt-4", contact: { name: "Борис" } },
      { ts: Math.floor(Date.now() / 1000) - 3600 },
    );
    expect((await post(path, old.raw, old.headers)).status).toBe(401);
    expect((await post(path, good.raw, { "content-type": "application/json" })).status).toBe(401);
    expect(await leads()).toHaveLength(1);
  });

  test("unknown token or integration → 404; body over 64 KiB → 413", async () => {
    const { raw, headers } = signed({ id: "evt-5", contact: { name: "Глеб" } });
    expect((await post(`/_wizard/hooks/webhook/site/${"A".repeat(43)}`, raw, headers)).status).toBe(404);
    expect((await post(`/_wizard/hooks/webhook/nope/${token("nope")}`, raw, headers)).status).toBe(404);
    expect((await post(`/_wizard/hooks/webhook/mail/${token("mail")}`, raw, headers)).status).toBe(404);
    const big = signed({ id: "evt-6", message: "x".repeat(70 * 1024) });
    expect((await post(`/_wizard/hooks/webhook/site/${token("site")}`, big.raw, big.headers)).status).toBe(
      413,
    );
  });
});

describe("hmac webhook with an unsigned event id header", () => {
  test("the same signed body with another X-Event-Id → duplicate, one record", async () => {
    const path = `/_wizard/hooks/webhook/crm/${token("crm")}`;
    const raw = JSON.stringify({ name: "Евгений", note: "Повтор" });
    const sig = createHmac("sha256", SECRET).update(raw).digest("hex");
    const headers = (id: string) => ({
      "content-type": "application/json",
      "x-crm-signature": sig,
      "x-event-id": id,
    });
    const before = (await leads()).length;
    const first = await post(path, raw, headers("crm-1"));
    expect(await first.json()).toEqual({ ok: true });
    const replay = await post(path, raw, headers("crm-2"));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ok: true, duplicate: true });
    expect(await leads()).toHaveLength(before + 1);
    // Another signed body is another event.
    const raw2 = JSON.stringify({ name: "Евгений", note: "Новая заявка" });
    const sig2 = createHmac("sha256", SECRET).update(raw2).digest("hex");
    const next = await post(path, raw2, { ...headers("crm-3"), "x-crm-signature": sig2 });
    expect(await next.json()).toEqual({ ok: true });
    expect(await leads()).toHaveLength(before + 2);
    const ev = await h.sql.unsafe(
      `select event_key, signed_body_hash from ${T("_w_webhook_events")} where integration = 'crm' order by id`,
    );
    expect(ev.map((r) => r.event_key)).toEqual(["id:crm-1", "id:crm-3"]);
    expect((ev[0]?.signed_body_hash as Buffer | undefined)?.length).toBe(32);
  });
});

describe("shared secret webhook (form-urlencoded, Tilda)", () => {
  test("the right header → record; a wrong one → 401; the body hash guards against replays", async () => {
    const path = `/_wizard/hooks/webhook/tilda/${token("tilda")}`;
    const form = new URLSearchParams({
      Name: "Дарья",
      Phone: "+79990001122",
      Comments: "Хочу на курс",
      formid: "f1",
    });
    const headers = { "content-type": "application/x-www-form-urlencoded", "x-tilda-token": TILDA };
    const before = (await leads()).length;
    expect((await post(path, form.toString(), headers)).status).toBe(200);
    expect((await post(path, form.toString(), { ...headers, "x-tilda-token": "wrong" })).status).toBe(401);
    const again = await post(path, form.toString(), headers);
    expect(await again.json()).toEqual({ ok: true, duplicate: true });
    const rows = await leads();
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)).toMatchObject({ name: "Дарья", comment: "Хочу на курс" });
  });

  test("more than 60 requests a minute → 429", async () => {
    const path = `/_wizard/hooks/webhook/tilda/${token("tilda")}`;
    const statuses: number[] = [];
    for (let i = 0; i < 62; i++)
      statuses.push(
        (await post(path, "Name=x", { "content-type": "application/x-www-form-urlencoded" })).status,
      );
    expect(statuses).toContain(429);
  });
});

test("logs carry neither the body, the signature nor the path token", () => {
  const text = JSON.stringify(logs);
  expect(text).not.toContain(token("site"));
  expect(text).not.toContain(token("tilda"));
  expect(text).not.toMatch(/sha256=|Анна|\+7999|Перезвоните|tilda-shared/);
  expect(text).toContain("webhook_rejected");
});
