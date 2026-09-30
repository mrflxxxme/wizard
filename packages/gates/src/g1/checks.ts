// Deterministic checks without LLM: permission matrix (qa.yaml#checks.permission_auto), consent probes
// (compliance.yaml#system_package.consent.gates) and AC → check mapping (qa.yaml#checks.from_acceptance).
import { type AppSpec, PERMISSION_OPS } from "@wizard/appspec";
import { compareMilestones } from "../catalog.js";
import { fieldPiiCategory } from "./seed.js";
import type { QaCheck, Scenario, Step } from "./types.js";

const pc = (role: string, entity: string, suffix: string) => `PC-${role}-${entity}-${suffix}`;

/** Full PC matrix: role × entity × op, plus row/hidden/ro per permission. */
export function generatePermissionChecks(spec: AppSpec): QaCheck[] {
  const out: QaCheck[] = [];
  const base = (role: string, entity: string, id: string): QaCheck => ({
    id,
    kind: "permission",
    level: "G1",
    role,
    entity,
  });
  for (const r of spec.roles) {
    for (const e of spec.entities) {
      const p = spec.permissions.find((x) => x.role === r.name && x.entity === e.name);
      const ops: readonly string[] = p?.ops ?? [];
      for (const op of PERMISSION_OPS) {
        out.push({
          ...base(r.name, e.name, pc(r.name, e.name, op)),
          probe: { kind: "op", op, expect: ops.includes(op) ? "allow" : "deny" },
        });
      }
      if (!p) continue;
      if (p.rowFilter && ops.some((o) => o !== "create"))
        out.push({ ...base(r.name, e.name, pc(r.name, e.name, "row")), probe: { kind: "row" } });
      if (p.hiddenFields?.length && ops.includes("read"))
        out.push({
          ...base(r.name, e.name, pc(r.name, e.name, "hidden")),
          probe: { kind: "hidden", fields: [...p.hiddenFields] },
        });
      if (p.readonlyFields?.length && (ops.includes("update") || ops.includes("create")))
        out.push({
          ...base(r.name, e.name, pc(r.name, e.name, "ro")),
          probe: { kind: "ro", fields: [...p.readonlyFields] },
        });
    }
  }
  return out;
}

/** «create без согласия → 422»: every non-admin role with create on an entity that has pii≠none fields. */
export function generateConsentChecks(spec: AppSpec): QaCheck[] {
  const out: QaCheck[] = [];
  for (const p of spec.permissions) {
    const role = spec.roles.find((r) => r.name === p.role);
    const e = spec.entities.find((x) => x.name === p.entity);
    if (!role || !e || role.isAdmin === true || !p.ops.includes("create")) continue;
    if (!e.fields.some((f) => fieldPiiCategory(f) !== "none")) continue;
    out.push({
      id: pc(p.role, p.entity, "consent"),
      kind: "permission",
      level: "G1",
      role: p.role,
      entity: p.entity,
      probe: { kind: "consent" },
    });
  }
  return out;
}

/** G1 selection (qa.yaml#checks.permission_auto.selection) plus row isolation and consent probes (notes M0-11). */
export function selectG1(spec: AppSpec, checks: readonly QaCheck[]): QaCheck[] {
  const publicRoles = new Set(spec.roles.filter((r) => r.access === "public").map((r) => r.name));
  const referenced = new Set<string>();
  for (const ac of spec.acceptance ?? []) {
    const c = ac.check;
    if (c.type === "permission" && c.role && c.entity && c.op) referenced.add(pc(c.role, c.entity, c.op));
  }
  return checks.filter(
    (c) =>
      referenced.has(c.id) ||
      (c.role !== undefined && publicRoles.has(c.role)) ||
      c.probe?.kind === "row" ||
      c.probe?.kind === "consent",
  );
}

/** SC-<AC id> for every AC (permission → probe 1:1, scenario/constraint → its DSL). */
export function acceptanceChecks(spec: AppSpec): QaCheck[] {
  const out: QaCheck[] = [];
  for (const ac of spec.acceptance ?? []) {
    const c = ac.check;
    const common = { id: `SC-${ac.id}`, acId: ac.id, level: "G1" as const, milestone: c.milestone ?? "M0" };
    if (c.type === "permission") {
      if (!c.role || !c.entity || !c.op || !c.expect) continue;
      out.push({
        ...common,
        kind: "permission",
        role: c.role,
        entity: c.entity,
        probe: { kind: "op", op: c.op, expect: c.expect },
      });
      continue;
    }
    if (!c.steps) continue;
    const scenario: Scenario = {
      id: common.id,
      acId: ac.id,
      title: ac.text.slice(0, 140),
      actors: (c.actors ?? {}) as Record<string, { role: string }>,
      milestone: common.milestone,
      seed: c.seed ?? "default",
      steps: c.steps as Step[],
    };
    out.push({ ...common, kind: c.type, scenario });
  }
  return out;
}

export const isLaterMilestone = (checkMilestone: string | undefined, ctxMilestone: string) =>
  compareMilestones(checkMilestone ?? "M0", ctxMilestone) > 0;
