// Scopes of a system API key (V3-20): which entities (and which of read/create/update/delete) and which public
// functions a key may touch. A scope narrows the key's role, never widens it: the data API still applies the role's
// permissions, hidden and read-only fields, rowFilter and RLS. The system entity users is never exposed.
import { type AppSpec, PERMISSION_OPS, USERS_ENTITY } from "@wizard/appspec";

export type ApiDataOp = (typeof PERMISSION_OPS)[number];
export type ApiScope = { entity: string; ops: ApiDataOp[] } | { fn: string };

/** Scopes of one key at most. */
export const API_SCOPES_MAX = 50;

const IDENT = /^[a-z][a-z0-9_]{0,39}$/;
const FN = /^[a-z][A-Za-z0-9]{0,59}$/;

/** Scopes from JSON (stored jsonb or a request body); null when the shape is wrong. */
export function parseScopes(raw: unknown): ApiScope[] | null {
  if (!Array.isArray(raw) || raw.length > API_SCOPES_MAX) return null;
  const out: ApiScope[] = [];
  for (const s of raw) {
    if (typeof s !== "object" || s === null) return null;
    const o = s as Record<string, unknown>;
    if (typeof o.fn === "string" && Object.keys(o).length === 1 && FN.test(o.fn)) {
      out.push({ fn: o.fn });
      continue;
    }
    if (
      typeof o.entity !== "string" ||
      !IDENT.test(o.entity) ||
      !Array.isArray(o.ops) ||
      Object.keys(o).length !== 2
    )
      return null;
    const ops = [...new Set(o.ops)];
    if (!ops.length || !ops.every((x): x is ApiDataOp => (PERMISSION_OPS as readonly unknown[]).includes(x)))
      return null;
    out.push({ entity: o.entity, ops });
  }
  return out;
}

/** The key's scopes allow `op` on `entity`. */
export function scopeAllows(scopes: readonly ApiScope[], entity: string, op: ApiDataOp): boolean {
  if (entity === USERS_ENTITY) return false;
  return scopes.some((s) => "entity" in s && s.entity === entity && s.ops.includes(op));
}

/** The key's scopes allow calling function `name`. */
export function scopeAllowsFn(scopes: readonly ApiScope[], name: string): boolean {
  return scopes.some((s) => "fn" in s && s.fn === name);
}

/**
 * Problems of scopes for a role of a spec (Russian, for the owner creating the key): unknown entities or functions,
 * users, operations the role itself does not have, functions the role may not call.
 */
export function scopeIssues(spec: AppSpec, role: string, scopes: readonly ApiScope[]): string[] {
  const out: string[] = [];
  const r = spec.roles.find((x) => x.name === role);
  if (!r) return [`В системе нет роли «${role}»`];
  if (!scopes.length) out.push("Укажите, к каким данным или функциям ключ даёт доступ");
  for (const s of scopes) {
    if ("fn" in s) {
      const f = (spec.functions ?? []).find((x) => x.name === s.fn);
      if (!f) out.push(`Функции «${s.fn}» нет в системе`);
      else if (f.public !== true) out.push(`Функция «${s.fn}» не вызывается извне`);
      else if (!(f.roles ?? spec.roles.filter((x) => x.isAdmin).map((x) => x.name)).includes(role))
        out.push(`Роль «${r.label}» не может вызывать функцию «${s.fn}»`);
      continue;
    }
    if (s.entity === USERS_ENTITY) {
      out.push("Пользователей системы через API выдать нельзя");
      continue;
    }
    const e = spec.entities.find((x) => x.name === s.entity);
    if (!e) {
      out.push(`Данных «${s.entity}» нет в системе`);
      continue;
    }
    const p = spec.permissions.find((x) => x.role === role && x.entity === s.entity);
    const missing = s.ops.filter((op) => !p?.ops.includes(op));
    if (missing.length)
      out.push(`Роль «${r.label}» не может ${missing.map((m) => OPS_RU[m]).join(", ")} «${e.label}»`);
  }
  return out;
}

const OPS_RU: Record<ApiDataOp, string> = {
  read: "читать",
  create: "создавать",
  update: "изменять",
  delete: "удалять",
};
