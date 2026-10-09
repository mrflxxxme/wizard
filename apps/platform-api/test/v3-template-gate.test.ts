// V3-14 acceptance, platform part (builder-v3.md §3 C6 stage template_gate, db.yaml#system_site_fingerprints): the
// memory of the template gate — the latest fingerprint of every other live system of the niche and of the same
// organisation — and the hook's decisions: over the threshold → redesign {avoid: the current archetype first, then
// those of the near-duplicates}; a second hit in the run or a direction the owner pinned → a note, never a loop; a
// broken capture falls back to the structure. End to end: «Собрать» of a system whose site repeats a recent site of
// its niche goes back to the art director, the draft gets another archetype. The fingerprints go with the system.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  briefNiche,
  designCss,
  SITE_PATH,
  type SiteModel,
  type V3BuildContext,
  type V3StageHook,
} from "@wizard/agents/builder";
import { systemBriefSchema } from "@wizard/appspec";
import { siteStructure } from "@wizard/gates";
import { createRouter, type Router, type RouterOptions } from "@wizard/llm";
import { closeExecutors, MemoryFileStorage } from "@wizard/runtime";
import type { DesignSystemV3 } from "@wizard/ui-kit/v3/design";
import { PATTERNS } from "@wizard/ui-kit/v3/patterns";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  clinicBrief,
  fakeComposer,
  pageComposeMessages,
  v3Lines,
  writeFixture,
} from "../../../packages/agents/test/v3-harness-fixtures.js";
import { createAgentExecutors } from "../src/agents/executors.js";
import { OutboxMailer } from "../src/auth/mailer.js";
import { saveBriefVersion } from "../src/briefs/store.js";
import { startV3Build } from "../src/builds-v3/start.js";
import {
  patternLookup,
  saveTemplateFingerprint,
  structureCapture,
  templateGateHook,
  templateGateHooks,
  templateMemory,
} from "../src/builds-v3/template-gate.js";
import { DEFAULT_ORG_ID, DEV_USER_ID, json } from "../src/db/index.js";
import { purgeDeletedSystems } from "../src/privacy/delete-system.js";
import { listEvents } from "../src/runs/events.js";
import { createTestDb, startApi, type TestApi, waitRun } from "./helpers.js";

/** One «must» scenario of the clinic (the request form) keeps the two end-to-end builds short. */
function leadBrief() {
  const b = clinicBrief();
  return { ...b, scenarios: (b.scenarios ?? []).filter((s) => s.id === "s_lead") };
}

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
let outboxDir: string;
let fixtureDir: string;
/** The template gate of the next build (the executors take one hook; each build gets a fresh one, as in host.ts). */
let gate: V3StageHook = async () => ({ status: "skipped" });

beforeAll(async () => {
  tdb = await createTestDb("v3tpl", { migrator: true });
  outboxDir = mkdtempSync(join(tmpdir(), "wz-v3t-outbox-"));
  const brief = systemBriefSchema.parse(leadBrief());
  fixtureDir = writeFixture(
    "clinic",
    v3Lines({
      brief: { goals: brief.goals, audience: brief.audience },
      niche: briefNiche(brief),
      seed: "x",
      pages: 10,
      prompt: pageComposeMessages({ brief, design: {} as never }, brief.scenarios[0] as never),
    }),
  );
  api = await startApi(tdb.url, {
    config: { unsafeLocalExec: true },
    createRouter: (opts: RouterOptions): Router =>
      createRouter({
        ...opts,
        mode: "fixture",
        fixture: { suite: "demo", name: "v3/clinic", dir: fixtureDir },
        env: {},
      }),
    executors: ({ pg, config }) =>
      createAgentExecutors({
        pg,
        config,
        v3: {
          enabled: true,
          composer: fakeComposer(),
          mailer: new OutboxMailer(outboxDir),
          hooks: { template_gate: (ctx) => gate(ctx) },
        },
      }),
  });
}, 60_000);

afterAll(async () => {
  await api?.dispose();
  await closeExecutors();
  await tdb?.drop();
  rmSync(outboxDir, { recursive: true, force: true });
  rmSync(fixtureDir, { recursive: true, force: true });
});

async function addOrg(): Promise<string> {
  const o = await api.deps.db
    .insertInto("platform.orgs")
    .values({ name: "Другая организация" })
    .returning("id")
    .executeTakeFirstOrThrow();
  return o.id;
}

