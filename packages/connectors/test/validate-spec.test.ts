// AC1 (M0-28): validateSpec on forum/bakery passes; one negative fixture per config_schema rule.
import { validateSpec as validateAppSpec } from "@wizard/appspec";
import { describe, expect, test } from "vitest";
import { CONNECTORS, validateIntegration, validateIntegrations } from "../src/index.js";
import { config, type Example, entity, field, integrationIndex, type Json, loadSpec } from "./helpers.js";

describe("reference specs", () => {
  for (const name of ["forum", "bakery"] as const) {
    test(`${name}: every integration passes configSchema + validateSpec`, () => {
      const spec = loadSpec(name);
      expect(validateAppSpec(spec).ok).toBe(true);
      expect(validateIntegrations(spec)).toEqual([]);
    });
  }

  test("all four connectors export configSchema, secrets and validateSpec", () => {
    for (const c of Object.values(CONNECTORS)) {
      expect(c.configSchema).toBeDefined();
      expect(Array.isArray(c.secrets)).toBe(true);
      expect(typeof c.validateSpec).toBe("function");
    }
  });
});

interface Case {
  rule: string;
  spec?: Example;
  integration: string;
  mutate(spec: Json, cfg: Json): void;
  code?: "SCHEMA_INVALID" | "CONFIG_INVALID";
}

const yk = (s: Json) => config(s, "yookassa").bindings[0];

