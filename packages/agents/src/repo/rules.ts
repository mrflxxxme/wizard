// Rules of a client's repository for the agent (V3-32, D77 (4)): AGENTS.md, CLAUDE.md and CONTRIBUTING are read and
// given to the agent as the repository's rules (the platform's rules come first). A repository without them gets a
// proposal — an AGENTS.md draft written by code from the compatibility profile (no model), sent as a separate draft PR;
// until it is merged the agent follows the draft.
import { type RepoProfile, RULE_FILES, SUPPORTED_FRAMEWORKS } from "./compat.js";
import { type SandboxPlan, sandboxPlan } from "./sandbox.js";
import { type RepoSnapshot, topOf } from "./snapshot.js";

/** Bytes of one rules file the agent reads; the rest is cut with a note. */
export const RULE_FILE_MAX = 16 * 1024;
/** Bytes of all rules together. */
export const RULES_MAX = 32 * 1024;

export interface RepoRules {
  /** Rule files of the repository; empty — none, the agent follows `draft`. */
  sources: { path: string; text: string; truncated: boolean }[];
  /** The AGENTS.md Wizard proposes when the repository has none (null when it has rules). */
  draft: string | null;
}

/** Rules of the repository (or the proposed draft). */
export function repoRules(s: RepoSnapshot, p: RepoProfile, repoName: string): RepoRules {
  const sources: RepoRules["sources"] = [];
  let left = RULES_MAX;
  for (const path of RULE_FILES) {
    const text = s.get(path)?.text;
    if (!text || left <= 0) continue;
    const cap = Math.min(RULE_FILE_MAX, left);
    const truncated = text.length > cap;
    const cut = truncated ? text.slice(0, cap) : text;
    sources.push({ path, text: cut, truncated });
    left -= cut.length;
  }
  return { sources, draft: sources.length ? null : draftAgentsMd(p, s, repoName) };
}

const fence = (s: string) => `\`${s}\``;

/** AGENTS.md proposed by Wizard: stack, commands, structure, rules of work — facts of the profile only. */
export function draftAgentsMd(p: RepoProfile, s: RepoSnapshot, repoName: string): string {
  const plan: SandboxPlan | null = sandboxPlan(p);
  const labels = (ids: readonly string[]) =>
    ids.map((id) => SUPPORTED_FRAMEWORKS.find((f) => f.id === id)?.label ?? id).join(", ");
  const stack =
    p.kind === "js_monorepo"
      ? p.workspaces.map(
          (w) =>
            `- ${fence(w.path)} — ${w.frameworks.length ? labels(w.frameworks) : (w.other ?? "библиотека")}`,
        )
      : [`- ${labels(p.frameworks) || "JavaScript"} на ${p.typescript ? "TypeScript" : "JavaScript"}`];
  const tops = [...new Set([...s.keys()].map(topOf))]
    .filter((t) => [...s.keys()].some((x) => x.startsWith(`${t}/`)) && !t.startsWith("."))
    .sort()
    .slice(0, 15);
  const commands = [
    plan?.install ? `- Установка зависимостей: ${fence(plan.install.label)}` : null,
    plan?.build ? `- Сборка: ${fence(plan.build.label)}` : null,
    plan?.test
      ? `- Тесты: ${fence(plan.test.label)}`
      : "- Тестов пока нет — добавьте скрипт test в package.json",
  ].filter((x): x is string => !!x);
  return [
    `# ${repoName}`,
    "",
    "Правила для разработчиков и ИИ-агентов этого репозитория. Черновик предложил Wizard по составу репозитория — поправьте его под себя перед мержем.",
    "",
    "## Стек",
    "",
    ...stack,
    ...(p.packageManager
      ? [`- Менеджер пакетов: ${p.packageManager}, lockfile ${fence(p.lockfile ?? "")}`]
      : []),
    ...(p.node ? [`- Node.js: ${p.node}`] : []),
    "",
    "## Команды",
    "",
    ...commands,
    "",
    ...(tops.length ? ["## Структура", "", ...tops.map((t) => `- ${fence(`${t}/`)}`), ""] : []),
    "## Правила",
    "",
    "- Каждая правка — через ветку и PR; сборка и тесты должны проходить до мержа.",
    "- Новые зависимости добавляются вместе с обновлённым lockfile, отдельным понятным коммитом.",
    "- Тесты не удаляются и не отключаются, чтобы правка прошла; новая логика — с тестом.",
    "- Ключи, пароли и токены в репозиторий не коммитятся; .env — только в .gitignore.",
    "- CI (.github/workflows, .gitlab-ci.yml) меняет человек.",
    "- Стиль кода — как в соседних файлах; форматирование и линтер проекта не меняются без договорённости.",
    "",
  ].join("\n");
}

/** The rules as the agent's prompt section (the platform's rules are separate and come first). */
export function rulesSection(r: RepoRules): string {
  if (!r.sources.length)
    return [
      "## Правила репозитория",
      "",
      "В репозитории нет AGENTS.md, CLAUDE.md и CONTRIBUTING. Wizard предложил владельцу черновик AGENTS.md отдельным PR; пока его не приняли, следуй ему:",
      "",
      r.draft ?? "",
    ].join("\n");
  return [
    "## Правила репозитория",
    "",
    "Это правила владельцев репозитория. Соблюдай их, если они не противоречат правилам платформы выше.",
    ...r.sources.flatMap((x) => ["", `### ${x.path}${x.truncated ? " (начало файла)" : ""}`, "", x.text]),
  ].join("\n");
}
