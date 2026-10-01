// S7 «Что изменится» (M1-08): the human diff of the draft against prod (GET /revisions/:v/diff?from=<prod>) with
// migration, gates and price; «Отменить» rolls the draft back to prod, «Опубликовать ревизию N+1» publishes it.
import { Button } from "@wizard/ui-kit";
import type { ReactNode } from "react";
import type { DiffChange, GateReport } from "../../api/types.js";
import { Alert, Pill } from "../../components/ui.js";
import { diffSign, groupChanges, migrationVerdict } from "../../diff/human.js";
import { ru } from "../../i18n/ru.js";
import s from "./Workspace.module.css";

export function DiffLine({ c }: { c: DiffChange }): ReactNode {
  const sign = diffSign(c);
  return (
    <li className={s.diffLine} data-testid="diff-line" data-sign={sign} data-kind={c.kind}>
      <span className={s.diffSign} data-sign={sign} title={ru.diff.signLabel[sign]}>
        {ru.diff.sign[sign]}
      </span>
      <span className={c.destructive ? s.destructive : undefined}>{c.text_ru}</span>
    </li>
  );
}

/** «Изменения» segment: changes grouped by kind (данные, права, экраны…). */
export function ChangesPanel({ changes }: { changes: DiffChange[] | null }): ReactNode {
  if (changes === null) return <p className={s.muted}>{ru.diff.loading}</p>;
  if (changes.length === 0) return <p className={s.muted}>{ru.diff.empty}</p>;
  return (
    <div className={s.changesPanel} data-testid="diff-groups">
      {groupChanges(changes).map((g) => (
        <section key={g.kind} className={s.block} aria-label={ru.diff.groups[g.kind] ?? g.kind}>
          <h3 className={s.blockTitle}>{ru.diff.groups[g.kind] ?? g.kind}</h3>
          <ul className={s.diffList}>
            {g.items.map((c) => (
              <DiffLine key={`${c.kind}:${c.text_ru}`} c={c} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function DiffCard({
  revision,
  changes,
  reports,
  credits,
  blockers,
  canCancel,
  busy,
  onCancel,
  onPublish,
}: {
  revision: number;
  changes: DiffChange[] | null;
  reports: GateReport[];
  credits: number | null;
  /** Publish blockers already in Russian (GateReport.publishBlockers). */
  blockers: string[];
  canCancel: boolean;
  busy: "publish" | "cancel" | null;
  onCancel(): void;
  onPublish(): void;
}): ReactNode {
  const verdict = changes ? migrationVerdict(changes) : null;
  const passed = reports.filter((r) => r.passed).map((r) => r.level);
  const checks = reports.reduce((n, r) => n + r.checks.filter((c) => c.status !== "skip").length, 0);
  const allPassed = reports.length > 0 && passed.length === reports.length;
  const destructive = verdict === "destructive";
  const lines = changes?.filter((c) => c.kind !== "file") ?? [];
  const files = changes?.filter((c) => c.kind === "file") ?? [];
  return (
    <section className={s.diff} data-testid="diff-card" aria-label={ru.diff.title}>
      <h3 className={s.blockTitle}>{ru.diff.title}</h3>
      {changes === null ? (
        <p className={s.small}>{ru.diff.loading}</p>
      ) : changes.length === 0 ? (
        <p className={s.small}>{ru.diff.empty}</p>
      ) : (
        <ul className={s.diffList}>
          {[...lines, ...files].map((c) => (
            <DiffLine key={`${c.kind}:${c.text_ru}`} c={c} />
          ))}
        </ul>
      )}
      <dl className={s.facts}>
        <dt>{ru.diff.migration}</dt>
        <dd data-testid="diff-migration" data-verdict={verdict ?? ""}>
          {verdict === null ? (
            "…"
          ) : verdict === "destructive" ? (
            <span className={s.destructive}>{ru.diff.migrationDestructive}</span>
          ) : verdict === "additive" ? (
            ru.diff.migrationAdditive
          ) : (
            ru.diff.migrationNone
          )}
        </dd>
        <dt>{ru.diff.gates}</dt>
        <dd data-testid="diff-gates">
          {allPassed ? (
            <Pill tone="ok" title={passed.map((l) => ru.build.gate[l]).join(", ")}>
              ✓ {ru.diff.gatesLine(passed.join(" · "), checks)}
            </Pill>
          ) : (
            <Pill tone="warn">{ru.diff.gatesPending}</Pill>
          )}
        </dd>
        <dt>{ru.diff.price}</dt>
        <dd data-testid="diff-price">
          {credits === null ? ru.diff.priceUnknown : ru.diff.priceLine(credits)}
        </dd>
      </dl>
      {destructive && <Alert testId="diff-destructive">{ru.diff.destructiveBlock}</Alert>}
      {blockers.map((b) => (
        <p key={b} className={s.blocker} data-testid="publish-blocker">
          {b}
        </p>
      ))}
      <div className={s.row}>
        <Button
          variant="secondary"
          data-testid="diff-cancel"
          disabled={!canCancel || busy !== null}
          loading={busy === "cancel"}
          title={ru.diff.cancelHint}
          onClick={onCancel}
        >
          {ru.diff.cancel}
        </Button>
        <Button
          variant="primary"
          data-testid="diff-publish"
          disabled={destructive || blockers.length > 0 || changes === null || busy !== null}
          loading={busy === "publish"}
          onClick={onPublish}
        >
          {ru.diff.publish(revision)}
        </Button>
      </div>
    </section>
  );
}
