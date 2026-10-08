// briefGaps(brief): which sections of a brief are filled and which the interview still has to ask about (V3-04 for
// V3-03: «интервью только по пробелам», D77 (8)). Sections go in the order of the interview tree: goals → audience →
// scenarios → data → roles → integrations → design and content → launch limits (out of scope). A required field the
// ТЗ did not answer carries BRIEF_DRAFT_TODO («уточнить в интервью»): such a section is partial, not filled.
import { BRIEF_FIELD_LABELS, type SystemBrief } from "@wizard/appspec";

/** Text put into a required brief field the ТЗ does not answer (a goal's success sign, a retention period…). */
export const BRIEF_DRAFT_TODO = "уточнить в интервью";

/** True when a text is (or contains) the «уточнить в интервью» mark. */
export const isDraftTodo = (s: string | undefined): boolean =>
  typeof s === "string" && s.toLowerCase().replace(/ё/g, "е").includes(BRIEF_DRAFT_TODO);

/** Brief sections the interview asks about, in the order of its question tree. */
export const BRIEF_GAP_SECTIONS = [
  "goals",
  "audience",
  "scenarios",
  "data",
  "roles",
  "integrations",
  "design",
  "outOfScope",
] as const;
export type BriefGapSection = (typeof BRIEF_GAP_SECTIONS)[number];

/** Without these the build has nothing to check against: the interview asks them first and does not skip them. */
export const BRIEF_BLOCKING_SECTIONS: readonly BriefGapSection[] = ["goals", "audience", "scenarios"];

export type BriefSectionStatus = "filled" | "partial" | "empty";

export interface BriefSectionGap {
  section: BriefGapSection;
  /** Russian name of the section (BRIEF_FIELD_LABELS). */
  label: string;
  status: BriefSectionStatus;
  blocking: boolean;
  /** Items in the section (audience: 1 when there is text). */
  count: number;
  /** What is missing inside a partial section, Russian. */
  notes: string[];
}

export interface BriefGaps {
  sections: BriefSectionGap[];
  /** Sections the interview does not ask about again. */
  filled: BriefGapSection[];
  /** Empty or partial sections in interview order: what the interview asks. */
  missing: BriefGapSection[];
  /** Missing sections that block the build (BRIEF_BLOCKING_SECTIONS). */
  blocking: BriefGapSection[];
}

const quoteList = (xs: readonly string[], max = 3) =>
  xs
    .slice(0, max)
    .map((x) => `«${x}»`)
    .join(", ") + (xs.length > max ? ` и ещё ${xs.length - max}` : "");

function sectionNotes(b: SystemBrief, s: BriefGapSection): string[] {
  const notes: string[] = [];
  switch (s) {
    case "goals": {
      const noSuccess = b.goals.filter((g) => isDraftTodo(g.success)).map((g) => g.text);
      if (noSuccess.length) notes.push(`Нет признака успеха у целей ${quoteList(noSuccess)}`);
      if (b.goals.some((g) => isDraftTodo(g.text))) notes.push("Цель не сформулирована");
      break;
    }
    case "audience":
      if (isDraftTodo(b.audience)) notes.push("Аудитория не описана");
      break;
    case "scenarios": {
      if (!b.scenarios.some((x) => x.priority === "must"))
        notes.push("Нет обязательных сценариев — подтвердите, что система должна уметь к запуску");
      const vague = b.scenarios
        .filter((x) => isDraftTodo(x.when) || x.then.some(isDraftTodo))
        .map((x) => x.when);
      if (vague.length) notes.push(`Не ясно, что делает система в сценариях ${quoteList(vague)}`);
      break;
    }
    case "data": {
      const noFields = b.data.filter((d) => d.fields.length === 0).map((d) => d.entity);
      if (noFields.length) notes.push(`Не указаны поля данных ${quoteList(noFields)}`);
      const noRetention = b.data.filter((d) => isDraftTodo(d.retention)).map((d) => d.entity);
      if (noRetention.length) notes.push(`Не указан срок хранения: ${quoteList(noRetention)}`);
      break;
    }
    case "roles": {
      const noAccess = b.roles
        .filter((r) => r.can.length === 0 || r.can.some(isDraftTodo))
        .map((r) => r.name);
      if (noAccess.length) notes.push(`Не указаны доступы ролей ${quoteList(noAccess)}`);
      break;
    }
    default:
      break;
  }
  return notes;
}

function countOf(b: SystemBrief, s: BriefGapSection): number {
  switch (s) {
    case "audience":
      return b.audience.trim() ? 1 : 0;
    case "design":
      return b.design.references.length + (b.design.archetype ? 1 : 0);
    default:
      return b[s].length;
  }
}

/**
 * Filled, partial and empty sections of a brief in interview order. A section is filled when it has items and nothing
 * inside waits for the interview; integrations, design and out-of-scope may stay empty (the build takes defaults), the
 * interview decides whether to ask them.
 */
export function briefGaps(brief: SystemBrief): BriefGaps {
  const sections = BRIEF_GAP_SECTIONS.map((section): BriefSectionGap => {
    const count = countOf(brief, section);
    const notes = count > 0 ? sectionNotes(brief, section) : [];
    return {
      section,
      label: BRIEF_FIELD_LABELS[section],
      status: count === 0 ? "empty" : notes.length > 0 ? "partial" : "filled",
      blocking: BRIEF_BLOCKING_SECTIONS.includes(section),
      count,
      notes,
    };
  });
  const missing = sections.filter((x) => x.status !== "filled");
  return {
    sections,
    filled: sections.filter((x) => x.status === "filled").map((x) => x.section),
    missing: missing.map((x) => x.section),
    blocking: missing.filter((x) => x.blocking).map((x) => x.section),
  };
}
