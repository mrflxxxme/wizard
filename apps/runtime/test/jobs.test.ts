// M1-09: minimal job runner (runtime.yaml#workflows) — on_status/on_create triggers from _w_audit, relative and cron
// schedules, wait steps, retries with backoff up to a dead job, retention (anonymize) with the _w_audit counter.
import { randomUUID } from "node:crypto";
import { type AppSpec, quoteIdent } from "@wizard/appspec";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type LoadedSystem, lastOccurrence, parseCron, SYSTEM_SUBJECT } from "../src/index.js";
import { backoffMs } from "../src/jobs/runner.js";
import { forumSpec, type Harness, harness } from "./helpers.js";

const DAY = 86_400_000;
const MIN = 60_000;

let h: Harness;
const schemas = new Map<string, string>();

/** Forum plus one extra workflow: on_create with a wait step (jobs-b) or a cron with a connector step (jobs-c). */
function extendedForum(kind: "wait" | "cron"): AppSpec {
  const spec = forumSpec();
  const extra: NonNullable<AppSpec["workflows"]>[number] =
    kind === "wait"
      ? {
          name: "stream_created",
          trigger: { type: "on_create", entity: "stream" },
          steps: [
            { type: "wait", params: { minutes: 30 } },
            { type: "update", params: { set: { description: "Проверено" } } },
          ],
        }
      : {
          name: "morning",
          trigger: { type: "schedule", cron: "0 9 * * *" },
          steps: [
            {
              type: "connector",
              params: {
                integration: "telegram",
                action: "sendToUser",
                input: { userId: "cron", text: "Утро" },
              },
            },
          ],
        };
  spec.workflows = [...(spec.workflows ?? []), extra];
  return spec;
}

beforeAll(async () => {
  h = await harness();
  for (const slug of ["jobs-a", "jobs-b", "jobs-c"]) {
    const spec = slug === "jobs-a" ? forumSpec() : extendedForum(slug === "jobs-b" ? "wait" : "cron");
    const { schema } = await h.system(slug, spec);
    schemas.set(slug, schema);
  }
});
afterAll(async () => {
  await h.close();
});

const sys = async (slug: string) => (await h.rt.systems.resolve(slug, "draft")) as LoadedSystem;

async function newUser(slug: string, role: string): Promise<string> {
  const id = randomUUID();
  await h.sql.begin(async (tx) => {
    await tx.unsafe("select set_config('wizard.role', '__system', true)");
    await tx.unsafe(
      `insert into ${quoteIdent(schemas.get(slug) as string)}."users" (id, role) values ($1, $2)`,
      [id, role],
    );
  });
  return id;
}

const run = (slug: string, now: Date, since?: Date) =>
  h.rt.runJobs({ slug, env: "draft", now, ...(since ? { since } : {}) });

describe("cron", () => {
  test("parse and latest occurrence in Europe/Moscow", () => {
    expect(parseCron("61 * * * *")).toBeNull();
    expect(parseCron("* * *")).toBeNull();
    const daily = parseCron("0 9 * * *");
    expect(daily).not.toBeNull();
    const at = lastOccurrence(
      daily as NonNullable<typeof daily>,
      new Date("2026-10-01T00:00:00Z"),
      new Date("2026-10-03T00:00:00Z"),
      "Europe/Moscow",
    );
    expect(at?.toISOString()).toBe("2026-10-02T06:00:00.000Z");
    const monday = parseCron("30 8 * * 1") as NonNullable<ReturnType<typeof parseCron>>;
    expect(
      lastOccurrence(
        monday,
        new Date("2026-09-28T00:00:00Z"),
        new Date("2026-10-07T00:00:00Z"),
        "Europe/Moscow",
      ),
    ).toEqual(new Date("2026-10-05T05:30:00.000Z"));
    const none = lastOccurrence(
      monday,
      new Date("2026-10-06T00:00:00Z"),
      new Date("2026-10-07T00:00:00Z"),
      "UTC",
    );
    expect(none).toBeNull();
  });

  test("backoff: 1 s × 4^(n-1), capped at 16 min", () => {
    expect([1, 2, 3, 6, 9].map(backoffMs)).toEqual([1000, 4000, 16_000, 960_000, 960_000]);
  });
});

