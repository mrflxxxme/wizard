// G2 fixture cases (scripts/gen-g2-fixtures.mjs) → GateContext; static/dynamic check id sets.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type AppSpec, quoteIdent } from "@wizard/appspec";
import type postgres from "postgres";
import { type DynamicOptions, G2_CHECKS, type GateContext } from "../src/index.js";
import { loadBakery } from "./g1-helpers.js";
import { forumCtx, forumFiles, loadForum, PKG_ROOT } from "./helpers.js";

export type Patch = { op: "set" | "push" | "remove"; path: string; value?: unknown };

export interface G2Case {
  check?: string;
  expect: "block" | "allow" | "pass" | "fail" | "warn";
  description: string;
  base: "forum" | "bakery" | "inline";
  spec?: Patch[] | AppSpec;
  files?: Record<string, string | null>;
  milestone?: string;
  env?: "draft" | "prod";
  slug?: string;
  abuse?: GateContext["abuse"];
  /** Existing vault secrets for prod ("*" = all). */
  secrets?: string[];
  sql?: string[];
  runtimeSpec?: Patch[];
  match?: string;
}

export const DYNAMIC_IDS = ["G2-PERM-01", "G2-PERM-02", "G2-PERM-03", "G2-PERM-04"];
export const STATIC_IDS = G2_CHECKS.map((c) => c.id).filter((id) => !DYNAMIC_IDS.includes(id));
export const ANTIFRAUD_DIR = join(PKG_ROOT, "test/antifraud");
export const FIXTURES_DIR = join(PKG_ROOT, "test/fixtures");

export function applyPatches<T>(doc: T, patches: Patch[] = []): T {
  const root = structuredClone(doc) as unknown as Record<string, unknown>;
  for (const p of patches) {
    const segs = p.path
      .split("/")
      .slice(1)
      .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
    const last = segs.pop() as string;
    let cur: Record<string, unknown> | unknown[] = root;
    for (const s of segs) cur = (cur as Record<string, unknown>)[s] as Record<string, unknown>;
    if (p.op === "set") (cur as Record<string, unknown>)[last] = p.value;
    else if (p.op === "push") ((cur as Record<string, unknown>)[last] as unknown[]).push(p.value);
    else if (Array.isArray(cur)) cur.splice(Number(last), 1);
    else delete cur[last];
  }
  return root as unknown as T;
}

export function readCases(dir: string): Map<string, G2Case> {
  const out = new Map<string, G2Case>();
  for (const sub of readdirSync(dir).sort()) {
    for (const f of readdirSync(join(dir, sub)).sort())
      out.set(`${sub}/${f}`, JSON.parse(readFileSync(join(dir, sub, f), "utf8")) as G2Case);
  }
  return out;
}

export function materialize(
  c: G2Case,
  db: postgres.Sql,
  over: Partial<GateContext> = {},
): { ctx: GateContext; dynamic: DynamicOptions } {
  let spec: AppSpec;
  let files: Map<string, string>;
  if (c.base === "inline") {
    spec = structuredClone(c.spec as AppSpec);
    files = new Map();
  } else {
    const b = c.base === "bakery" ? loadBakery() : { spec: loadForum(), files: forumFiles() };
    spec = applyPatches(b.spec, (c.spec as Patch[] | undefined) ?? []);
    files = b.files;
  }
  for (const [p, v] of Object.entries(c.files ?? {})) {
    if (v === null) files.delete(p);
    else files.set(p, v);
  }
  const secrets = c.secrets;
  const ctx = forumCtx(db, {
    spec,
    files,
    milestone: c.milestone ?? "M2",
    env: c.env ?? "draft",
    ...(c.slug ? { slug: c.slug } : {}),
    ...(c.abuse ? { abuse: c.abuse } : {}),
    ...(secrets ? { secretExists: async (n: string) => secrets.includes("*") || secrets.includes(n) } : {}),
    ...over,
  });
  const dynamic: DynamicOptions = {
    ...(c.sql?.length
      ? {
          afterMigrate: async (sql: postgres.Sql, schema: string) => {
            for (const st of c.sql ?? []) await sql.unsafe(st.replaceAll("{schema}", quoteIdent(schema)));
          },
        }
      : {}),
    ...(c.runtimeSpec ? { runtimeSpec: applyPatches(spec, c.runtimeSpec) } : {}),
  };
  return { ctx, dynamic };
}
