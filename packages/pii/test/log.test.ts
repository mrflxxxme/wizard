import { describe, expect, test } from "vitest";
import { createLogger, safeError, sanitizeLogLine } from "../src/log.js";

const PHONE = "+7 916 123-45-67";
const EMAIL = "ivan.canary@example.com";

describe("allowlist logger (L3-08)", () => {
  test("unknown fields are dropped, strings scrubbed, query stripped", () => {
    const l = sanitizeLogLine({
      msg: `звонок ${PHONE}`,
      body: { phone: PHONE },
      email: EMAIL,
      route: `/api/v1/x?email=${EMAIL}`,
      status: 500,
      ok: true,
    });
    expect(l).toEqual({ msg: expect.not.stringContaining("916"), route: "/api/v1/x", status: 500 });
    expect(JSON.stringify(l)).not.toContain(EMAIL);
  });

  test("PG errors keep only sqlstate and constraint", () => {
    const pg = Object.assign(new Error(`duplicate key value`), {
      name: "PostgresError",
      code: "23505",
      severity: "ERROR",
      detail: `Key (email)=(${EMAIL}) already exists.`,
      where: `phone ${PHONE}`,
      constraint_name: "users_email_key",
    });
    expect(safeError(pg)).toEqual({ type: "pg", sqlstate: "23505", constraint: "users_email_key" });
  });

  test("provider errors keep only status and code; LlmError only code", () => {
    const http = Object.assign(new Error(`bad request ${EMAIL}`), {
      status: 400,
      code: "invalid",
      body: EMAIL,
    });
    expect(safeError(http)).toEqual({ type: "provider", status: 400, code: "invalid" });
    const llm = Object.assign(new Error(`нет ответа ${PHONE}`), { name: "LlmError", code: "FIXTURE_MISS" });
    expect(safeError(llm)).toEqual({ type: "llm", code: "FIXTURE_MISS" });
  });

  test("generic errors: scrubbed message, stack frames only", () => {
    const e = safeError(new Error(`не удалось для ${EMAIL}`));
    expect(e.type).toBe("Error");
    expect(e.message).not.toContain(EMAIL);
    expect(e.stack?.every((f) => f.startsWith("at "))).toBe(true);
  });

  test("createLogger writes one sanitized JSON line per call", () => {
    const lines: string[] = [];
    const log = createLogger({ svc: "test", write: (j) => lines.push(j) });
    log.error("boom", new Error(`x ${PHONE}`), { runId: "r1", payload: PHONE });
    log.line({ level: "warn", msg: "fn log", fields: { email: EMAIL }, system: "forum" });
    log.debug("hidden");
    expect(lines).toHaveLength(2);
    const [a, b] = lines.map((l) => JSON.parse(l));
    expect(a).toMatchObject({ level: "error", svc: "test", msg: "boom", runId: "r1" });
    expect(b).toMatchObject({ level: "warn", system: "forum" });
    expect(lines.join("\n")).not.toMatch(/916|canary/);
  });
});
