// Ephemeral G1 environment (gates.yaml#G1.setup): schema app_<systemKey>_g1_<runId>_draft with DDL+RLS and seed,
// pinned into a runtime via RuntimeHandle (architecture.yaml#interfaces.runtime_handle); dropped in finally.
import { createHash, randomBytes } from "node:crypto";
import { type AppSpec, planMigration, quoteIdent, SYSTEM_ROLE, SYSTEM_TABLES, toDDL } from "@wizard/appspec";
import type postgres from "postgres";
import type { JobRunReport, RuntimeHandle } from "../types.js";
import { syntheticEmail, syntheticName, syntheticPhone, uuidFor } from "./seed.js";
import type { Seed } from "./types.js";

export interface HttpResult {
  status: number;
  body: unknown;
}

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
    private readonly runtimeRole: string,
  ) {
    if (!SYSTEM_KEY_RE.test(systemKey)) throw new Error(`invalid systemKey ${systemKey}`);
    this.systemKey = `${systemKey}_g1_${runId}`;
    this.schema = `app_${this.systemKey}_draft`;
    this.slug = `g1-${runId}`;
    const scheme = runtime.env?.publicScheme ?? "http";
    this.host = `${this.slug}--draft.${runtime.env?.systemsDomain ?? "localhost"}`;
    this.origin = `${scheme}://${this.host}`;
    this.cookieName = scheme === "https" ? "__Host-wz_sess" : "wz_sess";
  }

  private get s() {
    return quoteIdent(this.schema);
  }

  async migrate(): Promise<void> {
    const plan = planMigration(null, this.spec, { env: "draft" });
    const statements = toDDL(plan, this.schema, { runtimeRole: this.runtimeRole });
    await this.db.begin(async (tx) => {
      for (const st of statements) await tx.unsafe(st);
    });
  }

  async drop(): Promise<void> {
    await this.db.unsafe(`DROP SCHEMA IF EXISTS ${this.s} CASCADE`);
  }

  async load(artifactDir: string | null): Promise<void> {
    await this.runtime.loadSystem({
      systemKey: this.systemKey,
      env: "draft",
      spec: this.spec,
      artifactDir,
      slug: this.slug,
    });
  }

  /** Runs fn as the system role (bypasses row policies via wz__system; RLS is FORCEd for the owner too). */
  async system<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    return (await this.db.begin(async (tx) => {
      await tx.unsafe("select set_config('wizard.role', $1, true)", [SYSTEM_ROLE]);
      return fn(tx);
    })) as T;
  }

  private async insert(tx: postgres.TransactionSql, table: string, row: Record<string, unknown>) {
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
    await this.system(async (tx) => {
      await tx.unsafe(`TRUNCATE ${tables.map((t) => `${this.s}.${quoteIdent(t)}`).join(", ")} CASCADE`);
      if (!seed) return;
      for (const u of seed.users) await this.insert(tx, "users", { ...u });
      for (const name of seed.order)
        for (const row of seed.rows[name] ?? []) await this.insert(tx, name, row);
    });
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
