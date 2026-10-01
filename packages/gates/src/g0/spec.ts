// Spec-level G0 checks: G0-SPEC-01, -02, -05 (specs/quality/gates.yaml#G0.checks).
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type AppSpec, appSpecSchema, type Field, type Permission, validateSpec } from "@wizard/appspec";
import { validateIntegrations } from "@wizard/connectors";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import type { Finding } from "../report.js";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
export const APPSPEC_SCHEMA_PATH = resolve(REPO_ROOT, "specs/appspec/appspec.schema.json");

let ajvValidate: ValidateFunction | undefined;
function jsonSchema(): ValidateFunction {
  if (!ajvValidate) {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    ajvValidate = ajv.compile(JSON.parse(readFileSync(APPSPEC_SCHEMA_PATH, "utf8")) as object);
  }
  return ajvValidate;
}

const FIX_SPEC = "Исправьте описание системы операциями над спекой (ops.yaml)";

function ajvFinding(e: ErrorObject): Finding {
  const where = e.instancePath || "/";
  return {
    message_ru: `Описание системы не соответствует схеме в ${where} (${e.keyword})`,
    path: e.instancePath,
    evidence: `${e.keyword}: ${JSON.stringify(e.params)}`,
    fixHint: FIX_SPEC,
  };
}

/** G0-SPEC-01: appspec.schema.json (ajv) and zod must both accept. */
export function checkSchema(spec: unknown): Finding[] {
  const out: Finding[] = [];
  const v = jsonSchema();
  if (!v(spec)) out.push(...(v.errors ?? []).map(ajvFinding));
  if (!appSpecSchema.safeParse(spec).success) {
    const r = validateSpec(spec);
    const errs = r.ok ? [] : r.errors;
    for (const e of errs) {
      out.push({ message_ru: e.message_ru, path: e.path, evidence: e.code, fixHint: e.hint ?? FIX_SPEC });
    }
    if (errs.length === 0)
      out.push({ message_ru: "Описание системы не прошло структурную проверку", fixHint: FIX_SPEC });
  }
  return out;
}

/** G0-SPEC-02: ops.yaml#semantic_rules + connectors configSchema/validateSpec (connector-interface.md §4). */
export function checkSemantics(spec: AppSpec): Finding[] {
  const out: Finding[] = [];
  const r = validateSpec(spec);
  if (!r.ok) {
    for (const e of r.errors) {
      out.push({ message_ru: e.message_ru, path: e.path, evidence: e.code, fixHint: e.hint ?? FIX_SPEC });
    }
  }
  for (const i of validateIntegrations(spec)) {
    out.push({ message_ru: i.message_ru, path: i.path, evidence: `${i.code} ${i.rule}`, fixHint: FIX_SPEC });
  }
  return out;
}

export function fieldPii(f: Field): string {
  return f.pii ?? (f.type === "file" ? "basic" : "none");
}

/** Ops of a permission to which its rowFilter applies (ops.yaml: without rowFilterOps — all ops). */
function filteredOps(p: Permission): Set<string> {
  if (!p.rowFilter || Object.keys(p.rowFilter).length === 0) return new Set();
  return new Set(p.rowFilterOps ?? p.ops);
}

const DEFAULT_POLICY_PAGE = "/privacy";
/** runtime.yaml#routing: paths served by runtime itself. */
const RESERVED_PREFIXES = ["/api", "/_wizard", "/assets"];

/** G0-SPEC-05: login methods, reachability, reserved routes, safe selfSignup. */
export function checkRolesAndRoutes(spec: AppSpec): Finding[] {
  const out: Finding[] = [];
  const entityPii = new Map(spec.entities.map((e) => [e.name, e.fields.some((f) => fieldPii(f) !== "none")]));
  spec.roles.forEach((r, i) => {
    if (r.access === "login" && !r.loginMethods?.length) {
      out.push({
        message_ru: `У роли «${r.label}» нет способа входа`,
        path: `/roles/${i}/loginMethods`,
        fixHint: "Добавьте роли хотя бы один способ входа: email_otp, phone_otp или telegram",
      });
    }
    if (!r.selfSignup) return;
    const unsafe = (why: string, path = `/roles/${i}/selfSignup`) =>
      out.push({
        message_ru: `Самостоятельная регистрация в роль «${r.label}» небезопасна: ${why}`,
        path,
        evidence: "SELF_SIGNUP_UNSAFE",
        fixHint: "Уберите selfSignup или ограничьте права роли своими записями (rowFilter)",
      });
    if (r.access !== "login") unsafe("роль без входа");
    if (r.isAdmin) unsafe("роль администратора");
    spec.permissions.forEach((p, j) => {
      if (p.role !== r.name) return;
      const filtered = filteredOps(p);
      const writes = p.ops.filter((op) => op !== "read");
      if (writes.some((op) => !filtered.has(op))) {
        unsafe(`права на «${p.entity}» включают изменение чужих записей`, `/permissions/${j}`);
      } else if (entityPii.get(p.entity) && p.ops.some((op) => !filtered.has(op))) {
        unsafe(
          `доступ к персональным данным «${p.entity}» без ограничения своими записями`,
          `/permissions/${j}`,
        );
      }
    });
  });
  for (const e of spec.entities) {
    if (!spec.permissions.some((p) => p.entity === e.name && p.ops.length > 0)) {
      const i = spec.entities.indexOf(e);
      out.push({
        message_ru: `Сущность «${e.label}» недоступна ни одной роли`,
        path: `/entities/${i}`,
        fixHint: "Выдайте права на сущность хотя бы одной роли или удалите её",
      });
    }
  }
  const reserved = new Set(["/login", spec.compliance?.policyPage ?? DEFAULT_POLICY_PAGE]);
  (spec.pages ?? []).forEach((pg, i) => {
    const route = pg.route.replace(/\/+$/, "") || "/";
    const prefix = RESERVED_PREFIXES.find((p) => route === p || route.startsWith(`${p}/`));
    if (reserved.has(route) || prefix) {
      out.push({
        message_ru: `Адрес страницы «${pg.title}» (${pg.route}) занят системой`,
        path: `/pages/${i}/route`,
        evidence: `RESERVED_NAME ${pg.route}`,
        fixHint:
          "Выберите другой адрес: /login, страница политики, /api, /_wizard и /assets обслуживает платформа",
      });
    }
  });
  return out;
}
