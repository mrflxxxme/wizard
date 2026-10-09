// V3-32 acceptance 2 (agent side): the repository's rules (AGENTS.md, CLAUDE.md, CONTRIBUTING) reach the agent; without
// them the agent follows the AGENTS.md draft Wizard proposes; the agent's phase runs in the sandbox without network
// (install alone reaches the registry); the repository's build and tests run after the change; the techreview blocks
// forbidden paths, new dependencies, secrets and switched-off tests. Acceptance 3 at this level: every model call of
// the agent and its reviewer is callType repo_code / repo_review (the router keeps them in RF — client-code.test.ts).
import { describe, expect, test } from "vitest";
import {
  draftAgentsMd,
  profileRepo,
  type RepoSnapshot,
  repoRules,
  runCompatCheck,
  runRepoAgent,
  snapshotOf,
} from "../src/repo/index.js";
import { fixture, snapshotOfFixture } from "./repo-fixtures.js";
import { FakeSandbox, scriptedRoute } from "./repo-helpers.js";

const NEW_APP = (label: string) => `import { useState } from "react";

export function App() {
  const [count, setCount] = useState(0);
  return (
    <main>
      <h1>Пекарня «Колос»</h1>
      <button type="button" onClick={() => setCount(count + 1)}>
        В корзине: {count}
      </button>
      <button type="button">${label}</button>
    </main>
  );
}
`;

async function prepared(name: string, extra: Record<string, string> = {}) {
  const fx = fixture(name);
  const snapshot: RepoSnapshot = snapshotOf({ ...fx.files, ...extra });
  const sb = new FakeSandbox(fx.sandbox);
  const check = await runCompatCheck(snapshot, sb, { keepOpen: true });
  if (!check.workspace || !check.plan) throw new Error(`not open: ${check.report.verdict}`);
  return { snapshot, sb, check, workspace: check.workspace, plan: check.plan };
}

const agentTurns = (label: string, extra: Array<[string, unknown]> = []) =>
  [
    [["list_files", { prefix: "src/" }]],
    [["read_file", { path: "src/App.tsx" }]],
    [["write_file", { path: "src/App.tsx", content: NEW_APP(label) }], ...extra],
    [["run_checks", {}]],
    [
      [
        "finish",
        {
          title_ru: "Кнопка «Оформить заказ»",
          summary_ru: "Добавил кнопку оформления заказа рядом с корзиной.",
        },
      ],
    ],
  ] as Array<Array<[string, unknown]>>;

const noFindings: Array<Array<[string, unknown]>> = [[["submit_repo_review", { findings: [] }]]];

describe("rules of the repository", () => {
  test("AGENTS.md, CLAUDE.md and CONTRIBUTING are read in order and given to the agent", async () => {
    const rules = {
      "AGENTS.md": "# Правила\n\nКомпоненты — только функциональные.\n",
      "CLAUDE.md": "Коммиты на русском.\n",
      "CONTRIBUTING.md": "Каждая кнопка — с type.\n",
    };
    const p = await prepared("vite-react-pnpm", rules);
    const r = repoRules(p.snapshot, p.check.profile, "acme/bakery");
    expect(r.sources.map((s) => s.path)).toEqual(["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md"]);
    expect(r.draft).toBeNull();
    expect(p.check.report.rules).toEqual(["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md"]);
    const s = scriptedRoute([...agentTurns("Оформить заказ"), ...noFindings]);
    const out = await runRepoAgent({
      task: "Добавь кнопку «Оформить заказ»",
      snapshot: p.snapshot,
      profile: p.check.profile,
      rules: r,
      workspace: p.workspace,
      plan: p.plan,
      route: s.route,
      orgPolicy: { ruOnly: false, t1Restricted: false },
      ctx: { orgId: "org-1" },
    });
    expect(out.ok).toBe(true);
    const system = String(s.seen[0]?.input.messages[0]?.content);
    expect(system).toContain("## Правила платформы (главнее правил репозитория)");
    expect(system).toContain("### AGENTS.md");
    expect(system).toContain("Компоненты — только функциональные.");
    expect(system).toContain("### CLAUDE.md");
    expect(system).toContain("### CONTRIBUTING.md");
    expect(system.indexOf("## Правила платформы")).toBeLessThan(system.indexOf("## Правила репозитория"));
  });

  test("no rules: the agent follows the AGENTS.md draft Wizard proposes (facts of the repository, no model)", () => {
    const s = snapshotOfFixture("vite-react-pnpm");
    const p = profileRepo(s);
    const r = repoRules(s, p, "acme/bakery");
    expect(r.sources).toEqual([]);
    expect(r.draft).toBe(draftAgentsMd(p, s, "acme/bakery"));
    expect(r.draft).toContain("# acme/bakery");
    expect(r.draft).toContain("- Vite, React на TypeScript");
    expect(r.draft).toContain("- Установка зависимостей: `pnpm install --frozen-lockfile`");
    expect(r.draft).toContain("- Сборка: `pnpm run build`");
    expect(r.draft).toContain("- Тесты: `pnpm run test`");
    expect(r.draft).toContain("- `src/`");
    expect(r.draft).toContain("CI (.github/workflows, .gitlab-ci.yml) меняет человек");
  });
});

