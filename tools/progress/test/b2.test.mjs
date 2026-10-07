// B2-03: the «Бета v2» page and the daily digest on a fixture backlog (no network, no live models).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildModel,
  loadBacklog,
  loadExtra,
  loadFinal,
  normalizeExtra,
  parseCommits,
  renderDigest,
  renderHtml,
  sendTelegram,
} from "../b2.mjs";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const hasYaml = spawnSync("python3", ["-c", "import yaml"]).status === 0;
const tmp = mkdtempSync(join(tmpdir(), "wz-b2-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const NOW = new Date("2026-10-08T06:00:00Z");
const task = (id, group, status, deps = [], extra = {}) => ({
  id,
  title: `Задача ${id}`,
  milestone: "B2",
  deps,
  owner: "agents",
  parallel_group: group,
  estimate_days: 2,
  status,
  ...extra,
});
const TASKS = [
  { id: "M2-01", title: "Старая", milestone: "M2", deps: [], status: "done", parallel_group: "m2" },
  task("B2-01", "b2-0", "done"),
  task("B2-03", "b2-0", "in_progress"),
  task("B2-10", "b2-a", "done", ["M2-01"]),
  task("B2-11", "b2-a", "todo", ["B2-10"]),
  task("B2-13", "b2-a", "todo", ["B2-11"]),
  task("B2-30", "b2-b", "todo"),
  task("B2-31", "b2-b", "todo", ["B2-30"], { owner: "founder" }),
  task("B2-40", "b2-c", "todo", [], { owner: "founder", title: "Реальные брифы <для> замера" }),
];
const EXTRA = normalizeExtra({
  deploys: [{ date: "2026-10-07", sha: "abcdef1234567", note: "Служебный контур" }],
  spend: [
    { day: "2026-10-07", client: 10, staff: 5, eval: 300 },
    { day: "2026-10-06", client: 0, staff: 2.5, probe: 420, eval: 0 },
  ],
  probes: [{ date: "2026-10-07", name: "Проба конвейера", result: "2 из 3 готовы", costRub: 28.4 }],
  waitingOnFounder: ["Выбрать направление дизайна (B2-31), когда будут готовы прототипы"],
  notes: ["Дневной лимит обнулится в полночь МСК"],
});
const COMMITS = parseCommits(
  [
    ["a1", "2026-10-08T03:00:00+03:00", "B2-01: служебный контур (#80)"],
    ["a2", "2026-10-07T20:00:00+03:00", "B2-10: спека модулей (#81)"],
    ["a3", "2026-10-07T21:00:00+03:00", "B2-11: захват"],
    ["a4", "2026-10-05T10:00:00+03:00", "B2-03: старое"],
    ["a5", "2026-10-08T01:00:00+03:00", "D76: не B2"],
  ]
    .map((r) => r.join("\x1f"))
    .join("\n"),
);
// Intl puts a no-break space into «1 000 ₽»; tests compare with plain spaces.
const sp = (s) => s.replace(/[\u00a0\u202f]/g, " ");
const model = () => buildModel({ tasks: TASKS, extra: EXTRA, commits: COMMITS, now: NOW });

describe("b2 model", () => {
  it("counts B2 only, by stream, and marks blocked tasks", () => {
    const m = model();
    expect(m.counts).toEqual({ total: 8, done: 2, in_progress: 1, todo: 5 });
    expect(m.streams.map((s) => [s.key, s.counts.done, s.counts.total])).toEqual([
      ["0", 1, 2],
      ["A", 1, 3],
      ["B", 0, 2],
      ["C", 0, 1],
    ]);
    const t = Object.fromEntries(m.tasks.map((x) => [x.id, x]));
    expect(t["B2-13"].blockedBy).toEqual(["B2-11"]);
    expect(t["B2-11"].blockedBy).toEqual([]);
    // A dependency outside B2 counts by its own status.
    expect(t["B2-10"].deps).toEqual([{ id: "M2-01", status: "done" }]);
  });

  it("«что дальше»: todo with every dependency done, founder tasks go to «ждём от основателя»", () => {
    const m = model();
    expect(m.next.map((t) => t.id)).toEqual(["B2-11", "B2-30"]);
    // B2-31 is blocked by B2-30; the orchestrator's ask about it is kept, without a duplicate line.
    expect(m.waiting).toEqual([
      "B2-40: Реальные брифы <для> замера",
      "Выбрать направление дизайна (B2-31), когда будут готовы прототипы",
    ]);
    const unblocked = buildModel({
      tasks: TASKS.map((x) => (x.id === "B2-30" ? { ...x, status: "done" } : x)),
      extra: EXTRA,
      now: NOW,
    });
    expect(unblocked.next.map((t) => t.id)).toEqual(["B2-11"]);
    expect(unblocked.waiting.filter((w) => w.includes("B2-31"))).toHaveLength(1);
  });

  it("budget: probes and eval only, out of 1 000 ₽", () => {
    const m = model();
    expect(m.budget).toMatchObject({ limit: 1000, spent: 720 });
    expect(m.spend.map((s) => s.day)).toEqual(["2026-10-06", "2026-10-07"]);
    // Claims and other milestones are not merged work.
    expect(m.commits.map((c) => c.sha)).toEqual(["a1", "a2", "a4"]);
  });
});

describe("b2 page", () => {
  const html = sp(renderHtml(model()));

  it("self-contained, themed, every section present", () => {
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<html lang="ru">');
    expect(html).toContain('name="viewport"');
    expect(html).not.toMatch(/<script|<link|@import|url\(/);
    expect(html).toContain("prefers-color-scheme:dark");
    expect(html).toContain(':root[data-theme="dark"]');
    for (const id of ["next", "founder", "streams", "merged", "deploys", "spend", "probes"])
      expect(html).toContain(`id="${id}"`);
    for (const text of [
      "Поток 0 — разблокировка и прозрачность",
      "Поток A — конвейер",
      "Поток B — дизайн",
      "Поток C — приёмка",
      "Бюджет разработки B2: 720 ₽ из 1 000 ₽",
      "Потрачено больше 70%",
      "Проба конвейера",
      "Служебный контур",
      "B2-10: спека модулей (#81)",
      "Дневной лимит обнулится в полночь МСК",
    ])
      expect(html).toContain(text);
  });

  it("tasks with status, estimate, dependencies; text is escaped", () => {
    expect(html).toContain('data-id="B2-13" data-status="todo" data-blocked="1"');
    expect(html).toContain('data-id="B2-03" data-status="in_progress"');
    expect(html).toMatch(
      /data-id="B2-13"[\s\S]*?заблокирована[\s\S]*?2 дн[\s\S]*?Зависит от: <span class="wait">B2-11<\/span>/,
    );
    expect(html).toContain("Реальные брифы &lt;для&gt; замера");
    expect(html).not.toContain("<для>");
  });

  it("empty extra: calm empty states, no budget alert", () => {
    const empty = renderHtml(buildModel({ tasks: TASKS, now: NOW }));
    expect(empty).toContain("Расходов пока нет.");
    expect(empty).toContain("Выкатов беты v2 ещё не было.");
    expect(empty).not.toContain("Потрачено больше");
  });
});

describe("b2 digest", () => {
  it("3–5 lines: last day's merges, done of total, in progress, founder asks, the link", () => {
    const text = renderDigest(model(), { pageUrl: "https://example.org/b2" });
    const lines = sp(text).split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.length).toBeLessThanOrEqual(5);
    expect(lines[0]).toBe(
      "Бета v2 на 08.10.2026: готово 2 из 8, в работе 1; бюджет моделей 720 ₽ из 1 000 ₽.",
    );
    expect(lines[1]).toBe("За сутки влито: B2-01, B2-10.");
    expect(lines[2]).toBe("В работе: B2-03.");
    expect(lines[3]).toContain("Ждём от основателя: B2-40");
    expect(lines[4]).toBe("Подробно: https://example.org/b2");
  });

  it("never more than 5 lines and no line is huge, with any input", () => {
    const many = Array.from({ length: 40 }, (_, i) => task(`B2-${100 + i}`, "b2-a", "in_progress"));
    const asks = Array.from({ length: 20 }, (_, i) => `Просьба номер ${i} с длинным пояснением`);
    const m = buildModel({ tasks: many, extra: normalizeExtra({ waitingOnFounder: asks }), now: NOW });
    const lines = renderDigest(m, { pageUrl: "https://example.org/b2" }).split("\n");
    expect(lines.length).toBeLessThanOrEqual(5);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(300);
    // Without a link and with nothing in progress: «Дальше» instead, still at least 3 lines.
    const quiet = renderDigest(
      buildModel({ tasks: TASKS.filter((t) => t.status !== "in_progress"), now: NOW }),
    );
    expect(quiet.split("\n")).toHaveLength(4);
    expect(quiet).toContain("Дальше: B2-11, B2-30.");
  });
});

describe("telegram", () => {
  it("without the secrets: a warning, no request, no failure", async () => {
    let called = false;
    const out = await sendTelegram(
      "x",
      {},
      {
        fetch: async () => {
          called = true;
        },
      },
    );
    expect(out).toBe(false);
    expect(called).toBe(false);
  });

  it("sends plain text to the alert chat; a refusal fails the step", async () => {
    const calls = [];
    const ok = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const env = { WIZARD_OPS_ALERT_TELEGRAM_TOKEN: "123:abc", WIZARD_OPS_ALERT_CHAT_ID: "-100" };
    expect(await sendTelegram("сводка", env, { fetch: ok })).toBe(true);
    expect(calls[0].url).toBe("https://api.telegram.org/bot123:abc/sendMessage");
    expect(calls[0].body).toMatchObject({ chat_id: "-100", text: "сводка" });
    expect(calls[0].body.parse_mode).toBeUndefined();
    const bad = async () =>
      new Response(JSON.stringify({ ok: false, description: "chat not found" }), { status: 400 });
    await expect(sendTelegram("x", env, { fetch: bad })).rejects.toThrow(/chat not found/);
  });
});

describe.skipIf(!hasYaml)("b2 on the repository", () => {
  it("reads the real backlog (32 B2 tasks in four streams) and the extra file", () => {
    const m = buildModel({ tasks: loadBacklog(ROOT), extra: loadExtra(ROOT), now: NOW });
    expect(m.counts.total).toBeGreaterThanOrEqual(32);
    expect(m.streams.map((s) => s.key)).toEqual(["0", "A", "B", "C"]);
    expect(loadExtra(ROOT).waitingOnFounder.some((w) => w.includes("B2-31"))).toBe(true);
  });

  it("CLI: --html writes the page, --digest prints ≤ 5 lines (fixture root, no extra file)", () => {
    const root = join(tmp, "repo");
    mkdirSync(join(root, "specs"), { recursive: true });
    writeFileSync(
      join(root, "specs", "backlog.yaml"),
      `tasks:\n${TASKS.map((t) => `  - ${JSON.stringify(t)}`).join("\n")}\n`,
    );
    const cli = (...args) =>
      spawnSync(process.execPath, [join(ROOT, "tools/progress/b2.mjs"), "--root", root, ...args], {
        encoding: "utf8",
        env: { ...process.env, B2_PAGE_URL: "" },
      });
    const out = join(tmp, "b2.html");
    const r = cli("--html", out);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(out, "utf8")).toContain('data-id="B2-40"');
    const d = cli("--digest");
    expect(d.status, d.stderr).toBe(0);
    const lines = d.stdout.trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.length).toBeLessThanOrEqual(5);
    expect(cli().status).toBe(1);
  });
});

