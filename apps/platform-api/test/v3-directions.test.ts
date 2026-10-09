// V3-09 acceptance, platform part (api.yaml /systems/{id}/directions*, /direction-previews/*): after the brief, three
// first screens in three different archetypes with the client's texts — one recorded art_direction answer through the
// platform router (fixture mode, usage into llm_calls), three preview builds in parallel — within 2 minutes and 40 ₽;
// the owner's words change them, the pick and the references become brief versions (author owner); the logo gives the
// brand colour, a reference link gives principles without copying the page (GZ-03). No live calls.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ART_DIRECTION_CALL_TYPE,
  briefFacts,
  DIRECTION_TEXTS_TOOL,
  directionsNiche,
  directionTextsMessages,
  directionTextsSchema,
  proposeDirections,
} from "@wizard/agents/builder";
import type { RecordedExchange } from "@wizard/agents/research";
import { recordedFetch } from "@wizard/agents/research";
import type { SystemBriefInput } from "@wizard/appspec";
import { createRouter } from "@wizard/llm";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { defineTool } from "../../../packages/agents/src/core/tool.js";
import { fixtureLine } from "../../../packages/agents/test/build-v2-fixtures.js";
import { dentalBrief } from "../../../packages/appspec/test/brief-fixtures.js";
import { getLatestBrief, saveBriefVersion } from "../src/briefs/store.js";
import { DEFAULT_ORG_ID, DEV_USER_ID, json } from "../src/db/index.js";
import { DIRECTIONS_RATE } from "../src/directions/service.js";
import { createTestDb, fakeExecutors, startApi, type TestApi } from "./helpers.js";
import { expectContract } from "./session.js";

const VIEWER = { "x-wizard-dev-user": "viewer-dir@example.test" };
const STRANGER = { "x-wizard-dev-user": "stranger-dir@example.test" };
const REQUEST = "Нужен сайт стоматологии в нашем районе с онлайн-записью";
const REF_URL = "https://ref.example.ru/";
const PAGE_HTML = `<!doctype html><html lang="ru"><head><title>Клиника «Белый кит» — лучшие врачи города</title>
<meta name="theme-color" content="#0E7490">
<style>h1,h2{font-family:"PT Serif",serif;color:#0F172A} body{font-family:Inter,sans-serif;background:#F0F9FF}
.grid{display:grid;grid-template-columns:repeat(12,1fr)} .cta{background:#0E7490;color:#fff}</style></head>
<body><header><img src="/logo-kit.svg" alt="Белый кит"></header><main><h1>Улыбайтесь вместе с Белым китом</h1>
<p>Короткий текст о приёме.</p><h2>Врачи</h2><img src="/a.jpg" alt="Врач"><p>Ещё текст.</p><h2>Цены</h2>
<img src="/b.jpg" alt="Кабинет"><img src="/c.jpg" alt="Ресепшн"><p>Последний абзац.</p></main></body></html>`;
const EXCHANGES: RecordedExchange[] = [
  {
    key: "GET https://ref.example.ru/robots.txt",
    status: 404,
    headers: { "content-type": "text/plain" },
    body: "",
  },
  {
    key: `GET ${REF_URL}`,
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: PAGE_HTML,
  },
];

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
let fixtures: string;

beforeAll(async () => {
  tdb = await createTestDb("v3dir");
  fixtures = mkdtempSync(join(tmpdir(), "wz-dir-fx-"));
  mkdirSync(join(fixtures, "unit"), { recursive: true });
  api = await startApi(tdb.url, {
    executors: fakeExecutors(),
    createRouter: (o) =>
      createRouter({ ...o, fixture: { suite: "unit", name: "design-directions", dir: fixtures }, env: {} }),
    directions: { researchFetch: recordedFetch(EXCHANGES), researchMode: "fixture" },
  });
  for (const h of [VIEWER, STRANGER]) expect((await api.req("GET", "/me", { headers: h })).status).toBe(200);
  await api.deps.pg`update platform.memberships set role = 'viewer' where user_id =
    (select id from platform.users where email = 'viewer-dir@example.test')`;
  await api.deps.pg`delete from platform.memberships where user_id =
    (select id from platform.users where email = 'stranger-dir@example.test')`;
}, 60_000);

afterAll(async () => {
  await api?.dispose();
  await tdb?.drop();
  if (fixtures) rmSync(fixtures, { recursive: true, force: true });
});