const CASES: Case[] = [
  // ---- yookassa: config schema
  {
    rule: "yookassa.config_schema",
    integration: "yookassa",
    mutate: (_, c) => {
      c.bindings = [];
    },
  },
  {
    rule: "yookassa.config_schema",
    integration: "yookassa",
    mutate: (_, c) => {
      c.bindings[0].amount = 100;
    },
  },
  {
    rule: "yookassa.config_schema",
    integration: "yookassa",
    mutate: (_, c) => {
      c.bindings[0].receipt.vatCode = 7;
    },
  },
  {
    rule: "yookassa.config_schema",
    integration: "yookassa",
    mutate: (_, c) => {
      c.bindings[0].description = "я".repeat(129);
    },
  },
  {
    rule: "yookassa.config_schema",
    integration: "yookassa",
    mutate: (_, c) => {
      c.bindings[0].returnRoute = "ticket";
    },
  },
  {
    rule: "yookassa.config_schema",
    integration: "yookassa",
    mutate: (_, c) => void delete c.bindings[0].receipt.customerEmailField,
  },
  {
    rule: "yookassa.config_schema",
    integration: "yookassa",
    mutate: (_, c) => void delete c.bindings[0].receipt,
  },
  {
    rule: "yookassa.config_schema",
    integration: "yookassa",
    mutate: (_, c) => {
      c.refundWindowDays = 400;
    },
  },
  {
    rule: "yookassa.config_schema",
    integration: "yookassa",
    mutate: (_, c) => {
      c.testMode = "yes";
    },
  },
  {
    rule: "yookassa.config_schema",
    integration: "yookassa",
    mutate: (_, c) => void c.bindings.push({ ...c.bindings[0] }),
  },
  {
    rule: "yookassa.config_schema",
    integration: "yookassa",
    mutate: (_, c) => {
      c.bindings[0].receipt.paymentMode = "partial_prepayment";
    },
  },
  // ---- yookassa: references
  {
    rule: "yookassa.entity",
    integration: "yookassa",
    mutate: (s) => {
      yk(s).entity = "order";
    },
  },
  {
    rule: "yookassa.amount_field",
    integration: "yookassa",
    mutate: (s) => {
      yk(s).amountField = "total";
    },
  },
  {
    rule: "yookassa.amount_field_type",
    integration: "yookassa",
    mutate: (s) => {
      yk(s).amountField = "company";
    },
  },
  {
    rule: "yookassa.status_field",
    integration: "yookassa",
    mutate: (s) => {
      yk(s).statusField = "state";
    },
  },
  {
    rule: "yookassa.status_field_type",
    integration: "yookassa",
    mutate: (s) => {
      yk(s).statusField = "company";
    },
  },
  {
    rule: "yookassa.status_value",
    integration: "yookassa",
    mutate: (s) => {
      yk(s).paidStatus = "done";
    },
  },
  {
    rule: "yookassa.status_value",
    integration: "yookassa",
    mutate: (s) => {
      yk(s).refundedStatus = "returned";
    },
  },
  {
    rule: "yookassa.description_field",
    integration: "yookassa",
    mutate: (s) => {
      yk(s).description = "Билет {{seat}}";
    },
  },
  {
    rule: "yookassa.receipt_email_type",
    integration: "yookassa",
    mutate: (s) => {
      yk(s).receipt.customerEmailField = "holder_phone";
    },
  },
  {
    rule: "yookassa.receipt_phone",
    integration: "yookassa",
    mutate: (s) => {
      yk(s).receipt.customerPhoneField = "mobile";
    },
  },
  {
    rule: "yookassa.amount_writable",
    integration: "yookassa",
    mutate: (s) => {
      const p = s.permissions.find((x: Json) => x.role === "organizer" && x.entity === "ticket");
      p.readonlyFields = p.readonlyFields.filter((f: string) => f !== "amount");
    },
  },
  {
    rule: "yookassa.payment_entity",
    integration: "yookassa",
    mutate: (s) => {
      yk(s).paymentEntity.name = "payments";
    },
  },
  {
    rule: "yookassa.payment_ref",
    integration: "yookassa",
    mutate: (s) => {
      yk(s).paymentEntity.refField = "order";
    },
  },
  {
    rule: "yookassa.payment_ref_target",
    integration: "yookassa",
    mutate: (s) => {
      field(s, "payment", "ticket").ref.entity = "stream";
    },
  },
  {
    rule: "yookassa.payment_field",
    integration: "yookassa",
    mutate: (s) => {
      const e = entity(s, "payment");
      e.fields = e.fields.filter((f: Json) => f.name !== "provider_payment_id");
    },
  },
  {
    rule: "yookassa.payment_enum",
    integration: "yookassa",
    mutate: (s) => {
      const f = field(s, "payment", "status");
      f.enum = f.enum.filter((o: Json) => o.value !== "canceled");
    },
  },
  {
    rule: "yookassa.settle_binding",
    spec: "bakery",
    integration: "yookassa",
    mutate: (_, c) => {
      c.bindings[1].receipt.settlePrepaymentOf = "deposit";
    },
  },
  {
    rule: "yookassa.settle_binding",
    spec: "bakery",
    integration: "yookassa",
    mutate: (_, c) => {
      c.bindings[1].receipt.settlePrepaymentOf = "final";
    },
  },
  // ---- telegram
  {
    rule: "telegram.config_schema",
    integration: "telegram",
    mutate: (_, c) => {
      c.botUsername = "@north_bot";
    },
  },
  {
    rule: "telegram.config_schema",
    integration: "telegram",
    mutate: (_, c) => {
      c.botUsername = "abc";
    },
  },
  {
    rule: "telegram.config_schema",
    integration: "telegram",
    mutate: (_, c) => {
      c.allowPii = true;
    },
  },
  {
    rule: "telegram.config_schema",
    integration: "telegram",
    mutate: (_, c) => {
      c.botToken = "123456:ABCdef";
    },
  },
  {
    rule: "telegram.config_schema",
    integration: "telegram",
    mutate: (_, c) => {
      c.bot = "platform";
    },
  },
  {
    rule: "telegram.config_schema",
    integration: "telegram",
    mutate: (_, c) => {
      delete c.botUsername;
      c.bot = "own";
    },
  },
  {
    rule: "telegram.config_schema",
    integration: "telegram",
    mutate: (_, c) => {
      c.loginEnabled = "yes";
    },
  },
  {
    rule: "telegram.login_needs_own_bot",
    integration: "telegram",
    mutate: (_, c) => void delete c.botUsername,
  },
  {
    rule: "telegram.login_needs_own_bot",
    spec: "bakery",
    integration: "telegram",
    mutate: (_, c) => {
      delete c.botUsername;
      c.loginEnabled = true;
    },
  },
  {
    rule: "telegram.bot_token_secret",
    integration: "telegram",
    mutate: (s) => {
      s.integrations[integrationIndex(s, "telegram")].secretRefs = [];
    },
  },
  // ---- email
  {
    rule: "email.config_schema",
    integration: "email",
    mutate: (_, c) => {
      c.port = 25;
    },
  },
  {
    rule: "email.config_schema",
    integration: "email",
    mutate: (_, c) => {
      c.host = "10.0.0.5";
    },
  },
  {
    rule: "email.config_schema",
    integration: "email",
    mutate: (_, c) => {
      c.host = "smtp.mail.ru:465";
    },
  },
  {
    rule: "email.config_schema",
    integration: "email",
    mutate: (_, c) => {
      c.secure = false;
    },
  },
  {
    rule: "email.config_schema",
    integration: "email",
    mutate: (_, c) => {
      c.port = 587;
      c.secure = true;
    },
  },
  { rule: "email.config_schema", integration: "email", mutate: (_, c) => void delete c.host },
  { rule: "email.config_schema", integration: "email", mutate: (_, c) => void delete c.from },
  {
    rule: "email.config_schema",
    integration: "email",
    mutate: (_, c) => {
      c.provider = "sendgrid";
    },
  },
  {
    rule: "email.config_schema",
    integration: "email",
    mutate: (_, c) => {
      c.provider = "platform";
    },
  },
  {
    rule: "email.config_schema",
    integration: "email",
    mutate: (_, c) => {
      c.from.name = "Форум <noreply>";
    },
  },
  {
    rule: "email.config_schema",
    integration: "email",
    mutate: (_, c) => {
      c.from.name = "Ф".repeat(61);
    },
  },
  {
    rule: "email.config_schema",
    integration: "email",
    mutate: (_, c) => {
      c.from.address = "not-an-email";
    },
  },
  {
    rule: "email.config_schema",
    integration: "email",
    mutate: (_, c) => {
      c.replyTo = "a@b.ru, c@d.ru";
    },
  },
  {
    rule: "email.config_schema",
    integration: "email",
    mutate: (_, c) => {
      c.templates.ticket_issued.subject = "т".repeat(121);
    },
  },
  {
    rule: "email.config_schema",
    integration: "email",
    mutate: (_, c) => {
      c.templates.Ticket = { subject: "a", body: "b" };
    },
  },
  {
    rule: "email.config_schema",
    integration: "email",
    mutate: (_, c) => {
      c.password = "hunter2";
    },
  },
  {
    rule: "email.smtp_password_secret",
    integration: "email",
    mutate: (s) => {
      s.integrations[integrationIndex(s, "email")].secretRefs = [];
    },
  },
  {
    rule: "email.template_missing",
    integration: "email",
    mutate: (s) => {
      s.workflows[1].steps[0].params.template = "ticket_paid";
    },
  },
  // ---- qr
  {
    rule: "qr.config_schema",
    integration: "qr",
    mutate: (_, c) => {
      c.validStatuses = [];
    },
  },
  {
    rule: "qr.config_schema",
    integration: "qr",
    mutate: (_, c) => {
      c.scannerRoles = [];
    },
  },
  { rule: "qr.config_schema", integration: "qr", mutate: (_, c) => void delete c.checkin },
  {
    rule: "qr.config_schema",
    integration: "qr",
    mutate: (_, c) => {
      c.checkin.unique = true;
    },
  },
  {
    rule: "qr.config_schema",
    integration: "qr",
    mutate: (_, c) => {
      c.offline = "yes";
    },
  },
  {
    rule: "qr.config_schema",
    integration: "qr",
    mutate: (_, c) => {
      c.signingKey = "k";
    },
  },
  {
    rule: "qr.entity",
    integration: "qr",
    mutate: (_, c) => {
      c.entity = "tickets";
    },
  },
  {
    rule: "qr.token_field",
    integration: "qr",
    mutate: (_, c) => {
      c.tokenField = "token";
    },
  },
  {
    rule: "qr.token_field_type",
    integration: "qr",
    mutate: (_, c) => {
      c.tokenField = "promo_code";
    },
  },
  { rule: "qr.valid_status", integration: "qr", mutate: (_, c) => void c.validStatuses.push("used") },
  {
    rule: "qr.status_field",
    integration: "qr",
    mutate: (s) => {
      const e = entity(s, "ticket");
      e.fields = e.fields.filter((f: Json) => f.name !== "status");
    },
  },
  { rule: "qr.display_field", integration: "qr", mutate: (_, c) => void c.displayFields.push("seat") },
  {
    rule: "qr.checkin_entity",
    integration: "qr",
    mutate: (_, c) => {
      c.checkin.entity = "scan";
    },
  },
  {
    rule: "qr.checkin_ref",
    integration: "qr",
    mutate: (_, c) => {
      c.checkin.refField = "ticket_id";
    },
  },
  {
    rule: "qr.checkin_ref_type",
    integration: "qr",
    mutate: (_, c) => {
      c.checkin.refField = "device_id";
    },
  },
  {
    rule: "qr.checkin_ref_target",
    integration: "qr",
    mutate: (s) => {
      field(s, "checkin", "ticket").ref.entity = "stream";
    },
  },
  {
    rule: "qr.checkin_ref_unique",
    integration: "qr",
    mutate: (s) => void delete field(s, "checkin", "ticket").unique,
  },
  {
    rule: "qr.checkin_scanned_at",
    integration: "qr",
    mutate: (s) => {
      const e = entity(s, "checkin");
      e.fields = e.fields.filter((f: Json) => f.name !== "scanned_at");
    },
  },
  { rule: "qr.scanner_role", integration: "qr", mutate: (_, c) => void c.scannerRoles.push("guard") },
  {
    rule: "qr.scanner_role_open",
    integration: "qr",
    mutate: (_, c) => void c.scannerRoles.push("participant"),
  },
  { rule: "qr.scanner_role_open", integration: "qr", mutate: (_, c) => void c.scannerRoles.push("visitor") },
  {
    rule: "qr.scanner_role_create",
    integration: "qr",
    mutate: (_, c) => void c.scannerRoles.push("moderator"),
  },
  // ---- webhook (M2-53): the telegram slot of the forum spec is turned into a webhook integration
  {
    rule: "webhook.config_schema",
    integration: "telegram",
    mutate: (s) => {
      s.integrations[integrationIndex(s, "telegram")] = {
        name: "telegram",
        connector: "webhook",
        config: { verify: "hmac", entity: "ticket", fields: {} },
      };
    },
  },
  {
    rule: "webhook.field",
    integration: "telegram",
    mutate: (s) => {
      s.integrations[integrationIndex(s, "telegram")] = {
        name: "telegram",
        connector: "webhook",
        config: { verify: "shared_secret", entity: "ticket", fields: { created_by: "user" } },
      };
    },
  },
  // ---- secrets (all connectors)
  {
    rule: "connector.secret_required",
    integration: "qr",
    mutate: (s) => {
      s.integrations[integrationIndex(s, "qr")].secretRefs = [];
    },
  },
  {
    rule: "connector.secret_required",
    integration: "yookassa",
    mutate: (s) => void s.integrations[integrationIndex(s, "yookassa")].secretRefs.pop(),
  },
  {
    rule: "connector.secret_unknown",
    integration: "telegram",
    mutate: (s) =>
      void s.integrations[integrationIndex(s, "telegram")].secretRefs.push("secret://yookassa_secret_key"),
  },
];

