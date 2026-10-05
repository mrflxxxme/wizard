// M2-50 (D69, D71): notify recipients $owner / $role / visitor contact with consent, content rules, links, limits and
// the delivery journal — on the reference recipe specs/runtime/examples/booking-notify.json.
import { readFileSync } from "node:fs";
import { type AppSpec, validateSpec as validateAppSpec } from "@wizard/appspec";
import { describe, expect, test } from "vitest";
import {
  type MessageJournalEntry,
  runNotifyStep,
  UNSUBSCRIBE_FOOTER_RU,
  validateIntegrations,
} from "../src/index.js";
import { createTestCtx, MemoryStore, MemorySystemDb } from "../src/testing.js";
import type { Json } from "./helpers.js";

const SPEC_URL = new URL("../../../specs/runtime/examples/booking-notify.json", import.meta.url);
const booking = (): AppSpec => JSON.parse(readFileSync(SPEC_URL, "utf8")) as AppSpec;
const OWNER = "owner@example.ru";
const VISITOR = "visitor@example.ru";

const step = (spec: AppSpec, wf: string, i: number) =>
  ((spec.workflows ?? []).find((w) => w.name === wf)?.steps[i]?.params ?? {}) as Record<string, unknown>;

const record = (over: Record<string, unknown> = {}) => ({
  id: "b1",
  name: "Анна Петрова",
  phone: "+79991234567",
  email: VISITOR,
  service: "Стрижка",
  starts_at: "2026-10-07T10:00:00.000Z",
  status: "booked",
  consent_messages: false,
  ...over,
});

function ctxFor(spec: AppSpec, integration: "mail" | "tg", o: { env?: "draft" | "prod" } = {}) {
  const journal: MessageJournalEntry[] = [];
  const store = new MemoryStore();
  const base = createTestCtx({
    spec,
    integration,
    store,
    db: new MemorySystemDb(spec),
    contacts: {
      m1: { email: "master@example.ru", telegram_chat: "77" },
      o1: { email: OWNER, telegram_chat: "55" },
    },
    ...(o.env ? { env: o.env } : {}),
  });
  const ctx = {
    ...base,
    owners: async () => [OWNER],
    users: {
      ...base.users,
      byRole: async (role: string) => (role === "master" ? ["m1"] : []),
      byEmail: async (emails: readonly string[]) => (emails.includes(OWNER) ? ["o1"] : []),
    },
    messages: { write: async (e: MessageJournalEntry) => void journal.push(e) },
    messageLinks: {
      url: (a: { action: string; id: string }) =>
        `https://zapis.sandpile.ru/_wizard/hooks/message/${a.action}/tok-${a.id}`,
    },
  };
  return { ctx, journal, outbox: base.outbox };
}

describe("G0 of the recipe and the recipient rules", () => {
  test("booking-notify.json is a valid spec; its integrations pass validateSpec", () => {
    const spec = booking();
    const r = validateAppSpec(spec);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(validateIntegrations(spec)).toEqual([]);
  });

  test("visitor without consentField, Telegram to a visitor, unknown role → CONFIG_INVALID", () => {
    const spec = booking() as Json;
    delete spec.workflows[0].steps[2].params.consentField;
    spec.workflows[0].steps[1].params.to = ["$owner", "$record.email"];
    spec.workflows[0].steps[0].params.to = ["$owner", "$role:courier"];
    const rules = validateIntegrations(spec).map((i) => i.rule);
    expect(rules).toContain("notify.visitor_consent");
    expect(rules).toContain("telegram.notify_recipient");
    expect(rules).toContain("email.notify_recipient");
  });

  test("staff mail may carry the lead's data; a visitor gets only its own record; subject never", () => {
    const spec = booking() as Json;
    // Staff body with name and phone — allowed (D71); the same body to another user of the system — not.
    expect(validateIntegrations(spec)).toEqual([]);
    spec.entities[0].fields.push({
      name: "master_user",
      label: "Мастер",
      type: "ref",
      ref: { entity: "users" },
    });
    spec.workflows[0].steps[0].params.to = "$record.master_user";
    expect(validateIntegrations(spec).map((i) => i.rule)).toContain("email.body_pii_recipient");
    const s2 = booking() as Json;
    s2.integrations[0].config.templates.staff_new.subject = "Запись {{name}}";
    expect(validateIntegrations(s2).map((i) => i.rule)).toContain("email.subject_pii");
  });

  test("{{cancel_link}} needs cancel.set on non-PII fields of the record", () => {
    const spec = booking() as Json;
    delete spec.workflows[0].steps[2].params.cancel;
    expect(validateIntegrations(spec).map((i) => i.rule)).toContain("notify.cancel_link");
    const s2 = booking() as Json;
    s2.workflows[0].steps[2].params.cancel = { set: { phone: "" } };
    expect(validateIntegrations(s2).map((i) => i.rule)).toContain("notify.cancel_link");
  });
});

