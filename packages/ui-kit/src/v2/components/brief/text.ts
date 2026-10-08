// Plain Russian words of the brief components (D48): actors, levels, authors, dates, the theses of the short brief and
// item keys that match briefDiff (the panel highlights what the latest version changed).
import type { BriefActor, BriefChange, BriefField, SystemBrief } from "@wizard/appspec";

export const ACTOR_RU: Readonly<Record<BriefActor, string>> = {
  visitor: "Посетитель",
  client: "Клиент",
  staff: "Сотрудник",
  owner: "Владелец",
  system: "Система",
};

export const LEVEL_RU = {
  modules: "на проверенных модулях",
  custom: "своим кодом, с пометкой",
  not_yet: "пока не умею — в запросы на развитие",
} as const;

export const CHOSEN_RU = {
  recommended: "по рекомендации",
  option: "выбран вариант",
  custom: "свой ответ",
  delegated: "решили за вас",
} as const;

export const SOURCE_RU = {
  default: "по умолчанию",
  owner_skip: "вы доверили решение нам",
} as const;

export const AUTHOR_RU = { agent: "Ассистент", owner: "Вы" } as const;

export const OP_RU = { added: "Добавлено", changed: "Изменено", removed: "Удалено" } as const;

/** «3 изменения» with the right Russian plural. */
export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  const w = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  return `${n} ${w}`;
}

export const changesRu = (n: number) => plural(n, "изменение", "изменения", "изменений");

/** «8 окт., 14:05» in the viewer's time zone; an invalid date gives "". */
export function dateRu(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

/** «3 мин», «1 ч 20 мин», «меньше минуты»; "" without both ends. */
export function durationRu(from: string | null | undefined, to: string | null | undefined): string {
  if (!from || !to) return "";
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const min = Math.round(ms / 60_000);
  if (min < 1) return "меньше минуты";
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} ч ${min % 60} мин` : `${h} ч`;
}

/** One line of at most `max` characters (with «…»). */
export function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

const lowerFirst = (s: string) => (s ? (s[0] as string).toLowerCase() + s.slice(1) : s);

/** «Когда клиент оплачивает заказ, система проводит оплату и отправляет чек». */
export function scenarioRu(s: SystemBrief["scenarios"][number]): string {
  const steps = s.then.map(lowerFirst);
  const tail = steps.length > 1 ? `${steps.slice(0, -1).join(", ")} и ${steps[steps.length - 1]}` : steps[0];
  return `Когда ${s.when}, система ${tail ?? "…"}`;
}

/**
 * 5–8 theses of the short brief for the chat before «Собрать» (D77 (9)): goals, audience, the main scenario, roles,
 * personal data with retention, integrations, what is out of scope, assumptions. Empty parts are skipped.
 */
export function briefTheses(b: SystemBrief): string[] {
  const out: string[] = [];
  if (b.goals.length) {
    const g = b.goals.slice(0, 2).map((x) => `${lowerFirst(x.text)} (${lowerFirst(x.success)})`);
    out.push(`${b.goals.length > 1 ? "Цели" : "Цель"}: ${g.join("; ")}${b.goals.length > 2 ? " и др." : ""}`);
  }
  if (b.audience) out.push(`Для кого: ${clip(lowerFirst(b.audience), 140)}`);
  const must = b.scenarios.filter((s) => s.priority === "must");
  const should = b.scenarios.length - must.length;
  if (b.scenarios.length) {
    const main = must[0] ?? b.scenarios[0];
    out.push(
      `Сценарии: ${plural(must.length, "обязательный", "обязательных", "обязательных")}` +
        (should ? `, ${plural(should, "желательный", "желательных", "желательных")}` : "") +
        (main ? `. Главный — ${lowerFirst(clip(scenarioRu(main), 120))}` : ""),
    );
  }
  if (b.roles.length) out.push(`Кто работает в системе: ${b.roles.map((r) => r.name).join(", ")}`);
  if (b.data.length) {
    const pii = b.data.flatMap((d) => d.fields.filter((f) => f.pii).map((f) => lowerFirst(f.name)));
    const keep = b.data.find((d) => d.fields.some((f) => f.pii))?.retention;
    out.push(
      `Данные: ${b.data.map((d) => d.entity).join(", ")}` +
        (pii.length ? `; персональные — ${pii.join(", ")}${keep ? `, храним ${lowerFirst(keep)}` : ""}` : ""),
    );
  }
  if (b.integrations.length) out.push(`Связи с сервисами: ${b.integrations.map((i) => i.name).join(", ")}`);
  if (b.outOfScope.length) {
    const o = b.outOfScope[0] as SystemBrief["outOfScope"][number];
    out.push(
      `Не входит: ${lowerFirst(o.text)}${o.substitute ? ` — вместо этого ${lowerFirst(o.substitute)}` : ""}` +
        (b.outOfScope.length > 1 ? ` и ещё ${b.outOfScope.length - 1}` : ""),
    );
  }
  if (b.assumptions.length)
    out.push(`Допущения: ${clip(b.assumptions.map((a) => lowerFirst(a.text)).join("; "), 140)}`);
  const notYet = b.capability.filter((c) => c.level === "not_yet").map((c) => lowerFirst(c.requirement));
  if (notYet.length) out.push(`Пока не умеем: ${notYet.join(", ")} — это уйдёт в запросы на развитие`);
  return out.slice(0, 8);
}

type Item = Record<string, unknown>;

/** Key of a brief list item exactly as briefDiff matches it (id, entity in lower case or the main text). */
export function itemKey(field: BriefField, item: unknown): string {
  const i = (item ?? {}) as Item;
  const raw =
    field === "goals" || field === "scenarios" || field === "roles" || field === "integrations"
      ? i.id
      : field === "data"
        ? typeof i.entity === "string"
          ? i.entity.toLowerCase()
          : i.entity
        : field === "outOfScope" || field === "assumptions"
          ? i.text
          : field === "qa"
            ? i.q
            : field === "capability"
              ? i.requirement
              : undefined;
  return typeof raw === "string" ? raw : "";
}

/** What a version changed: field → keys of added or changed items; `whole` — fields changed as a whole. */
export function changedKeys(diff: readonly BriefChange[]): {
  items: Map<BriefField, Map<string, "added" | "changed">>;
  whole: Set<BriefField>;
} {
  const items = new Map<BriefField, Map<string, "added" | "changed">>();
  const whole = new Set<BriefField>();
  for (const c of diff) {
    if (c.op === "removed" && c.prop === undefined) continue;
    if (c.key === undefined) {
      whole.add(c.field);
      continue;
    }
    const m = items.get(c.field) ?? new Map<string, "added" | "changed">();
    m.set(c.key, c.op === "added" && c.prop === undefined ? "added" : "changed");
    items.set(c.field, m);
  }
  return { items, whole };
}

/** A diff value in plain words: text, list, item (its main text), yes/no. */
export function valueRu(v: unknown): string {
  if (v === undefined || v === null || v === "") return "—";
  if (typeof v === "boolean") return v ? "да" : "нет";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return v.map(valueRu).join("; ");
  if (typeof v === "object") {
    const o = v as Item;
    for (const k of ["text", "name", "entity", "when", "q", "requirement"])
      if (typeof o[k] === "string") {
        if (k === "when" && Array.isArray(o.then))
          return `Когда ${o.when}, система ${(o.then as unknown[]).map(String).join(", ")}`;
        return String(o[k]);
      }
    return Object.values(o).map(valueRu).join(" · ");
  }
  return String(v);
}
