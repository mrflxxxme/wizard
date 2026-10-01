// Human diff of a revision (GET /systems/:id/revisions/:v/diff, platform-screens.yaml S7): the sign of each line,
// grouping by kind for the «Изменения» segment and the migration verdict of the diff card.
import type { DiffChange, DiffKind } from "../api/types.js";

export type DiffSign = "add" | "change" | "remove";

const REMOVE = /(^|[\s«(])(удал[её]н[аоы]?|отключено|больше не имеет)(?=$|[\s»:,.)])/iu;
const ADD = /(^|[\s«(])(добавлен[аоы]?|нов(ый|ая|ое|ые)|подключено|теперь может)(?=$|[\s»:,.)])/iu;

/** «+ новое / ~ изменено / − удалено» from the wording of text_ru (@wizard/appspec diffSpecs, file lines). */
export function diffSign(c: Pick<DiffChange, "text_ru">): DiffSign {
  if (REMOVE.test(c.text_ru)) return "remove";
  if (ADD.test(c.text_ru)) return "add";
  return "change";
}

/** Display order of the groups: data first, code last (S7 «сгруппированные по kind (данные, права, экраны…)»). */
export const KIND_ORDER: readonly DiffKind[] = [
  "entity",
  "field",
  "role",
  "permission",
  "page",
  "workflow",
  "integration",
  "function",
  "compliance",
  "theme",
  "file",
];

export function groupChanges(changes: readonly DiffChange[]): { kind: DiffKind; items: DiffChange[] }[] {
  const by = new Map<DiffKind, DiffChange[]>();
  for (const c of changes) by.set(c.kind, [...(by.get(c.kind) ?? []), c]);
  const known = KIND_ORDER.filter((k) => by.has(k));
  const other = [...by.keys()].filter((k) => !KIND_ORDER.includes(k));
  return [...known, ...other].map((kind) => ({ kind, items: by.get(kind) ?? [] }));
}

export type MigrationVerdict = "none" | "additive" | "destructive";

/** Schema changes are entity/field lines; any destructive=true line makes the migration «удаляет данные». */
export function migrationVerdict(changes: readonly DiffChange[]): MigrationVerdict {
  if (changes.some((c) => c.destructive === true)) return "destructive";
  return changes.some((c) => c.kind === "entity" || c.kind === "field") ? "additive" : "none";
}
