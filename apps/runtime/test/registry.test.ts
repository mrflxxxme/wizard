// FileRegistry + artifact loading (runtime.yaml#system_loading): 200/404/451/503, revision switch.
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dropSystemRoleDDL, quoteIdent } from "@wizard/appspec";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRuntimeApp,
  FileRegistry,
  migrateSystem,
  parseRegistry,
  type RegistryEntry,
  type RuntimeApp,
} from "../src/index.js";
import { DB_URL, devEnv, forumSpec, newKey, request } from "./helpers.js";

const spec = forumSpec();
const root = mkdtempSync(join(tmpdir(), "wz-runtime-"));
const regPath = join(root, "registry.json");
const key = newKey();
const role = `wz_rt_reg_${key.slice(0, 8)}`;
const sql = postgres(DB_URL, { max: 3, onnotice: () => {} });
let rt: RuntimeApp;

function entry(over: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    systemId: key,
    slug: "shop",
    env: "draft",
    revision: 1,
    specHash: "h1",
    bundleKey: "b1",
    publishedAt: "2026-09-30T00:00:00Z",
    suspended: false,
    features: { phoneOtp: false },
    ...over,
  };
}

function writeArtifact(revision: number, specHash: string, bundleKey: string, appName: string) {
  const dir = join(root, key, String(revision));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "spec.json"), JSON.stringify({ ...spec, app: { ...spec.app, name: appName } }));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ specHash, bundleKey }));
}

let tick = 0;
function writeRegistry(list: RegistryEntry[]) {
  writeFileSync(regPath, JSON.stringify({ deployments: list }));
  // FileRegistry re-reads on mtime change; force a distinct mtime.
  tick += 1;
  const t = new Date(Date.now() + tick * 1000);
  utimesSync(regPath, t, t);
}

const HOST = "shop--draft.localhost:4100";
const appName = async () =>
  ((await (await rt.fetch(request("GET", HOST, "/_wizard/spec"))).json()) as { app: { name: string } }).app
    .name;

beforeAll(async () => {
  await sql.unsafe(`CREATE ROLE ${quoteIdent(role)} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  await migrateSystem(sql, { systemId: key, env: "draft", spec, runtimeRole: role });
  rt = createRuntimeApp({
    db: sql,
    registry: new FileRegistry(regPath),
    artifactsRoot: root,
    dbRole: role,
    env: devEnv,
  });
});

afterAll(async () => {
  await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdent(`app_${key}_draft`)} CASCADE`);
  for (const st of dropSystemRoleDDL(`app_${key}_draft`)) await sql.unsafe(st);
  await sql.unsafe(`DROP ROLE IF EXISTS ${quoteIdent(role)}`);
  await sql.end();
  rmSync(root, { recursive: true, force: true });
});

describe("FileRegistry", () => {
  it("parses entries and skips invalid ones", () => {
    expect(parseRegistry([entry(), { ...entry(), slug: "Bad--slug" }, { systemId: "short" }])).toHaveLength(
      1,
    );
    expect(parseRegistry({ deployments: [entry()] })[0]?.features.phoneOtp).toBe(false);
  });

  it("missing registry file → 404 «Система не найдена»", async () => {
    const res = await rt.fetch(request("GET", HOST, "/_wizard/health"));
    expect(res.status).toBe(404);
  });

  it("loads the published revision and switches on a new one", async () => {
    writeArtifact(1, "h1", "b1", "Магазин 1");
    writeRegistry([entry()]);
    expect(await appName()).toBe("Магазин 1");
    const cookie = (
      (await rt.fetch(request("GET", HOST, "/_wizard/dev-login?role=organizer"))).headers.get("set-cookie") ??
      ""
    ).split(";")[0];
    expect((await rt.fetch(request("GET", HOST, "/api/data/stream", { cookie }))).status).toBe(200);
    writeArtifact(2, "h2", "b2", "Магазин 2");
    writeRegistry([entry({ revision: 2, specHash: "h2", bundleKey: "b2" })]);
    expect(await appName()).toBe("Магазин 2");
  });

  it("manifest mismatch → 503", async () => {
    writeArtifact(3, "h3", "OTHER", "Магазин 3");
    writeRegistry([entry({ revision: 3, specHash: "h3", bundleKey: "b3" })]);
    expect((await rt.fetch(request("GET", HOST, "/_wizard/spec"))).status).toBe(503);
    writeRegistry([entry({ revision: 4, specHash: "h4", bundleKey: "b4" })]);
    expect((await rt.fetch(request("GET", HOST, "/_wizard/spec"))).status).toBe(503);
  });

  it("suspended → 451 everywhere except /_wizard/health", async () => {
    writeRegistry([entry({ suspended: true })]);
    const res = await rt.fetch(request("GET", HOST, "/api/data/stream"));
    expect(res.status).toBe(451);
    expect(await res.text()).toContain("временно недоступна по жалобе");
    expect((await rt.fetch(request("GET", HOST, "/_wizard/health"))).status).toBe(200);
  });

  it("env not published → 404", async () => {
    writeRegistry([entry()]);
    expect((await rt.fetch(request("GET", "shop.localhost:4100", "/_wizard/health"))).status).toBe(404);
  });
});
