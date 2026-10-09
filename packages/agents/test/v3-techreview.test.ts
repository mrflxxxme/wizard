// V3-15 acceptance (techreview of the harness v3: builder-v3.md §3 C6 stage 7, product.yaml D77_v3 (10)) on recorded
// answers (v3-techreview-fixtures.ts: suite demo in a temporary dir, usage priced by models.yaml; no network, no money):
// 1. the deterministic part — build and types (G0 in process), the migration dry run, RLS, ПДн (static G2), contract
//    tests of the integrations (the V3-20 seam), the end-to-end chains between modules (lead → deal → the person in
//    charge), basic performance and accessibility of the pages;
// 2. the reviewer on a model of another family than the builder (avoidFamilies, T0): a closed set of findings with
//    evidence; safe fixes applied by code and re-checked (a function patch in functions/custom/**, an extension under
//    the gates), ≤ 2 rounds; blockers → the system is not published (the harness fails the build: GATES_FAILED).
import { type AppSpec, emptySpec, type SystemBriefInput, systemBriefSchema } from "@wizard/appspec";
import type { GateReport } from "@wizard/gates";
import { createRegistry, createRouter, type RouteInput, type RouteOutput } from "@wizard/llm";
import { describe, expect, test } from "vitest";
import {
  accessibilityChecks,
  briefNiche,
  CHAINS,
  chainChecks,
  contractTests,
  createTechreview,
  defaultBuilderFamilies,
  deterministicChecks,
  familyOf,
  integrationChecks,
  localGates,
  OWNER_INPUT_SUFFIX_RU,
  ownerInputFinding,
  performanceChecks,
  referenceSpec,
  runBuildV3,
  runTechreview,
  type TechCheck,
  type TechContract,
  type TechRequest,
  type TechreviewHookResult,
  techDigest,
  techreviewMessages,
  type V3BriefVersion,
  type V3Checkpoint,
  type V3Host,
} from "../src/builder/index.js";
import {
  contractFromOpenApi,
  contractHash,
  integrationLayer,
  withIntegrationLayer,
} from "../src/integrations/index.js";
import { DEFAULT_REGISTRY } from "../src/planner/index.js";
import { crmOpenApi } from "./integrations/fixtures.js";
import {
  clinicBrief,
  fakeComposer,
  pageComposeMessages,
  v3Lines,
  writeFixture,
} from "./v3-harness-fixtures.js";
import {
  BAD_PATCH,
  BROKEN_SOURCE,
  CUSTOM_FILE,
  FIXED_SOURCE,
  finding,
  OPEN,
  repairStatus,
  reviewLine,
  walletRoute,
  workshopBrief,
  workshopCtx,
} from "./v3-techreview-fixtures.js";

const noRoute = async (): Promise<RouteOutput> => {
  throw new Error("no model in this test");
};
const reg = createRegistry({ buildDefaultTier: "T1" });

/** A workshop context whose route answers with the recorded findings, round by round. */
function reviewed(
  rounds: Parameters<typeof reviewLine>[1][],
  o: { source?: string; budgetRub?: number; extensions?: readonly unknown[] } = {},
) {
  const base = workshopCtx({
    route: noRoute,
    ...(o.extensions
      ? { extensions: o.extensions }
      : { extensions: [repairStatus(o.source ?? FIXED_SOURCE)] }),
  });
  const seen: RouteInput[] = [];
  const outs: RouteOutput[] = [];
  const { route } = walletRoute({
    lines: rounds.map((r, i) => reviewLine(base, r, i + 1)),
    seen,
    outs,
    ...(o.budgetRub !== undefined ? { budgetRub: o.budgetRub } : {}),
  });
  return { ctx: { ...base, route, budgetRub: o.budgetRub ?? 60 }, seen, outs };
}

