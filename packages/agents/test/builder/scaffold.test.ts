// Live-eval regressions (M2P): page files from the spec (stubs + reminder rounds), the exact @wizard/sdk API in the
// static prompt (its examples pass G0 against sdk.d.ts) and pages on routes the runtime serves (G0-SPEC-05).
import { type AppSpec, applyOps, emptySpec } from "@wizard/appspec";
import { runG0 } from "@wizard/gates";
import type { LlmMessage } from "@wizard/llm";
import { describe, expect, test } from "vitest";
import { PROMPT_PARTS } from "../../src/builder/docs.js";
import { createMemoryHost, runBuild } from "../../src/builder/index.js";
import { gateReportText, SDK_FIX_HINT, STATIC_PROMPT, STUB_MARKER } from "../../src/builder/prompt.js";
import {
  dropReservedPages,
  isStub,
  pageComponentName,
  pageStub,
  pagesOnReservedRoutes,
} from "../../src/builder/scaffold.js";
import { cardFor, g1Stub, report, stop, tc, turn } from "../builder-helpers.js";
import { scriptedRoute } from "../helpers.js";

function leadSpec(): AppSpec {
  const r = applyOps(
    emptySpec("Клиника"),
    [
      {
        op: "add_role",
        name: "admin",
        label: "Админ",
        access: "login",
        loginMethods: ["email_otp"],
        isAdmin: true,
      },
      { op: "add_role", name: "guest", label: "Гость", access: "public" },
      {
        op: "add_entity",
        name: "service",
        label: "Услуга",
        fields: [{ name: "name", label: "Название", type: "string", required: true }],
      },
      {
        op: "add_entity",
        name: "lead",
        label: "Заявка",
        fields: [
          { name: "name", label: "Имя", type: "string", required: true },
          { name: "phone", label: "Телефон", type: "phone", required: true, pii: "basic" },
          { name: "comment", label: "Комментарий", type: "text" },
          { name: "service", label: "Услуга", type: "ref", ref: { entity: "service" }, required: true },
          {
            name: "status",
            label: "Статус",
            type: "enum",
            required: true,
            enum: [
              { value: "new", label: "Новая" },
              { value: "done", label: "Обработана" },
            ],
          },
        ],
        indexes: [{ fields: ["status"] }],
        retention: { deleteAfterDays: 365 },
      },
      { op: "set_permission", role: "admin", entity: "lead", ops: ["read", "create", "update"] },
      { op: "set_permission", role: "admin", entity: "service", ops: ["read", "create", "update"] },
      { op: "set_permission", role: "guest", entity: "service", ops: ["read"] },
      {
        op: "add_function",
        name: "leadList",
        kind: "query",
        file: "functions/leadList.ts",
        roles: ["admin"],
      },
      {
        op: "add_function",
        name: "leadCreate",
        kind: "mutation",
        file: "functions/leadCreate.ts",
        public: true,
        roles: ["guest", "admin"],
      },
      {
        op: "add_function",
        name: "leadNotify",
        kind: "action",
        file: "functions/leadNotify.ts",
        roles: ["admin"],
      },
      { op: "add_page", route: "/", title: "Главная", file: "ui/pages/Home.tsx", roles: ["guest", "admin"] },
      {
        op: "add_page",
        route: "/leads/:id",
        title: "Заявка «№»",
        file: "ui/pages/lead-detail.tsx",
        roles: ["admin"],
      },
    ],
    0,
  );
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.spec;
}

/** The function examples of the SDK cheatsheet: `// functions/<name>.ts …` code blocks. */
function cheatsheetFunctions(): [string, string][] {
  const out: [string, string][] = [];
  for (const m of PROMPT_PARTS.sdk.matchAll(/```ts\n\/\/ (functions\/\w+\.ts)[^\n]*\n([\s\S]*?)```/g))
    out.push([m[1] as string, m[2] as string]);
  return out;
}

const ctxOf = (spec: AppSpec) => ({
  spec,
  prevSpec: null,
  specVersion: 1,
  files: new Map<string, string>(),
  env: "draft" as const,
  systemKey: "scaffold_test",
  db: undefined as never,
});

