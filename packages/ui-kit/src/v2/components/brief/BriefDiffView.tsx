import {
  BRIEF_FIELD_LABELS,
  BRIEF_FIELDS,
  type BriefAuthor,
  type BriefChange,
  type BriefField,
} from "@wizard/appspec";
import { type ReactNode, useId } from "react";
import { cx, type PBase, pRoot } from "../../util.js";
import s from "./BriefDiffView.module.css";
import { AUTHOR_RU, changesRu, dateRu, OP_RU, valueRu } from "./text.js";

export interface BriefDiffViewProps extends PBase {
  /** Changes of a version to the previous one (BriefVersion.diff). */
  changes: readonly BriefChange[];
  /** Version these changes made (heading). */
  version?: number;
  author?: BriefAuthor;
  /** RFC 3339 time of the version. */
  createdAt?: string;
  /** Shows the values before and after (default true). */
  details?: boolean;
}

/** «Цели, «…»: изменено «…»» without the section name the group heading already says. */
function lineOf(c: BriefChange): string {
  const label = BRIEF_FIELD_LABELS[c.field];
  const t = c.text_ru;
  for (const sep of [": ", ", "])
    if (t.startsWith(`${label}${sep}`)) {
      const rest = t.slice(label.length + sep.length);
      return rest.charAt(0).toUpperCase() + rest.slice(1);
    }
  return t;
}

/**
 * The difference of a brief version, highlighted (D77 (9)): changes grouped by section, each with a word (added,
 * changed, removed — not only a colour) and what it was and became as <del>/<ins>.
 */
export function BriefDiffView({
  changes,
  version,
  author,
  createdAt,
  details = true,
  className,
  testId,
}: BriefDiffViewProps): ReactNode {
  const hid = useId();
  const groups = BRIEF_FIELDS.map((f) => [f, changes.filter((c) => c.field === f)] as const).filter(
    ([, cs]) => cs.length > 0,
  ) as [BriefField, BriefChange[]][];
  const meta = [author ? AUTHOR_RU[author] : "", dateRu(createdAt), changesRu(changes.length)].filter(
    Boolean,
  );
  return (
    <section
      {...pRoot("BriefDiffView", testId, "p-brief-diff")}
      aria-labelledby={hid}
      className={cx(s.diff, className)}
    >
      <header className={s.head}>
        <h3 id={hid} className={s.title}>
          {version === undefined
            ? "Что изменилось"
            : version === 1
              ? "Версия 1: первый бриф"
              : `Версия ${version}: что изменилось`}
        </h3>
        <p className={s.meta}>{meta.join(" · ")}</p>
      </header>
      {groups.length === 0 ? (
        <p className={s.empty}>Изменений нет.</p>
      ) : (
        groups.map(([field, cs]) => (
          <div key={field} className={s.group} data-testid={`p-brief-diff-${field}`}>
            <h4 className={s.field}>{BRIEF_FIELD_LABELS[field]}</h4>
            <ul className={s.list}>
              {cs.map((c, i) => (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: a stored diff never reorders
                  key={i}
                  className={cx(s.change, s[c.op])}
                  data-op={c.op}
                  data-testid="p-brief-change"
                >
                  <span className={s.op}>{OP_RU[c.op]}</span>
                  <span className={s.text}>{lineOf(c)}</span>
                  {details && c.prop !== "order" && (c.before !== undefined || c.after !== undefined) && (
                    <span className={s.values}>
                      {c.before !== undefined && (
                        <del className={s.before}>
                          <span className={s.sr}>было: </span>
                          {valueRu(c.before)}
                        </del>
                      )}
                      {c.after !== undefined && (
                        <ins className={s.after}>
                          <span className={s.sr}>стало: </span>
                          {valueRu(c.after)}
                        </ins>
                      )}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}