describe("runNotifyStep", () => {
  test("owner and masters get the lead by mail with its data in the body, no PII in the subject", async () => {
    const spec = booking();
    const { ctx, journal, outbox } = ctxFor(spec, "mail");
    const r = await runNotifyStep(ctx, {
      params: step(spec, "booking_new", 0),
      entity: "booking",
      record: record(),
      jobId: "j1",
      stepIndex: 0,
      workflow: "booking_new",
    });
    expect(r).toEqual({ sent: 2, skipped: 0 });
    const to = outbox.messages.map((m) => m.payload.to).sort();
    expect(to).toEqual(["master@example.ru", OWNER]);
    const owner = outbox.messages.find((m) => m.payload.to === OWNER) as Json;
    expect(owner.payload.text).toContain("Телефон: +79991234567");
    expect(owner.payload.text).toContain("Имя: Анна Петрова");
    expect(owner.payload.headers.Subject).toBe("Новая запись");
    expect(journal.map((j) => [j.recipient, j.status]).sort()).toEqual([
      ["owner", "test_mode"],
      ["role", "test_mode"],
    ]);
    expect(JSON.stringify(journal)).not.toContain(OWNER);
    // A repeated run of the same job/step sends nothing.
    await runNotifyStep(ctx, {
      params: step(spec, "booking_new", 0),
      entity: "booking",
      record: record(),
      jobId: "j1",
      stepIndex: 0,
    });
    expect(outbox.messages).toHaveLength(2);
  });

  test("Telegram goes to the owner and masters with a linked chat, without PII", async () => {
    const spec = booking();
    const { ctx, outbox } = ctxFor(spec, "tg");
    await runNotifyStep(ctx, {
      params: step(spec, "booking_new", 1),
      entity: "booking",
      record: record(),
      jobId: "j2",
      stepIndex: 1,
    });
    expect(outbox.messages).toHaveLength(2);
    for (const m of outbox.messages) {
      expect(m.payload.text).toMatch(/^Запись к мастеру: Новая заявка — откройте по ссылке https:\/\//);
      expect(JSON.stringify(m.payload)).not.toContain("+7999");
    }
  });

  test("visitor without consent gets nothing; with consent — confirmation with cancel and unsubscribe links", async () => {
    const spec = booking();
    const params = step(spec, "booking_new", 2);
    const a = ctxFor(spec, "mail");
    const r = await runNotifyStep(a.ctx, {
      params,
      entity: "booking",
      record: record(),
      jobId: "j3",
      stepIndex: 2,
    });
    expect(r).toEqual({ sent: 0, skipped: 1 });
    expect(a.outbox.messages).toHaveLength(0);
    expect(a.journal).toMatchObject([{ recipient: "visitor", status: "no_consent", addressHash: null }]);

    const b = ctxFor(spec, "mail");
    await runNotifyStep(b.ctx, {
      params,
      entity: "booking",
      record: record({ consent_messages: true }),
      jobId: "j3",
      stepIndex: 2,
    });
    expect(b.outbox.messages).toHaveLength(1);
    const text = String((b.outbox.messages[0] as Json).payload.text);
    expect((b.outbox.messages[0] as Json).payload.to).toBe(VISITOR);
    expect(text).toContain("отмените запись: https://zapis.sandpile.ru/_wizard/hooks/message/cancel/tok-b1");
    expect(text).toContain(
      `${UNSUBSCRIBE_FOOTER_RU} https://zapis.sandpile.ru/_wizard/hooks/message/unsubscribe/tok-b1`,
    );
    expect(b.journal[0]).toMatchObject({ recipient: "visitor", status: "test_mode" });
    expect(b.journal[0]?.addressHash).toBeInstanceOf(Buffer);
  });

  test("visitor limit: the 4th message to one contact in a day is refused and journaled", async () => {
    const spec = booking();
    const params = step(spec, "booking_new", 2);
    const { ctx, journal, outbox } = ctxFor(spec, "mail");
    for (let n = 0; n < 4; n++) {
      const run = runNotifyStep(ctx, {
        params,
        entity: "booking",
        record: record({ consent_messages: true }),
        jobId: `j${n}`,
        stepIndex: 2,
      });
      if (n < 3) await run;
      else await expect(run).rejects.toMatchObject({ code: "RATE_LIMITED" });
    }
    expect(outbox.messages).toHaveLength(3);
    expect(journal.at(-1)).toMatchObject({ status: "rate_limited", errorCode: "RATE_LIMITED" });
  });

  test("owner without known email → journaled no_address, the role still gets the mail", async () => {
    const spec = booking();
    const { ctx, journal, outbox } = ctxFor(spec, "mail");
    const noOwner = { ...ctx, owners: async () => [] };
    const r = await runNotifyStep(noOwner, {
      params: step(spec, "booking_new", 0),
      entity: "booking",
      record: record(),
      jobId: "j9",
      stepIndex: 0,
    });
    expect(r).toEqual({ sent: 1, skipped: 1 });
    expect(outbox.messages).toHaveLength(1);
    expect(journal.map((j) => j.status)).toContain("no_address");
  });
});
