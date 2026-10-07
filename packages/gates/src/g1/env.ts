// Ephemeral G1 environment (gates.yaml#G1.setup): schema app_<systemKey>_g1_<runId>_draft with DDL+RLS and seed,
// pinned into a runtime via RuntimeHandle (architecture.yaml#interfaces.runtime_handle); dropped in finally.
import { createHash, randomBytes } from "node:crypto";
import {
  type AppSpec,
  dropSystemRoleDDL,
  planMigration,
  quoteIdent,
  SYSTEM_TABLES,
  systemRoleName,
  toDDL,
  toSystemRoleDDL,
} from "@wizard/appspec";
import type postgres from "postgres";
import type { JobRunReport, RuntimeHandle } from "../types.js";
import { syntheticEmail, syntheticName, syntheticPhone, uuidFor } from "./seed.js";
import type { Seed } from "./types.js";

export interface HttpResult {
  status: number;
  body: unknown;
}

/** Smallest valid PNG (1×1, RGBA, transparent). */
const TINY_PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  ),
);

export interface Actor {
  id: string | null;
  role: string;
  cookie: string | null;
}

const SYSTEM_KEY_RE = /^[a-z0-9][a-z0-9_]{0,40}$/;

export class G1Env {
  readonly systemKey: string;
  readonly schema: string;
  readonly slug: string;
  readonly host: string;
  readonly origin: string;
  private readonly cookieName: string;
  private userSeq = 0;

  constructor(
    private readonly db: postgres.Sql,
    readonly runtime: RuntimeHandle,
    readonly spec: AppSpec,
    systemKey: string,
    readonly runId: string,
    readonly runtimeRole: string,
    /** Ephemeral schema tag: app_<key>_<tag>_<runId>_draft (G1 and G2 runs). */
    tag: "g1" | "g2" = "g1",
  ) {
    if (!SYSTEM_KEY_RE.test(systemKey)) throw new Error(`invalid systemKey ${systemKey}`);
    this.systemKey = `${systemKey}_${tag}_${runId}`;
    this.schema = `app_${this.systemKey}_draft`;
    this.slug = `${tag}-${runId}`;
    const scheme = runtime.env?.publicScheme ?? "http";
    this.host = `${this.slug}--draft.${runtime.env?.systemsDomain ?? "localhost"}`;
    this.origin = `${scheme}://${this.host}`;
    this.cookieName = scheme === "https" ? "__Host-wz_sess" : "wz_sess";
  }

  private get s() {
    return quoteIdent(this.schema);
  }

  /** sys_<key>_g1_<runId>_draft_system: system access of the ephemeral schema (isolation.yaml#db_access, L3-20). */
  get systemRole(): string {
    return systemRoleName(this.schema);
  }

  async migrate(): Promise<void> {
    // The system role is SET by the runtime role and by this connection's session user (seed, reset).
    const [who] = await this.db`select session_user as u`;
    const members = [this.runtimeRole, String(who?.u)];
    for (const st of toSystemRoleDDL(this.schema, { members })) await this.db.unsafe(st);
    const plan = planMigration(null, this.spec, { env: "draft" });
    const statements = toDDL(plan, this.schema, {
      runtimeRole: this.runtimeRole,
      systemRole: this.systemRole,
    });
    await this.db.begin(async (tx) => {
      for (const st of statements) await tx.unsafe(st);
    });
  }

  async drop(): Promise<void> {
    await this.db.unsafe(`DROP SCHEMA IF EXISTS ${this.s} CASCADE`);
    for (const st of dropSystemRoleDDL(this.schema)) await this.db.unsafe(st);
  }

  async load(artifactDir: string | null, spec: AppSpec = this.spec): Promise<void> {
    await this.runtime.loadSystem({
      systemKey: this.systemKey,
      env: "draft",
      spec,
      artifactDir,
      slug: this.slug,
    });
  }

