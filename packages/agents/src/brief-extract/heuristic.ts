// Draft without a model (the model is off, failed or the LLM budget is out): headings split the ТЗ into sections, the
// list items of a «Цели» section become goals and those of a «Функции / Сценарии / Требования» section become
// scenarios (priority should — the interview confirms them); everything else stays empty. Minimal on purpose: the
// interview asks what the heuristic could not take (briefGaps).
import { BRIEF_LIMITS, type SystemBrief, systemBriefSchema } from "@wizard/appspec";
import { BRIEF_DRAFT_TODO } from "./gaps.js";

interface Section {
  heading: string;
  items: string[];
  paragraphs: string[];
}

const LIST_ITEM = /^\s*(?:[-*•–—▪●◦]|\d{1,2}[.)]|[a-zа-я][)])\s+(.+)$/u;
const NUMBERED = /^(\d{1,2}(?:\.\d{1,2})*)[.)]?\s+(\S.{0,98})$/u;

function headingOf(line: string, next: string | undefined, prev: string | undefined): string | null {
  const md = /^#{1,6}\s+(.+)$/.exec(line);
  if (md) return (md[1] as string).trim();
  const num = NUMBERED.exec(line);
  if (num && !/[.;,]$/.test(line) && /^[A-ZА-ЯЁ]/u.test(num[2] as string)) {
    // «2.1 Роли» is a heading; «1. Текст» is a heading unless it is part of a numbered list (a neighbour numbered the
    // same way — «2. …» next to «1. …», but not «1) …» under «3. Требования»).
    const mark = line.charAt((num[1] as string).length);
    const sameKind = (s: string | undefined) =>
      s !== undefined && /^\d{1,2}[.)]?\s/.test(s) && s.charAt(/^\d+/.exec(s)?.[0].length ?? 0) === mark;
    if ((num[1] as string).includes(".") || !(sameKind(next) || sameKind(prev)))
      return (num[2] as string).trim();
  }
  const letters = line.replace(/[^\p{L}]/gu, "");
  if (
    letters.length >= 3 &&
    line.length <= 80 &&
    letters === letters.toUpperCase() &&
    /\p{Lu}/u.test(letters)
  )
    return line.replace(/:$/, "").trim();
  if (line.length <= 80 && /:$/.test(line) && !LIST_ITEM.test(line)) return line.slice(0, -1).trim();
  return null;
}

/** Sections of a markdown-like text: a heading and the list items and paragraphs under it. */
export function sectionsOf(text: string): Section[] {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^\|?[-:| ]+\|?$/.test(l));
  const out: Section[] = [{ heading: "", items: [], paragraphs: [] }];
  for (const [i, line] of lines.entries()) {
    const heading = headingOf(line, lines[i + 1], lines[i - 1]);
    const cur = out[out.length - 1] as Section;
    if (heading !== null) out.push({ heading, items: [], paragraphs: [] });
    else {
      const item = LIST_ITEM.exec(line);
      if (item) cur.items.push((item[1] as string).trim());
      else cur.paragraphs.push(line);
    }
  }
  return out.filter((s) => s.heading || s.items.length || s.paragraphs.length);
}

type Kind = "goals" | "scenarios" | null;

function kindOf(heading: string): Kind {
  const h = heading.toLowerCase();
  if (
    /не входит|не требует|не нужн|вне рамок|исключ|нефункц|дизайн|оформлен|хостинг|безопасн|срок|бюджет|стоимост/.test(
      h,
    )
  )
    return null;
  if (/цел[ьиейя]|зачем|назначени|задач[аи]\s+(?:проекта|сайта|системы)/.test(h)) return "goals";
  if (/сценари|функци|возможност|требован|что должн|как работа|процесс/.test(h)) return "scenarios";
  return null;
}

const ACTORS: [RegExp, SystemBrief["scenarios"][number]["actor"]][] = [
  [/администратор|менеджер|сотрудник|мастер|оператор|курьер|бариста|продав/i, "staff"],
  [/владел|руководител|директор/i, "owner"],
  [/автоматическ|по расписанию|каждый|ежедневно|еженедельно|ежемесячно|напомина|система сама/i, "system"],
  [/клиент|покупател|заказчик|гост|пациент/i, "client"],
];

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);

/** «Клиент выбирает услугу → система показывает время»: the part before an arrow or a colon is «когда». */
function whenThen(item: string): { when: string; steps: string[] } {
  const m = /^(.{3,}?)\s*(?:→|->|=>|:)\s*(.{3,})$/.exec(item);
  if (m)
    return {
      when: clip((m[1] as string).trim(), BRIEF_LIMITS.text),
      steps: [clip((m[2] as string).trim(), BRIEF_LIMITS.text)],
    };
  return { when: clip(item, BRIEF_LIMITS.text), steps: [BRIEF_DRAFT_TODO] };
}

/** The heuristic draft of a ТЗ text: goals and scenarios from headed lists, the rest empty. */
export function heuristicDraft(text: string): SystemBrief {
  const goals: { id: string; text: string; success: string }[] = [];
  const scenarios: Record<string, unknown>[] = [];
  for (const s of sectionsOf(text)) {
    const kind = kindOf(s.heading);
    if (kind === "goals") {
      const texts = s.items.length ? s.items : s.paragraphs.slice(0, 3);
      for (const t of texts) {
        if (goals.length >= BRIEF_LIMITS.goals) break;
        goals.push({
          id: `g${goals.length + 1}`,
          text: clip(t, BRIEF_LIMITS.text),
          success: BRIEF_DRAFT_TODO,
        });
      }
    } else if (kind === "scenarios") {
      for (const item of s.items) {
        if (scenarios.length >= BRIEF_LIMITS.scenarios) break;
        const { when, steps } = whenThen(item);
        // The subject usually opens the item («Гость выбирает мастер-класс»): its first words decide first.
        const subject = when.split(/\s+/).slice(0, 2).join(" ");
        const actor =
          ACTORS.find(([re]) => re.test(subject))?.[1] ??
          ACTORS.find(([re]) => re.test(when))?.[1] ??
          "visitor";
        // biome-ignore lint/suspicious/noThenProperty: field name fixed by builder-v3.md §3 C1
        scenarios.push({ id: `s${scenarios.length + 1}`, actor, when, then: steps, priority: "should" });
      }
    }
  }
  return systemBriefSchema.parse({ goals, scenarios });
}