const G0_CODE = ["G0-IMP-01", "G0-SEC-01", "G0-SPEC-01", "G0-SPEC-03", "G0-FN-01", "G0-TS-01"];

describe("SDK cheatsheet in the static prompt", () => {
  test("has the exact import line, function shapes, v.optional and the ctx.db methods", () => {
    for (const s of [
      'import { query, v } from "@wizard/sdk";',
      'import { mutation, v } from "@wizard/sdk";',
      'import { action, v } from "@wizard/sdk";',
      "export default query({",
      "handler: async (ctx, args) =>",
      "v.optional(v.string())",
      "getBy(",
      "paginate(",
      "insert(doc)",
    ])
      expect(STATIC_PROMPT).toContain(s);
    expect(STATIC_PROMPT).toContain(PROMPT_PARTS.sdk);
  });

  test("its function examples pass G0 (FN-01, TS-01 against sdk.d.ts); a page left as a stub is a G0 blocker", async () => {
    const spec = leadSpec();
    const fns = cheatsheetFunctions();
    expect(fns.map(([p]) => p).sort()).toEqual((spec.functions ?? []).map((f) => f.file).sort());
    // Stubs compile and import the ui-kit, but a build that still holds one is not ready (G0-SPEC-03).
    const stubbed = new Map<string, string>(fns);
    for (const p of spec.pages ?? []) stubbed.set(p.file, pageStub(p));
    const s0 = await runG0({ ...ctxOf(spec), files: stubbed }, { only: G0_CODE });
    const stubFails = s0.checks.filter((c) => c.status === "fail" || c.status === "error");
    expect(stubFails.map((c) => c.id)).toEqual((spec.pages ?? []).map(() => "G0-SPEC-03"));
    expect(stubFails.every((c) => c.message_ru.includes("осталась заготовкой"))).toBe(true);
    // The same files once the model rewrote the pages (here: the stub body without its marker line) pass.
    const files = new Map<string, string>(fns);
    for (const p of spec.pages ?? []) files.set(p.file, pageStub(p).split("\n").slice(1).join("\n"));
    const r = await runG0({ ...ctxOf(spec), files }, { only: G0_CODE });
    const bad = r.checks.filter((c) => c.status === "fail" || c.status === "error");
    expect(bad, JSON.stringify(bad, null, 1)).toEqual([]);
    for (const id of ["G0-SPEC-03", "G0-FN-01", "G0-TS-01"])
      expect(r.checks.find((c) => c.id === id)?.status, id).toBe("pass");
    // What the cheatsheet warns about is what G0 rejects: `.optional()` chaining is not a v.* validator.
    const chained = new Map(files);
    chained.set(
      "functions/leadCreate.ts",
      (files.get("functions/leadCreate.ts") ?? "").replace(
        "v.optional(v.string({ max: 2000 }))",
        "v.string().optional()",
      ),
    );
    const r2 = await runG0({ ...ctxOf(spec), files: chained }, { only: ["G0-FN-01"] });
    expect(r2.checks.find((c) => c.id === "G0-FN-01")?.status).toBe("fail");
  }, 60_000);

  test("a fix round with G0-TS-01/G0-FN-01 repeats the SDK reminder; other failures do not", () => {
    const ts = gateReportText(report("G0", false, [{ id: "G0-TS-01", file: "functions/a.ts", line: 1 }]));
    expect(ts).toContain(SDK_FIX_HINT);
    expect(ts).toContain("v.optional(v.X())");
    expect(gateReportText(report("G0", false, [{ id: "G0-SPEC-05" }]))).not.toContain(SDK_FIX_HINT);
  });
});

