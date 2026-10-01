// M1-09: G1-RENDER-01 (gates.yaml#G1) — every page × each of its roles renders with react-dom/server on the seed,
// data from the real runtime as that role, page code sandboxed (render/child.mjs). Catches throws (also after data
// arrives), blank pages, console errors, forms collecting pii without consent, ui-kit elements without build wz-ids;
// time limits per render and for the gate. QA seed hints shape the shared seed.
import type { AppSpec } from "@wizard/appspec";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type Check, type GateReport, type QaCheck, type RuntimeHandle, runG1 } from "../src/index.js";
import { type G1Harness, g1Harness, loadBakery } from "./g1-helpers.js";
import { forumFiles, loadForum } from "./helpers.js";

let h: G1Harness;
beforeAll(async () => {
  h = await g1Harness();
});
afterAll(async () => {
  expect(await h.leftoverSchemas()).toBe(0);
  await h.close();
});

const m1Now = () => new Date(Math.max(Date.now(), Date.parse("2026-10-20T00:00:00.000Z")));
const render = (r: GateReport) => r.checks.filter((c) => c.id === "G1-RENDER-01");
const detail = (r: GateReport) =>
  JSON.stringify(
    r.checks.filter((c) => c.status === "fail" || c.status === "error"),
    null,
    1,
  ).slice(0, 3000);
type Rendered = { file: string; role: string; path: string; html?: string; passes?: number };

/** A runtime handle over the harness runtime that records every request path (and may override env). */
function spyRuntime(seen: string[], env?: RuntimeHandle["env"]): RuntimeHandle {
  return {
    fetch: (req) => {
      seen.push(`${req.method} ${new URL(req.url).pathname}${new URL(req.url).search}`);
      return h.rt.fetch(req);
    },
    loadSystem: (i) => h.rt.loadSystem(i),
    outbox: () => h.rt.outbox(),
    runJobs: (i) => h.rt.runJobs(i),
    env: env ?? h.rt.env,
  };
}

const KIT = 'import { AppShell, Button, ConsentCheckbox, Field, RecordForm } from "@wizard/ui-kit";';
const PAGES: Record<string, { route: string; roles: string[]; code: string }> = {
  "ui/t/Throw.tsx": {
    route: "/t-throw",
    roles: ["organizer"],
    code: `${KIT}
export default function Throw() {
  const data = undefined as unknown as { items: string[] };
  return <AppShell title="Падает">{data.items.length}</AppShell>;
}`,
  },
  "ui/t/DataThrow.tsx": {
    route: "/t-data",
    roles: ["organizer"],
    code: `import { useEntityList } from "@wizard/sdk";
${KIT}
export default function DataThrow() {
  const { items } = useEntityList("stream");
  const first = items[0] as unknown as { nope: { deep: string } } | undefined;
  return <AppShell title="Потоки">{first ? first.nope.deep : "Загрузка"}</AppShell>;
}`,
  },
  "ui/t/Blank.tsx": {
    route: "/t-blank",
    roles: ["visitor"],
    code: "export default function Blank() {\n  return null;\n}",
  },
  "ui/t/Console.tsx": {
    route: "/t-console",
    roles: ["organizer"],
    code: `${KIT}
export default function Noisy() {
  console.error("разметка сломалась");
  return <AppShell title="Шумная">Текст</AppShell>;
}`,
  },
  "ui/t/FormNoConsent.tsx": {
    route: "/t-form",
    roles: ["speaker"],
    code: `${KIT}
export default function Apply() {
  return (
    <AppShell title="Заявка">
      <form>
        <Field name="full_name" label="ФИО" type="string" value="" onChange={() => {}} />
        <input name="topic" defaultValue="" />
        <Button type="submit">Отправить</Button>
      </form>
    </AppShell>
  );
}`,
  },
  "ui/t/FormConsent.tsx": {
    route: "/t-form-ok",
    roles: ["speaker"],
    code: `${KIT}
export default function ApplyOk() {
  return (
    <AppShell title="Заявка">
      <form>
        <Field name="full_name" label="ФИО" type="string" value="" onChange={() => {}} />
        <ConsentCheckbox checked={false} onChange={() => {}} />
        <Button type="submit">Отправить</Button>
      </form>
    </AppShell>
  );
}`,
  },
  "ui/t/Record.tsx": {
    route: "/t-record",
    roles: ["speaker"],
    code: `${KIT}
export default function Rec() {
  return (
    <AppShell title="Заявка">
      <RecordForm entity="speaker_application" />
    </AppShell>
  );
}`,
  },
  "ui/t/Alias.tsx": {
    route: "/t-alias",
    roles: ["organizer"],
    code: `${KIT}
const Kit = { Button };
export default function Alias() {
  const B = Kit.Button;
  return <AppShell title="Псевдоним"><B>Ок</B></AppShell>;
}`,
  },
  "ui/t/Escape.tsx": {
    route: "/t-escape",
    roles: ["organizer"],
    code: `${KIT}
export default function Escape() {
  const F = ({}).constructor.constructor as (s: string) => () => unknown;
  return <AppShell title="Побег">{String(F("return process")())}</AppShell>;
}`,
  },
  "ui/t/Probe.tsx": {
    route: "/t-probe",
    roles: ["organizer"],
    code: `${KIT}
export default function Probe() {
  const g = globalThis as unknown as Record<string, unknown>;
  void fetch("/api/data/stream?wz-render-probe=1", { method: "POST", body: JSON.stringify({ name: "x", capacity: 1 }) });
  void fetch("http://169.254.169.254/latest?wz-render-probe=2");
  return (
    <AppShell title="Проба">
      {\`process:\${typeof g.process} require:\${typeof g.require} Buffer:\${typeof g.Buffer}\`}
    </AppShell>
  );
}`,
  },
};

