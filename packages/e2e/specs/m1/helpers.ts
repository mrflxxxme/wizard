// Helpers of the M1 specs (stand/m1.ts): sessions through dev-login, the platform API with CSRF, the mail outbox,
// and a built «форум» (scripted builder) to publish from.
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type BrowserContext, expect } from "@playwright/test";
import { M1, M1_OUTBOX } from "../../stand/ports.js";

export const WEB = `http://localhost:${M1.web}`;

export const uniqueEmail = (who: string) => `${who}-${randomBytes(4).toString("hex")}@example.test`;

// biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field in the specs
export type Json = any;

export interface Api {
  req(method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }>;
}

/** The platform API as the browser context sees it: session cookie, X-Wizard-CSRF and Origin (api.yaml x-auth M1). */
export function api(ctx: BrowserContext): Api {
  return {
    async req(method, path, body) {
      const cookies = await ctx.cookies(WEB);
      const csrf = cookies.find((c) => c.name === "wizard_csrf")?.value;
      const res = await ctx.request.fetch(`${WEB}/api/v1${path}`, {
        method,
        headers: {
          Origin: WEB,
          ...(csrf && method !== "GET" ? { "X-Wizard-CSRF": csrf } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { data: JSON.stringify(body) }),
      });
      const text = await res.text();
      return { status: res.status(), body: text.startsWith("{") ? JSON.parse(text) : text };
    },
  };
}

/** A session for `email` in this context without OTP (POST /auth/dev-login, the stand enables WIZARD_DEV_LOGIN). */
export async function devLogin(ctx: BrowserContext, email: string): Promise<Api> {
  const res = await ctx.request.post(`${WEB}/api/v1/auth/dev-login`, {
    headers: { Origin: WEB, "content-type": "application/json" },
    data: JSON.stringify({ email }),
  });
  expect(res.status(), await res.text()).toBe(200);
  return api(ctx);
}

/** Letters of the stand's OutboxMailer to `to`, oldest first. */
export function letters(to: string): { kind: string; to: string; subject: string; text: string }[] {
  let names: string[] = [];
  try {
    names = readdirSync(M1_OUTBOX).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  return names
    .sort()
    .map((n) => JSON.parse(readFileSync(join(M1_OUTBOX, n), "utf8")))
    .filter((l) => l.to === to);
}

export async function lastLetter(to: string, kind: "otp" | "invite"): Promise<string> {
  let text = "";
  await expect
    .poll(() => {
      text =
        letters(to)
          .filter((l) => l.kind === kind)
          .at(-1)?.text ?? "";
      return text;
    })
    .not.toBe("");
  return text;
}

export async function waitRun(a: Api, id: string, ms = 120_000): Promise<Json> {
  const until = Date.now() + ms;
  for (;;) {
    const r = await a.req("GET", `/runs/${id}`);
    if (["succeeded", "failed", "cancelled"].includes(r.body.status)) return r.body;
    if (Date.now() > until) throw new Error(`run ${id} timeout`);
    await new Promise((res) => setTimeout(res, 200));
  }
}

/** The owner's personal org (first membership) with a known region, so ruOnly is a free choice (not t1Restricted). */
export async function ownerOrg(a: Api): Promise<string> {
  const me = await a.req("GET", "/me");
  const org = me.body.memberships.find((m: { role: string }) => m.role === "owner");
  expect(org).toBeTruthy();
  const patched = await a.req("PATCH", `/orgs/${org.orgId}`, { regionCode: "77" });
  expect(patched.status, JSON.stringify(patched.body)).toBe(200);
  return org.orgId;
}

/** «Форум» through the API: card → build (scripted, real G0) → stage ready. */
export async function builtForum(a: Api, orgId: string): Promise<Json> {
  const created = await a.req("POST", "/systems", {
    prompt: "Регистрация на форум «Северный ритейл»",
    orgId,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.system.id;
  await waitRun(a, created.body.run.id);
  const s = await a.req("GET", `/systems/${id}`);
  const ap = await a.req("POST", `/systems/${id}/card/approve`, { cardVersion: s.body.card.cardVersion });
  expect(ap.status, JSON.stringify(ap.body)).toBe(202);
  const run = await waitRun(a, ap.body.run.id);
  expect(run.status, JSON.stringify(run.failure)).toBe("succeeded");
  return (await a.req("GET", `/systems/${id}`)).body.system;
}

/** Operator of personal data (publish precondition) through PUT /compliance; returns the new draft revision. */
export async function setOperator(a: Api, system: Json): Promise<number> {
  const put = await a.req("PUT", `/systems/${system.id}/compliance`, {
    expectedVersion: system.draftRevision,
    operatorName: "ООО «Северный ритейл»",
    operatorContact: "privacy@north-retail.example",
    operatorAddress: "г. Москва, ул. Тверская, д. 1",
  });
  expect(put.status, JSON.stringify(put.body)).toBe(200);
  return put.body.revision.version;
}

export async function publishApi(a: Api, systemId: string, revision: number): Promise<Json> {
  const res = await a.req("POST", `/systems/${systemId}/publish`, { revision, confirmDiff: true });
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  const run = await waitRun(a, res.body.run.id);
  expect(run.status, JSON.stringify(run.failure)).toBe("succeeded");
  return run;
}
