// S6 «Отчёт проверок» (GET /systems/:id/gates/latest) and the publish card (publishing itself is M1-04/M1-11; the
// RU card status and blocker links to S10 «Персональные данные» and S-billing — M2-11). A G2 antifraud stop offers the
// owner «Оспорить» (abuse.yaml#rescan, #messages_ru.dispute → api.yaml#disputeG2Block). D28/D48: checks are named for
// people («Проверка прав доступа, данных и согласий»); levels G0–G2, check ids and file:line only under «Подробнее для
// специалиста».
import { Button } from "@wizard/ui-kit";
import { type ReactNode, useState } from "react";
import type { GateReport as Report, RevisionSummary } from "../../api/types.js";
import { navigate } from "../../app/router.js";
import { Alert, Pill, Specialist } from "../../components/ui.js";
import { ru } from "../../i18n/ru.js";
import s from "./Workspace.module.css";

/** G2 antifraud blockers the owner may dispute (gates.yaml#G2.antifraud_rules; AF-08/09 are review warnings). */
const DISPUTABLE = /^G2-AF-0[1-7]$/;

/** Owner's «Оспорить» of a G2 antifraud stop: `send` returns the server's message_ru. */
export interface DisputeHandler {
  send(revision: number, text: string): Promise<string>;
}

function Dispute({ revision, handler }: { revision: number; handler: DisputeHandler }): ReactNode {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (sent)
    return (
      <p className={s.small} role="status" data-testid="gate-dispute-sent">
        {sent}
      </p>
    );
  if (!open)
    return (
      <div className={s.row}>
        <span className={s.small}>{ru.gates.disputeHint}</span>
        <Button size="sm" variant="secondary" data-testid="gate-dispute" onClick={() => setOpen(true)}>
          {ru.gates.dispute}
        </Button>
      </div>
    );
  return (
    <div className={s.checks}>
      <label className={s.small}>
        {ru.gates.disputeText}
        <textarea
          value={text}
          maxLength={2000}
          rows={3}
          onChange={(e) => setText(e.target.value)}
          data-testid="gate-dispute-text"
        />
      </label>
      <Button
        size="sm"
        variant="primary"
        loading={busy}
        data-testid="gate-dispute-send"
        onClick={() => {
          setBusy(true);
          setError(null);
          handler
            .send(revision, text.trim())
            .then((m) => setSent(m || ru.gates.disputeSent))
            .catch((e: unknown) => setError(e instanceof Error ? e.message : ru.errors.generic))
            .finally(() => setBusy(false));
        }}
      >
        {ru.gates.disputeSend}
      </Button>
      {error && <Alert testId="gate-dispute-error">{error}</Alert>}
    </div>
  );
}

function ReportRow({
  r,
  revision,
  dispute,
}: {
  r: Report;
  revision: number | null;
  dispute?: DisputeHandler | undefined;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const pass = r.summary?.pass ?? r.checks.filter((c) => c.status === "pass").length;
  const counted = r.checks.filter((c) => c.status !== "skip").length;
  const warnings = r.checks.filter((c) => c.status === "warn");
  const disputable =
    r.level === "G2" && !r.passed && r.checks.some((c) => c.status === "fail" && DISPUTABLE.test(c.id));
  const rev = r.specVersion ?? revision;
  return (
    <li className={s.reportRow} data-testid={`gate-report-row-${r.level}`} data-passed={r.passed}>
      <div className={s.row}>
        <span aria-hidden="true" className={r.passed ? s.okMark : s.badMark}>
          {r.passed ? "✓" : "✗"}
        </span>
        <b>{ru.build.gate[r.level] ?? r.level}</b>
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
            </li>
          ))}
        </ul>
      )}
      {disputable && dispute && rev !== null && <Dispute revision={rev} handler={dispute} />}
      {open && (
        <ul className={s.checks}>
          {r.checks.map((c) => (
            <li key={c.id} data-status={c.status}>
              <span className={s.muted}>{c.status === "pass" ? "✓" : c.status === "skip" ? "–" : "✗"}</span>{" "}
              {c.message_ru}
            </li>
          ))}
          <li>
            <Specialist testId={`gate-report-specialist-${r.level}`}>
              {r.level}
              {r.checks.map((c) => (
                <div key={c.id}>
                  {c.id} {c.status}
                  {c.file ? ` ${c.file}${c.line ? `:${c.line}` : ""}` : ""}
                </div>
              ))}
            </Specialist>
          </li>
        </ul>
      )}
    </li>
  );
}

