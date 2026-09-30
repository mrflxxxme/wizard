// S6 «Отчёт проверок» (GET /systems/:id/gates/latest) and the publish card (publishing itself is M1-04/M1-11).
import { Button } from "@wizard/ui-kit";
import { type ReactNode, useState } from "react";
import type { GateReport as Report } from "../../api/types.js";
import { Pill } from "../../components/ui.js";
import { ru } from "../../i18n/ru.js";
import s from "./Workspace.module.css";

function ReportRow({ r }: { r: Report }): ReactNode {
  const [open, setOpen] = useState(false);
  const pass = r.summary?.pass ?? r.checks.filter((c) => c.status === "pass").length;
  const counted = r.checks.filter((c) => c.status !== "skip").length;
  const warnings = r.checks.filter((c) => c.status === "warn");
  return (
    <li className={s.reportRow} data-testid={`gate-report-row-${r.level}`} data-passed={r.passed}>
      <div className={s.row}>
        <span aria-hidden="true" className={r.passed ? s.okMark : s.badMark}>
          {r.passed ? "✓" : "✗"}
        </span>
        <b title={ru.build.gate[r.level]}>{r.level}</b>
        <span>{r.passed ? ru.gates.passed : ru.gates.failed}</span>
        <span className={s.muted}>{ru.gates.summary(pass, counted)}</span>
        <button type="button" className={s.linkButton} aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? ru.gates.hideChecks : ru.gates.showChecks}
        </button>
      </div>
      {warnings.length > 0 && (
        <ul className={s.checks}>
          {warnings.map((c) => (
            <li key={c.id} data-testid="gate-warning">
              <Pill tone="warn">{ru.gates.nonBlocking}</Pill> {c.message_ru}
              {c.file ? ` (${c.file}${c.line ? `:${c.line}` : ""})` : ""}
            </li>
          ))}
        </ul>
      )}
      {open && (
        <ul className={s.checks}>
          {r.checks.map((c) => (
            <li key={c.id} data-status={c.status}>
              <span className={s.muted}>{c.status === "pass" ? "✓" : c.status === "skip" ? "–" : "✗"}</span>{" "}
              {c.message_ru}
              {c.file ? ` (${c.file}${c.line ? `:${c.line}` : ""})` : ""}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function GateReportView({ reports }: { reports: Report[] }): ReactNode {
  const order = ["G0", "G1", "G2"];
  const sorted = [...reports].sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level));
  return (
    <section className={s.report} data-testid="gate-report" aria-label={ru.gates.report}>
      <h3 className={s.blockTitle}>{ru.gates.report}</h3>
      {sorted.length === 0 ? (
        <p className={s.muted}>{ru.gates.noReport}</p>
      ) : (
        <ul className={s.reportList}>
          {sorted.map((r) => (
            <ReportRow key={r.level} r={r} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** Blocker codes of GET /systems/:id publishBlockers; failed gate reports imply GATES_FAILED. */
export function publishBlockers(apiBlockers: string[] | undefined, reports: Report[]): string[] {
  const out = [...(apiBlockers ?? [])];
  const failed = reports.filter((r) => !r.passed).map((r) => r.level);
  if (failed.length > 0 && !out.includes("GATES_FAILED")) out.unshift("GATES_FAILED");
  return out.map((code) => {
    const t = ru.publish.blockers[code];
    if (typeof t === "function") return t(failed.join(", "));
    return t ?? code;
  });
}

export function PublishCard({
  slug,
  blockers,
  onEdit,
}: {
  slug: string;
  blockers: string[];
  onEdit(): void;
}): ReactNode {
  return (
    <section className={s.publish} data-testid="publish-card" aria-label={ru.publish.title}>
      <h3 className={s.blockTitle}>{ru.publish.title}</h3>
      <p data-testid="publish-address">{ru.publish.address(slug)}</p>
      <p className={s.small}>{ru.publish.features}</p>
      <p className={s.small} data-testid="publish-card-status">
        {ru.publish.cardStatus}
      </p>
      {blockers.map((b) => (
        <p key={b} className={s.blocker} data-testid="publish-blocker">
          {b}
        </p>
      ))}
      <div className={s.row}>
        <Button variant="secondary" data-testid="chat-edit" onClick={onEdit}>
          {ru.publish.edits}
        </Button>
        <Button variant="primary" data-testid="publish-submit" disabled title={ru.publish.unavailable}>
          {ru.publish.submit}
        </Button>
      </div>
      <p className={s.small}>{ru.publish.unavailable}</p>
    </section>
  );
}