function variant(pages: Record<string, { route: string; roles: string[]; code: string }>) {
  const spec = loadForum() as AppSpec;
  const files = new Map(forumFiles());
  spec.pages = Object.entries(pages).map(([file, p]) => ({
    route: p.route,
    title: p.route.slice(1),
    file,
    roles: p.roles,
  }));
  for (const [file, p] of Object.entries(pages)) files.set(file, p.code);
  return { spec, files };
}

/** QA check relying on a seed hint: the first stream must be «Большой зал». */
const hinted: QaCheck = {
  id: "SC-AC1-9",
  acId: "AC1",
  kind: "scenario",
  level: "G1",
  scenario: {
    id: "SC-AC1-9",
    acId: "AC1",
    title: "Первый поток seed — большой зал",
    actors: { org: { role: "organizer" } },
    seedHints: [{ entity: "stream", field: "name", values: ["Большой зал"] }],
    steps: [
      { as: "org" },
      { read: { entity: "stream", id: "$seed.stream[0].id" } },
      { expect: { status: "ok", fields: { name: "Большой зал" } } },
    ],
  },
};

describe("golden systems", () => {
  test("forum (M1): every page × role renders with seed data; G1-RENDER-01 passes; seed hints reach the seed", async () => {
    const seen: Rendered[] = [];
    const r = await runG1(h.ctx({ milestone: "M1", now: m1Now(), checks: [hinted] }), {
      onRender: (x) => seen.push(x),
    });
    expect(
      render(r).map((c) => c.status),
      detail(r),
    ).toEqual(["pass"]);
    expect(r.checks.find((c) => c.id === "SC-AC1-9")?.status, detail(r)).toBe("pass");
    expect(r.passed, detail(r)).toBe(true);
    const spec = loadForum();
    const expected = (spec.pages ?? []).flatMap((p) => p.roles.map((role) => `${p.file}|${role}`));
    expect(seen.map((x) => `${x.file}|${x.role}`).sort()).toEqual(expected.sort());
    for (const x of seen) expect(x.html, `${x.file} ${x.role}`).toMatch(/data-wz-id="[0-9a-f]{8}:\d+"/);
    // Data arrived in a second pass: the moderation table lists a seed application, the ticket route has a real id.
    const moderation = seen.find((x) => x.file === "ui/Moderation.tsx");
    expect(moderation?.passes).toBeGreaterThanOrEqual(2);
    expect(moderation?.html).toContain('data-wz-component="DataTable"');
    expect(moderation?.html).not.toContain("wz-loading");
    expect(seen.find((x) => x.file === "ui/MyTicket.tsx")?.path).toMatch(/^\/ticket\/[0-9a-f-]{36}$/);
    // The visitor is anonymous, the participant sees their own name in the shell.
    expect(seen.find((x) => x.file === "ui/Landing.tsx" && x.role === "visitor")?.html).toContain("Войти");
    expect(seen.find((x) => x.file === "ui/Landing.tsx" && x.role === "participant")?.html).toContain(
      "Выйти",
    );
    expect(r.durationMs).toBeLessThan(120_000);
  }, 120_000);

  test("bakery (M1): G1-RENDER-01 passes", async () => {
    const b = loadBakery();
    const seen: Rendered[] = [];
    const r = await runG1(h.ctx({ spec: b.spec, files: b.files, milestone: "M1" }), {
      onRender: (x) => seen.push(x),
    });
    expect(
      render(r).map((c) => c.status),
      detail(r),
    ).toEqual(["pass"]);
    expect(seen).toHaveLength((b.spec.pages ?? []).reduce((n, p) => n + p.roles.length, 0));
    expect(seen.find((x) => x.file === "ui/MyOrders.tsx")?.html).toContain("Заказ №");
  }, 120_000);

  test("M0: G1-RENDER-01 is skipped (since M1)", async () => {
    const r = await runG1(h.ctx({ milestone: "M0", checks: [] }), { timeBudgetMs: 1 });
    expect(render(r).map((c) => [c.status, c.message_ru])).toEqual([
      ["skip", "Проверка включается с этапа M1"],
    ]);
  });
});

