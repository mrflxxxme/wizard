// address (data-boundary.yaml#detectors.kinds.address): ≥ 2 address markers within 60 characters, each followed by a
// capitalized word or a number. A single city ("форум в Казани") is not an address.
import type { Finding } from "../types.js";
import { finding } from "../util.js";

type ValueKind = "name" | "number" | "any";

// Marker → which value may follow it. Order matters for alternation (longer first).
const MARKERS: Array<[string, ValueKind]> = [
  ["город[еау]?", "name"],
  ["гор\\.", "name"],
  ["г\\.", "name"],
  ["улиц[аеыу]", "any"],
  ["ул\\.", "any"],
  ["проспект[еау]?", "any"],
  ["просп\\.", "any"],
  ["пр-к?т\\.?", "any"],
  ["переул(?:ок|ке|ка)", "any"],
  ["пер\\.", "any"],
  ["шоссе", "any"],
  ["ш\\.", "name"],
  ["набережн(?:ая|ой|ую)", "any"],
  ["наб\\.", "any"],
  ["бульвар[еау]?", "any"],
  ["б-р\\.?", "any"],
  ["площад(?:ь|и)", "any"],
  ["пл\\.", "any"],
  ["микрорайон[еау]?", "any"],
  ["мкр-?н?\\.?", "any"],
  ["дом[еау]?", "number"],
  ["д\\.", "number"],
  ["корпус[еау]?", "number"],
  ["корп\\.", "number"],
  ["к\\.", "number"],
  ["строени[ея]", "number"],
  ["стр\\.", "number"],
  ["квартир[аеыу]", "number"],
  ["кв\\.", "number"],
  ["офис[еау]?", "number"],
  ["оф\\.", "number"],
];

const MARKER_RE = new RegExp(
  `(?<![\\p{L}\\d])(?:${MARKERS.map(([m], i) => `(?<m${i}>${m})`).join("|")})|(?<![\\d])(?<idx>[1-6]\\d{5})(?![\\d])`,
  "giu",
);
const NUMBER_VALUE = /^[ \xa0]*(?:№[ \xa0]*)?\d+(?:[\/-]\d+)?(?:-?[а-яёa-z](?![\p{L}]))?(?:-?(?:я|й|е|го))?/iu;
const NAME_VALUE =
  /^[ \xa0]*(?:\d+-?(?:я|й|е|го)?[ \xa0]+)?(?:им\.[ \xa0]*)?[А-ЯЁA-Z][\p{L}-]*(?:[ \xa0]+(?:[А-ЯЁA-Z][\p{L}-]*|\d+(?:-?(?:я|й|е|го))?))*/u;
const GAP_OK = /^[\s,;.]*(?:[А-ЯЁ][\p{L}-]*[\s,;.]*){0,2}$/u;

interface Marker {
  start: number;
  end: number; // end of the value
}

export function detectAddresses(text: string): Finding[] {
  const markers: Marker[] = [];
  for (const m of text.matchAll(MARKER_RE)) {
    const groups = m.groups ?? {};
    const start = m.index;
    const markerEnd = start + m[0].length;
    if (groups.idx) {
      // Postal index: only as part of an address line (followed by a comma or preceded by «индекс»).
      const after = text.slice(markerEnd, markerEnd + 2);
      if (/^[ \xa0]?,/.test(after) || /индекс\s*[:\-]?\s*$/iu.test(text.slice(Math.max(0, start - 12), start))) {
        markers.push({ start, end: markerEnd });
      }
      continue;
    }
    let kind: ValueKind | undefined;
    for (let i = 0; i < MARKERS.length; i++) {
      if (groups[`m${i}`] !== undefined) {
        kind = MARKERS[i]?.[1];
        break;
      }
    }
    if (!kind) continue;
    // "2020 г." is a year, not a city.
    if (/^г\.$/iu.test(m[0]) && /\d[ \xa0]*$/.test(text.slice(Math.max(0, start - 3), start))) continue;
    const rest = text.slice(markerEnd, markerEnd + 80);
    let v: RegExpMatchArray | null = null;
    if (kind === "number" || kind === "any") v = rest.match(NUMBER_VALUE);
    if (!v && (kind === "name" || kind === "any")) v = rest.match(NAME_VALUE);
    if (!v) continue;
    markers.push({ start, end: markerEnd + v[0].length });
  }

  const out: Finding[] = [];
  let i = 0;
  while (i < markers.length) {
    const first = markers[i] as Marker;
    let last = first;
    let count = 1;
    let j = i + 1;
    for (; j < markers.length; j++) {
      const next = markers[j] as Marker;
      if (next.start < last.end) continue; // nested (e.g. index inside a value)
      const gap = text.slice(last.end, next.start);
      if (gap.length > 30 || !GAP_OK.test(gap) || next.start - last.start > 60) break;
      last = next;
      count++;
    }
    if (count >= 2) out.push(finding("address", first.start, last.end, count >= 3 ? "high" : "medium"));
    i = j;
  }
  return out;
}
