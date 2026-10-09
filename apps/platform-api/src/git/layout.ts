// Layout of a system repository (V3-30, D77_v3 (2)): the full source of the system — brief/brief.json (its versions
// are the history of the file), spec/appspec.json, ui/** with the design tokens ui/design.css, functions/**, assets/**,
// tests/** (goal scenarios as data) and AGENTS.md for the client's own developers. The brief is scrubbed of personal
// data; platform secrets never get here (the spec keeps only secret:// references).
import type { AppSpec, SystemBrief } from "@wizard/appspec";
import { scrubJson } from "@wizard/pii";

export const BRIEF_FILE = "brief/brief.json";
export const SPEC_FILE = "spec/appspec.json";
export const AGENTS_FILE = "AGENTS.md";
export const SCENARIOS_FILE = "tests/scenarios.json";
export const ACCEPTANCE_FILE = "tests/acceptance.json";
export const DESIGN_FILE = "ui/design.css";

/** A stored path that can be a tree entry: relative, no empty, «.», «..» or «.git» segment, no NUL or backslash. */
export function isRepoPath(p: string): boolean {
  if (!p || p.includes("\0") || p.includes("\\") || p.startsWith("/")) return false;
  return p
    .split("/")
    .every((seg) => seg !== "" && seg !== "." && seg !== ".." && seg.toLowerCase() !== ".git");
}

/** Paths the platform writes itself; a stored file under them is not taken into the repository. */
export function isGeneratedPath(path: string): boolean {
  return (
    path === AGENTS_FILE || path.startsWith("brief/") || path.startsWith("spec/") || path.startsWith("tests/")
  );
}

const jsonFile = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");

// The scrubbed brief of a version never changes: keep the last few instead of scrubbing again on every commit.
const scrubbed = new Map<string, SystemBrief>();
const SCRUB_CACHE = 64;

/** The brief without personal data (packages/pii scrub; placeholders stay stable within the brief). */
export function scrubBrief(key: string | null, brief: SystemBrief): SystemBrief {
  const hit = key ? scrubbed.get(key) : undefined;
  if (hit) return hit;
  const value = scrubJson(brief).value;
  if (key) {
    if (scrubbed.size >= SCRUB_CACHE) scrubbed.delete(scrubbed.keys().next().value as string);
    scrubbed.set(key, value);
  }
  return value;
}

export interface LayoutInput {
  systemName: string;
  /** Spec of the revision; null before the first revision (brief-only commits of the interview). */
  spec: AppSpec | null;
  /** Latest brief version at this point, already scrubbed. */
  brief: { version: number; brief: SystemBrief } | null;
  /** Paths of the stored source files (ui/**, functions/**, assets/**) that go into the tree as they are. */
  sourcePaths: readonly string[];
}

/** Files the platform generates for a commit: brief, spec, tests and AGENTS.md. */
export function generatedFiles(i: LayoutInput): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  if (i.brief) {
    out.set(BRIEF_FILE, jsonFile(i.brief.brief));
    const b = i.brief.brief;
    if (b.scenarios.length)
      out.set(
        SCENARIOS_FILE,
        jsonFile({
          source: "brief",
          briefVersion: i.brief.version,
          goals: b.goals,
          scenarios: b.scenarios,
        }),
      );
  }
  if (i.spec) {
    out.set(SPEC_FILE, jsonFile(i.spec));
    if (i.spec.acceptance?.length)
      out.set(ACCEPTANCE_FILE, jsonFile({ source: "spec", acceptance: i.spec.acceptance }));
  }
  out.set(AGENTS_FILE, Buffer.from(agentsMd({ ...i, generated: [...out.keys()] }), "utf8"));
  return out;
}

const code = (s: string) => `\`${s.replace(/`/g, "'")}\``;
const line = (s: string) => s.replace(/\s+/g, " ").trim();
const MAX_LIST = 40;

function list(items: string[]): string[] {
  if (items.length <= MAX_LIST) return items.map((s) => `- ${s}`);
  return [...items.slice(0, MAX_LIST).map((s) => `- ${s}`), `- …и ещё ${items.length - MAX_LIST}`];
}

/**
 * AGENTS.md of the repository: how the system is organised and how its checks run, in Russian, for the client's
 * developers and their coding agents. Only structure goes in (names of entities, roles, pages, functions), no data.
 */