describe("page stubs", () => {
  test("component names and stub marker", () => {
    expect(pageComponentName("ui/pages/Home.tsx")).toBe("HomePage");
    expect(pageComponentName("ui/pages/admin/students.tsx")).toBe("StudentsPage");
    expect(pageComponentName("ui/pages/lead-detail.tsx")).toBe("LeadDetailPage");
    expect(pageComponentName("ui/pages/404.tsx")).toBe("P404Page");
    expect(pageComponentName("ui/LeadsPage.tsx")).toBe("LeadsPage");
    const stub = pageStub({ file: "ui/pages/Home.tsx", title: 'Главная {"x"}', route: "/" });
    expect(isStub(stub)).toBe(true);
    expect(stub).toContain(STUB_MARKER);
    expect(stub).toContain('title={"Главная {\\"x\\"}"}');
    expect(isStub("export default function A() { return null; }\n")).toBe(false);
    expect(isStub(null)).toBe(false);
  });
});

describe("pages on routes the runtime serves", () => {
  test("add_page on /login or on the batch's policy page is dropped; other routes stay", () => {
    const spec = emptySpec("x");
    const { ops, dropped } = dropReservedPages(
      [
        { op: "add_page", route: "/", title: "Главная", file: "ui/pages/Home.tsx", roles: ["admin"] },
        {
          op: "add_page",
          route: "/policy",
          title: "Политика",
          file: "ui/pages/Policy.tsx",
          roles: ["admin"],
        },
        { op: "add_page", route: "/login", title: "Вход", file: "ui/pages/Login.tsx", roles: ["admin"] },
        { op: "set_compliance", policyPage: "/policy" },
      ],
      spec,
    );
    expect(ops.map((o) => o.route ?? o.op)).toEqual(["/", "set_compliance"]);
    expect(dropped.map((d) => [d.route, d.reason])).toEqual([
      ["/policy", "policy"],
      ["/login", "login"],
    ]);
    // Default policy page /privacy.
    expect(
      dropReservedPages(
        [{ op: "add_page", route: "/privacy", title: "П", file: "ui/P.tsx", roles: [] }],
        spec,
      ).dropped,
    ).toHaveLength(1);
    const withPage = {
      ...spec,
      pages: [{ route: "/policy", title: "П", file: "ui/P.tsx", roles: [] }],
    } as AppSpec;
    expect(pagesOnReservedRoutes(withPage)).toEqual([]);
    expect(pagesOnReservedRoutes({ ...withPage, compliance: { policyPage: "/policy" } })).toHaveLength(1);
  });
});

/** Scripted create build: the ops turn(s), then the given code-phase turns. */
async function build(opsTurns: ReturnType<typeof turn>[], codeTurns: ReturnType<typeof turn>[]) {
  const base = leadSpec();
  const spec: AppSpec = { ...base, pages: [], functions: [] };
  const { route, inputs } = scriptedRoute([
    turn(tc("submit_plan", { steps: [{ id: "P1", kind: "ops", title: "Спека", targets: [], acRefs: [] }] })),
    ...opsTurns,
    stop(),
    ...codeTurns,
  ]);
  const mem = createMemoryHost({
    spec,
    version: 1,
    route,
    gates: { G0: async () => report("G0", true), G1: g1Stub },
  });
  const out = await runBuild(mem.host, { card: cardFor(spec), cap: 100, mode: "create", pipeline: "single" });
  return { out, mem, inputs };
}

const userTexts = (inputs: { messages: LlmMessage[] }[]) =>
  inputs.flatMap((i) => i.messages.filter((m) => m.role === "user").map((m) => String(m.content)));

const toolContent = (inputs: { messages: LlmMessage[] }[], id: string) =>
  inputs
    .flatMap((i) => i.messages)
    .find((m): m is Extract<LlmMessage, { role: "tool" }> => m.role === "tool" && m.toolCallId === id)
    ?.content as { notes?: string[]; version?: number } | undefined;