  /** Runs fn as the schema's system DB role (policy wz__system; RLS is FORCEd for the owner too). */
  async system<T>(
    fn: (tx: postgres.TransactionSql) => Promise<T>,
    before?: (tx: postgres.TransactionSql) => Promise<unknown>,
  ): Promise<T> {
    return (await this.db.begin(async (tx) => {
      if (before) await before(tx);
      await tx.unsafe(`set local role ${quoteIdent(this.systemRole)}`);
      return fn(tx);
    })) as T;
  }

  async insert(tx: postgres.TransactionSql, table: string, row: Record<string, unknown>) {
    const cols = Object.keys(row);
    await tx.unsafe(
      `insert into ${this.s}.${quoteIdent(table)} (${cols.map(quoteIdent).join(", ")}) values (${cols
        .map((_, i) => `$${i + 1}`)
        .join(", ")})`,
      cols.map((c) => {
        const v = row[c];
        return (v !== null && typeof v === "object" ? JSON.stringify(v) : v) as never;
      }),
    );
  }

  /** Empties every table and loads the seed (null → empty system, scenario seed: none). */
  async reset(seed: Seed | null): Promise<void> {
    const tables = [...Object.keys(SYSTEM_TABLES), ...this.spec.entities.map((e) => e.name)];
    // TRUNCATE needs the owner's privilege (and ignores RLS): it runs before switching to the system role.
    await this.system(
      async (tx) => {
        if (!seed) return;
        for (const u of seed.users) await this.insert(tx, "users", { ...u });
        for (const name of seed.order)
          for (const row of seed.rows[name] ?? []) await this.insert(tx, name, row);
      },
      (tx) => tx.unsafe(`TRUNCATE ${tables.map((t) => `${this.s}.${quoteIdent(t)}`).join(", ")} CASCADE`),
    );
  }

