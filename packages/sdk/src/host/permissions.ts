// Permission semantics for ctx.db (sdk.md §2.3 → runtime.yaml#permissions.algorithm). Hosts compile an
// AccessPolicy per (user, entity) and apply it: ops, rowFilter (+rowFilterOps), hiddenFields, readonlyFields.
import type { AppSpec, Permission } from "@wizard/appspec";

export const SYSTEM_ROLE = "__system";
export type PermissionOp = "read" | "create" | "update" | "delete";

/** Who performs a data operation. `record` holds the full `users` row used for `$user.<attr>` (host only). */
export interface AccessSubject {
  id: string | null;
  role: string;
  record?: Readonly<Record<string, unknown>>;
}

/**
 * - `null` → no row restriction;
 * - `false` → matches nothing (NULL value or `$user.*` for the public role);
 * - object → every listed column must equal the value.
 */
export type RowConstraint = Readonly<Record<string, unknown>> | null | false;

export interface AccessPolicy {
  readonly system: boolean;
  allows(op: PermissionOp): boolean;
  rowConstraint(op: PermissionOp): RowConstraint;
  readonly hidden: ReadonlySet<string>;
  readonly readonly: ReadonlySet<string>;
}

type PermissionWithOps = Permission & { rowFilterOps?: PermissionOp[] };

const SYSTEM_POLICY: AccessPolicy = {
  system: true,
  allows: () => true,
  rowConstraint: () => null,
  hidden: new Set(),
  readonly: new Set(),
};

const DENY_POLICY: AccessPolicy = {
  system: false,
  allows: () => false,
  rowConstraint: () => false,
  hidden: new Set(),
  readonly: new Set(),
};

/** Resolves `$user.id` / `$user.<attr>` placeholders; literals pass through. */
export function resolveFilterValue(
  raw: unknown,
  subject: AccessSubject,
): { ok: true; value: unknown } | { ok: false } {
  if (typeof raw !== "string" || !raw.startsWith("$user.")) return { ok: true, value: raw };
  if (subject.id === null) return { ok: false };
  const attr = raw.slice("$user.".length);
  const value = attr === "id" ? subject.id : attr === "role" ? subject.role : subject.record?.[attr];
  return value === null || value === undefined ? { ok: false } : { ok: true, value };
}

export function compilePolicy(spec: AppSpec, entity: string, subject: AccessSubject): AccessPolicy {
  if (subject.role === SYSTEM_ROLE) return SYSTEM_POLICY;
  const perm = spec.permissions.find((p) => p.role === subject.role && p.entity === entity) as
    | PermissionWithOps
    | undefined;
  if (!perm) return DENY_POLICY;
  const ops = new Set<string>(perm.ops);
  let constraint: RowConstraint = null;
  if (perm.rowFilter && Object.keys(perm.rowFilter).length > 0) {
    const resolved: Record<string, unknown> = {};
    constraint = resolved;
    for (const [col, raw] of Object.entries(perm.rowFilter)) {
      const r = resolveFilterValue(raw, subject);
      if (!r.ok) {
        constraint = false;
        break;
      }
      resolved[col] = r.value;
    }
  }
  const filteredOps = perm.rowFilterOps ? new Set<string>(perm.rowFilterOps) : undefined;
  return {
    system: false,
    allows: (op) => ops.has(op),
    rowConstraint: (op) => (filteredOps && !filteredOps.has(op) ? null : constraint),
    hidden: new Set(perm.hiddenFields ?? []),
    readonly: new Set(perm.readonlyFields ?? []),
  };
}

/** True when a row satisfies the constraint (loose equality on ids/strings/numbers). */
export function rowMatches(row: Readonly<Record<string, unknown>>, c: RowConstraint): boolean {
  if (c === null) return true;
  if (c === false) return false;
  return Object.entries(c).every(
    ([k, v]) => row[k] !== null && row[k] !== undefined && String(row[k]) === String(v),
  );
}

/** Copy of the row without hidden fields (the key is absent, not null). */
export function stripHidden<T extends Record<string, unknown>>(row: T, hidden: ReadonlySet<string>): T {
  if (hidden.size === 0) return { ...row };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (!hidden.has(k)) out[k] = v;
  return out as T;
}

/** Roles that may call a public function (runtime.yaml#functions.roles). */
export function functionAllowsRole(spec: AppSpec, fnName: string, role: string): boolean {
  if (role === SYSTEM_ROLE) return true;
  const fn = spec.functions?.find((f) => f.name === fnName);
  if (!fn) return false;
  if (fn.roles) return fn.roles.includes(role);
  return spec.roles.some((r) => r.name === role && r.isAdmin === true);
}
