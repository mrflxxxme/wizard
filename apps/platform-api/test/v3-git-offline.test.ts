// V3-30 acceptance: build and publish do not depend on external git. The whole flow — interview, build (ops and
// files), compliance, publish — runs with every outbound connection except loopback refused and with a `git` on PATH
// that only records being called; the system repository still gets a commit per revision, and its preview and prod
// refs point at the commits of the published revisions.
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startBuild } from "./flow.js";
import {
  createTestDb,
  fakeExecutors,
  fakeRouterFactory,
  startApi,
  type TestApi,
  waitRun,
} from "./helpers.js";
import { expectContract } from "./session.js";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const refused: string[] = [];
const origConnect = net.Socket.prototype.connect;
const origFetch = globalThis.fetch;
const binDir = mkdtempSync(join(tmpdir(), "wz-nogit-"));
const marker = join(binDir, "git-called");
const origPath = process.env.PATH;

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;

beforeAll(async () => {
  // No network beyond this machine: Postgres on localhost stays reachable, anything else is refused.
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    const first = args[0] as { host?: string; path?: string } | number | string;
    const host =
      typeof first === "object" && first !== null
        ? first.path
          ? "localhost"
          : (first.host ?? "localhost")
        : typeof args[1] === "string"
          ? args[1]
          : "localhost";
    if (!LOOPBACK.has(host)) {
      refused.push(host);
      throw new Error(`network is off in this test: ${host}`);
    }
    return (origConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!LOOPBACK.has(url.hostname)) {
      refused.push(url.hostname);
      throw new Error(`network is off in this test: ${url.hostname}`);
    }
    return origFetch(input, init);
  }) as typeof fetch;
  // A `git` that only leaves a marker: nothing in the flow may need the binary.
  writeFileSync(join(binDir, "git"), `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
  chmodSync(join(binDir, "git"), 0o755);
  process.env.PATH = `${binDir}:${origPath ?? ""}`;

  tdb = await createTestDb("v3gitoff", { migrator: true });
  api = await startApi(tdb.url, {
    executors: fakeExecutors({ spec: "forum" }),
    createRouter: fakeRouterFactory(),
    publish: {
      smoke: async () => ({ ok: true }),
      lockRetryDelaysMs: [10, 10, 10],
      telegram: { mode: "outbox", outboxDir: null },
    },
  });
}, 60_000);

afterAll(async () => {
  await api?.dispose();
  await tdb?.drop();
  net.Socket.prototype.connect = origConnect;
  globalThis.fetch = origFetch;
  process.env.PATH = origPath;
  rmSync(binDir, { recursive: true, force: true });
});

describe("build and publish without external git", () => {
  test("every revision is a commit; preview and prod refs; no network, no git binary", async () => {
    const b = await startBuild(api);
    const run = await waitRun(api, b.buildRunId, ["succeeded"], 20_000);
    expect(run.status).toBe("succeeded");
    const s0 = await api.req("GET", `/systems/${b.systemId}`);
    const put = await api.req("PUT", `/systems/${b.systemId}/compliance`, {
      body: {
        expectedVersion: s0.body.system.draftRevision,
        operatorName: "ООО «Северный ритейл»",
        operatorContact: "privacy@north-retail.example",
        operatorAddress: "г. Москва, ул. Тверская, д. 1",
        operatorInn: "500100732259",
      },
    });
    expect(put.status, put.text).toBe(200);
    const revision = put.body.revision.version as number;
    const pub = await api.req("POST", `/systems/${b.systemId}/publish`, {
      body: { revision, confirmDiff: true },
    });
    expect(pub.status, pub.text).toBe(202);
    const published = await waitRun(api, pub.body.run.id, ["succeeded"], 30_000);
    expect(published.status).toBe("succeeded");

    const sys = await api.deps.db
      .selectFrom("platform.systems")
      .select(["draft_revision", "preview_revision", "prod_revision"])
      .where("id", "=", b.systemId)
      .executeTakeFirstOrThrow();
    expect(sys.prod_revision).toBe(revision);
    // The commits were written by the revision transactions themselves, before any read of the repository.
    const rows = await api.deps.pg<{ revision: number | null }[]>`
      select revision from platform.system_git_commits where system_id = ${b.systemId} order by seq`;
    const revisions = rows.map((r) => r.revision).filter((r): r is number => r !== null);
    expect(revisions).toEqual(Array.from({ length: sys.draft_revision }, (_, i) => i + 1));

    const repo = await api.req("GET", `/systems/${b.systemId}/repo`);
    expect(repo.status, repo.text).toBe(200);
    expectContract("getSystemRepo", repo);
    expect(repo.body.behind).toBe(false);
    expect(repo.body.refs.prod?.revision).toBe(revision);
    expect(repo.body.refs.preview?.revision).toBe(sys.preview_revision);
    expect(repo.body.head.revision).toBe(sys.draft_revision);
    const prodCommit = await api.req("GET", `/systems/${b.systemId}/repo/revisions/${revision}`);
    expect(prodCommit.body.commit.subject).toMatch(/^Правка: Сведения об операторе ПДн/);
    expect(prodCommit.body.commit.oid).toBe(repo.body.refs.prod.oid);
    const first = await api.req("GET", `/systems/${b.systemId}/repo/revisions/1`);
    expect(first.body.commit.subject).toMatch(/^Сборка: /);

    expect(refused).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  }, 60_000);

  test("the guard works: an outbound connection is refused here", async () => {
    const before = refused.length;
    await expect(origFetch("https://example.com/")).rejects.toThrow();
    expect(refused.length).toBeGreaterThan(before);
    refused.length = before;
  });
});
