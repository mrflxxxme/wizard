// M1-02 test kit: memory mailer, cookie sessions (dev-login or OTP), api.yaml response validation by operationId.
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import formatsCjs from "ajv-formats";
import { expect } from "vitest";
import type { Mailer, MailMessage } from "../src/auth/mailer.js";
import { loadYaml, type Res, type TestApi } from "./helpers.js";

export const ORIGIN = "http://localhost:5173";

export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  async send(m: MailMessage): Promise<void> {
    this.sent.push(m);
  }
  last(to: string, kind: MailMessage["kind"]): MailMessage | undefined {
    return this.sent.filter((m) => m.to === to && m.kind === kind).at(-1);
  }
  code(to: string): string {
    const m = /(\d{6})/.exec(this.last(to, "otp")?.text ?? "");
    if (!m) throw new Error(`no OTP letter to ${to}`);
    return m[1] as string;
  }
  inviteToken(to: string): string {
    const m = /\/invite\/([A-Za-z0-9_-]+)/.exec(this.last(to, "invite")?.text ?? "");
    if (!m) throw new Error(`no invite letter to ${to}`);
    return m[1] as string;
  }
}

/** Set-Cookie values of a response → name/value pairs (Max-Age=0 removes). */
export function setCookies(res: Res): { raw: string[]; jar: Record<string, string> } {
  const raw = res.headers.getSetCookie();
  const jar: Record<string, string> = {};
  for (const v of raw) {
    const [pair] = v.split(";");
    const i = (pair as string).indexOf("=");
    jar[(pair as string).slice(0, i)] = (pair as string).slice(i + 1);
  }
  return { raw, jar };
}

export interface Session {
  email: string;
  userId: string;
  cookies: Record<string, string>;
  csrf: string;
  req: TestApi["req"];
}

/** Client with the session cookies, Origin and X-Wizard-CSRF on every request (as platform-web sends them). */
export function asSession(api: TestApi, res: Res, email: string): Session {
  const { jar } = setCookies(res);
  const csrfName = Object.keys(jar).find((k) => k.endsWith("wizard_csrf")) as string;
  const cookies = { ...jar };
  const header = () =>
    Object.entries(cookies)
      .filter(([, v]) => v !== "")
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  return {
    email,
    userId: res.body.user.id,
    cookies,
    csrf: jar[csrfName] as string,
    req: (m, p, i = {}) =>
      api.req(m, p, {
        ...i,
        headers: { cookie: header(), origin: ORIGIN, "x-wizard-csrf": jar[csrfName] as string, ...i.headers },
      }),
  };
}

export async function devLogin(api: TestApi, email: string): Promise<Session> {
  const res = await api.req("POST", "/auth/dev-login", { body: { email }, headers: { origin: ORIGIN } });
  expect(res.status).toBe(200);
  return asSession(api, res, email);
}

export async function otpLogin(api: TestApi, mailer: MemoryMailer, email: string): Promise<Session> {
  const h = { origin: ORIGIN };
  expect((await api.req("POST", "/auth/otp/request", { body: { email }, headers: h })).status).toBe(204);
  const res = await api.req("POST", "/auth/otp/verify", {
    body: { email, code: mailer.code(email), acceptOffer: true, pdConsent: true },
    headers: h,
  });
  expect(res.status).toBe(200);
  return asSession(api, res, email);
}

// biome-ignore lint/suspicious/noExplicitAny: OpenAPI document
type Json = Record<string, any>;
const doc = loadYaml("specs/platform/api.yaml") as Json;
const ajv = new Ajv2020({ strict: false, allErrors: true });
formatsCjs.default(ajv);
ajv.addSchema({ $id: "api", components: doc.components });
const rewrite = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(rewrite)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v).map(([k, x]) => [
            k,
            k === "$ref" && typeof x === "string" ? `api${x}` : rewrite(x),
          ]),
        )
      : v;
const ops = new Map<string, Json>();
for (const item of Object.values(doc.paths as Json))
  for (const op of Object.values(item as Json)) if (op?.operationId) ops.set(op.operationId, op);
const cache = new Map<string, ValidateFunction>();
const xHttpStatus = doc.components.schemas.Error.properties.code["x-http-status"] as Record<string, number>;

function compiled(key: string, schema: unknown): ValidateFunction {
  let v = cache.get(key);
  if (!v) {
    v = ajv.compile(rewrite(schema) as Json);
    cache.set(key, v);
  }
  return v;
}

/** Asserts the response matches api.yaml for the operation (Error schema + x-http-status for ≥ 400). */
export function expectContract(opId: string, res: Res): void {
  const op = ops.get(opId);
  if (!op) throw new Error(`unknown operation ${opId}`);
  if (res.status >= 400) {
    const v = compiled("Error", { $ref: "#/components/schemas/Error" });
    expect(v(res.body), ajv.errorsText(v.errors)).toBe(true);
    expect(xHttpStatus[res.body.code]).toBe(res.status);
    return;
  }
  const resp = op.responses[String(res.status)];
  expect(resp, `${opId}: undocumented ${res.status}`).toBeDefined();
  const schema = resp.content?.["application/json"]?.schema;
  if (!schema) return;
  const v = compiled(`${opId}:${res.status}`, schema);
  expect(v(res.body), `${opId}: ${ajv.errorsText(v.errors)}`).toBe(true);
}
