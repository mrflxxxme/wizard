// Local YooKassa API v3 stub (yookassa.yaml#test_mode.mocks): /v3/payments, /v3/refunds, /v3/receipts over real
// HTTP on 127.0.0.1 with Basic auth, Idempotence-Key semantics, scripted failures and a notification generator.
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

export interface YookassaCall {
  method: string;
  path: string;
  idempotenceKey: string | null;
  body: Record<string, unknown> | null;
  status: number;
}

export interface MockAmount {
  value: string;
  currency: string;
}

export interface MockPayment {
  id: string;
  status: "pending" | "waiting_for_capture" | "succeeded" | "canceled";
  paid: boolean;
  amount: MockAmount;
  description?: string;
  metadata: Record<string, string>;
  confirmation: { type: "redirect"; return_url: string; confirmation_url: string };
  created_at: string;
  captured_at?: string;
  test: true;
  refunded_amount?: MockAmount;
}

export interface MockRefund {
  id: string;
  payment_id: string;
  status: "pending" | "succeeded" | "canceled";
  amount: MockAmount;
  created_at: string;
  description?: string;
}

export interface ScriptedFailure {
  status: number;
  body?: Record<string, unknown>;
}

const kop = (v: unknown) => Math.round(Number(v) * 100);
const err = (status: number, code: string, description: string) => ({
  status,
  body: { type: "error", id: randomUUID(), code, description },
});

export class YookassaMock {
  readonly calls: YookassaCall[] = [];
  readonly payments = new Map<string, MockPayment>();
  readonly refunds = new Map<string, MockRefund>();
  /** Body of every created payment/refund receipt and of POST /receipts, by object id. */
  readonly receipts = new Map<string, unknown>();
  readonly closingReceipts: Record<string, unknown>[] = [];
  /** Failures returned (in order) before normal handling; each consumes one request. */
  readonly queue: ScriptedFailure[] = [];
  /** Status of newly created refunds. */
  refundStatus: MockRefund["status"] = "succeeded";
  private readonly idem = new Map<string, { hash: string; status: number; body: unknown }>();
  private server: Server;
  /** Origin of the stub (http://127.0.0.1:<port>); the API base is `${origin}/v3`. */
  origin = "";

