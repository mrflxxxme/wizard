// Semantic checks of model outputs beyond zod (orchestrator.yaml S4_ask, S5_card.validate, pii_notice.rules).
import type { ToolIssue } from "../core/tool.js";
import { piiPaths } from "./pii.js";
import type { CardDraft, ChangeDraft, Question } from "./schemas.js";
import { type ForkContext, forkOptions } from "./taxonomy.js";

const issue = (path: string, message: string, code = "SEMANTIC"): ToolIssue => ({ path, message, code });

function dlpIssues(value: unknown): ToolIssue[] {
  return piiPaths(value).map((p) =>
    issue(p, "Здесь персональные данные — убери их, в карточке только структура.", "PII_IN_OUTPUT"),
  );
}

/** ask_questions: forks exactly the selected ones (each once), options from the taxonomy (after plan rules). */
export function checkQuestions(
  questions: readonly Question[],
  selected: readonly string[],
  ctx: ForkContext,
  opts: { requireAll?: boolean } = {},
): ToolIssue[] {
  const out: ToolIssue[] = [];
  const ids = new Set<string>();
  const forks = new Set<string>();
  questions.forEach((q, i) => {
    const p = `questions.${i}`;
    if (ids.has(q.id)) out.push(issue(`${p}.id`, `Повтор id вопроса ${q.id}.`));
    ids.add(q.id);
    if (!selected.includes(q.forkId)) {
      out.push(
        issue(`${p}.forkId`, `Развилку ${q.forkId} не спрашиваем; допустимы: ${selected.join(", ")}.`),
      );
    }
    if (forks.has(q.forkId)) out.push(issue(`${p}.forkId`, `Развилка ${q.forkId} уже спрошена.`));
    forks.add(q.forkId);
    const allowed = forkOptions(q.forkId, ctx);
    const seen = new Set<string>();
    q.options.forEach((o, j) => {
      if (!allowed.includes(o.id)) {
        out.push(
          issue(
            `${p}.options.${j}.id`,
            `Вариант ${o.id} не из таксономии; допустимы: ${allowed.join(", ")}.`,
          ),
        );
      }
      if (seen.has(o.id)) out.push(issue(`${p}.options.${j}.id`, `Повтор варианта ${o.id}.`));
      seen.add(o.id);
    });
  });
  if (opts.requireAll !== false) {
    const missing = selected.filter((f) => !forks.has(f));
    if (missing.length > 0) out.push(issue("questions", `Нет вопросов по развилкам: ${missing.join(", ")}.`));
  }
  return [...out, ...dlpIssues(questions)];
}

function refIssues(card: Partial<CardDraft>, knownRoles: Set<string>, knownData: Set<string>): ToolIssue[] {
  const out: ToolIssue[] = [];
  card.acceptance?.forEach((ac, i) => {
    if (ac.check.role && !knownRoles.has(ac.check.role)) {
      out.push(issue(`acceptance.${i}.check.role`, `Роли ${ac.check.role} нет в карточке.`));
    }
    if (ac.check.entity && !knownData.has(ac.check.entity)) {
      out.push(issue(`acceptance.${i}.check.entity`, `Данных ${ac.check.entity} нет в карточке.`));
    }
  });
  card.screens?.forEach((s, i) => {
    for (const r of s.roles) {
      if (!knownRoles.has(r)) out.push(issue(`screens.${i}.roles`, `Роли ${r} нет в карточке.`));
    }
  });
  card.pii?.fields.forEach((f, i) => {
    if (!knownData.has(f.entity))
      out.push(issue(`pii.fields.${i}.entity`, `Данных ${f.entity} нет в карточке.`));
  });
  card.pii?.retention.forEach((r, i) => {
    if (!knownData.has(r.entity))
      out.push(issue(`pii.retention.${i}.entity`, `Данных ${r.entity} нет в карточке.`));
  });
  return out;
}

/** S5_card.validate semantics + DLP over the card = 0 findings. */
export function checkCard(card: CardDraft, ctx: ForkContext): ToolIssue[] {
  const roles = new Set(card.roles.map((r) => r.name));
  const data = new Set(card.data.map((d) => d.name));
  const out = refIssues(card, roles, data);
  if (roles.size !== card.roles.length) out.push(issue("roles", "Имена ролей повторяются."));
  if (data.size !== card.data.length) out.push(issue("data", "Имена данных повторяются."));
  card.acceptance.forEach((ac, i) => {
    if (ac.id !== `AC${i + 1}`)
      out.push(issue(`acceptance.${i}.id`, `Ожидался id AC${i + 1}: нумерация AC1..ACn.`));
  });
  const covered = new Set(card.acceptance.map((ac) => ac.check.role).filter((r): r is string => !!r));
  for (const r of card.roles) {
    if (r.access === "login" && !covered.has(r.name)) {
      out.push(issue("acceptance", `Нет ни одного критерия для роли ${r.name} (check.role).`));
    }
  }
  if (ctx.plan === "free") {
    card.roles.forEach((r, i) => {
      if (r.loginMethods?.includes("phone_otp")) {
        out.push(issue(`roles.${i}.loginMethods`, "Вход по телефону недоступен на бесплатном тарифе."));
      }
    });
  }
  const piiData = card.data.filter((d) => d.pii !== "none").map((d) => d.name);
  for (const name of piiData) {
    if (!card.pii.retention.some((r) => r.entity === name)) {
      out.push(issue("pii.retention", `Нет срока хранения для данных ${name}.`));
    }
  }
  if (piiData.length > 0 && !card.pii.consent)
    out.push(issue("pii.consent", "При ПДн согласие обязательно."));
  const connectors = card.integrations.map((x) => x.connector);
  if (new Set(connectors).size !== connectors.length)
    out.push(issue("integrations", "Подключения повторяются."));
  return [...out, ...dlpIssues(card)];
}

/** Mini-card of a change: references into the card itself or the current system, DLP. */
export function checkChangeDraft(
  draft: ChangeDraft,
  current: { roles: readonly string[]; entities: readonly string[] },
  ctx: ForkContext,
): ToolIssue[] {
  const roles = new Set([...current.roles, ...(draft.roles ?? []).map((r) => r.name)]);
  const data = new Set([...current.entities, ...(draft.data ?? []).map((d) => d.name)]);
  const out = refIssues(draft, roles, data);
  if (ctx.plan === "free" && draft.roles?.some((r) => r.loginMethods?.includes("phone_otp"))) {
    out.push(issue("roles", "Вход по телефону недоступен на бесплатном тарифе."));
  }
  return [...out, ...dlpIssues(draft)];
}