/** A system with the owner's first request in its chat and the dental brief as version 1. */
async function addSystem(
  name = "Стоматология «Улыбка»",
  brief: SystemBriefInput = dentalBrief(),
): Promise<string> {
  const key = randomUUID().replace(/-/g, "").slice(0, 12);
  const row = await api.deps.db
    .insertInto("platform.systems")
    .values({
      org_id: DEFAULT_ORG_ID,
      slug: `dir-${key}`,
      schema_key: key,
      name,
      pending_questions: json([]),
      created_by: DEV_USER_ID,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await api.deps.db
    .insertInto("platform.messages")
    .values({
      system_id: row.id,
      seq: 1,
      role: "user",
      kind: "text",
      text: REQUEST,
      author_user_id: DEV_USER_ID,
    })
    .execute();
  await saveBriefVersion(api.deps.db, {
    systemId: row.id,
    brief: { ...brief, design: { references: [] } },
    author: "agent",
  });
  return row.id;
}

/** The recorded texts answer for a system: the prompt the platform will send, three sets in the client's words. */
async function recordTexts(systemId: string, name: string): Promise<void> {
  const latest = await getLatestBrief(api.deps.db, systemId);
  if (!latest) throw new Error("no brief");
  const niche = directionsNiche(name, REQUEST);
  const p = await proposeDirections({ brief: latest.brief, name, niche, seed: systemId });
  const ids = p.directions.map((d) => d.archetype);
  const tool = defineTool({
    name: DIRECTION_TEXTS_TOOL,
    description: "texts",
    input: directionTextsSchema(ids),
  });
  const messages = directionTextsMessages(
    briefFacts(latest.brief, name, niche),
    p.directions.map((d) => ({ archetype: d.archetype, voice: d.voice })),
  );
  const sets = ids.map((direction, i) => ({
    direction,
    title: [
      "Запись на приём с сайта — без звонков",
      "Приём у стоматолога рядом с домом",
      "Стоматология «Улыбка» онлайн",
    ][i],
    lead: "Выберите услугу и удобное время — подтверждение придёт в Telegram. Для жителей района и семей с детьми.",
    action: ["Записаться", "Выбрать время", "Записаться онлайн"][i],
  }));
  const line = fixtureLine(ART_DIRECTION_CALL_TYPE, messages, [tool.definition], {
    name: DIRECTION_TEXTS_TOOL,
    args: { sets },
  });
  writeFileSync(join(fixtures, "unit", "design-directions.jsonl"), `${JSON.stringify(line)}\n`, {
    flag: "a",
  });
}

const get = (path: string) =>
  api.fetch(new Request(`http://localhost:4000/api/v1${path}`, { headers: { host: "localhost:4000" } }));

/** A PNG: white canvas with a block of `rgb` over the top `share` of it. */
function png(w: number, h: number, rgb: [number, number, number], share = 0.3): Uint8Array {
  const img = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const c = y < h * share ? rgb : [255, 255, 255];
      img.data[i] = c[0] as number;
      img.data[i + 1] = c[1] as number;
      img.data[i + 2] = c[2] as number;
      img.data[i + 3] = 255;
    }
  return new Uint8Array(PNG.sync.write(img));
}

function upload(id: string, kind: string, bytes: Uint8Array, name = "file.png") {
  const form = new FormData();
  form.set("file", new Blob([bytes as Uint8Array<ArrayBuffer>]), name);
  form.set("kind", kind);
  return api.req("POST", `/systems/${id}/directions/references/upload`, { body: form });
}

let main: string;
// biome-ignore lint/suspicious/noExplicitAny: JSON answers of the API under test
let first: Record<string, any>;

describe("three directions after the brief", () => {
  test("≤ 2 min and ≤ 40 ₽: three archetypes, the model's texts, live previews built in parallel, a chat card", async () => {
    main = await addSystem();
    await recordTexts(main, "Стоматология «Улыбка»");
    const t0 = performance.now();
    const r = await api.req("POST", `/systems/${main}/directions`);
    const ms = performance.now() - t0;
    expect(r.status, r.text).toBe(201);
    expectContract("proposeDesignDirections", r);
    first = r.body.proposal;
    expect(first.directions).toHaveLength(3);
    expect(new Set(first.directions.map((d: { archetype: string }) => d.archetype)).size).toBe(3);
    expect(first.fallback).toBe(false);
    expect(first.directions.map((d: { textsSource: string }) => d.textsSource)).toEqual([
      "model",
      "model",
      "model",
    ]);
    expect(first.directions[0].texts.title).toBe("Запись на приём с сайта — без звонков");
    expect(first.costRub).toBeGreaterThan(0);
    expect(first.costRub).toBeLessThanOrEqual(40);
    expect(ms).toBeLessThan(120_000);
    console.info(
      `V3-09 три направления через API: ${first.costRub.toFixed(2)} ₽, ${Math.round(ms)} мс со сборкой трёх превью`,
    );
    for (const d of first.directions) {
      expect(d.previewHtml).toContain(`/api/v1/direction-previews/${first.id}/${d.n}/boot.js`);
      expect(d.previewHtml).toMatch(
        /<script type="module" src="\/api\/v1\/direction-previews\/[0-9a-f]{64}\/\d\/assets\/[^"]+\.js">/,
      );
      expect(d.palette.accent).toMatch(/^#[0-9A-F]{6}$/);
    }
    // The texts call is journaled like every model call (T1 after scrub).
    const calls = await api.deps.pg<
      { call_type: string; tier: string; scrubbed: boolean; cost_rub: string }[]
    >`
      select call_type, tier, scrubbed, cost_rub from platform.llm_calls where system_id = ${main}`;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ call_type: "art_direction", tier: "T1", scrubbed: true });
    expect(Number(calls[0]?.cost_rub)).toBeLessThanOrEqual(40);
    // A chat card announces them; GET returns the same set.
    const chat = await api.deps.pg<{ role: string; text: string; payload: Record<string, unknown> }[]>`
      select role, text, payload from platform.messages where system_id = ${main} order by seq`;
    expect(chat.at(-1)).toMatchObject({
      role: "assistant",
      payload: { type: "design_directions", proposalId: first.id },
    });
    expect(chat.at(-1)?.text).toContain("Выберите одно");
    const again = await api.req("GET", `/systems/${main}/directions`, { headers: VIEWER });
    expect(again.status).toBe(200);
    expectContract("getDesignDirections", again);
    expect(again.body.proposal.id).toBe(first.id);
  }, 150_000);

  test("preview files: the bundle, its CSS, the boot script, fonts and photo placeholders — CORS for the sandboxed frame", async () => {
    const d = first.directions[0];
    const script = /src="(\/api\/v1\/direction-previews\/[^"]+\.js)"><\/script>\n<\/head>/.exec(
      d.previewHtml,
    )?.[1] as string;
    const style = /href="(\/api\/v1\/direction-previews\/[^"]+\.css)"/.exec(d.previewHtml)?.[1] as string;
    for (const [path, type] of [
      [script, "text/javascript"],
      [style, "text/css"],
      [`/api/v1/direction-previews/${first.id}/1/boot.js`, "text/javascript"],
    ] as const) {
      const res = await get(path.replace("/api/v1", ""));
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type")).toContain(type);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    }
    const css = await (await get(style.replace("/api/v1", ""))).text();
    const font = /url\(\/api\/v1\/direction-previews\/fonts\/([\w.-]+\.woff2)\)/.exec(css)?.[1] as string;
    expect(font).toBeTruthy();
    const f = await get(`/direction-previews/fonts/${font}`);
    expect(f.status).toBe(200);
    expect(f.headers.get("access-control-allow-origin")).toBe("*");
    const boot = await (await get(`/direction-previews/${first.id}/1/boot.js`)).text();
    expect(boot).toContain("/_wizard/spec");
    expect((await get("/direction-previews/photos/warm-craft-1-1.svg")).headers.get("content-type")).toBe(
      "image/svg+xml",
    );
    expect((await get(`/direction-previews/${"0".repeat(64)}/1/boot.js`)).status).toBe(404);
    expect((await get(`/direction-previews/${first.id}/4/boot.js`)).status).toBe(404);
    expect((await get("/direction-previews/fonts/..%2Fpackage.json")).status).toBe(404);
  });

  test("access: a viewer reads but cannot propose; another org's system is 404; no brief yet → a Russian hint", async () => {
    expect((await api.req("POST", `/systems/${main}/directions`, { headers: VIEWER })).status).toBe(403);
    expect((await api.req("GET", `/systems/${main}/directions`, { headers: STRANGER })).status).toBe(404);
    expect(
      (await api.req("POST", `/systems/${main}/directions/pick`, { headers: STRANGER, body: {} })).status,
    ).toBe(404);
    const key = randomUUID().replace(/-/g, "").slice(0, 12);
    const bare = await api.deps.db
      .insertInto("platform.systems")
      .values({
        org_id: DEFAULT_ORG_ID,
        slug: `dir-${key}`,
        schema_key: key,
        name: "Без брифа",
        pending_questions: json([]),
        created_by: DEV_USER_ID,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const r = await api.req("POST", `/systems/${bare.id}/directions`);
    expect(r.status).toBe(400);
    expect(r.body.message_ru).toMatch(/бриф/);
    expect((await api.req("GET", `/systems/${bare.id}/directions`)).body).toEqual({ proposal: null });
  });
});

