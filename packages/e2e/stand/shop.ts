// Test shop of the M2 stand (M2-11): the platform's YooKassa shop (billing.yaml#recurring) on YookassaMock
// (@wizard/connectors/mocks, API v3 over HTTP) plus the page a buyer sees at confirmation_url. The page plays the
// YooKassa checkout: «Оплатить» (a RU card), «Оплатить зарубежной картой» (issuer_country ≠ RU → CARD_NOT_RU) or
// «Отказаться»; then it delivers the notification to the platform webhook like YooKassa would (the platform re-reads
// the payment with GET /v3/payments/{id}) and redirects to return_url (/billing?payment=<id>).
// Each card binding gets its own random last4: the platform lets one card into at most 3 organizations (L3-28).
import { randomInt } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { type MockPayment, YookassaMock } from "@wizard/connectors/mocks";

export interface Shop {
  mock: YookassaMock;
  /** API base for the platform config (yookassaApiBase). */
  apiBase: string;
  /** Origin of the checkout page. */
  origin: string;
  close(): Promise<void>;
}

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );

async function form(req: IncomingMessage): Promise<URLSearchParams> {
  let raw = "";
  for await (const chunk of req) raw += String(chunk);
  return new URLSearchParams(raw);
}

function page(p: MockPayment): string {
  const card = p.payment_method?.card;
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Тестовый магазин ЮKassa</title></head>
<body style="font-family: sans-serif; max-width: 480px; margin: 40px auto">
<h1>Тестовый магазин ЮKassa</h1>
<p data-testid="shop-description">${esc(p.description ?? "")}</p>
<p data-testid="shop-amount">${esc(p.amount.value)} ₽</p>
${card ? `<p data-testid="shop-card">Карта •• ${esc(card.last4)}</p>` : ""}
<form method="post" action="/checkout/payments/${esc(p.id)}/pay">
  <button name="card" value="ru" data-testid="shop-pay">Оплатить</button>
  <button name="card" value="foreign" data-testid="shop-pay-foreign">Оплатить зарубежной картой</button>
</form>
<form method="post" action="/checkout/payments/${esc(p.id)}/cancel">
  <button data-testid="shop-cancel">Отказаться от оплаты</button>
</form>
</body></html>`;
}

export async function startShop(o: { port: number; webhook: string }): Promise<Shop> {
  const mock = await new YookassaMock().start();
  const apiBase = mock.apiBase;
  const origin = `http://localhost:${o.port}`;
  // confirmation_url of new payments is `${mock.origin}/checkout/payments/<id>`: point it at this page.
  mock.origin = origin;
  const carded = new Set<string>();

  async function notify(event: string, id: string): Promise<void> {
    const res = await fetch(`${o.webhook}/api/v1/webhooks/yookassa`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(mock.notification(event, id)),
    });
    if (!res.ok) console.error(`[shop] webhook ${event} ${id}: ${res.status} ${await res.text()}`);
  }

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", origin);
      const m = /^\/checkout\/payments\/([0-9a-f-]{36})(?:\/(pay|cancel))?$/.exec(url.pathname);
      const p = m ? mock.payments.get(m[1] as string) : undefined;
      if (!m || !p) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Платёж не найден");
        return;
      }
      if (req.method === "GET" && !m[2]) {
        if (p.payment_method && !carded.has(p.id)) {
          carded.add(p.id);
          p.payment_method.card.last4 = String(randomInt(0, 10_000)).padStart(4, "0");
          p.payment_method.title = `Bank card *${p.payment_method.card.last4}`;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page(p));
        return;
      }
      if (req.method !== "POST" || p.status !== "pending") {
        res.writeHead(409, { "content-type": "text/plain; charset=utf-8" }).end("Платёж уже обработан");
        return;
      }
      if (m[2] === "pay") {
        const f = await form(req);
        if (f.get("card") === "foreign" && p.payment_method) p.payment_method.card.issuer_country = "DE";
        const paid = mock.pay(p.id);
        await notify(
          paid.status === "waiting_for_capture" ? "payment.waiting_for_capture" : "payment.succeeded",
          p.id,
        );
      } else {
        mock.cancel(p.id);
        await notify("payment.canceled", p.id);
      }
      res.writeHead(303, { location: p.confirmation.return_url }).end();
    })().catch((e) => {
      console.error("[shop]", e);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  await new Promise<void>((r) => server.listen(o.port, "127.0.0.1", r));
  return {
    mock,
    apiBase,
    origin,
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      await mock.stop();
    },
  };
}
