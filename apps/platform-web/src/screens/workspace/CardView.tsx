// S3 «Карточка системы» (orchestrator.yaml#system_card): the single approval point; «Строить» → POST approve.
import { Button } from "@wizard/ui-kit";
import type { ReactNode } from "react";
import type { SystemCard } from "../../api/types.js";
import { Alert, Pill } from "../../components/ui.js";
import { ru } from "../../i18n/ru.js";
import s from "./Workspace.module.css";

type SectionKey = "spec" | "code" | "integrations" | "acceptance" | "summary";

/** Sections whose content differs from the previous card version (highlighted after «Карточка обновлена»). */
export function changedSections(prev: SystemCard | null, next: SystemCard): Set<SectionKey> {
  const out = new Set<SectionKey>();
  if (!prev || prev.cardVersion === next.cardVersion) return out;
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  if (!same(prev.specVsCode?.spec, next.specVsCode?.spec) || !same(prev.pii, next.pii)) out.add("spec");
  if (!same(prev.specVsCode?.code, next.specVsCode?.code) || !same(prev.screens, next.screens))
    out.add("code");
  if (!same(prev.integrations, next.integrations)) out.add("integrations");
  if (!same(prev.acceptance, next.acceptance)) out.add("acceptance");
  if (!same(prev.summary, next.summary) || !same(prev.title, next.title)) out.add("summary");
  return out;
}

export function CardView({
  card,
  changed,
  buildModelLabel,
  busy,
  error,
  onBuild,
  onEdit,
}: {
  card: SystemCard;
  changed: Set<SectionKey>;
  buildModelLabel: string | undefined;
  busy: boolean;
  error: string | null;
  onBuild(): void;
  onEdit(): void;
}): ReactNode {
  const cls = (k: SectionKey) => (changed.has(k) ? `${s.cardSection} ${s.changed}` : s.cardSection);
  const credits = card.estimate?.credits;
  const minutes = card.estimate?.minutes;
  const roles = card.roles?.length ?? 0;
  const data = card.data?.length ?? 0;
  const screens = card.screens?.length ?? 0;
  const integrations = card.integrations?.length ?? 0;
  return (
    <section className={s.card} data-testid="card" aria-labelledby="card-title">
      {changed.size > 0 && (
        <div className={s.updated} role="status" data-testid="card-updated">
          {ru.card.updated}
        </div>
      )}
      <div className={s.cardHead}>
        <span className={s.muted} data-testid="card-version">
          {ru.card.version(card.cardVersion)}
        </span>
        <h2 id="card-title" className={s.panelTitle}>
          {card.title ?? card.summary ?? ""}
        </h2>
        {card.kind === "create" && (
          <Pill tone="accent">{ru.card.counts(roles, data, screens, integrations)}</Pill>
        )}
      </div>
      {card.summary && (
        <div className={cls("summary")}>
          {card.kind === "change" && <h3 className={s.blockTitle}>{ru.card.changeTitle}</h3>}
          <p className={s.lead}>{card.summary}</p>
        </div>
      )}
      {(card.roles?.length ?? 0) > 0 && (
        <div className={s.cardSection}>
          <h3 className={s.blockTitle}>{ru.card.roles}</h3>
          <ul className={s.list}>
            {card.roles?.map((r) => (
              <li key={r.name}>
                <b>{r.label}</b>
                {r.description ? ` — ${r.description}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className={s.cardGrid}>
        <div className={cls("spec")} data-testid="card-section-spec">
          <h3 className={s.blockTitle}>{ru.card.spec}</h3>
          <ul className={s.list}>
            {(card.specVsCode?.spec ?? []).map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
          {card.pii?.summary && (
            <p className={s.small}>
              <b>{ru.card.pii}:</b> {card.pii.summary}
            </p>
          )}
          {(card.pii?.retention ?? []).map((r) =>
            r.humanText ? (
              <p key={r.entity} className={s.small}>
                {r.humanText}
              </p>
            ) : null,
          )}
        </div>
        <div className={cls("code")} data-testid="card-section-code">
          <h3 className={s.blockTitle}>{ru.card.code}</h3>
          <ul className={s.list}>
            {(card.specVsCode?.code ?? []).map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
          {(card.screens?.length ?? 0) > 0 && (
            <ul className={s.list}>
              {card.screens?.map((x) => (
                <li key={x.route}>
                  <b>{x.title}</b>
                  {x.purpose ? ` — ${x.purpose}` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {(card.integrations?.length ?? 0) > 0 && (
        <div className={cls("integrations")} data-testid="card-section-integrations">
          <h3 className={s.blockTitle}>{ru.card.integrations}</h3>
          <ul className={s.list}>
            {card.integrations?.map((i) => (
              <li key={i.connector}>
                <b>{i.connector}</b>
                {i.purpose ? ` — ${i.purpose}` : ""}{" "}
                {i.userActionRequired && (
                  <Pill tone="warn" title={i.userActionRequired}>
                    {ru.card.keyNeeded}
                  </Pill>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {(card.acceptance?.length ?? 0) > 0 && (
        <div className={cls("acceptance")}>
          <h3 className={s.blockTitle}>{ru.card.acceptance}</h3>
          <ul className={s.checklist}>
            {card.acceptance?.map((a) => (
              <li key={a.id} data-testid="card-acceptance-item">
                <span aria-hidden="true">☑</span> {a.text}
              </li>
            ))}
          </ul>
        </div>
      )}
      <footer className={s.cardFooter}>
        <div className={s.cardFooterText}>
          {credits?.expected !== undefined && (
            <span data-testid="card-estimate">
              {ru.card.estimate(credits.expected, minutes?.min, minutes?.max)}
            </span>
          )}
          <span data-testid="card-cap" className={s.muted}>
            {ru.card.cap(card.cap.credits, buildModelLabel)}
          </span>
        </div>
        <div className={s.row}>
          <Button variant="secondary" data-testid="card-edit" onClick={onEdit}>
            {ru.card.edit}
          </Button>
          <Button variant="primary" data-testid="card-build" loading={busy} onClick={onBuild}>
            {ru.card.build}
          </Button>
        </div>
        {error && <Alert>{error}</Alert>}
      </footer>
    </section>
  );
}