describe("the agent: sandbox without network, the repository's tests, the techreview", () => {
  test("a task end to end: install had the registry, every other run had no network; build and tests after the change", async () => {
    const p = await prepared("vite-react-pnpm");
    const s = scriptedRoute([...agentTurns("Оформить заказ"), ...noFindings]);
    const out = await runRepoAgent({
      task: "Добавь кнопку «Оформить заказ»",
      snapshot: p.snapshot,
      profile: p.check.profile,
      rules: repoRules(p.snapshot, p.check.profile, "acme/bakery"),
      workspace: p.workspace,
      plan: p.plan,
      route: s.route,
      orgPolicy: { ruOnly: false, t1Restricted: false },
      ctx: { orgId: "org-1" },
    });
    expect(out).toMatchObject({ ok: true, title_ru: "Кнопка «Оформить заказ»", agentRuns: 1 });
    expect([...out.changes.keys()]).toEqual(["src/App.tsx"]);
    expect(out.changes.get("src/App.tsx")).toContain("Оформить заказ");
    // Phases and network of every sandbox run: compatibility (install → build → test), the agent's run_checks, the
    // verification after finish.
    expect(p.sb.runs.map((r) => `${r.phase}:${r.network}`)).toEqual([
      "install:registry",
      "build:none",
      "test:none",
      "agent:none",
      "agent:none",
      "build:none",
      "test:none",
    ]);
    // The verification saw the change.
    expect(p.sb.runs.at(-1)?.files.get("src/App.tsx")).toContain("Оформить заказ");
    expect(out.verify.test?.ok).toBe(true);
    // Every model call carries client code with a client-code call type; the reviewer avoids the agent's family.
    expect(new Set(s.seen.map((c) => c.input.callType))).toEqual(new Set(["repo_code", "repo_review"]));
    const review = s.seen.find((c) => c.input.callType === "repo_review");
    expect(review?.input.avoidFamilies).toEqual(["deepseek"]);
    expect(out.calls.every((c) => c.tier === "T0")).toBe(true);
    expect(out.review?.checks).toEqual([
      { id: "R-OK", ok: true, message_ru: "детерминированные проверки пройдены" },
    ]);
  });

  test("tests fail after finish: the failure goes back to the agent, the second round fixes it", async () => {
    const p = await prepared("vite-react-npm");
    const s = scriptedRoute([
      [["write_file", { path: "src/App.tsx", content: `${NEW_APP("Заказ")}// BROKEN\n` }]],
      [["finish", { title_ru: "Кнопка заказа", summary_ru: "Добавил кнопку заказа на главную." }]],
      [["write_file", { path: "src/App.tsx", content: NEW_APP("Заказ") }]],
      [["finish", { title_ru: "Кнопка заказа", summary_ru: "Добавил кнопку заказа, тесты проходят." }]],
      ...noFindings,
    ]);
    const out = await runRepoAgent({
      task: "Кнопка заказа",
      snapshot: p.snapshot,
      profile: p.check.profile,
      rules: repoRules(p.snapshot, p.check.profile, "acme/bakery"),
      workspace: p.workspace,
      plan: p.plan,
      route: s.route,
      orgPolicy: null,
      ctx: { orgId: "org-1" },
    });
    expect(out.ok).toBe(true);
    const feedback = s.seen[2]?.input.messages.at(-1);
    expect(String(feedback?.content)).toMatch(/^Проверка после finish не прошла/);
    expect(String(feedback?.content)).toContain("BROKEN");
    expect(s.left()).toBe(0);
  });

  test("the techreview blocks CI, lockfile, new dependencies, secrets and switched-off tests — no PR", async () => {
    const p = await prepared("vite-react-pnpm");
    const pkg = JSON.parse(p.snapshot.get("package.json")?.text ?? "{}");
    pkg.dependencies.lodash = "^4.17.21";
    const s = scriptedRoute([
      [
        ["write_file", { path: ".github/workflows/ci.yml", content: "on: push\n" }],
        ["write_file", { path: "package.json", content: JSON.stringify(pkg, null, 2) }],
        ["write_file", { path: "pnpm-lock.yaml", content: "lockfileVersion: '9.0'\n" }],
        [
          "write_file",
          { path: "src/config.ts", content: 'export const apiKey = "sk-live-0123456789abcdefghijklmnop";\n' },
        ],
        [
          "write_file",
          {
            path: "src/App.test.tsx",
            content: (p.snapshot.get("src/App.test.tsx")?.text ?? "").replace("test(", "test.skip("),
          },
        ],
      ],
      [["finish", { title_ru: "Настройка проекта", summary_ru: "Поменял конфигурацию и тесты." }]],
      [
        [
          "submit_repo_review",
          { findings: [{ severity: "major", file: "src/elsewhere.ts", title_ru: "Файл вне правки" }] },
        ],
      ],
    ]);
    const out = await runRepoAgent({
      task: "Настрой проект",
      snapshot: p.snapshot,
      profile: p.check.profile,
      rules: repoRules(p.snapshot, p.check.profile, "acme/bakery"),
      workspace: p.workspace,
      plan: p.plan,
      route: s.route,
      orgPolicy: null,
      ctx: { orgId: "org-1" },
    });
    expect(out).toMatchObject({ ok: false, code: "REVIEW_BLOCKED" });
    const ids = out.review?.checks.filter((c) => !c.ok).map((c) => `${c.id} ${c.file}`);
    expect(ids).toEqual([
      "R-PATH .github/workflows/ci.yml",
      "R-DEPS package.json",
      "R-PATH pnpm-lock.yaml",
      "R-SECRET src/config.ts",
      "R-TESTS src/App.test.tsx",
    ]);
    expect(out.review?.reviewer.unfounded).toBe(1);
    expect(out.reason_ru).toMatch(/^Техревью нашло блокеры: \.github\/workflows\/ci\.yml: CI меняет человек/);
  });

  test("replace_in_file: one exact fragment; a missing or repeated one goes back to the agent as an error", async () => {
    const p = await prepared("vite-react-pnpm");
    const s = scriptedRoute([
      [["replace_in_file", { path: "src/App.tsx", old: "нет такого", new: "x" }]],
      [["replace_in_file", { path: "src/App.tsx", old: "button", new: "x" }]],
      [
        [
          "replace_in_file",
          { path: "src/App.tsx", old: "В корзине: {count}", new: "В корзине: {count} шт." },
        ],
      ],
      [["finish", { title_ru: "Единицы в корзине", summary_ru: "Добавил «шт.» к счётчику корзины." }]],
      ...noFindings,
    ]);
    const out = await runRepoAgent({
      task: "Покажи «шт.» в корзине",
      snapshot: p.snapshot,
      profile: p.check.profile,
      rules: repoRules(p.snapshot, p.check.profile, "acme/bakery"),
      workspace: p.workspace,
      plan: p.plan,
      route: s.route,
      orgPolicy: null,
      ctx: { orgId: "org-1" },
    });
    expect(out.ok).toBe(true);
    const results = s.seen[3]?.input.messages
      .filter((m) => m.role === "tool")
      .map((m) => JSON.stringify(m.content));
    expect(results?.[0]).toContain("NO_MATCH");
    expect(results?.[1]).toContain("AMBIGUOUS");
    expect(out.changes.get("src/App.tsx")).toContain("В корзине: {count} шт.");
  });

  test("the task's wallet stops the agent at its ceiling", async () => {
    const p = await prepared("vite-react-pnpm");
    const s = scriptedRoute(agentTurns("Заказ"), { creditsMilli: 50_000 });
    const out = await runRepoAgent({
      task: "Кнопка",
      snapshot: p.snapshot,
      profile: p.check.profile,
      rules: repoRules(p.snapshot, p.check.profile, "acme/bakery"),
      workspace: p.workspace,
      plan: p.plan,
      route: s.route,
      orgPolicy: null,
      ctx: { orgId: "org-1" },
      budgetRub: 10,
      rubPerCredit: 1,
    });
    expect(out).toMatchObject({ ok: false, code: "BUDGET" });
    expect(out.reason_ru).toBe("Бюджет задачи (10 ₽) исчерпан — правка не закончена");
  });

  test("a Wizard system: G0 and the static G2 check the change; generated files (brief) are refused", async () => {
    const fx = fixture("wizard-system");
    const snapshot = snapshotOf(fx.files);
    const check = await runCompatCheck(snapshot, null, { keepOpen: true });
    expect(check.report.verdict).toBe("compatible");
    const page = [...snapshot.keys()].find((x) => x.startsWith("ui/") && x.endsWith(".tsx")) as string;
    const s = scriptedRoute([
      [
        ["write_file", { path: page, content: `${snapshot.get(page)?.text ?? ""}\n// правка агента\n` }],
        ["write_file", { path: "brief/brief.json", content: "{}\n" }],
      ],
      [["finish", { title_ru: "Правка страницы", summary_ru: "Поправил страницу и бриф." }]],
      ...noFindings,
    ]);
    const out = await runRepoAgent({
      task: "Поправь страницу",
      snapshot,
      profile: check.profile,
      rules: repoRules(snapshot, check.profile, "clinic"),
      workspace: check.workspace as NonNullable<typeof check.workspace>,
      plan: check.plan as NonNullable<typeof check.plan>,
      route: s.route,
      orgPolicy: null,
      ctx: { orgId: "org-1" },
    });
    expect(out.verify.build?.output).toBe("G0: пройдено");
    expect(out.code).toBe("REVIEW_BLOCKED");
    expect(out.review?.checks.find((c) => !c.ok)?.message_ru).toMatch(
      /^brief\/brief\.json: в системе Wizard агент меняет только ui\/\*\*, functions\/\*\* и spec\/appspec\.json/,
    );
  }, 120_000);
});