describe.skipIf(!hasYaml)("b2-digest workflow", () => {
  it("daily at 06:00 UTC and on demand, read-only, the alert bot's secrets in the sending step only", () => {
    const text = readFileSync(join(ROOT, ".github/workflows/b2-digest.yml"), "utf8");
    const r = spawnSync(
      "python3",
      ["-c", "import sys,json,yaml; print(json.dumps(yaml.safe_load(sys.stdin)))"],
      { input: text, encoding: "utf8" },
    );
    expect(r.status, r.stderr).toBe(0);
    const doc = JSON.parse(r.stdout);
    // YAML 1.1: the key `on` loads as true.
    const on = doc.on ?? doc.true;
    expect(on.schedule).toEqual([{ cron: "0 6 * * *" }]);
    expect(on).toHaveProperty("workflow_dispatch");
    expect(doc.permissions).toEqual({ contents: "read" });
    const job = doc.jobs.digest;
    expect(job.permissions).toBeUndefined();
    const step = job.steps.find((s) => String(s.run ?? "").includes("tools/progress/b2.mjs"));
    expect(step.run).toContain("--digest --send");
    const gh = (expr) => `$${"{{"} ${expr} }}`;
    expect(step.env).toEqual({
      B2_PAGE_URL: gh("vars.B2_PAGE_URL"),
      WIZARD_OPS_ALERT_TELEGRAM_TOKEN: gh("secrets.WIZARD_OPS_ALERT_TELEGRAM_TOKEN"),
      WIZARD_OPS_ALERT_CHAT_ID: gh("secrets.WIZARD_OPS_ALERT_CHAT_ID || vars.WIZARD_OPS_ALERT_CHAT_ID"),
    });
    for (const s of job.steps) if (s !== step) expect(JSON.stringify(s)).not.toContain("secrets.");
  });
});