describe("refinement by words and the pick", () => {
  test("«теплее» → three new previews; «как второй, но строже» → only the second; words and replies in the chat", async () => {
    const warm = await api.req("POST", `/systems/${main}/directions/refine`, {
      body: { proposalId: first.id, text: "Теплее" },
    });
    expect(warm.status, warm.text).toBe(200);
    expectContract("refineDesignDirections", warm);
    expect(warm.body).toMatchObject({ kind: "tuned", changed: [1, 2, 3] });
    expect(warm.body.proposal.id).not.toBe(first.id);
    expect(
      warm.body.proposal.directions.every((d: { tuning: string[] }) => d.tuning.includes("теплее")),
    ).toBe(true);
    const strict = await api.req("POST", `/systems/${main}/directions/refine`, {
      body: { proposalId: warm.body.proposal.id, text: "как второй, но строже" },
    });
    expect(strict.body.changed).toEqual([2]);
    expect(strict.body.proposal.directions[1].tuning).toEqual(
      expect.arrayContaining(["теплее", "контрастнее"]),
    );
    expect(strict.body.proposal.directions[0].previewHtml.replaceAll(strict.body.proposal.id, "X")).toBe(
      warm.body.proposal.directions[0].previewHtml.replaceAll(warm.body.proposal.id, "X"),
    );
    const chat = await api.deps.pg<{ role: string; text: string }[]>`
      select role, text from platform.messages where system_id = ${main} order by seq desc limit 2`;
    expect(chat.map((m) => m.role)).toEqual(["assistant", "user"]);
    expect(chat[1]?.text).toBe("как второй, но строже");
    expect(chat[0]?.text).toMatch(/Второй вариант: /);
    first = strict.body.proposal;
  });

  test("«беру второй» picks: a new brief version by the owner with the archetype pinned and the owner's words", async () => {
    const r = await api.req("POST", `/systems/${main}/directions/refine`, {
      body: { proposalId: first.id, text: "беру второй" },
    });
    expect(r.status).toBe(200);
    expect(r.body.kind).toBe("pick");
    expect(r.body.proposal.picked).toBe(2);
    const latest = await getLatestBrief(api.deps.db, main);
    expect(latest?.author).toBe("owner");
    expect(latest?.brief.design).toMatchObject({
      archetype: first.directions[1].archetype,
      pinned: true,
      references: [expect.stringMatching(/^Пожелания словами: .*теплее/)],
    });
    expect(r.body.reply).toContain(`версия ${latest?.version}`);
  });

  test("«Решите за меня»: the system's first direction, not pinned", async () => {
    const r = await api.req("POST", `/systems/${main}/directions/pick`, {
      body: { proposalId: first.id, skip: true },
    });
    expect(r.status).toBe(200);
    expectContract("pickDesignDirection", r);
    expect(r.body).toMatchObject({ archetype: first.directions[0].archetype, pinned: false });
    expect(r.body.brief.brief.design.references).toEqual([]);
    const wrong = await api.req("POST", `/systems/${main}/directions/pick`, {
      body: { proposalId: "f".repeat(64), n: 1 },
    });
    expect(wrong.status).toBe(404);
  });

  test("an unknown phrase without a recorded answer → the polite hint, nothing changes", async () => {
    const r = await api.req("POST", `/systems/${main}/directions/refine`, {
      body: { proposalId: first.id, text: "сделайте с котиками" },
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ kind: "unknown", changed: [] });
    expect(r.body.reply).toMatch(/теплее.*строже/);
  });
});