describe("negative fixtures", () => {
  test.each(CASES.map((c, i) => [`${i}:${c.rule}`, c] as const))("%s", (_, c) => {
    const spec = loadSpec(c.spec ?? "forum") as Json;
    const idx = integrationIndex(spec, c.integration);
    c.mutate(spec, spec.integrations[idx].config);
    const issues = validateIntegration(spec, idx);
    const hit = issues.find((i) => i.rule === c.rule);
    expect(hit, JSON.stringify(issues)).toBeDefined();
    expect(hit?.message_ru).toMatch(/[А-Яа-яЁё]/);
    expect(hit?.path.startsWith("/integrations/") || hit?.path.startsWith("/workflows/")).toBe(true);
    if (c.rule.endsWith(".config_schema")) expect(hit?.code).toBe("SCHEMA_INVALID");
  });

  test("each connector-specific rule id has at least one negative fixture", () => {
    const covered = new Set(CASES.map((c) => c.rule));
    for (const id of Object.keys(CONNECTORS)) expect(covered.has(`${id}.config_schema`)).toBe(true);
    expect(covered.size).toBeGreaterThanOrEqual(40);
  });

  test("telegram: loginEnabled=false allows the platform bot; own bot needs no login", () => {
    const spec = loadSpec("forum") as Json;
    const idx = integrationIndex(spec, "telegram");
    spec.integrations[idx].config = { loginEnabled: false };
    spec.integrations[idx].secretRefs = [];
    expect(validateIntegration(spec, idx)).toEqual([]);
  });

  test("email: provider=platform needs no SMTP settings or password", () => {
    const spec = loadSpec("forum") as Json;
    const idx = integrationIndex(spec, "email");
    spec.integrations[idx].config = { templates: config(spec, "email").templates };
    spec.integrations[idx].secretRefs = [];
    expect(validateIntegration(spec, idx)).toEqual([]);
  });

  test("issue paths point into the spec", () => {
    const spec = loadSpec("forum") as Json;
    const idx = integrationIndex(spec, "qr");
    spec.integrations[idx].config.validStatuses = ["paid", "used"];
    const [issue] = validateIntegration(spec, idx);
    expect(issue).toMatchObject({
      code: "CONFIG_INVALID",
      path: `/integrations/${idx}/config/validStatuses/1`,
      rule: "qr.valid_status",
    });
    expect(issue?.allowed).toContain("paid");
  });
});