/** A system of `orgId` (unit tests use an organisation of their own: the memory spans the organisation). */
async function addSystem(name: string, orgId: string): Promise<string> {
  const key = randomUUID().replace(/-/g, "").slice(0, 12);
  const row = await api.deps.db
    .insertInto("platform.systems")
    .values({
      org_id: orgId,
      slug: `t-${key}`,
      schema_key: key,
      name,
      pending_questions: json([]),
      created_by: DEV_USER_ID,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

const TYPES = ["header", "hero", "services", "testimonials", "faq", "form", "footer"] as const;

/** A one-page site model on library patterns: the n-th variant of every section type. */
function siteOf(n: number, archetype = "calm_medical"): SiteModel {
  return {
    version: 1,
    seed: "t",
    archetype,
    primary: null,
    pages: [
      {
        route: "/",
        title: "Главная",
        kind: "home",
        file: "ui/pages/site/Home.tsx",
        component: "Home",
        nav: "Главная",
        header: true,
        roles: ["guest"],
        seo: { title: "Главная", description: "Главная" },
        sections: TYPES.map((t) => {
          const list = PATTERNS.filter((p) => p.sectionType === t);
          const p = list[n % list.length];
          if (!p) throw new Error(`no pattern ${t}`);
          return { id: t, type: t, pattern: p.id, props: {} };
        }),
      },
    ],
  };
}

/** What the hook reads of the build context: the site model, the design (niche, archetype), the brief's design. */
function ctxOf(
  systemId: string,
  o: { site: SiteModel | null; niche: string; archetype: string; pinned?: boolean },
) {
  return {
    systemId,
    brief: { design: { references: [], ...(o.pinned ? { archetype: o.archetype, pinned: true } : {}) } },
    design: { niche: o.niche, archetype: o.archetype },
    files: new Map(o.site ? [[SITE_PATH, JSON.stringify(o.site)]] : []),
  } as unknown as V3BuildContext;
}

const remember = (systemId: string, niche: string, archetype: string, site: SiteModel) =>
  saveTemplateFingerprint(api.deps.pg, {
    systemId,
    runId: null,
    niche,
    archetype,
    fingerprint: siteStructure(site, patternLookup),
    similarity: null,
  });

const row = async (systemId: string) =>
  (
    await api.deps.pg<{ archetype: string; similarity: string | null; niche: string }[]>`
      select f.archetype, f.similarity, f.niche from platform.system_site_fingerprints f where f.system_id = ${systemId}`
  )[0];

describe("memory of the template gate", () => {
  test("other live systems of the niche and of the organisation, newest first, each once; a rebuild replaces", async () => {
    const niche = `ниша ${randomUUID().slice(0, 8)}`;
    const elsewhere = `другая ${randomUUID().slice(0, 8)}`;
    const org = await addOrg();
    const otherOrg = await addOrg();
    const me = await addSystem("Я", org);
    const sameNiche = await addSystem("Та же ниша", org);
    const foreignNiche = await addSystem("Та же ниша, другая организация", otherOrg);
    const sameOrg = await addSystem("Та же организация, другая ниша", org);
    const stranger = await addSystem("Другая ниша и организация", otherOrg);
    const deleted = await addSystem("Удалённая", org);
    await remember(sameNiche, niche, "swiss", siteOf(0));
    await remember(foreignNiche, niche, "editorial", siteOf(1));
    await remember(sameOrg, elsewhere, "luxury", siteOf(2));
    await remember(stranger, elsewhere, "natural", siteOf(3));
    await remember(deleted, niche, "warm_craft", siteOf(4));
    await remember(me, niche, "calm_medical", siteOf(0));
    await api.deps.pg`update platform.systems set deleted_at = now() where id = ${deleted}`;

    const memory = await templateMemory(api.deps.pg, me, niche);
    const ids = memory.map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining([sameNiche, foreignNiche, sameOrg]));
    expect(ids).not.toContain(stranger);
    expect(ids).not.toContain(deleted);
    expect(ids).not.toContain(me);
    expect(new Set(ids).size).toBe(ids.length);
    expect(memory.find((m) => m.id === foreignNiche)).toMatchObject({ archetype: "editorial" });
    expect(memory.find((m) => m.id === foreignNiche)?.fingerprint.pages[0]?.sections).toHaveLength(
      TYPES.length,
    );

    // Limits keep the newest only: the latest of the niche, the latest of the organisation.
    const newest = await templateMemory(api.deps.pg, me, niche, { niche: 1, org: 1 });
    expect(newest.map((m) => m.id).sort()).toEqual([foreignNiche, sameOrg].sort());

    // One row per system: a rebuild replaces the fingerprint, its archetype and niche.
    await remember(sameNiche, niche, "bold_poster", siteOf(5));
    const [n] = await api.deps.pg<{ n: number }[]>`
      select count(*)::int as n from platform.system_site_fingerprints where system_id = ${sameNiche}`;
    expect(n?.n).toBe(1);
    expect((await row(sameNiche))?.archetype).toBe("bold_poster");
  });
});

describe("template_gate hook", () => {
  test("over the threshold: redesign without the current archetype and the near-duplicate's; once per run", async () => {
    const niche = `ниша ${randomUUID().slice(0, 8)}`;
    const org = await addOrg();
    const old = await addSystem("Недавний сайт ниши", org);
    const me = await addSystem("Новый сайт ниши", org);
    await remember(old, niche, "swiss", siteOf(0));
    const hook = templateGateHook({ pg: api.deps.pg, runId: null, capture: structureCapture });
    const ctx = ctxOf(me, { site: siteOf(0), niche, archetype: "calm_medical" });

    const first = await hook(ctx);
    expect(first.status).toBe("done");
    expect(first.redesign).toEqual({ avoid: ["calm_medical", "swiss"] });
    expect(first.note).toMatch(/шаблонность 100 %/);
    expect(await row(me)).toMatchObject({ archetype: "calm_medical", similarity: "1.000", niche });

    // The same run asks again (a harness that re-checks after the redesign): a note, not a second redesign.
    const second = await hook(ctx);
    expect(second.redesign).toBeUndefined();
    expect(second.notes?.[0]).toMatch(/всё ещё похож/);
    // A new run (a new hook) may redesign again.
    const next = await templateGateHook({ pg: api.deps.pg, runId: null, capture: structureCapture })(ctx);
    expect(next.redesign?.avoid[0]).toBe("calm_medical");
  });

  test("the owner pinned the direction: a note, the style stays", async () => {
    const niche = `ниша ${randomUUID().slice(0, 8)}`;
    const org = await addOrg();
    const old = await addSystem("Недавний", org);
    const me = await addSystem("Выбор владельца", org);
    await remember(old, niche, "swiss", siteOf(1));
    const out = await templateGateHook({ pg: api.deps.pg, runId: null, capture: structureCapture })(
      ctxOf(me, { site: siteOf(1), niche, archetype: "editorial", pinned: true }),
    );
    expect(out.redesign).toBeUndefined();
    expect(out.notes?.[0]).toMatch(/стиль вы выбрали сами/);
  });

  test("a different site of the niche passes with its similarity; an empty memory passes; no site — skipped", async () => {
    const niche = `ниша ${randomUUID().slice(0, 8)}`;
    const org = await addOrg();
    const old = await addSystem("Другие паттерны", org);
    const me = await addSystem("Свой сайт", org);
    await remember(old, niche, "swiss", siteOf(0));
    const out = await templateGateHook({ pg: api.deps.pg, runId: null, capture: structureCapture })(
      ctxOf(me, { site: siteOf(1), niche, archetype: "calm_medical" }),
    );
    expect(out).toMatchObject({ status: "done" });
    expect(out.redesign).toBeUndefined();
    expect(out.note).toMatch(/^сходство с недавними сайтами \d+ %, только структура$/);
    expect(Number((await row(me))?.similarity)).toBeLessThan(0.85);

    const alone = await addSystem("Первый в нише", await addOrg());
    const first = await templateGateHook({ pg: api.deps.pg, runId: null, capture: structureCapture })(
      ctxOf(alone, { site: siteOf(2), niche: `пусто ${randomUUID().slice(0, 8)}`, archetype: "natural" }),
    );
    expect(first).toEqual({ status: "done", note: "память ниши пуста" });
    expect((await row(alone))?.similarity).toBeNull();

    const none = await templateGateHook({ pg: api.deps.pg, runId: null, capture: structureCapture })(
      ctxOf(alone, { site: null, niche, archetype: "natural" }),
    );
    expect(none.status).toBe("skipped");
  });

  test("a broken capture falls back to the structure (the template is still caught); no browser — no hook", async () => {
    const niche = `ниша ${randomUUID().slice(0, 8)}`;
    const org = await addOrg();
    const old = await addSystem("Недавний", org);
    const me = await addSystem("Без браузера", org);
    await remember(old, niche, "luxury", siteOf(3));
    const logged: string[] = [];
    const out = await templateGateHook({
      pg: api.deps.pg,
      runId: null,
      capture: async () => {
        throw new Error("browser crashed");
      },
      log: (msg) => logged.push(msg),
    })(ctxOf(me, { site: siteOf(3), niche, archetype: "calm_medical" }));
    expect(out.redesign).toEqual({ avoid: ["calm_medical", "luxury"] });
    expect(logged).toEqual(["template gate capture failed"]);
    // host.ts: a platform without the process browser keeps the stage skipped, as before V3-14.
    expect(templateGateHooks({ pg: api.deps.pg, runId: randomUUID(), browser: null })).toEqual({});
  });

  test("delete_system purges the fingerprint with the system", async () => {
    const org = await addOrg();
    const id = await addSystem("Удаляется", org);
    await remember(id, "ниша удаления", "swiss", siteOf(0));
    await api.deps.pg`update platform.systems set deleted_at = now() - interval '31 days' where id = ${id}`;
    const purged = await purgeDeletedSystems({
      db: api.deps.db,
      pg: api.deps.pg,
      blobs: api.deps.blobs,
      config: api.deps.config,
      files: new MemoryFileStorage(),
    });
    expect(purged.map((p) => p.systemId)).toContain(id);
    expect(await row(id)).toBeUndefined();
  });
});

describe("platform: a site that repeats a recent site of the niche goes back to the art director", () => {
  async function build(systemId: string) {
    gate = templateGateHook({ pg: api.deps.pg, runId: null, capture: structureCapture });
    const run = await startV3Build(api.deps, { systemId, userId: DEV_USER_ID });
    const done = await waitRun(api, run.id, ["succeeded", "failed"], 240_000);
    expect(done.status, JSON.stringify(done.failure)).toBe("succeeded");
    return { run, events: await listEvents(api.deps.db, run.id, 0) };
  }
  const checkpoint = async (systemId: string, key: string) =>
    (
      await api.deps.pg<{ checkpoint: { data: Record<string, unknown> } }[]>`
        select c.checkpoint from platform.system_build_checkpoints c where c.system_id = ${systemId} and c.key = ${key}`
    )[0]?.checkpoint.data;
  /** ui/design.css of the latest draft revision (files manifest → blob). */
  const draftCss = async (systemId: string) => {
    const [rev] = await api.deps.pg<{ files_manifest_sha: string }[]>`
      select r.files_manifest_sha from platform.revisions r where r.system_id = ${systemId}
      order by r.version desc limit 1`;
    const manifest = JSON.parse((await api.deps.blobs.get(rev?.files_manifest_sha ?? "")).toString("utf8"));
    return (await api.deps.blobs.get(manifest["ui/design.css"])).toString("utf8");
  };

  test("«Собрать»: the first site of the niche passes; the second one repeats it — another archetype in the draft", async () => {
    const first = await addSystem("Клиника «Улыбка»", DEFAULT_ORG_ID);
    const second = await addSystem("Клиника «Жемчуг»", DEFAULT_ORG_ID);
    for (const id of [first, second])
      await saveBriefVersion(api.deps.db, { systemId: id, brief: leadBrief(), author: "agent" });

    const a = await build(first);
    expect(await checkpoint(first, "template_gate")).toMatchObject({ status: "done" });
    expect((await checkpoint(first, "template_gate"))?.redesign).toBeUndefined();
    const stagesA = a.events
      .filter((e) => e.type === "build_stage")
      .map((e) => `${e.payload.stage}:${e.payload.status}`);
    expect(stagesA).toEqual(expect.arrayContaining(["template_gate:started", "template_gate:done"]));

    const b = await build(second);
    const design = (await checkpoint(second, "design")) as {
      archetype: string;
      styleName: string;
      design: DesignSystemV3;
    };
    const tg = await checkpoint(second, "template_gate");
    expect(tg).toMatchObject({ status: "done", redesign: { avoid: [design.archetype] } });
    // The harness asked the art director again (no model): another archetype, named in the summary.
    const summary = String(b.events.find((e) => e.type === "run_finished")?.payload.summary_ru ?? "");
    const style = /Сменил стиль на «([^»]+)»/.exec(summary)?.[1];
    expect(style).toBeTruthy();
    expect(style).not.toBe(design.styleName);
    // The draft carries the new design system, not the one of the design stage.
    expect(await draftCss(second)).not.toBe(designCss(design.design));
    // The memory has both sites; the second one at similarity 1 to the first.
    expect(await row(second)).toMatchObject({ archetype: design.archetype, similarity: "1.000" });
    expect(await row(first)).toMatchObject({ similarity: null });
  }, 600_000);
});