describe("runBuild: declared pages always get their files", () => {
  test("stubs before the code phase; a model that stops early is asked to fill the rest", async () => {
    const pages = [
      { op: "add_page", route: "/", title: "Главная", file: "ui/pages/Home.tsx", roles: ["guest", "admin"] },
      { op: "add_page", route: "/leads", title: "Заявки", file: "ui/pages/Leads.tsx", roles: ["admin"] },
    ];
    const home =
      'import { AppShell } from "@wizard/ui-kit";\n\nexport default function Home() {\n  return <AppShell title="Главная">Привет</AppShell>;\n}\n';
    const leads = home.replace(/Home/g, "Leads").replace("Главная", "Заявки");
    const { out, mem, inputs } = await build(
      [turn(tc("apply_ops", { ops: pages, expectedVersion: 1 }, "o1"))],
      [
        stop("Функции готовы."), // code phase ends without pages
        turn(tc("write_file", { path: "ui/pages/Home.tsx", content: home }, "w1")),
        stop(), // stub round 1: Leads left
        turn(tc("write_file", { path: "ui/pages/Leads.tsx", content: leads }, "w2")),
        stop(), // stub round 2: none left
      ],
    );
    expect(out.status).toBe("succeeded");
    const { files } = mem.state();
    expect(files.get("ui/pages/Home.tsx")).toBe(home);
    expect(files.get("ui/pages/Leads.tsx")).toBe(leads);
    const texts = userTexts(inputs);
    expect(
      texts.some((t) => t.startsWith("Фаза code") && t.includes("ui/pages/Home.tsx, ui/pages/Leads.tsx")),
    ).toBe(true);
    expect(
      texts.some((t) => t.startsWith("Остались незаполненные") && t.includes("ui/pages/Leads.tsx")),
    ).toBe(true);
    const written = mem.events.filter((e) => e.type === "file_written").map((e) => e.payload);
    expect(written.slice(0, 2)).toEqual([
      expect.objectContaining({ path: "ui/pages/Home.tsx", action: "create" }),
      expect.objectContaining({ path: "ui/pages/Leads.tsx", action: "create" }),
    ]);
    expect(written.slice(2)).toEqual([
      expect.objectContaining({ path: "ui/pages/Home.tsx", action: "update" }),
      expect.objectContaining({ path: "ui/pages/Leads.tsx", action: "update" }),
    ]);
  });

  test("stub rounds are bounded: a model that never fills them still reaches the gates", async () => {
    const { out, mem } = await build(
      [
        turn(
          tc(
            "apply_ops",
            {
              ops: [
                { op: "add_page", route: "/", title: "Главная", file: "ui/pages/Home.tsx", roles: ["guest"] },
              ],
              expectedVersion: 1,
            },
            "o1",
          ),
        ),
      ],
      [stop(), stop(), stop()],
    );
    expect(out.status).toBe("succeeded");
    expect(isStub(mem.state().files.get("ui/pages/Home.tsx") ?? null)).toBe(true);
  });

  test("a policy page is dropped in the batch, or removed when policyPage lands on it later", async () => {
    const { mem, inputs } = await build(
      [
        turn(
          tc(
            "apply_ops",
            {
              ops: [
                { op: "add_page", route: "/", title: "Главная", file: "ui/pages/Home.tsx", roles: ["guest"] },
                {
                  op: "add_page",
                  route: "/policy",
                  title: "Политика",
                  file: "ui/pages/Policy.tsx",
                  roles: ["guest"],
                },
                {
                  op: "add_page",
                  route: "/rules",
                  title: "Правила",
                  file: "ui/pages/Rules.tsx",
                  roles: ["guest"],
                },
                { op: "set_compliance", policyPage: "/policy" },
              ],
              expectedVersion: 1,
            },
            "o1",
          ),
        ),
        turn(
          tc(
            "apply_ops",
            { ops: [{ op: "set_compliance", policyPage: "/rules" }], expectedVersion: 2 },
            "o2",
          ),
        ),
      ],
      [stop(), stop(), stop()],
    );
    const { spec, files } = mem.state();
    expect((spec.pages ?? []).map((p) => p.route)).toEqual(["/"]);
    expect([...files.keys()]).toEqual(["ui/pages/Home.tsx"]);
    expect(toolContent(inputs, "o1")?.notes?.[0]).toContain("/policy");
    expect(toolContent(inputs, "o2")).toMatchObject({
      version: 4,
      notes: [expect.stringContaining("/rules")],
    });
  });
});