export function GateReportView({
  reports,
  revision = null,
  dispute,
}: {
  reports: Report[];
  /** Revision of the latest reports (GET gates/latest), when a report has no specVersion. */
  revision?: number | null;
  /** Owner only: «Оспорить» on a G2 antifraud stop. */
  dispute?: DisputeHandler | undefined;
}): ReactNode {
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
            <ReportRow key={r.level} r={r} revision={revision} dispute={dispute} />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The revision the owner would publish now (as getSystem.publishBlockers counts it): the latest draft revision
 * unless its G0 failed, else the preview revision.
 */
export function publishTarget(
  latest: RevisionSummary | undefined,
  previewRevision: number | null,
): number | null {
  if (latest && latest.g0Passed !== false) return latest.version;
  return previewRevision;
}

/** Blocker codes of GET /systems/:id publishBlockers; failed gate reports imply GATES_FAILED. */
export function publishBlockers(apiBlockers: string[] | undefined, reports: Report[]): string[] {
  const out = [...(apiBlockers ?? [])];
  const failed = reports.filter((r) => !r.passed).map((r) => r.level);
  if (failed.length > 0 && !out.includes("GATES_FAILED")) out.unshift("GATES_FAILED");
  return out.map((code) => {
    const t = ru.publish.blockers[code];
    if (typeof t === "function") return t(failed.map((l) => ru.build.gate[l] ?? l).join(", "));
    return t ?? code;
  });
}

/** Blocker codes that the owner fixes in S10 (operator of personal data, L4-09). */
export const SETTINGS_BLOCKERS: ReadonlySet<string> = new Set([
  "OPERATOR_NAME_REQUIRED",
  "OPERATOR_CONTACT_REQUIRED",
  "OPERATOR_ADDRESS_REQUIRED",
  "INN_INVALID",
  // V3-18: the shop's seller requisites (ЗоЗПП ст. 26.1) are the operator's data of the same form.
  "SELLER_REQUISITES_REQUIRED",
  "OGRN_INVALID",
]);
/** Blocker codes fixed on S-billing: the card (identification, D9) and the plan (F4 phone login, prod limit). */
export const BILLING_BLOCKERS: ReadonlySet<string> = new Set([
  "CARD_BINDING_REQUIRED",
  "PHONE_LOGIN_PLAN_REQUIRED",
  "PLAN_LIMIT",
]);

function InternalLink({
  to,
  testId,
  children,
}: {
  to: string;
  testId: string;
  children: ReactNode;
}): ReactNode {
  return (
    <a
      href={to}
      className={s.linkButton}
      data-testid={testId}
      onClick={(e) => {
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

export function PublishCard({
  systemId,
  slug,
  blockers,
  codes,
  prodRevision,
  prodUrl,
  revision,
  showSubmit,
  running,
  busy,
  error,
  cardBound,
  onEdit,
  onPublish,
}: {
  systemId: string;
  slug: string;
  /** Blockers already in Russian (publishBlockers). */
  blockers: string[];
  /** Raw blocker codes of GET /systems/:id. */
  codes: string[];
  prodRevision: number | null;
  prodUrl: string | null;
  /** Revision «Опубликовать» would publish; null — nothing to publish. */
  revision: number | null;
  /** false when the diff card (S7) carries the publish button. */
  showSubmit: boolean;
  running: boolean;
  busy: boolean;
  error: string | null;
  /** M2: Org.cardBound of the system's organization (GET /orgs/:orgId); undefined — unknown. */
  cardBound?: boolean | undefined;
  onEdit(): void;
  onPublish(): void;
}): ReactNode {
  const upToDate = prodRevision !== null && revision === prodRevision;
  const needsCard = codes.includes("CARD_BINDING_REQUIRED");
  return (
    <section className={s.publish} data-testid="publish-card" aria-label={ru.publish.title}>
      <div className={s.buildHead}>
        <h3 className={s.blockTitle}>{ru.publish.title}</h3>
        {prodRevision !== null && (
          <Pill tone="ok" title={ru.start.prodTitle} testId="publish-prod-revision">
            {ru.publish.published(prodRevision)}
          </Pill>
        )}
      </div>
      <p data-testid="publish-address">
        {prodUrl ? (
          <a href={prodUrl} target="_blank" rel="noopener noreferrer" data-testid="publish-prod-url">
            {prodUrl}
          </a>
        ) : (
          ru.publish.address(slug)
        )}
      </p>
      <p className={s.small}>{ru.publish.features}</p>
      <p
        className={s.small}
        data-testid="publish-card-status"
        data-bound={cardBound === true ? "true" : needsCard ? "false" : undefined}
      >
        {cardBound ? ru.publish.cardBound : needsCard ? ru.publish.cardMissing : ru.publish.cardStatus}
      </p>
      {blockers.map((b) => (
        <p key={b} className={s.blocker} data-testid="publish-blocker">
          {b}
        </p>
      ))}
      {codes.includes("FOUNDER_REVIEW_PENDING") && <p className={s.small}>{ru.publish.reviewHint}</p>}
      {codes.some((c) => SETTINGS_BLOCKERS.has(c)) && (
        <InternalLink to={`/s/${systemId}/settings#pd`} testId="publish-to-settings">
          {ru.publish.toSettings}
        </InternalLink>
      )}
      {codes.some((c) => BILLING_BLOCKERS.has(c)) && (
        <InternalLink to="/billing" testId="publish-to-billing">
          {needsCard ? ru.publish.bindCard : ru.publish.toBilling}
        </InternalLink>
      )}
      <div className={s.row}>
        <Button variant="secondary" data-testid="chat-edit" onClick={onEdit}>
          {ru.publish.edits}
        </Button>
        {showSubmit && (
          <Button
            variant="primary"
            data-testid="publish-submit"
            disabled={blockers.length > 0 || revision === null || upToDate || running}
            loading={busy}
            onClick={onPublish}
          >
            {revision !== null && prodRevision !== null && !upToDate
              ? ru.publish.submitRevision(revision)
              : ru.publish.submit}
          </Button>
        )}
      </div>
      {error && <Alert testId="publish-error">{error}</Alert>}
    </section>
  );
}
