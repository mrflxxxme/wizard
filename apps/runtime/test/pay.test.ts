// M0-24: POST /api/pay/:integration (M0 stub) and the draft mock payment page /_wizard/pay-mock
// (connectors/yookassa.yaml#runtime_endpoint, connector-interface.md §2 «M0»).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SYSTEM_SUBJECT } from "../src/index.js";
import { login, request, seedRow, seedUser, userIdOf } from "./helpers.js";
import { type PreviewFixture, previewFixture } from "./preview-helpers.js";

let fx: PreviewFixture;
let schema: string;
let cookie: string;
const HOST = "forumpay--draft.localhost:4100";

async function ticket(holder: string, status = "pending_payment", amount = 1500): Promise<string> {
  const sys = await fx.rt.systems.resolve("forumpay", "draft");
  if (!sys) throw new Error("system not loaded");
  const stream = await seedRow(fx.sql, schema, sys.spec, "stream");
  const type = await seedRow(fx.sql, schema, sys.spec, "ticket_type");
  return sys.data.transaction("default", SYSTEM_SUBJECT, (tx) =>
    tx.system.insert("ticket", {
      ticket_type: type,
      stream,
      holder_user: holder,
      holder_name: "Мария",
      holder_email: `m${randomUUID().slice(0, 8)}@example.ru`,
      status,
      amount,
      event_starts_at: "2026-11-01T09:00:00.000Z",
    }),
  );
}

const pay = (body: unknown, integration = "yookassa") =>
  fx.rt.fetch(request("POST", HOST, `/api/pay/${integration}`, { cookie, body }));
const confirm = (body: unknown) => fx.rt.fetch(request("POST", HOST, "/_wizard/pay-mock", { cookie, body }));
const statusOf = async (id: string) =>
  String((await fx.sql.unsafe(`select status from "${schema}"."ticket" where id = $1`, [id]))[0]?.status);

beforeAll(async () => {
  fx = await previewFixture();
  const entry = await fx.publish({ slug: "forumpay", env: "draft", revision: 1, migrate: true });
  schema = `app_${entry.systemId}_draft`;
  cookie = await login(fx.rt, HOST, "participant");
}, 60_000);
afterAll(() => fx?.close());

describe("draft payment flow", () => {
  test("/api/pay → mock page → confirm: ticket paid, payment succeeded, return route", async () => {
    const me = await userIdOf(fx.sql, schema, "participant");
    const id = await ticket(me);
    const res = await pay({ binding: "ticket", id, amount: 1 });
    expect(res.status).toBe(200);
    const { confirmationUrl } = (await res.json()) as { confirmationUrl: string };
    expect(confirmationUrl).toBe(`/_wizard/pay-mock?binding=ticket&id=${id}`);
    // Pending payment younger than 30 minutes with the same amount is reused.
    expect(
      ((await (await pay({ binding: "ticket", id })).json()) as { confirmationUrl: string }).confirmationUrl,
    ).toBe(confirmationUrl);
    expect(
      await fx.sql.unsafe(`select count(*)::int as n from "${schema}"."payment" where ticket = $1`, [id]),
    ).toEqual([{ n: 1 }]);

    const page = await fx.rt.fetch(request("GET", HOST, confirmationUrl, { cookie }));
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    const html = await page.text();
    expect(html).toContain("Тестовая оплата");
    expect(html).toMatch(/1\s500,00\s₽/);
    expect(html).toContain('<script src="/_wizard/pay-mock.js" defer></script>');
    expect((await fx.rt.fetch(request("GET", HOST, "/_wizard/pay-mock.js"))).status).toBe(200);

    const ok = await confirm({ binding: "ticket", id });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ result: "applied", returnUrl: `/ticket/${id}` });
    expect(await statusOf(id)).toBe("paid");
    const payments = await fx.sql.unsafe(`select status, kind from "${schema}"."payment" where ticket = $1`, [
      id,
    ]);
    expect(payments).toEqual([{ status: "succeeded", kind: "payment" }]);
    const kv = await fx.sql.unsafe(
      `select count(*)::int as n from "${schema}"."_w_connector_calls" where idempotency_key like 'kv:yookassa:pay:%'`,
    );
    expect(kv[0]?.n).toBeGreaterThanOrEqual(1);

    // Nothing pending any more; the paid ticket is not payable.
    expect((await confirm({ binding: "ticket", id })).status).toBe(404);
    const again = await pay({ binding: "ticket", id });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe("NOT_PAYABLE");
  });

  test("return check (V3-23): draft mock payments are left to the mock page; another's record → 404", async () => {
    const check = (body: unknown) =>
      fx.rt.fetch(request("POST", HOST, "/api/pay/yookassa/check", { cookie, body }));
    const me = await userIdOf(fx.sql, schema, "participant");
    const id = await ticket(me);
    expect(await (await check({ binding: "ticket", id })).json()).toEqual({ result: "none" });
    expect((await pay({ binding: "ticket", id })).status).toBe(200);
    const res = await check({ binding: "ticket", id });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ result: "none" });
    expect(await statusOf(id)).toBe("pending_payment");
    const other = await seedUser(fx.sql, schema, "participant");
    expect((await check({ binding: "ticket", id: await ticket(other) })).status).toBe(404);
    expect((await check({ binding: "nope", id })).status).toBe(404);
  });

  test("records the caller cannot read → 404 on /api/pay, the page and the confirmation", async () => {
    const other = await seedUser(fx.sql, schema, "participant");
    const id = await ticket(other);
    expect((await pay({ binding: "ticket", id })).status).toBe(404);
    const page = await fx.rt.fetch(
      request("GET", HOST, `/_wizard/pay-mock?binding=ticket&id=${id}`, { cookie }),
    );
    expect(page.status).toBe(404);
    expect((await confirm({ binding: "ticket", id })).status).toBe(404);
    expect(await statusOf(id)).toBe("pending_payment");
  });

  test("zero amount → 409 NOTHING_TO_PAY; unknown integration or binding → 404; CSRF enforced", async () => {
    const me = await userIdOf(fx.sql, schema, "participant");
    const zero = await ticket(me, "pending_payment", 0);
    const res = await pay({ binding: "ticket", id: zero });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("NOTHING_TO_PAY");
    expect((await pay({ binding: "ticket", id: zero }, "qr")).status).toBe(404);
    expect((await pay({ binding: "nope", id: zero })).status).toBe(404);
    const noCsrf = await fx.rt.fetch(
      request("POST", HOST, "/_wizard/pay-mock", {
        cookie,
        body: { binding: "ticket", id: zero },
        csrf: false,
      }),
    );
    expect(noCsrf.status).toBe(403);
  });
});