// B2-41: the block «Финальный замер» from the report JSON the coordinator puts into docs/progress/.
describe("b2 final measurement", () => {
  const lvl = () => ({ passed: true, blockers: [], ownerActions: [], warnings: 0 });
  const result = (id, over = {}) => ({
    id,
    title: `Бриф ${id}`,
    status: "ready",
    ready: true,
    systemId: `sys-${id}`,
    gates: { G0: lvl(), G1: lvl(), G2: lvl() },
    gaps: { outOfScope: [], reported: [], mentions: [] },
    plan: { coverage: "covered", modules: ["landing"], custom: [], outOfScope: [] },
    browser: { ran: true, mobile: "pass", goals: { total: 1, passed: 1, failed: [] } },
    build: { status: "succeeded" },
    screenshots: [
      { label: "телефон, 390 px", src: `shots/${id}-390.png` },
      { label: "компьютер, 1280 px", src: `shots/${id}-1280.png` },
    ],
    creditsUsed: 2,
    costRubEstimate: 10,
    minutes: 4.5,
    buildMinutes: 3.5,
    ...over,
  });
  const report = {
    kind: "d76",
    threshold: "d76",
    runId: "20261009-abcdef",
    startedAt: "2026-10-09T09:00:00Z",
    maxCostRub: 300,
    concurrency: 2,
    results: [result("mvp-01-a"), result("mvp-02-b", { ready: false, status: "not_ready" })],
    db: { costs: { "sys-mvp-01-a": { rub: 12.4 }, "sys-mvp-02-b": { rub: 13.1 } }, gaps: null },
  };

  it("the verdict, ₽, minutes and the phone screenshot of each brief; missing shots stay in the artifact", () => {
    const root = join(tmp, "final");
    mkdirSync(join(root, "docs", "progress", "b2-final", "shots"), { recursive: true });
    writeFileSync(join(root, "docs", "progress", "b2-final.json"), JSON.stringify(report));
    writeFileSync(
      join(root, "docs", "progress", "b2-final", "shots", "mvp-01-a-390.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    const m = buildModel({ tasks: TASKS, now: NOW, final: loadFinal(root) });
    expect(m.final).toMatchObject({ passed: false, counted: 1, total: 2, costRub: 25.5, costExact: true });
    expect(m.final.items.map((x) => [x.id, x.counted, x.costRub])).toEqual([
      ["mvp-01-a", true, 12.4],
      ["mvp-02-b", false, 13.1],
    ]);
    const html = sp(renderHtml(m));
    expect(html).toContain('id="final"');
    expect(html).toContain("Строгий порог D76 не пройден: засчитано 1 из 2");
    expect(html).toContain('<img src="data:image/png;base64,iVBORw==" alt="mvp-01-a: телефон, 390 px"');
    expect(html).toContain("снимок в артефакте: shots/mvp-02-b-390.png");
    expect(html).toContain("Средняя сборка без дописывания: 12,75 ₽ и 3,5 мин");
    expect(html).not.toMatch(/<script|<link|@import|url\(/);
    expect(sp(renderDigest(m))).toContain("Финальный замер: порог D76 не пройден, засчитано 1 из 2, 25,5 ₽.");
    // No report yet: no block, no digest line.
    expect(loadFinal(join(tmp, "nothing"))).toBeNull();
    const none = buildModel({ tasks: TASKS, now: NOW });
    expect(renderHtml(none)).not.toContain('id="final"');
    expect(renderDigest(none)).not.toContain("Финальный замер");
  });

  it("a screenshot path never leaves docs/progress/b2-final", () => {
    const root = join(tmp, "final-escape");
    mkdirSync(join(root, "docs", "progress"), { recursive: true });
    writeFileSync(join(root, "secret.png"), Buffer.from([1]));
    const bad = {
      ...report,
      results: [result("x", { screenshots: [{ label: "x", src: "../../secret.png" }] })],
    };
    writeFileSync(join(root, "docs", "progress", "b2-final.json"), JSON.stringify(bad));
    const m = buildModel({ tasks: TASKS, now: NOW, final: loadFinal(root) });
    expect(m.final.items[0].shot.src).toBeNull();
  });
});