  constructor(
    readonly shopId = "100500",
    readonly secretKey = "test_mockSecretKey0123456789",
  ) {
    this.server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => {
        raw += c.toString();
      });
      req.on("end", () => {
        let body: Record<string, unknown> | null = null;
        try {
          body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
        } catch {
          body = null;
        }
        const key = (req.headers["idempotence-key"] as string | undefined) ?? null;
        const out = this.handle(
          req.method ?? "GET",
          req.url ?? "/",
          req.headers.authorization,
          key,
          body,
          raw,
        );
        this.calls.push({
          method: req.method ?? "GET",
          path: req.url ?? "/",
          idempotenceKey: key,
          body,
          status: out.status,
        });
        res.writeHead(out.status, { "content-type": "application/json" });
        res.end(JSON.stringify(out.body));
      });
    });
  }

  get apiBase(): string {
    return `${this.origin}/v3`;
  }

  async start(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    const addr = this.server.address();
    this.origin = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  /** The buyer paid on the YooKassa page. */
  succeed(id: string): MockPayment {
    const p = this.must(id);
    p.status = "succeeded";
    p.paid = true;
    p.captured_at = new Date().toISOString();
    return p;
  }

  /** The buyer left or the payment expired. */
  cancel(id: string): MockPayment {
    const p = this.must(id);
    p.status = "canceled";
    return p;
  }

  setStatus(id: string, status: MockPayment["status"]): MockPayment {
    const p = this.must(id);
    p.status = status;
    return p;
  }

  /** Body of an HTTP notification as YooKassa sends it (the object as currently stored, or overridden). */
  notification(event: string, id: string, object?: Record<string, unknown>): Record<string, unknown> {
    const current = event.startsWith("refund.") ? this.refunds.get(id) : this.payments.get(id);
    return { type: "notification", event, object: { ...(current ?? { id }), ...object } };
  }

  /** Calls to one path prefix (e.g. "/v3/payments"). */
  callsTo(method: string, prefix: string): YookassaCall[] {
    return this.calls.filter((c) => c.method === method && c.path.startsWith(prefix));
  }

  private must(id: string): MockPayment {
    const p = this.payments.get(id);
    if (!p) throw new Error(`no mock payment ${id}`);
    return p;
  }

  private handle(
    method: string,
    url: string,
    auth: string | undefined,
    key: string | null,
    body: Record<string, unknown> | null,
    raw: string,
  ): { status: number; body: unknown } {
    const scripted = this.queue.shift();
    if (scripted)
      return { status: scripted.status, body: scripted.body ?? err(scripted.status, "x", "x").body };
    const expected = `Basic ${Buffer.from(`${this.shopId}:${this.secretKey}`).toString("base64")}`;
    if (auth !== expected) return err(401, "invalid_credentials", "Login or password is incorrect");
    const path = url.replace(/\?.*$/, "");
    if (method === "POST") {
      if (!key || key.length > 64) return err(400, "invalid_request", "Idempotence-Key header is required");
      const hash = createHash("sha256").update(`${path}\n${raw}`).digest("hex");
      const seen = this.idem.get(key);
      if (seen) {
        return seen.hash === hash
          ? { status: seen.status, body: seen.body }
          : err(400, "invalid_request", "Idempotence key duplicated with another request");
      }
      const out = this.post(path, body ?? {});
      if (out.status < 500) this.idem.set(key, { hash, status: out.status, body: out.body });
      return out;
    }
    if (method === "GET") {
      let m = /^\/v3\/payments\/([^/]+)$/.exec(path);
      if (m) {
        const p = this.payments.get(m[1] as string);
        return p ? { status: 200, body: p } : err(404, "not_found", "Payment not found");
      }
      m = /^\/v3\/refunds\/([^/]+)$/.exec(path);
      if (m) {
        const r = this.refunds.get(m[1] as string);
        return r ? { status: 200, body: r } : err(404, "not_found", "Refund not found");
      }
    }
    return err(404, "not_found", "Unknown endpoint");
  }

  private post(path: string, body: Record<string, unknown>): { status: number; body: unknown } {
    const now = new Date().toISOString();
    if (path === "/v3/payments") {
      const amount = body.amount as MockAmount | undefined;
      const confirmation = body.confirmation as { type?: string; return_url?: string } | undefined;
      if (!amount || !/^\d+\.\d{2}$/.test(String(amount.value)) || amount.currency !== "RUB") {
        return err(400, "invalid_request", "Invalid amount");
      }
      if (confirmation?.type !== "redirect" || typeof confirmation.return_url !== "string") {
        return err(400, "invalid_request", "Invalid confirmation");
      }
      const id = randomUUID();
      const p: MockPayment = {
        id,
        status: "pending",
        paid: false,
        amount,
        ...(typeof body.description === "string" ? { description: body.description } : {}),
        metadata: (body.metadata as Record<string, string>) ?? {},
        confirmation: {
          type: "redirect",
          return_url: confirmation.return_url,
          confirmation_url: `${this.origin}/checkout/payments/${id}`,
        },
        created_at: now,
        test: true,
      };
      this.payments.set(id, p);
      if (body.receipt) this.receipts.set(id, body.receipt);
      return { status: 200, body: p };
    }
    const cancel = /^\/v3\/payments\/([^/]+)\/cancel$/.exec(path);
    if (cancel) {
      const p = this.payments.get(cancel[1] as string);
      if (!p) return err(404, "not_found", "Payment not found");
      if (p.status !== "pending" && p.status !== "waiting_for_capture") {
        return err(400, "invalid_request", "Payment can not be canceled");
      }
      p.status = "canceled";
      return { status: 200, body: p };
    }
    if (path === "/v3/refunds") {
      const p = this.payments.get(String(body.payment_id));
      const amount = body.amount as MockAmount | undefined;
      if (!p) return err(404, "not_found", "Payment not found");
      if (p.status !== "succeeded") return err(400, "invalid_request", "Payment is not succeeded");
      if (amount?.currency !== "RUB" || kop(amount.value) <= 0) {
        return err(400, "invalid_request", "Invalid amount");
      }
      const refunded = kop(p.refunded_amount?.value ?? 0);
      if (refunded + kop(amount.value) > kop(p.amount.value)) {
        return err(400, "invalid_request", "Refund amount exceeds payment amount");
      }
      p.refunded_amount = { value: ((refunded + kop(amount.value)) / 100).toFixed(2), currency: "RUB" };
      const r: MockRefund = {
        id: randomUUID(),
        payment_id: p.id,
        status: this.refundStatus,
        amount,
        created_at: now,
        ...(typeof body.description === "string" ? { description: body.description } : {}),
      };
      this.refunds.set(r.id, r);
      if (body.receipt) this.receipts.set(r.id, body.receipt);
      return { status: 200, body: r };
    }
    if (path === "/v3/receipts") {
      if (!this.payments.has(String(body.payment_id))) return err(404, "not_found", "Payment not found");
      this.closingReceipts.push(body);
      return {
        status: 200,
        body: { id: randomUUID(), type: body.type, payment_id: body.payment_id, status: "pending" },
      };
    }
    return err(404, "not_found", "Unknown endpoint");
  }
}
