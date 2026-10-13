// V4-04 acceptance 2: a failed build of the founder becomes an issue in the platform repository with the link to its
// report and to the records of its model calls — on a GitHub stub: one issue per run (the next sweep sends nothing), a
// failed POST is tried again by the next sweep, a client's failed build and a run without a report send nothing, no
// token — nothing at all.
import { randomUUID } from "node:crypto";
import { createDb, DEFAULT_ORG_ID, DEV_USER_ID, migrate } from "@wizard/platform-api";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { BuildReport } from "../../platform-api/src/builds-v3/report/index.js";
import { saveBuildReport } from "../../platform-api/src/builds-v3/report/store.js";
import { createTestDb } from "../../platform-api/test/helpers.js";
import { MemoryFileStorage } from "../../runtime/src/index.js";
import { fileBuildIssues, githubIssuesFromEnv, issueTitle } from "../src/report/issues.js";

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let handle: ReturnType<typeof createDb>;
const files = new MemoryFileStorage();
const GH = { token: "ghp_test", repo: "acme/platform" };

beforeAll(async () => {
  tdb = await createTestDb("buildissues");
  handle = createDb(tdb.url);
  await migrate(handle.db);
}, 60_000);

afterAll(async () => {
  await handle?.close();
  await tdb?.drop();
});

async function failedRun(kind: "staff" | "client"): Promise<string> {
  const orgId = kind === "staff" ? DEFAULT_ORG_ID : randomUUID();
  if (kind === "client")
    await handle.pg`insert into platform.orgs (id, name, kind) values (${orgId}, 'Клиент', 'client')`;
  else await handle.pg`update platform.orgs set kind = 'staff' where id = ${orgId}`;
  const [row] = await handle.pg<{ id: string }[]>`
    insert into platform.runs (org_id, kind, status, input, failure_code, failure_message_ru, started_by, started_at,
      finished_at)
    values (${orgId}, 'build', 'failed', '{}'::jsonb, 'GATES_FAILED', 'Сценарий записи не прошёл', ${DEV_USER_ID},
      now() - interval '10 minutes', now())
    returning id`;
  return (row as { id: string }).id;
}

function report(runId: string): BuildReport {
  return {
    v: 1,
    runId,
    systemId: null,
    systemName: "Клиника «Улыбка»",
    orgId: DEFAULT_ORG_ID,
    orgKind: "staff",
    startedBy: DEV_USER_ID,
    status: "failed",
    failure: { code: "GATES_FAILED", message: "Сценарий записи не прошёл" },
    startedAt: null,
    finishedAt: null,
    minutes: 12.5,
    rub: 41.2,
    stages: [{ stage: "scenarios", status: "failed", rub: 30, minutes: 9 }],
    scenarios: [
      {
        id: "s_book",
        status: "failed",
        problems: ["Форма записи не отправляется"],
        http: [
          {
            scenario: "s_book",
            method: "POST",
            url: "/api/fn/book",
            status: 500,
            type: "fetch",
            body: "boom",
          },
        ],
      },
    ],
    gates: [],
    critic: { scores: [54, 61], stop: "target", note: null },
    techreview: null,
    calls: [],
    shots: [],
    records: `wz_reports/${randomUUID()}`,
    gaps: [],
    createdAt: new Date().toISOString(),
  };
}

function stub(status = 201) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ html_url: "https://github.com/acme/platform/issues/1" }), {
      status,
    });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const sweep = (f: typeof fetch, github = GH) =>
  fileBuildIssues({
    pg: handle.pg,
    files,
    platformOrigin: "https://wizard.example",
    founderEmail: null,
    github,
    fetch: f,
  });

describe("V4-04: an issue for a failed founder build", () => {
  test("one issue with the link to the report and the records; the next sweep sends nothing", async () => {
    const runId = await failedRun("staff");
    await saveBuildReport(files, report(runId));
    const gh = stub();
    expect(await sweep(gh.f)).toBe(1);
    expect(gh.calls).toHaveLength(1);
    const call = gh.calls[0] as { url: string; init: RequestInit };
    expect(call.url).toBe("https://api.github.com/repos/acme/platform/issues");
    expect((call.init.headers as Record<string, string>).authorization).toBe("Bearer ghp_test");
    const body = JSON.parse(String(call.init.body)) as { title: string; body: string };
    expect(body.title).toBe(issueTitle(report(runId)));
    expect(body.title).toContain("GATES_FAILED");
    expect(body.body).toContain(`https://wizard.example/api/v1/admin/runs/${runId}/report`);
    expect(body.body).toContain(`/report/files/wz_reports/`);
    expect(body.body).toContain("POST /api/fn/book → 500");
    expect(await sweep(gh.f)).toBe(0);
    expect(gh.calls).toHaveLength(1);
  });

  test("a failed POST is tried again; a client's build and a run without a report send nothing", async () => {
    const runId = await failedRun("staff");
    await saveBuildReport(files, report(runId));
    const down = stub(502);
    expect(await sweep(down.f)).toBe(0);
    expect(down.calls).toHaveLength(1);
    const up = stub();
    expect(await sweep(up.f)).toBe(1);

    const client = await failedRun("client");
    await saveBuildReport(files, { ...report(client), orgKind: "client" });
    await failedRun("staff"); // no report
    const none = stub();
    expect(await sweep(none.f)).toBe(0);
    expect(none.calls).toHaveLength(0);
  });

  test("no token or repository — nothing is sent", async () => {
    expect(githubIssuesFromEnv({})).toBeNull();
    expect(
      githubIssuesFromEnv({ WIZARD_GITHUB_ISSUES_TOKEN: "t", WIZARD_GITHUB_ISSUES_REPO: "bad repo" }),
    ).toBeNull();
    expect(
      githubIssuesFromEnv({ WIZARD_GITHUB_ISSUES_TOKEN: "t", WIZARD_GITHUB_ISSUES_REPO: "a/b" }),
    ).toEqual({
      token: "t",
      repo: "a/b",
    });
    const runId = await failedRun("staff");
    await saveBuildReport(files, report(runId));
    const gh = stub();
    expect(
      await fileBuildIssues({
        pg: handle.pg,
        files,
        platformOrigin: "x",
        founderEmail: null,
        github: null,
        fetch: gh.f,
      }),
    ).toBe(0);
    expect(gh.calls).toHaveLength(0);
  });
});
