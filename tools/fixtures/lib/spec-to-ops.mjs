// specToOps: AppSpec → Op[] (specs/appspec/ops.yaml) in the builder's batch order (specs/agents/builder.yaml#loop.phases.ops).
// Pure JS without dependencies so gen-golden.mjs runs on bare Node; equivalence with applyOps is tested in tools/fixtures/test.

export const MAX_BATCH = 50;

/** Mirrors @wizard/appspec OWNER_ONLY_COMPLIANCE_FIELDS: an agent may set only consentTemplateId and policyPage. */
export const OWNER_ONLY_COMPLIANCE_FIELDS = [
  "consentText",
  "operatorName",
  "operatorContact",
  "operatorInn",
  "operatorAddress",
  "retentionWaiver",
];

const clone = (v) => structuredClone(v);

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = clone(obj[k]);
  return out;
}

/** Referenced entities first (stable: otherwise spec order), so any split into batches keeps refs valid. */
function sortEntities(entities) {
  const byName = new Map(entities.map((e) => [e.name, e]));
  const done = new Set();
  const out = [];
  const visit = (e, stack) => {
    if (done.has(e.name) || stack.has(e.name)) return;
    stack.add(e.name);
    for (const f of e.fields ?? []) {
      const target = f.type === "ref" ? byName.get(f.ref?.entity) : undefined;
      if (target) visit(target, stack);
    }
    done.add(e.name);
    out.push(e);
  };
  for (const e of entities) visit(e, new Set());
  return out;
}

/**
 * @param {object} spec AppSpec
 * @param {{author?: "user"|"agent"|"system"}} [opts] author=agent drops owner-only compliance fields (OWNER_ONLY_FIELD).
 * @returns {object[]} ops: app → theme → roles → entities → permissions → workflows → integrations → functions → pages
 *   → aiActions → acceptance → compliance. `app.locale`/`app.template` are not expressible by ops (set at system creation).
 */
export function specToOps(spec, opts = {}) {
  const author = opts.author ?? "system";
  const ops = [];
  const app = pick(spec.app, ["name", "description", "timezone"]);
  ops.push({ op: "set_app", ...app });
  if (spec.theme && Object.keys(spec.theme).length) ops.push({ op: "set_theme", ...clone(spec.theme) });
  for (const r of spec.roles ?? []) ops.push({ op: "add_role", ...clone(r) });
  for (const e of sortEntities(spec.entities ?? [])) ops.push({ op: "add_entity", ...clone(e) });
  for (const p of spec.permissions ?? []) ops.push({ op: "set_permission", ...clone(p) });
  for (const w of spec.workflows ?? []) ops.push({ op: "add_workflow", workflow: clone(w) });
  for (const i of spec.integrations ?? []) ops.push({ op: "add_integration", integration: clone(i) });
  for (const f of spec.functions ?? []) ops.push({ op: "add_function", ...clone(f) });
  for (const p of spec.pages ?? []) ops.push({ op: "add_page", ...clone(p) });
  for (const a of spec.aiActions ?? []) ops.push({ op: "add_ai_action", aiAction: clone(a) });
  if (spec.acceptance?.length) ops.push({ op: "set_acceptance", acceptance: clone(spec.acceptance) });
  if (spec.compliance) {
    const c = clone(spec.compliance);
    if (author === "agent") for (const k of OWNER_ONLY_COMPLIANCE_FIELDS) delete c[k];
    if (Object.keys(c).length) ops.push({ op: "set_compliance", ...c });
  }
  return ops;
}

/** Greedy split into apply_ops batches of ≤ max ops, preserving order. */
export function batchOps(ops, max = MAX_BATCH) {
  const out = [];
  for (let i = 0; i < ops.length; i += max) out.push(ops.slice(i, i + max));
  return out;
}
