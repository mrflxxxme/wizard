import { BRIEF_DIAGRAM_TITLES, type BriefDiagrams, type SystemBrief } from "@wizard/appspec";
import { type ReactNode, useId, useMemo, useState } from "react";
import { cx, type PBase, pRoot } from "../../util.js";
import { ActionButton } from "../controls.js";
import { BriefDiagram } from "./BriefDiagram.js";
import s from "./BriefSummary.module.css";
import { briefTheses, plural } from "./text.js";

/** Theses shown on a phone before «Ещё». */
const PHONE_THESES = 3;

export type BriefDiagramKey = keyof BriefDiagrams;
/** The three diagrams in the order they are shown. */
export const BRIEF_DIAGRAM_KEYS: readonly BriefDiagramKey[] = ["journey", "dataRoles", "integrations"];

export interface BriefSummaryProps extends PBase {
  brief: SystemBrief;
  diagrams: BriefDiagrams;
  /** Version of the brief the summary shows. */
  version: number;
  /** Opens the full brief in the «Бриф» panel; with a diagram — on the «Схемы» tab at that diagram. */
  onOpen?(diagram?: BriefDiagramKey): void;
  /** Heading; default «Бриф перед сборкой». */
  title?: string;
  /** Line under the heading; default — how to change the brief. */
  note?: string;
}

/**
 * The short brief in the chat before «Собрать» (D77 (9)): 5–8 theses in plain words and thumbnails of the three
 * diagrams; the full brief opens in the «Бриф» panel.
 */
export function BriefSummary({
  brief,
  diagrams,
  version,
  onOpen,
  title = "Бриф перед сборкой",
  note = "Проверьте главное. Поправить можно словами в чате или в панели «Бриф».",
  className,
  testId,
}: BriefSummaryProps): ReactNode {
  const hid = useId();
  const theses = useMemo(() => briefTheses(brief), [brief]);
  // On a phone the floating chat keeps the diagrams and the first theses in view; «Ещё» shows the rest.
  const [all, setAll] = useState(false);
  return (
    <section
      {...pRoot("BriefSummary", testId, "p-brief-summary")}
      aria-labelledby={hid}
      className={cx(s.card, className)}
    >
      <header className={s.head}>
        <h2 id={hid} className={s.title}>
          {title}
        </h2>
        <span className={s.version} data-testid="p-brief-summary-version">
          версия {version}
        </span>
      </header>
      <p className={s.note}>{note}</p>
      <ul className={s.thumbs} aria-label="Схемы">
        {BRIEF_DIAGRAM_KEYS.map((k) => (
          <li key={k}>
            <button
              type="button"
              className={s.thumb}
              data-testid={`p-brief-thumb-${k}`}
              aria-label={`Открыть схему «${BRIEF_DIAGRAM_TITLES[k]}»`}
              disabled={!onOpen}
              onClick={() => onOpen?.(k)}
            >
              <span className={s.pic}>
                <BriefDiagram graph={diagrams[k]} title={BRIEF_DIAGRAM_TITLES[k]} mini />
              </span>
              <span className={s.thumbCap}>{BRIEF_DIAGRAM_TITLES[k]}</span>
            </button>
          </li>
        ))}
      </ul>
      <ul className={cx(s.theses, !all && s.short)} data-testid="p-brief-theses">
        {theses.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
      {!all && theses.length > PHONE_THESES && (
        <button
          type="button"
          className={s.more}
          data-testid="p-brief-theses-more"
          onClick={() => setAll(true)}
        >
          Ещё {plural(theses.length - PHONE_THESES, "пункт", "пункта", "пунктов")}
        </button>
      )}
      {onOpen && (
        <div className={s.foot}>
          <ActionButton size="sm" testId="p-brief-open" onClick={() => onOpen()}>
            Открыть бриф целиком
          </ActionButton>
        </div>
      )}
    </section>
  );
}
