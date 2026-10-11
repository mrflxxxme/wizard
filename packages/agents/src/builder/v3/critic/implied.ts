// The closed edit a finding implies when the model gave none (V3-40). In the final measurement most critiques named
// catalog signs with `edit: null`, so the loop stopped after one cycle with nothing applied (stop no_edits) and the site
// kept the very findings that held its score under the founder's floor of 30. The edit is code's own reading of the
// sign: it goes through the same applyEdit, linter, G0, browser checks and the model's next score as any other edit.
import { hash32, type PatternMeta } from "@wizard/ui-kit/v3/patterns";
import { type CriticState, type EditOp, variantsFor } from "./ops.js";
import { type Finding, parseWhere } from "./rubric.js";

/** Catalog id at the start of a finding's sign («T04 раздутый h1»). */
const SIGN_CODE_RE = /^\s*([A-Z]\d{2})\b/;

/** Layout signs another variant of the section answers: three cards, repeated layouts, a crowded first screen, a split hero. */
const SWAP_CODES = new Set(["L01", "L06", "L13", "L15"]);

/**
 * The edit of a finding without one: T04 (раздутый h1) — the display size a step smaller; L01/L06/L13/L15 on a pattern
 * section — another variant of it (same type and binding, the slots accept the content) whose layout family differs
 * from its own and its neighbours', never a split one for L15 (сплит-шапка); ties by the seed. Null — nothing fits.
 */
export function impliedEdit(
  f: Pick<Finding, "sign" | "where">,
  st: CriticState,
  library: readonly PatternMeta[],
  seed: string,
): EditOp | null {
  const code = SIGN_CODE_RE.exec(f.sign)?.[1];
  if (code === "T04") return { op: "token", token: "display_size", value: "smaller" };
  if (!code || !SWAP_CODES.has(code)) return null;
  const w = parseWhere(f.where);
  const page = w ? st.site.pages.find((p) => p.route === w.route) : undefined;
  const i = page && w ? page.sections.findIndex((s) => s.id === w.section) : -1;
  const s = page?.sections[i];
  if (!w || !page || !s) return null;
  const layoutOf = (id: string | undefined) => library.find((p) => p.id === id)?.layout;
  const own = layoutOf(s.pattern);
  const avoid = new Set([
    own,
    layoutOf(page.sections[i - 1]?.pattern),
    layoutOf(page.sections[i + 1]?.pattern),
  ]);
  if (code === "L15") avoid.add("split");
  const all = variantsFor(library, s);
  const fresh = all.filter((p) => !avoid.has(p.layout));
  const pool = fresh.length || code === "L15" ? fresh : all.filter((p) => p.layout !== own);
  const best = [...pool].sort(
    (a, b) => hash32(`${seed}:${s.id}:${a.id}`) - hash32(`${seed}:${s.id}:${b.id}`),
  )[0];
  return best ? { op: "swap_variant", route: w.route, section: s.id, pattern: best.id } : null;
}

/** One edit per section (a token once): the first, most severe one wins. */
export function editKey(op: EditOp): string {
  if (op.op === "token") return `token:${op.token}`;
  if (op.op === "reorder") return `reorder:${op.route}`;
  return `${op.route}#${op.section}`;
}