describe("logo and references", () => {
  test("a PNG logo gives the brand colour: the next three directions all carry it", async () => {
    const id = await addSystem("Пекарня «Колос»");
    const r = await upload(id, "logo", png(240, 120, [0xb5, 0x54, 0x1b]));
    expect(r.status, r.text).toBe(201);
    expectContract("uploadDesignReference", r);
    expect(r.body.reference).toMatch(/^Логотип: фирменный цвет #[0-9A-F]{6}/);
    expect(r.body.brief.author).toBe("owner");
    const p = await api.req("POST", `/systems/${id}/directions`);
    expect(p.status).toBe(201);
    const brand = /#[0-9A-F]{6}/.exec(r.body.reference)?.[0] as string;
    // The light scheme keeps the brand colour exactly (palette accent of the starting scheme when it is light).
    for (const d of p.body.proposal.directions)
      if (d.archetype !== "night_contrast") expect(d.palette.accent).toBe(brand);
    // A new logo replaces the old one.
    const again = await upload(id, "logo", png(64, 64, [0x1f, 0x6f, 0xeb], 0.5));
    expect(
      again.body.brief.brief.design.references.filter((x: string) => x.startsWith("Логотип")).length,
    ).toBe(1);
  });

  test("limits: not PNG/SVG → 415, SVG screenshot → 415, > 2 МБ → 413, tiny → 400, more than three references → 400", async () => {
    const id = await addSystem("Студия «Линия»");
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]);
    expect((await upload(id, "logo", jpeg, "x.jpg")).status).toBe(415);
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#0B6E4F"/></svg>',
    );
    expect((await upload(id, "screenshot", svg, "x.svg")).status).toBe(415);
    const svgLogo = await upload(id, "logo", svg, "logo.svg");
    expect(svgLogo.status).toBe(201);
    expect(svgLogo.body.reference).toContain("#0B6E4F");
    const big = new Uint8Array(2 * 1024 * 1024 + 10);
    big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect((await upload(id, "screenshot", big)).status).toBe(413);
    expect((await upload(id, "screenshot", png(8, 8, [10, 10, 10]))).status).toBe(400);
    expect((await upload(id, "screenshot", new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).status).toBe(415);
    for (let i = 0; i < 3; i++)
      expect((await upload(id, "screenshot", png(120, 80, [20 + i * 60, 30, 40], 0.6))).status).toBe(201);
    const fourth = await upload(id, "screenshot", png(120, 80, [200, 30, 40]));
    expect(fourth.status).toBe(400);
    expect(fourth.body.message_ru).toMatch(/трёх|3/);
    const latest = await getLatestBrief(api.deps.db, id);
    expect(latest?.brief.design.references).toHaveLength(4);
    // The files are not kept: only principle lines in the brief.
    expect(JSON.stringify(latest?.brief.design.references)).not.toMatch(/png|base64/i);
  });

  test("a reference link: read_page + inline CSS → principles; the page's texts, logo and layout are not copied (GZ-03)", async () => {
    const id = await addSystem("Клиника «Мята»");
    const r = await api.req("POST", `/systems/${id}/directions/references`, { body: { url: REF_URL } });
    expect(r.status, r.text).toBe(201);
    expectContract("addDesignReference", r);
    expect(r.body.read).toBe(true);
    expect(r.body.reference).toMatch(/^Сайт ref\.example\.ru: /);
    expect(r.body.reference).toContain("антиква в заголовках, гротеск в тексте");
    expect(r.body.reference).toContain("сетка 12 колонок");
    for (const copied of ["Белый кит", "Белым китом", "лучшие врачи", "Улыбайтесь", "logo-kit"])
      expect(r.body.reference).not.toContain(copied);
    const p = await api.req("POST", `/systems/${id}/directions`);
    expect(p.status).toBe(201);
    const page = JSON.stringify(p.body.proposal);
    for (const copied of ["Белый кит", "Улыбайтесь", "logo-kit"]) expect(page).not.toContain(copied);
    // A link that cannot be read is kept as a link; a private address is refused.
    const lost = await api.req("POST", `/systems/${id}/directions/references`, {
      body: { url: "https://nowhere.example.ru/" },
    });
    expect(lost.status).toBe(201);
    expect(lost.body.read).toBe(false);
    const local = await api.req("POST", `/systems/${id}/directions/references`, {
      body: { url: "http://127.0.0.1/admin" },
    });
    expect(local.status).toBe(400);
    expect(
      (await api.req("POST", `/systems/${id}/directions/references`, { body: { url: "ftp://x.ru/a" } }))
        .status,
    ).toBe(400);
  });
});

describe("robustness", () => {
  test("previews are rebuilt from the stored proposal when the process lost them", async () => {
    const other = await startApi(tdb.url, {
      executors: fakeExecutors(),
      config: { artifactsDir: api.artifactsDir },
    });
    try {
      const res = await other.fetch(
        new Request(`http://localhost:4000/api/v1/direction-previews/${first.id}/2/boot.js`, {
          headers: { host: "localhost:4000" },
        }),
      );
      expect(res.status).toBe(200);
    } finally {
      await other.dispose();
    }
  }, 60_000);

  test(`more than ${DIRECTIONS_RATE.max} requests in the window → RATE_LIMITED`, async () => {
    const id = await addSystem("Ателье «Нить»");
    const p = await api.req("POST", `/systems/${id}/directions`);
    let last = 0;
    for (let i = 0; i < DIRECTIONS_RATE.max; i++) {
      const r = await api.req("POST", `/systems/${id}/directions/refine`, {
        body: { proposalId: p.body.proposal.id, text: "сделайте с котиками" },
      });
      last = r.status;
      if (last === 429) break;
    }
    expect(last).toBe(429);
  }, 120_000);
});