  /**
   * Runs fn as the runtime DB role under a subject (SET LOCAL ROLE + set_config(…, true): RLS applies like for the
   * runtime) and always rolls back. G2-PERM-02 probes the policies directly with it.
   */
  async rolledBack<T>(
    subject: { role: string; id: string | null; attrs: Record<string, unknown> },
    fn: (tx: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> {
    const rollback = new Error("rollback");
    let out: { v: T } | null = null;
    try {
      await this.db.begin(async (tx) => {
        await tx.unsafe(`set local role ${quoteIdent(this.runtimeRole)}`);
        await tx.unsafe(
          "select set_config('wizard.role', $1, true), set_config('wizard.user_id', $2, true), set_config('wizard.user_attrs', $3, true)",
          [subject.role, subject.id ?? "", JSON.stringify(subject.attrs)],
        );
        out = { v: await fn(tx) };
        throw rollback;
      });
    } catch (e) {
      if (e !== rollback) throw e;
    }
    return (out as { v: T } | null)?.v as T;
  }

  /** All rows of an entity (as the system role; G1 browser checks read what a goal scenario created). */
  async rows(entity: string): Promise<Record<string, unknown>[]> {
    if (!this.spec.entities.some((e) => e.name === entity)) return [];
    return this.system(async (tx) => [
      ...(await tx.unsafe(
        `select * from ${this.s}.${quoteIdent(entity)} order by created_at desc limit 500`,
      )),
    ]);
  }

  async insertRow(entity: string, row: Record<string, unknown>): Promise<void> {
    await this.system((tx) => this.insert(tx, entity, row));
  }

  async readColumn(entity: string, column: string, id: string): Promise<unknown> {
    return this.system(async (tx) => {
      const rows = await tx.unsafe(
        `select ${quoteIdent(column)} as v from ${this.s}.${quoteIdent(entity)} where id = $1`,
        [id],
      );
      return rows[0]?.v ?? null;
    });
  }

  /** Session cookie for an existing user (runtime.yaml#auth.session_cookie: sha256 of the token in _w_sessions). */
  async login(userId: string, role: string): Promise<Actor> {
    const token = randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(token).digest();
    await this.system((tx) =>
      tx.unsafe(
        `insert into ${this.s}."_w_sessions" (token_hash, user_id, expires_at) values ($1, $2, now() + interval '1 day')`,
        [hash, userId],
      ),
    );
    return { id: userId, role, cookie: `${this.cookieName}=${token}` };
  }

  /** New synthetic user (actors of scenarios) with a session; numbers start after the seed range. */
  async newUser(role: string): Promise<Actor> {
    this.userSeq += 1;
    const n = 9000 + this.userSeq;
    const id = uuidFor(this.runId, "actor", this.userSeq);
    await this.system((tx) =>
      this.insert(tx, "users", {
        id,
        role,
        display_name: syntheticName(n),
        email: syntheticEmail(n),
        phone: syntheticPhone(n),
      }),
    );
    return this.login(id, role);
  }

  /**
   * Runtime outbox of this environment's system. Gates share one long-lived runtime and the platform drops the
   * messages of finished gates in place (B2-28), so a gate counts its own system's messages — never positions in the
   * whole outbox (B2-41: a parallel gate finishing mid-scenario hid the scenario's messages). Messages without a
   * system tag (test handles) are kept; the runtime never drops them.
   */
  outbox(): ReturnType<RuntimeHandle["outbox"]> {
    const key = this.systemKey;
    return this.runtime.outbox().filter((m) => m.system == null || m.system === key);
  }

  /** One job-runner pass at `now` (runWorkflows/advanceTime); null when the runtime has no runner. */
  async runJobs(now: Date, since: Date): Promise<JobRunReport | null> {
    if (!this.runtime.runJobs) return null;
    return this.runtime.runJobs({ slug: this.slug, env: "draft", now, since });
  }

  anonymous(role = "anon"): Actor {
    return { id: null, role, cookie: null };
  }

  /** Request with a raw JSON body (page renders forward the SDK's own body); returns the raw text. */
  async raw(
    actor: Actor,
    method: string,
    path: string,
    payload?: string,
  ): Promise<{ status: number; text: string }> {
    const headers: Record<string, string> = { host: this.host };
    if (actor.cookie) headers.cookie = actor.cookie;
    if (method !== "GET" && method !== "HEAD") {
      headers.origin = this.origin;
      headers["x-wizard-request"] = "1";
    }
    if (payload !== undefined) headers["content-type"] = "application/json";
    const res = await this.runtime.fetch(
      new Request(`${this.origin}${path}`, { method, headers, body: payload }),
    );
    return { status: res.status, text: await res.text() };
  }

  /**
   * Uploads a 1×1 PNG into entity.field as the actor (POST /api/files, runtime.yaml#files, M2-14): a required file field
   * of a create probe needs a real upload of the writer. null when the runtime refuses it.
   */
  async upload(actor: Actor, entity: string, field: string): Promise<string | null> {
    const form = new FormData();
    form.set("file", new File([TINY_PNG], "g1.png", { type: "image/png" }));
    form.set("entity", entity);
    form.set("field", field);
    const headers: Record<string, string> = { host: this.host, origin: this.origin, "x-wizard-request": "1" };
    if (actor.cookie) headers.cookie = actor.cookie;
    const res = await this.runtime.fetch(
      new Request(`${this.origin}/api/files`, { method: "POST", headers, body: form }),
    );
    const json = (await res.json().catch(() => null)) as { fileId?: unknown } | null;
    return res.status === 201 && typeof json?.fileId === "string" ? json.fileId : null;
  }

  async request(actor: Actor, method: string, path: string, body?: unknown): Promise<HttpResult> {
    const res = await this.raw(actor, method, path, body === undefined ? undefined : JSON.stringify(body));
    const text = res.text;
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { status: res.status, body: parsed };
  }
}

export const errorCode = (r: HttpResult): string | undefined =>
  (r.body as { error?: { code?: string } } | null)?.error?.code;