describe("runJobs", () => {
  test("on_status: approving a speaker sends email + telegram once, without personal data", async () => {
    const s = await sys("jobs-a");
    const sp = await newUser("jobs-a", "speaker");
    const app = await s.data.create(SYSTEM_SUBJECT, "speaker_application", {
      speaker_user: sp,
      full_name: "Спикер Один",
      email: "user1@example.test",
      topic: "Тема",
      abstract: "Кейс",
    });
    const t0 = new Date();
    const mine = () => h.rt.outbox().filter((m) => m.userId === sp);
    let r = await run("jobs-a", t0);
    expect(r.failed).toEqual([]);
    expect(mine()).toEqual([]);

    await s.data.update(SYSTEM_SUBJECT, "speaker_application", String(app.id), { status: "approved" });
    r = await run("jobs-a", t0);
    expect(r.ran).toBe(1);
    expect(mine().map((m) => [m.integration, m.action])).toEqual([
      ["email", "sendTemplate"],
      ["telegram", "sendToUser"],
    ]);
    expect(JSON.stringify(mine())).not.toContain("Спикер Один");
    // B2-28: outbox mode records the letter itself (as the email connector renders it) and the sending system.
    const mail = mine()[0] as { payload: { subject?: unknown; text?: unknown }; system?: string };
    expect(typeof mail.payload.subject).toBe("string");
    expect(String(mail.payload.text)).not.toBe("");
    expect(`${String(mail.payload.subject)} ${String(mail.payload.text)}`).not.toContain("{{");
    expect(mail.system).toBe(s.entry.systemId);

    r = await run("jobs-a", t0);
    expect(r.ran).toBe(0);
    await s.data.update(SYSTEM_SUBJECT, "speaker_application", String(app.id), { moderator_comment: "Ок" });
    r = await run("jobs-a", t0);
    expect(r.ran).toBe(0);
    expect(mine()).toHaveLength(2);
    // B2-28: the platform's G1 runtime forgets the messages of a finished gate's systems; others keep theirs.
    const others = h.rt.outbox().filter((m) => m.system !== s.entry.systemId).length;
    h.rt.dropOutbox([s.entry.systemId]);
    expect(mine()).toEqual([]);
    expect(h.rt.outbox()).toHaveLength(others);
  });

  test("relative schedule → function step (disabled) retries until dead; retention anonymizes pii fields", async () => {
    const s = await sys("jobs-a");
    const holder = await newUser("jobs-a", "participant");
    const stream = await s.data.create(SYSTEM_SUBJECT, "stream", { name: "Поток", capacity: 10 });
    const type = await s.data.create(SYSTEM_SUBJECT, "ticket_type", {
      name: "Стандарт",
      kind: "standard",
      price: 1000,
      capacity: 10,
    });
    const t0 = new Date();
    const ticket = await s.data.create(SYSTEM_SUBJECT, "ticket", {
      ticket_type: type.id,
      stream: stream.id,
      holder_user: holder,
      holder_name: "Участник 1",
      holder_email: "user1@example.test",
      company: "Альфа",
      status: "paid",
      amount: 1000,
      event_starts_at: new Date(t0.getTime() + 2 * DAY).toISOString(),
    });

    // on_status paid fires on create: the ticket email; the reminder (start − 24 h) is not due yet.
    let r = await run("jobs-a", t0);
    expect(r.failed).toEqual([]);
    expect(h.rt.outbox().filter((m) => m.userId === holder && m.integration === "email")).toHaveLength(1);

    // Reminder due: its function step cannot run (WIZARD_UNSAFE_LOCAL_EXEC off) → failure with the step.
    let now = new Date(t0.getTime() + DAY + MIN);
    r = await run("jobs-a", now);
    expect(r.failed).toEqual([
      expect.objectContaining({
        kind: "workflow_step",
        name: "ticket_reminder",
        step: 0,
        stepType: "function",
        code: "FUNCTIONS_DISABLED",
        dead: false,
      }),
    ]);

    // 30 days after the event: pii fields are nulled, the rest stays; the retry fails again (attempt 2).
    now = new Date(t0.getTime() + 33 * DAY);
    r = await run("jobs-a", now);
    expect(r.retention).toContainEqual({ entity: "ticket", mode: "anonymize", rows: 1 });
    expect(r.failed.map((f) => f.name)).toEqual(["ticket_reminder"]);
    const row = await s.data.get(SYSTEM_SUBJECT, "ticket", String(ticket.id));
    expect(row).toMatchObject({
      holder_name: null,
      holder_email: null,
      holder_phone: null,
      company: "Альфа",
    });
    const [audit] = await h.sql.unsafe(
      `select count(*)::int as n from ${quoteIdent(schemas.get("jobs-a") as string)}."_w_audit"
       where op = 'retention' and entity = 'ticket'`,
    );
    expect(audit?.n).toBe(1);

    // Attempts 3–5 (backoff < 1 h each); the 5th marks the job dead, then it never runs again.
    const dead: boolean[] = [];
    for (let i = 1; i <= 4; i++) {
      now = new Date(now.getTime() + 60 * MIN);
      r = await run("jobs-a", now);
      dead.push(...r.failed.map((f) => f.dead));
    }
    expect(dead).toEqual([false, false, true]);
  });

  test("on_create + wait: the second step runs after the wait at a later `now`", async () => {
    const s = await sys("jobs-b");
    const stream = await s.data.create(SYSTEM_SUBJECT, "stream", { name: "Поток", capacity: 5 });
    const t0 = new Date();
    let r = await run("jobs-b", t0);
    expect(r).toMatchObject({ ran: 1, failed: [] });
    r = await run("jobs-b", new Date(t0.getTime() + 29 * MIN));
    expect(r.ran).toBe(0);
    expect((await s.data.get(SYSTEM_SUBJECT, "stream", String(stream.id))).description).toBeNull();
    r = await run("jobs-b", new Date(t0.getTime() + 31 * MIN));
    expect(r).toMatchObject({ ran: 1, failed: [] });
    expect((await s.data.get(SYSTEM_SUBJECT, "stream", String(stream.id))).description).toBe("Проверено");
  });

  test("cron: the latest occurrence of the window fires once", async () => {
    const t0 = new Date();
    const cron = () => h.rt.outbox().filter((m) => m.userId === "cron");
    await run("jobs-c", new Date(t0.getTime() + 2 * DAY), t0);
    expect(cron()).toHaveLength(1);
    await run("jobs-c", new Date(t0.getTime() + 2 * DAY), t0);
    expect(cron()).toHaveLength(1);
    await run("jobs-c", new Date(t0.getTime() + 3 * DAY), t0);
    expect(cron()).toHaveLength(2);
  });
});
