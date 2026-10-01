// sdk.md §2.3 (L3-22, M2): documents read through ctx.systemDb are marked, and fields pii≠none the caller's role
// cannot see (no read, hiddenFields, row outside rowFilter) are cut out of the /api/fn result. The marking is by
// value: every such value read in this call taints the result, whatever shape the function returns it in.
import type { AppSpec, Entity, Permission } from "@wizard/appspec";
import type { CurrentUser } from "@wizard/sdk";

const DOC_METHODS = new Set(["get", "getBy", "list", "first", "paginate"]);
const USER_REF_RE = /^\$user\.([a-z_]+)$/;
/** Shorter values are not distinctive enough to strip by value (they would also match unrelated data). */
const MIN_VALUE_LENGTH = 3;
const MASK = "•••";

const piiOf = (f: Entity["fields"][number]) => f.pii ?? (f.type === "file" ? "basic" : "none");

function rowVisible(p: Permission, user: CurrentUser, doc: Record<string, unknown>): boolean {
  const ops = p.rowFilterOps ?? p.ops;
  if (!p.rowFilter || !ops.includes("read")) return true;
  return Object.entries(p.rowFilter).every(([field, want]) => {
    const m = typeof want === "string" ? USER_REF_RE.exec(want) : null;
    const v = m ? (m[1] === "id" ? user.id : m[1] === "role" ? user.role : user.attrs[m[1] as string]) : want;
    return v !== null && v !== undefined && String(doc[field]) === String(v);
  });
}

/** Per-call taint: values of invisible ПДн fields seen in ctx.systemDb results. */
export class PiiTaint {
  readonly values = new Set<string>();
  private readonly entities: Map<string, Entity>;

  constructor(
    private readonly spec: AppSpec,
    private readonly user: CurrentUser,
  ) {
    this.entities = new Map(spec.entities.map((e) => [e.name, e]));
  }

  /** Nothing to strip for the system subject (workflows, scheduler). */
  get active(): boolean {
    return this.user.role !== "__system";
  }

  private observeDoc(entity: Entity, doc: unknown): void {
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return;
    const d = doc as Record<string, unknown>;
    const p = this.spec.permissions.find((x) => x.role === this.user.role && x.entity === entity.name);
    const readable = p?.ops.includes("read") === true;
    const visibleRow = readable && p ? rowVisible(p, this.user, d) : false;
    const hidden = new Set(p?.hiddenFields ?? []);
    for (const f of entity.fields) {
      if (piiOf(f) === "none") continue;
      if (visibleRow && !hidden.has(f.name)) continue;
      const v = d[f.name];
      if (typeof v === "string" && v.length >= MIN_VALUE_LENGTH) this.values.add(v);
      else if (typeof v === "number" && String(v).length >= MIN_VALUE_LENGTH) this.values.add(String(v));
    }
  }

  /** Records the result of ctx.systemDb.<entity>.<method>(…). */
  observe(entityName: string, method: string, result: unknown): void {
    const e = this.entities.get(entityName);
    if (!e || !DOC_METHODS.has(method) || !this.active) return;
    if (Array.isArray(result)) for (const d of result) this.observeDoc(e, d);
    else if (method === "paginate" && result && typeof result === "object") {
      const page = (result as { page?: unknown }).page;
      if (Array.isArray(page)) for (const d of page) this.observeDoc(e, d);
    } else this.observeDoc(e, result);
  }

  private tainted(v: unknown): boolean {
    return (typeof v === "string" || typeof v === "number") && this.values.has(String(v));
  }

  private maskString(s: string): string {
    let out = s;
    for (const v of this.values) if (v.length >= 5 && out.includes(v)) out = out.split(v).join(MASK);
    return out;
  }

  /** The function result with tainted values removed: object keys deleted, array items and scalars → null. */
  strip(result: unknown): unknown {
    if (this.values.size === 0) return result;
    const walk = (v: unknown): unknown => {
      if (this.tainted(v)) return null;
      if (typeof v === "string") return this.maskString(v);
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(v)) if (!this.tainted(x)) out[k] = walk(x);
        return out;
      }
      return v;
    };
    return walk(result);
  }
}

type Table = Readonly<Record<string, unknown>>;

/** ctx.systemDb whose document reads feed `taint` (same own-property shape the executor dispatch expects). */
export function taintedSystemDb(systemDb: unknown, taint: PiiTaint): Readonly<Record<string, Table>> {
  const out: Record<string, Table> = {};
  if (!systemDb || typeof systemDb !== "object") return out;
  for (const [entity, table] of Object.entries(systemDb as Record<string, Table>)) {
    const wrapped: Record<string, unknown> = {};
    for (const [method, fn] of Object.entries(table)) {
      wrapped[method] =
        typeof fn === "function" && DOC_METHODS.has(method)
          ? async (...a: unknown[]) => {
              const r = await (fn as (...x: unknown[]) => Promise<unknown>)(...a);
              taint.observe(entity, method, r);
              return r;
            }
          : fn;
    }
    out[entity] = Object.freeze(wrapped);
  }
  return Object.freeze(out);
}