describe("V3-15 techreview: the deterministic part", () => {
  const ctx = workshopCtx({ route: noRoute });
  const reference = referenceSpec(ctx.plan, DEFAULT_REGISTRY);

  test("build and types, migration dry run, RLS, ПДн, integrations, chains, pages: no blocker on the workshop", async () => {
    const checks = await deterministicChecks(
      { spec: ctx.spec, files: ctx.files },
      { plan: ctx.plan, reference, evidence: [], gates: localGates },
    );
    const status = (id: string) => checks.find((c) => c.id === id)?.status;
    // Build and types of the whole system (the extension function included), the migration and RLS, ПДн.
    for (const id of [
      "G0-TS-01",
      "G0-BUILD-01",
      "G0-MIG-01",
      "TR-MIG-01",
      "TR-RLS-01",
      "G2-PII-02",
      "G2-PII-05",
    ])
      expect(status(id), id).toBe("pass");
    // The shadow-schema dry run needs a database: in process it is replaced by TR-MIG-01.
    expect(status("G0-MIG-02")).toBe("skip");
    // The operator's data are the owner's input before publication — a warning, never a blocker of the build.
    expect(checks.filter((c) => c.id === "G2-PII-06").every((c) => c.status === "warn")).toBe(true);
    expect(new Set(checks.map((c) => c.area))).toEqual(
      new Set([
        "build",
        "migrations",
        "rls",
        "pii",
        "permissions",
        "security",
        "integrations",
        "chains",
        "performance",
        "accessibility",
      ]),
    );
    expect(checks.filter((c) => c.status === "fail")).toEqual([]);
    // Chains: lead → owner notice is whole; lead → deal is made by the deals module, but no module tells the person in
    // charge about the deal — a warning (a gap the reviewer may close by an extension), covered by the G1 scenario.
    expect(status("TR-CHAIN-lead_owner")).toBe("pass");
    const responsible = checks.find((c) => c.id === "TR-CHAIN-lead_deal_responsible");
    expect(responsible).toMatchObject({ status: "warn", severity: "warning" });
    expect(responsible?.message_ru).toContain("ответственный узнаёт о сделке");
    expect(responsible?.message_ru).not.toContain("заявка в работе становится сделкой");
    expect(responsible?.message_ru).toMatch(/Проверяется сценарием G1: AC\d+/);
    expect(status("TR-INT-mail")).toBe("pass");
  }, 120_000);

  test("a chain link the build lost, or one pointing at a missing channel or function, is a blocker", () => {
    const spec = structuredClone(ctx.spec) as AppSpec;
    spec.workflows = (spec.workflows ?? []).filter((w) => w.name !== "lead_notify");
    const lost = chainChecks({ plan: ctx.plan, spec, files: ctx.files, reference, evidence: [] });
    expect(lost.find((c) => c.id === "TR-CHAIN-lead_owner")).toMatchObject({
      status: "fail",
      severity: "blocker",
    });
    expect(lost.find((c) => c.id === "TR-CHAIN-lead_owner")?.message_ru).toContain("потеряно при сборке");

    const broken = structuredClone(ctx.spec) as AppSpec;
    const deal = broken.workflows?.find((w) => w.name === "deal_from_lead");
    const step = deal?.steps.find((s) => s.type === "function");
    if (!step) throw new Error("no deal_from_lead");
    step.params = { ...(step.params as object), name: "dealFromLead" };
    broken.functions = (broken.functions ?? []).filter((f) => f.name !== "dealFromLead");
    const c = chainChecks({ plan: ctx.plan, spec: broken, files: ctx.files, reference, evidence: [] }).find(
      (x) => x.id === "TR-CHAIN-lead_deal_responsible",
    );
    expect(c).toMatchObject({ status: "fail", severity: "blocker" });
    expect(c?.message_ru).toContain("функции «dealFromLead» нет в системе");
    expect(c?.ref).toMatch(/^\/workflows\/\d+\/steps\/\d+$/);

    // Evidence: the latest G1 of the draft failed the covering scenario — a warning, the final G1 decides.
    const g1: GateReport = {
      level: "G1",
      passed: false,
      specVersion: 3,
      startedAt: "2026-10-09T00:00:00.000Z",
      durationMs: 1,
      checks: [
        { id: "G1-AC", status: "fail", severity: "blocker", message_ru: "Сценарий не прошёл", acId: "AC1" },
      ],
      summary: { pass: 0, fail: 1, warn: 0, skip: 0, error: 0 },
    };
    const ev = chainChecks({ plan: ctx.plan, spec: ctx.spec, files: ctx.files, reference, evidence: [g1] });
    expect(ev.find((x) => x.id === "TR-CHAIN-lead_owner")).toMatchObject({ status: "warn" });
    expect(ev.find((x) => x.id === "TR-CHAIN-lead_owner")?.message_ru).toContain("не прошёл сценарий AC1");
    // The chains of the catalog: order → stock applies only when such modules exist.
    expect(CHAINS.map((x) => x.id)).toContain("order_stock");
    expect(ev.some((x) => x.id === "TR-CHAIN-order_stock")).toBe(false);
  });

  test("integrations: catalog connectors pass; V3-20 contracts — client in the system, contract tests on the mock, the key", async () => {
    const spec = structuredClone(ctx.spec) as AppSpec;
    spec.integrations = [
      ...(spec.integrations ?? []),
      { name: "pay", connector: "yookassa", config: {}, secretRefs: ["secret://yookassa_key"] } as never,
    ];
    const connectors = await integrationChecks({ spec, files: ctx.files });
    expect(connectors.find((c) => c.id === "TR-INT-pay")).toMatchObject({
      status: "pass",
      severity: "warning",
    });
    expect(connectors.find((c) => c.id === "TR-INT-pay")?.message_ru).toContain(
      "коннектор каталога платформы",
    );

    // A V3-20 contract of the brief's outgoing integration and its layer over the backend (as V3Host.integrations).
    const contract = contractFromOpenApi(crmOpenApi(), {
      id: "crm",
      name: "Partner CRM",
      need: "заявки в CRM",
    });
    const brief = systemBriefSchema.parse({
      ...workshopBrief(),
      integrations: [{ id: "crm", name: "Partner CRM", direction: "out" }],
    });
    const layer = integrationLayer({
      brief,
      contracts: [{ contract, version: 1, sha256: contractHash(contract), mode: "mock" }],
    });
    const withLayer = withIntegrationLayer({ spec: ctx.spec, files: Object.fromEntries(ctx.files) }, layer, [
      contract,
    ]);
    const system = { spec: withLayer.spec, files: new Map(Object.entries(withLayer.files)) };
    const tc = (status: TechContract["status"], message_ru = "Ключ принят"): TechContract => ({
      integrationId: "crm",
      contract,
      version: 1,
      status,
      keyCheck: status === "mock" ? null : { ok: status === "live", message_ru },
    });
    const at = (cs: TechCheck[]) => cs.find((c) => c.id === "TR-INT-crm");
    // No key: the contract tests pass on the mock — a note, not a blocker.
    const mock = at(await integrationChecks(system, { contracts: [tc("mock")] }));
    expect(mock).toMatchObject({ status: "warn", severity: "warning", ref: "functions/integrations/crm/" });
    expect(mock?.message_ru).toBe(
      "«Partner CRM»: контрактные тесты на моке прошли; ключа ещё нет — интеграция работает на моке и включится после проверки ключа",
    );
    // The V3-20 key check passed: live.
    const live = at(await integrationChecks(system, { contracts: [tc("live")] }));
    expect(live).toMatchObject({ status: "pass" });
    expect(live?.message_ru).toContain("ключ проверен (Ключ принят)");
    // The key check failed: still a note — the system works on the mock.
    const failed = at(
      await integrationChecks(system, { contracts: [tc("failed", "Ключ не подошёл (401)")] }),
    );
    expect(failed).toMatchObject({ status: "warn", severity: "warning" });
    expect(failed?.message_ru).toContain("ключ не прошёл проверку (Ключ не подошёл (401))");
    // The default runner really runs the V3-20 contract tests on the mock.
    expect(await contractTests(tc("mock"), system)).toEqual({ ok: true, mock: true, problems: [] });
    // Blockers: contract tests that fail, or a contract whose client never reached the system.
    const broken = at(
      await integrationChecks(system, {
        contracts: [tc("mock")],
        runner: async () => ({ ok: false, mock: true, problems: ["createLead: ответ без поля id"] }),
      }),
    );
    expect(broken).toMatchObject({ status: "fail", severity: "blocker" });
    expect(broken?.message_ru).toContain(
      "контрактные тесты на моке не прошли — createLead: ответ без поля id",
    );
    const missing = at(
      await integrationChecks({ spec: ctx.spec, files: ctx.files }, { contracts: [tc("mock")] }),
    );
    expect(missing).toMatchObject({ status: "fail", severity: "blocker" });
    expect(missing?.message_ru).toContain("не попал в систему");
  });

  test("performance and accessibility basics of the pages and public functions", () => {
    const page = `export default function Page() {
  return (
    <main>
      <img src="/a.jpg" />
      <img src="/b.jpg" alt="Мастерская" loading="lazy" />
      <input name="q" />
      <label htmlFor="phone">Телефон</label>
      <input id="phone" name="phone" />
      <button onClick={() => go()}><svg viewBox="0 0 1 1" /></button>
      <button aria-label="Закрыть"><svg viewBox="0 0 1 1" /></button>
      <button type="submit">Отправить</button>
      <div onClick={() => open()}>Открыть</div>
      <a href="#x" tabIndex={2}>Ссылка</a>
      <img src="data:image/png;base64,${"A".repeat(9000)}" alt="" width={10} height={10} />
    </main>
  );
}
`;
    const files = new Map([["ui/pages/Home.tsx", page]]);
    const a11y = accessibilityChecks(files);
    const by = (id: string) => a11y.find((c) => c.id === id);
    expect(by("TR-A11Y-01")).toMatchObject({ status: "warn", ref: "ui/pages/Home.tsx:4" });
    expect(by("TR-A11Y-02")?.message_ru).toContain("(1)");
    expect(by("TR-A11Y-03")).toMatchObject({ status: "warn", ref: "ui/pages/Home.tsx:9" });
    expect(by("TR-A11Y-04")).toMatchObject({ status: "warn", ref: "ui/pages/Home.tsx:12" });
    expect(by("TR-A11Y-05")).toMatchObject({ status: "warn" });
    expect(a11y.every((c) => c.severity === "warning")).toBe(true);
    const spec = {
      ...emptySpec("Мастерская"),
      functions: [{ name: "listAll", kind: "query", file: "functions/custom/listAll.ts", public: true }],
    } as AppSpec;
    const perf = performanceChecks(
      spec,
      new Map([
        ...files,
        ["functions/custom/listAll.ts", "export default query({ handler: (ctx) => ctx.db.lead.list() });"],
        ["ui/pages/Big.tsx", `export default () => <p>${"x".repeat(70_000)}</p>;`],
      ]),
    );
    const p = (id: string) => perf.find((c) => c.id === id);
    expect(p("TR-PERF-01")).toMatchObject({ status: "warn", ref: "ui/pages/Big.tsx:1" });
    expect(p("TR-PERF-02")).toMatchObject({ status: "warn" });
    expect(p("TR-PERF-03")).toMatchObject({ status: "warn", ref: "ui/pages/Home.tsx:4" });
    expect(p("TR-PERF-04")).toMatchObject({ status: "warn", ref: "functions/custom/listAll.ts:1" });
    // A clean page passes every check.
    const clean = new Map([
      ["ui/pages/Ok.tsx", '<main><img src="/a.jpg" alt="Фото" loading="lazy" /><button>Ок</button></main>'],
    ]);
    expect(accessibilityChecks(clean).every((c) => c.status === "pass")).toBe(true);
    expect(performanceChecks(emptySpec("x"), clean).every((c) => c.status === "pass")).toBe(true);
  });

  test("the digest: spec, plan, extensions, signatures and checks — no client data (T0 only)", () => {
    const brief = systemBriefSchema.parse({
      ...(ctx.brief as unknown as SystemBriefInput),
      audience: "Звоните мастеру Ивану +7 916 123-45-67, пишите ivan.master@mail.ru",
    });
    const spec = {
      ...ctx.spec,
      compliance: {
        ...ctx.spec.compliance,
        operatorName: "ИП Петров Пётр Петрович",
        operatorContact: "petrov@mail.ru",
      },
    } as AppSpec;
    const d = techDigest({
      brief,
      plan: ctx.plan,
      system: { spec, files: ctx.files },
      reference,
      checks: [],
      fixes: [],
    });
    const text = JSON.stringify(d);
    expect(text).not.toContain("Петров");
    expect(text).not.toContain("petrov@mail.ru");
    expect(text).not.toContain("123-45-67");
    expect(text).not.toContain("ivan.master@mail.ru");
    // Acceptance sample data of the modules never reach the reviewer.
    expect(text).not.toContain("Анна Тестова");
    expect(d.extensions).toContain(`функция repairStatus (${CUSTOM_FILE})`);
    expect(d.functions.find((f) => f.name === "repairStatus")?.signature).toBe('query({ id: v.id("lead") })');
    expect(d.functions.find((f) => f.name === "dealFromLead")?.signature).toBe(
      'mutation({ id: v.id("lead") })',
    );
    expect(d.custom.map((c) => c.file)).toEqual([CUSTOM_FILE]);
    expect(
      d.workflows.some((w) =>
        /deal_from_lead: on_status lead status=in_work → function\(dealFromLead\)/.test(w),
      ),
    ).toBe(true);
  });
});