describe("broken pages", () => {
  let r: GateReport;
  const seen: Rendered[] = [];
  const requests: string[] = [];
  const byFile = (file: string) => render(r).filter((c) => c.file === file);

  beforeAll(async () => {
    const { spec, files } = variant(PAGES);
    r = await runG1(h.ctx({ spec, files, milestone: "M1", now: m1Now(), runtime: spyRuntime(requests) }), {
      onRender: (x) => seen.push(x),
    });
  }, 120_000);

  test("the gate fails on G1-RENDER-01 only; each finding points to the page file and /pages/<i>", () => {
    expect(r.passed).toBe(false);
    const failing = r.checks.filter((c) => c.status === "fail" || c.status === "error");
    expect(new Set(failing.map((c) => c.id))).toEqual(new Set(["G1-RENDER-01"]));
    for (const c of render(r)) {
      expect(c.status).toBe("fail");
      expect(c.path).toMatch(/^\/pages\/\d+$/);
      expect(c.file).toMatch(/^ui\/t\//);
    }
  });

  test("a page that throws while data is loading", () => {
    const [c] = byFile("ui/t/Throw.tsx");
    expect(c?.message_ru).toContain("падает при отрисовке");
    expect(c?.evidence).toContain("TypeError");
  });

  test("a page that throws only once seed data arrives (second render pass)", () => {
    const [c] = byFile("ui/t/DataThrow.tsx");
    expect(c?.message_ru).toContain("падает при отрисовке");
    expect(c?.evidence).toContain("deep");
  });

  test("blank page and console errors", () => {
    expect(byFile("ui/t/Blank.tsx").map((c) => c.message_ru)).toEqual([expect.stringContaining("пустая")]);
    const noisy = byFile("ui/t/Console.tsx");
    expect(noisy.map((c) => c.message_ru)).toEqual([expect.stringContaining("ошибки в консоль")]);
    expect(noisy[0]?.evidence).toContain("разметка сломалась");
  });

  test("a form collecting pii without ConsentCheckbox fails; with it, or via RecordForm, it passes", () => {
    const form = byFile("ui/t/FormNoConsent.tsx");
    expect(form.map((c) => c.message_ru)).toEqual([expect.stringContaining("без согласия")]);
    expect(form[0]?.message_ru).toContain("full_name");
    expect(form[0]?.message_ru).not.toContain("topic");
    expect(byFile("ui/t/FormConsent.tsx")).toEqual([]);
    expect(byFile("ui/t/Record.tsx")).toEqual([]);
    expect(seen.find((x) => x.file === "ui/t/Record.tsx")?.html).toContain("wz-consent--recordform");
  });

  test("ui-kit elements the build could not tag (aliased) miss data-wz-id", () => {
    const c = byFile("ui/t/Alias.tsx");
    expect(c.map((x) => x.message_ru)).toEqual([
      expect.stringContaining("компонент Button без отметки data-wz-id"),
    ]);
    expect(c[0]?.evidence).toContain("demo:Button");
  });

  test("sandbox: no code generation, no host globals, only reads leave the render", () => {
    const [esc] = byFile("ui/t/Escape.tsx");
    expect(esc?.evidence).toContain("EvalError");
    expect(byFile("ui/t/Probe.tsx")).toEqual([]);
    expect(seen.find((x) => x.file === "ui/t/Probe.tsx")?.html).toContain(
      "process:undefined require:undefined Buffer:undefined",
    );
    expect(requests.filter((u) => u.includes("wz-render-probe"))).toEqual([]);
  });
});

describe("limits", () => {
  test("an endless render is stopped at the per-render limit; the next page still renders", async () => {
    const pages = {
      "ui/t/Loop.tsx": {
        route: "/t-loop",
        roles: ["organizer"],
        code: "export default function Loop() {\n  for (;;) {}\n}",
      },
      "ui/t/Fine.tsx": {
        route: "/t-fine",
        roles: ["organizer"],
        code: `${KIT}\nexport default function Fine() {\n  return <AppShell title="Хорошо">Текст</AppShell>;\n}`,
      },
    };
    const { spec, files } = variant(pages);
    const seen: Rendered[] = [];
    const started = Date.now();
    const r = await runG1(h.ctx({ spec, files, milestone: "M1", now: m1Now() }), {
      renderTimeoutMs: 1500,
      onRender: (x) => seen.push(x),
    });
    const checks: Check[] = render(r);
    expect(checks.map((c) => [c.file, c.status])).toEqual([["ui/t/Loop.tsx", "fail"]]);
    expect(checks[0]?.message_ru).toContain("не отрисовалась");
    expect(seen.find((x) => x.file === "ui/t/Fine.tsx")?.html).toContain("Хорошо");
    expect(Date.now() - started).toBeLessThan(60_000);
  }, 120_000);

  test("G1 time budget exhausted → G1-RENDER-01 error, the gate fails", async () => {
    const r = await runG1(h.ctx({ milestone: "M1", now: m1Now() }), { timeBudgetMs: 1 });
    expect(render(r).map((c) => c.status)).toEqual(["error"]);
    expect(render(r)[0]?.message_ru).toContain("превышено время G1");
    expect(r.passed).toBe(false);
  }, 120_000);

  test("without WIZARD_UNSAFE_LOCAL_EXEC=1 the page code is not run: error", async () => {
    const r = await runG1(
      h.ctx({
        milestone: "M1",
        now: m1Now(),
        runtime: spyRuntime([], { ...h.rt.env, unsafeLocalExec: false }),
      }),
    );
    expect(render(r).map((c) => c.status)).toEqual(["error"]);
    expect(render(r)[0]?.message_ru).toContain("WIZARD_UNSAFE_LOCAL_EXEC=1");
  }, 120_000);
});