export function agentsMd(i: LayoutInput & { generated: readonly string[] }): string {
  const has = (p: string) => i.generated.includes(p) || i.sourcePaths.includes(p);
  const under = (prefix: string) => i.sourcePaths.some((p) => p.startsWith(prefix));
  const rows: [string, string][] = [];
  if (has(BRIEF_FILE))
    rows.push([
      BRIEF_FILE,
      "Бриф: цели, аудитория, сценарии «Когда…, система…», роли, данные, интеграции, «не входит», допущения. Прежние версии — в истории коммитов",
    ]);
  if (has(SPEC_FILE))
    rows.push([
      SPEC_FILE,
      "Спецификация бэкенда (AppSpec): сущности и поля, роли и права, процессы, интеграции, функции, страницы",
    ]);
  if (under("ui/")) rows.push(["ui/", "Интерфейс: страницы и компоненты на React (TSX)"]);
  if (has(DESIGN_FILE))
    rows.push([
      DESIGN_FILE,
      "Дизайн-токены: CSS-переменные дизайн-системы клиента, на них построена тема Tailwind",
    ]);
  if (under("functions/")) rows.push(["functions/", "Серверные функции на TypeScript"]);
  if (under("assets/")) rows.push(["assets/", "Логотип и другие файлы"]);
  if (has(SCENARIOS_FILE))
    rows.push([SCENARIOS_FILE, "Сценарии целей из брифа как данные — критерии приёмки сборки"]);
  if (has(ACCEPTANCE_FILE))
    rows.push([ACCEPTANCE_FILE, "Проверки приёмки из спецификации: права доступа и сценарии"]);
  rows.push([AGENTS_FILE, "Этот файл: как устроен репозиторий и как запускаются проверки"]);

  const s = i.spec;
  const what: string[] = [];
  if (s) {
    if (s.entities.length) {
      what.push("", "Сущности:");
      what.push(...list(s.entities.map((e) => `${line(e.label)} — ${code(e.name)}`)));
    }
    if (s.roles.length) {
      what.push("", "Роли:");
      what.push(
        ...list(
          s.roles.map(
            (r) =>
              `${line(r.label)} — ${code(r.name)}${r.access === "public" ? " (без входа)" : " (со входом)"}`,
          ),
        ),
      );
    }
    if (s.pages?.length) {
      what.push("", "Страницы:");
      what.push(...list(s.pages.map((p) => `${code(p.route)} — ${line(p.title)} (${code(p.file)})`)));
    }
    if (s.functions?.length) {
      what.push("", "Функции:");
      what.push(...list(s.functions.map((f) => `${code(f.name)} (${f.kind}) — ${code(f.file)}`)));
    }
    if (s.integrations?.length) {
      what.push("", "Интеграции:");
      what.push(...list(s.integrations.map((g) => `${code(g.name)} — коннектор ${code(g.connector)}`)));
    }
  }
  if (i.brief?.brief.scenarios.length) {
    const must = i.brief.brief.scenarios.filter((x) => x.priority === "must").length;
    what.push(
      "",
      `Сценариев в брифе: ${i.brief.brief.scenarios.length}, из них обязательных: ${must} (версия брифа ${i.brief.version}).`,
    );
  }

  return [
    `# ${line(i.systemName)}`,
    "",
    `Это полный исходник системы «${line(i.systemName)}», собранной в Wizard. Wizard обновляет репозиторий при каждой ревизии: одна ревизия — один коммит в ветке ${code("main")}, правка брифа — тоже коммит. Файл написан для разработчиков клиента и их ИИ-агентов.`,
    "",
    "## Как устроен репозиторий",
    "",
    "| Путь | Что внутри |",
    "|---|---|",
    ...rows.map(([p, d]) => `| ${code(p)} | ${d} |`),
    ...(what.length ? ["", "## Что в системе", ...what] : []),
    "",
    "## Как запускать проверки",
    "",
    "Проверки запускает Wizard на своих серверах в России; рантайм систем закрыт, поэтому локально систему целиком не запустить.",
    "",
    "1. G0 — на каждой ревизии: сборка, типы TypeScript, импорты и линтер файлов `ui/**` и `functions/**`, проверка `spec/appspec.json`.",
    "2. G1 — перед превью: система поднимается в песочнице, сценарии из `tests/**` проходятся в браузере.",
    "3. G2 — перед публикацией: права доступа, персональные данные, секреты и безопасность.",
    "",
    "Результат проверок виден в Wizard на экране системы. Когда к системе подключён внешний репозиторий (GitHub или GitLab), изменения приходят через PR в ветки `wizard/*` и проходят те же проверки, статус пишется в PR.",
    "",
    "## Правила",
    "",
    "- Ключи и пароли — только ссылками `secret://имя`; их значения в репозитории не хранятся.",
    "- Персональные данные клиентов в репозиторий не попадают: бриф очищен от ПДн, данные системы живут в её базе.",
    "- Тексты для пользователей системы — на русском.",
    "- `spec/appspec.json` меняется операциями Wizard: правка руками проходит те же проверки, что и правка агентом.",
    "",
  ].join("\n");
}