describe("V3-15 techreview: the reviewer of another family, ≤ 2 rounds, blockers", () => {
  test("another family than the builder: the chain skips glm and kimi (and the run's own families), T0 only", async () => {
    expect(defaultBuilderFamilies()).toEqual(["glm", "kimi"]);
    const { ctx, seen, outs } = reviewed([{ findings: [] }]);
    const r = await runTechreview(ctx);
    expect(r.blockers).toEqual([]);
    expect(seen.map((s) => s.callType)).toEqual(["techreview"]);
    expect(seen[0]?.avoidFamilies).toEqual(["glm", "kimi"]);
    expect(outs[0]).toMatchObject({ tier: "T0", model: "gpt-oss-120b" });
    expect(familyOf(outs[0]?.model ?? "")).toBe("gpt-oss");
    expect(r.reviewer).toMatchObject({ status: "done", calls: 1, model: "gpt-oss-120b" });
    expect(r.reviewer.costRub).toBeGreaterThan(0);
    // The run's builder answered on gpt-oss (a fallback): the reviewer goes further down the chain.
    const again = reviewed([{ findings: [] }]);
    const r2 = await runTechreview(again.ctx, { builderFamilies: async () => ["gpt-oss"] });
    expect(again.seen[0]?.avoidFamilies).toEqual(["glm", "gpt-oss", "kimi"]);
    expect(again.outs[0]?.model).toBe("gigachat-3.5");
    expect(r2.reviewer.model).toBe("gigachat-3.5");
  }, 120_000);

  test("a deterministic blocker fixed by the reviewer's patch in functions/custom/**; round 2 is clean → published", async () => {
    const { ctx, seen } = reviewed(
      [
        {
          findings: [
            finding({
              title_ru: "Запрос статуса падает, если заявки нет",
              evidence: { kind: "check", ref: "G0-TS-01" },
              fix: { kind: "function_patch", file: CUSTOM_FILE, source: FIXED_SOURCE },
            }),
          ],
        },
        { findings: [] },
      ],
      { source: BROKEN_SOURCE },
    );
    const hook = createTechreview();
    const out = (await hook(ctx)) as TechreviewHookResult;
    expect(out.blockers).toEqual([]);
    expect(out.status).toBe("done");
    expect(out.files?.get(CUSTOM_FILE)).toBe(FIXED_SOURCE);
    // The reviewer's calls go through ctx.route: the stage wallet counts them, the hook adds nothing.
    expect(out.spentRub).toBe(0);
    expect(out.notes?.join(" ")).toContain("исправлено 1");
    expect(out.note).toContain("раундов исправлений 1");
    expect(seen).toHaveLength(2);
    // Without the reviewer's fix the same system is not published: G0-TS-01 is a deterministic blocker.
    const { ctx: alone } = reviewed([{ findings: [] }], { source: BROKEN_SOURCE });
    const r = await runTechreview(alone);
    expect(r.blockers).toHaveLength(1);
    expect(r.blockers[0]).toMatch(/^Сборка и типы: Ошибка типов в functions\/custom\/repairStatus\.ts:8/);
  }, 180_000);

  test("a blocker without a safe fix keeps the system from publication", async () => {
    const { ctx } = reviewed([
      {
        findings: [
          finding({
            severity: "blocker",
            area: "permissions",
            title_ru: "Сотрудник видит заявки всех мастеров, а должен — только свои",
            evidence: { kind: "spec", ref: "/permissions/0" },
          }),
          finding({
            severity: "minor",
            area: "edge_cases",
            title_ru: "Повторная отправка формы создаёт вторую заявку",
            evidence: { kind: "spec", ref: "/entities/0" },
          }),
        ],
      },
    ]);
    const r = await runTechreview(ctx);
    expect(r.blockers).toEqual(["Права: Сотрудник видит заявки всех мастеров, а должен — только свои"]);
    expect(r.findings.map((f) => f.severity)).toEqual(["blocker", "minor"]);
    expect(r.rounds).toBe(0);
  }, 120_000);

  test("the operator's data are the owner's input: the reviewer's blocker about them never fails the build", async () => {
    // Checkpoint 2026-10-09 (v3-01): the reviewer read G2-PII-06 «нельзя опубликовать» as «Права: Отсутствует название
    // оператора персональных данных» — GATES_FAILED. The owner fills them before publication (publish refuses without).
    const { ctx } = reviewed([
      {
        findings: [
          finding({
            severity: "blocker",
            area: "permissions",
            title_ru: "Отсутствует название оператора персональных данных",
            evidence: { kind: "check", ref: "G2-PII-06" },
          }),
          finding({
            severity: "blocker",
            area: "data",
            title_ru: "Не указан контакт оператора для обращений",
            evidence: { kind: "spec", ref: "/entities/0" },
          }),
          finding({
            severity: "blocker",
            area: "permissions",
            title_ru: "Сотрудник видит заявки всех мастеров, а должен — только свои",
            evidence: { kind: "spec", ref: "/permissions/0" },
          }),
        ],
      },
    ]);
    const r = await runTechreview(ctx);
    expect(r.blockers).toEqual(["Права: Сотрудник видит заявки всех мастеров, а должен — только свои"]);
    expect(r.ownerInput).toEqual([
      "Отсутствует название оператора персональных данных",
      "Не указан контакт оператора для обращений",
    ]);
    expect(r.findings.map((f) => f.title_ru)).toEqual([
      "Сотрудник видит заявки всех мастеров, а должен — только свои",
    ]);
    expect(r.note).toContain("данные владельца перед публикацией: 2");
    // The deterministic G2-PII-06 says it is the owner's, so the reviewer is not misled by «нельзя опубликовать».
    const pii = r.checks.filter((c) => c.id === "G2-PII-06");
    expect(pii.length).toBeGreaterThan(0);
    for (const c of pii) {
      expect(c).toMatchObject({ status: "warn", severity: "warning" });
      expect(c.message_ru.endsWith(OWNER_INPUT_SUFFIX_RU)).toBe(true);
    }
    expect(
      techreviewMessages(
        techDigest({
          brief: ctx.brief,
          plan: ctx.plan,
          system: { spec: ctx.spec, files: ctx.files },
          reference: null,
          checks: [],
          fixes: [],
        }),
        1,
        2,
      )[0]?.content,
    ).toContain("Данные оператора персональных данных");
  }, 120_000);

  test("ownerInputFinding: the operator's data by check, /compliance pointer or title; other findings are the build's", () => {
    const f = (title_ru: string, kind: "check" | "spec" | "file", ref: string) => ({
      title_ru,
      evidence: { kind, ref },
    });
    expect(ownerInputFinding(f("Нет данных", "check", "G2-PII-06"))).toBe(true);
    expect(ownerInputFinding(f("Пусто", "spec", "/compliance/operatorAddress"))).toBe(true);
    expect(ownerInputFinding(f("Не заполнен адрес оператора ПДн", "spec", "/entities/0"))).toBe(true);
    expect(ownerInputFinding(f("Нет оператора обработки персональных данных", "file", CUSTOM_FILE))).toBe(
      true,
    );
    expect(ownerInputFinding(f("Утечка телефонов клиентов в публичной функции", "check", "G2-PII-02"))).toBe(
      false,
    );
    expect(ownerInputFinding(f("Оператор колл-центра видит все заявки", "spec", "/permissions/0"))).toBe(
      false,
    );
  });

  test("a patch that breaks the build is reverted; never more than 2 rounds; the blocker stays with the reason", async () => {
    const bad = finding({
      title_ru: "Статус ремонта берётся не из того поля",
      area: "data",
      evidence: { kind: "file", ref: `${CUSTOM_FILE}:9` },
      fix: { kind: "function_patch", file: CUSTOM_FILE, source: BAD_PATCH },
    });
    const { ctx, seen } = reviewed([{ findings: [bad] }, { findings: [bad] }, { findings: [] }]);
    const r = await runTechreview(ctx);
    expect(seen).toHaveLength(2);
    expect(r.rounds).toBe(2);
    expect(r.fixes.map((f) => [f.round, f.applied])).toEqual([
      [1, false],
      [2, false],
    ]);
    expect(r.fixes[0]?.reason_ru).toMatch(/^код не прошёл проверки G0: Ошибка типов/);
    expect(r.files.size).toBe(0);
    expect(r.blockers).toHaveLength(1);
    expect(r.blockers[0]).toMatch(
      /^Связность данных: Статус ремонта берётся не из того поля \(исправление не применено: код не прошёл проверки G0/,
    );
    // The deterministic part is unchanged: the reverted patch left no trace.
    expect(r.checks.filter((c) => c.status === "fail")).toEqual([]);
  }, 180_000);

  test("fixes stay inside functions/custom/**; findings without evidence in the system are dropped", async () => {
    const { ctx } = reviewed([
      {
        findings: [
          finding({
            title_ru: "Сделка из заявки не проверяет статус",
            area: "chains",
            evidence: { kind: "file", ref: "functions/deals/dealFromLead.ts" },
            fix: { kind: "function_patch", file: "functions/deals/dealFromLead.ts", source: FIXED_SOURCE },
          }),
          finding({ title_ru: "Проверка G9 упала", evidence: { kind: "check", ref: "G9-XYZ-01" } }),
          finding({ title_ru: "Поле удалено", evidence: { kind: "spec", ref: "/entities/99/fields/0" } }),
          finding({ title_ru: "Файл не тот", evidence: { kind: "file", ref: "functions/custom/nope.ts" } }),
        ],
      },
      // Round 2: the reviewer raises it again without a fix — it keeps the reason the round-1 fix was refused.
      {
        findings: [
          finding({
            title_ru: "Сделка из заявки не проверяет статус",
            area: "chains",
            evidence: { kind: "file", ref: "functions/deals/dealFromLead.ts" },
          }),
        ],
      },
    ]);
    const r = await runTechreview(ctx);
    expect(r.reviewer.unfounded).toBe(3);
    expect(r.fixes).toEqual([
      expect.objectContaining({
        applied: false,
        reason_ru: "правка только в functions/custom/** — функции модулей не меняются",
      }),
    ]);
    expect(r.blockers).toEqual([
      "Связи модулей: Сделка из заявки не проверяет статус (исправление не применено: правка только в functions/custom/** — функции модулей не меняются)",
    ]);
  }, 180_000);

  test("an extension closing the chain is checked under the gates: applied by a host that merges it, else a request", async () => {
    const op = {
      op: "add_automation",
      name: "deal_team_notify",
      label: "Сообщить команде о новой сделке",
      trigger: { type: "on_create", entity: "deal" },
      steps: [
        {
          type: "notify",
          params: { integration: "mail", to: "$owner", template: "new_lead", link: "/cabinet" },
        },
      ],
    };
    const answer = {
      findings: [
        finding({
          severity: "major",
          area: "chains",
          title_ru: "Ответственный не узнаёт о новой сделке",
          evidence: { kind: "check", ref: "TR-CHAIN-lead_deal_responsible" },
          fix: { kind: "extension", op },
        }),
      ],
    };
    const requests: TechRequest[] = [];
    const { ctx } = reviewed([answer, { findings: [] }]);
    const deferred = await runTechreview(ctx, { request: async (q) => void requests.push(q) });
    expect(deferred.fixes[0]).toMatchObject({ kind: "extension", applied: false });
    expect(deferred.fixes[0]?.reason_ru).toContain("Запросы на развитие");
    expect(deferred.extensions).toEqual([]);
    expect(deferred.blockers).toEqual([]);
    expect(requests.map((q) => q.key)).toEqual([
      "techreview:ext:Ответственный не узнаёт о новой сделке",
      "techreview:TR-CHAIN-lead_deal_responsible",
    ]);

    const { ctx: ctx2 } = reviewed([answer, { findings: [] }]);
    const hook = createTechreview({ applyExtensions: true });
    const out = (await hook(ctx2)) as TechreviewHookResult;
    expect(out.extensions).toEqual([op]);
    expect(out.blockers).toEqual([]);
    const applied = await runTechreview(reviewed([answer, { findings: [] }]).ctx, { applyExtensions: true });
    expect(applied.fixes[0]).toMatchObject({ applied: true });
    expect(applied.checks.find((c) => c.id === "TR-CHAIN-lead_deal_responsible")?.status).toBe("pass");
    // An operation the extension rules refuse is not applied.
    const refused = await runTechreview(
      reviewed([
        {
          findings: [
            finding({
              severity: "major",
              area: "permissions",
              title_ru: "Нужна роль бухгалтера",
              evidence: { kind: "spec", ref: "/roles/0" },
              fix: { kind: "extension", op: { op: "add_role", role: { name: "x" } } },
            }),
          ],
        },
        { findings: [] },
      ]).ctx,
      { applyExtensions: true },
    );
    expect(refused.fixes[0]).toMatchObject({ applied: false });
    expect(refused.fixes[0]?.reason_ru).toContain("Операция не по схеме расширения");
  }, 240_000);

  test("budget and availability: the reviewer skipped, the deterministic verdict stands", async () => {
    // The stage has 0.5 ₽ left: the reviewer's call does not fit (the wallet refuses before the call).
    const poor = reviewed([{ findings: [] }], { budgetRub: 0.5 });
    const r = await runTechreview(poor.ctx);
    expect(poor.seen).toEqual([]);
    expect(r.reviewer).toMatchObject({ status: "skipped", reason: "бюджет этапа исчерпан", calls: 0 });
    expect(r.blockers).toEqual([]);
    expect(r.notes[1]).toBe(
      "Ревьюер не ответил (бюджет этапа исчерпан) — систему проверила детерминированная часть.",
    );
    // No recorded answer (models unavailable): the same.
    const none = reviewed([]);
    const r2 = await runTechreview(none.ctx);
    expect(r2.reviewer).toMatchObject({ status: "skipped" });
    expect(r2.reviewer.reason).toMatch(/^модели ревьюера недоступны/);
    // A deterministic blocker still blocks without the reviewer.
    const broken = reviewed([], { source: BROKEN_SOURCE, budgetRub: 0.5 });
    expect((await runTechreview(broken.ctx)).blockers).toHaveLength(1);
  }, 180_000);
});

// ------------------------------------------------------------------------------------------- the harness end to end

/** A V3Host over a fixture router (page_compose and techreview answers), passing gates and in-memory state. */
function harnessHost(lines: Parameters<typeof writeFixture>[1], hooks: V3Host["hooks"]) {
  const brief = systemBriefSchema.parse(clinicBrief());
  const sys = {
    briefs: [{ version: 1, brief }] as V3BriefVersion[],
    spec: emptySpec("Клиника"),
    version: 0,
    files: {} as Record<string, string>,
    checkpoints: new Map<string, V3Checkpoint>(),
  };
  const dir = writeFixture("clinic", lines);
  const router = createRouter({
    mode: "fixture",
    fixture: { suite: "demo", name: "v3/clinic", dir },
    registry: reg,
    sink: { write: async () => {} },
    env: {},
  });
  const calls: RouteInput[] = [];
  const requests: string[] = [];
  const passing = (level: string): GateReport => ({
    level: level as GateReport["level"],
    passed: true,
    specVersion: sys.version,
    startedAt: "2026-10-09T00:00:00.000Z",
    durationMs: 1,
    checks: [],
    summary: { pass: 1, fail: 0, warn: 0, skip: 0, error: 0 },
  });
  const host: V3Host = {
    run: { id: `run-${Math.random().toString(16).slice(2)}` },
    systemId: "sys-clinic",
    runStep: (_n, fn) => fn(),
    emit: () => {},
    route: async (input) => {
      const { step: _s, upperBoundCredits: _u, ...rest } = input;
      const full = { ...rest, orgPolicy: OPEN, ctx: { orgId: "org" } } as RouteInput;
      calls.push(full);
      return router.route(full);
    },
    brief: async () => sys.briefs.at(-1) ?? null,
    checkpoints: {
      load: async () => [...sys.checkpoints.values()],
      save: async (cp) => {
        sys.checkpoints.set(cp.key, cp);
      },
    },
    currentSpec: async () => ({ spec: sys.spec, version: sys.version }),
    commit: async ({ spec, files }) => {
      sys.version += 1;
      sys.spec = spec;
      sys.files = { ...files };
      return { revision: sys.version };
    },
    runGates: async (level) => passing(level),
    composer: fakeComposer(),
    preview: async () => ({ ok: true, problems: [] }),
    checkScenario: async () => ({ ok: true, problems: [], browser: false }),
    hooks,
    recordDevelopmentRequest: async (input) => {
      requests.push(String(input.quote));
    },
  };
  return { host, sys, calls, brief, requests };
}

describe("V3-15 techreview in the harness v3", () => {
  const brief = systemBriefSchema.parse(clinicBrief());
  const pages = v3Lines({
    brief: { goals: brief.goals, audience: brief.audience },
    niche: briefNiche(brief),
    seed: "sys-clinic",
    pages: 10,
    prompt: pageComposeMessages({ brief, design: {} as never }, brief.scenarios[0] as never),
  });
  const review = (args: Parameters<typeof reviewLine>[1]) =>
    reviewLine(workshopCtx({ route: noRoute }), args);

  test("a clean techreview: the build is published with its notes; a blocker → GATES_FAILED, not published", async () => {
    const ok = harnessHost([...pages, review({ findings: [] })], { techreview: createTechreview() });
    const out = await runBuildV3(ok.host, { appName: "Клиника" });
    if (out.status !== "succeeded") throw new Error(JSON.stringify(out));
    expect(out.stages.techreview?.status).toBe("done");
    expect(out.stages.techreview?.note).toMatch(/ревьюер gpt-oss-120b/);
    expect(out.summary_ru).toContain("Техревью: проверил сборку и типы");
    expect(ok.calls.filter((c) => c.callType === "techreview").map((c) => c.avoidFamilies)).toEqual([
      ["glm", "kimi"],
    ]);
    // The final gates ran: the system is ready for publication.
    expect(out.stages.gates?.status).toBe("done");

    const blocked = harnessHost(
      [
        ...pages,
        review({
          findings: [
            finding({
              area: "permissions",
              title_ru: "Посетитель без входа читает записи других посетителей",
              evidence: { kind: "spec", ref: "/permissions/0" },
            }),
          ],
        }),
      ],
      { techreview: createTechreview() },
    );
    const failed = await runBuildV3(blocked.host, { appName: "Клиника" });
    expect(failed).toMatchObject({ status: "failed", code: "GATES_FAILED", retryable: true });
    expect((failed as { message_ru: string }).message_ru).toContain(
      "Техревью нашло ошибку, с которой систему нельзя публиковать: Права: Посетитель без входа читает записи других посетителей",
    );
    // Not published: the final gates never ran.
    expect((failed as { stages: Record<string, unknown> }).stages.gates).toBeUndefined();
  }, 300_000);

  test("an extension fix of the techreview is applied by the harness under the gates; a refused one goes to the requests", async () => {
    // The clinic's backend as the harness compiles it: an automation on its own channel and template.
    const clinic = workshopCtx({ route: noRoute, brief: clinicBrief(), extensions: [] });
    const mail = (clinic.spec.integrations ?? []).find((i) => i.connector === "email");
    const template = Object.keys(((mail?.config ?? {}) as { templates?: object }).templates ?? {})[0];
    if (!mail || !template) throw new Error("clinic: no e-mail channel");
    const step = {
      type: "notify",
      params: { integration: mail.name, to: "$owner", template, link: "/cabinet" },
    };
    const op = {
      op: "add_automation",
      name: "booking_owner_copy",
      label: "Копия о новой записи владельцу",
      trigger: { type: "on_create", entity: "booking" },
      steps: [step],
    };
    const fix = (o: Record<string, unknown>, title_ru: string) =>
      review({
        findings: [
          finding({
            severity: "major",
            area: "chains",
            title_ru,
            evidence: { kind: "spec", ref: "/workflows/0" },
            fix: { kind: "extension", op: o },
          }),
        ],
      });
    const ok = harnessHost(
      [...pages, fix(op, "Владелец не получает копию о записи"), review({ findings: [] })],
      {
        techreview: createTechreview({ applyExtensions: true }),
      },
    );
    const out = await runBuildV3(ok.host, { appName: "Клиника" });
    if (out.status !== "succeeded") throw new Error(JSON.stringify(out));
    // The harness compiled the backend again with the operation: it is in the committed spec, the gates ran after it.
    expect(ok.sys.spec.workflows?.map((w) => w.name)).toContain("booking_owner_copy");
    expect(out.stages.gates?.status).toBe("done");
    expect(ok.requests).toEqual([]);

    // The techreview refuses an operation the extension rules do not allow: the reason goes to the requests.
    const requests: TechRequest[] = [];
    const bad = {
      ...op,
      name: "booking_to_client",
      steps: [{ ...step, params: { ...step.params, to: "$record.email" } }],
    };
    const refused = harnessHost(
      [...pages, fix(bad, "Клиенту не уходит копия записи"), review({ findings: [] })],
      {
        techreview: createTechreview({ applyExtensions: true, request: async (q) => void requests.push(q) }),
      },
    );
    const out2 = await runBuildV3(refused.host, { appName: "Клиника" });
    expect(out2.status).toBe("succeeded");
    expect(refused.sys.spec.workflows?.map((w) => w.name)).not.toContain("booking_to_client");
    expect(requests.map((q) => q.quote_ru)).toEqual([
      expect.stringMatching(
        /^Доработка по техревью: Клиенту не уходит копия записи — не применена: .*письма посетителям отправляют модули/,
      ),
    ]);

    // An operation the harness itself refuses when it compiles the backend becomes a request with the reason.
    const own = harnessHost(pages, {
      techreview: async () => ({ status: "done", extensions: [{ ...op, name: "lead_notify" } as never] }),
    });
    const out3 = await runBuildV3(own.host, { appName: "Клиника" });
    expect(out3.status).toBe("succeeded");
    expect(own.requests).toEqual([
      expect.stringMatching(/^Доработка системы: Автоматизация «lead_notify» уже есть в системе/),
    ]);
  }, 300_000);
});
