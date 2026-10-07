// Staff console (/admin, M2-08; api.yaml x-auth M2, D21_beta_moderation): only staff with TOTP — enrolment (key,
// first code, recovery codes shown once), step-up of each session, then the moderation queue by SLA, the ticket
// (staff access to system data for 24 h, takedown / dismiss / restore with a journal note) and founder reviews before
// prod, and the «Пилот» tab (Pilot.tsx: beta_readiness, client invitations, pilot orgs, LLM spend). Non-staff see
// «Страница не найдена» (the API answers 404); any 403 MFA_REQUIRED returns to the code screen.
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import { ApiError } from "../../api/client.js";
import type {
  AbuseReport,
  AbuseStatus,
  AbuseTicket,
  FounderReviewItem,
  StaffData,
  StaffSession,
} from "../../api/types.js";
import { usePlatform } from "../../app/context.js";
import { navigate, setQueryParam, useRoute } from "../../app/router.js";
import { Alert, Pill, type Tone } from "../../components/ui.js";
import { Button } from "../../components/v2/Button.js";
import { PlatformPage } from "../../components/v2/Shell.js";
import { AdminCandidates } from "../../features/factory/AdminCandidates.js";
import { AdminGaps } from "../../features/gaps/AdminGaps.js";
import { AdminSupport } from "../../features/support/AdminSupport.js";
import { factory } from "../../i18n/ru/factory.js";
import { gaps } from "../../i18n/ru/gaps.js";
import { support } from "../../i18n/ru/support.js";
import { ru } from "../../i18n/ru.js";
import f from "../abuse/Abuse.module.css";
import a from "../auth/Auth.module.css";
import st from "../settings/Settings.module.css";
import s from "./Admin.module.css";
import { PilotSection } from "./Pilot.js";

const errText = (e: unknown) => (e instanceof Error ? e.message : ru.errors.generic);
const isMfa = (e: unknown) => e instanceof ApiError && e.code === "MFA_REQUIRED";
const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString("ru-RU", {
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
const categoryRu = (c: string) => ru.abuse.categories[c] ?? c;
const OPEN: readonly AbuseStatus[] = ["new", "triaged"];
const STATUS_TONE: Record<AbuseStatus, Tone> = {
  new: "warn",
  triaged: "accent",
  takedown: "bad",
  dismissed: "neutral",
  restored: "ok",
};

/** «осталось 3 ч 5 мин» / «просрочено на 1 ч 0 мин» for an SLA deadline. */
export function slaText(deadline: string, now: number): { text: string; late: boolean } {
  const ms = new Date(deadline).getTime() - now;
  const mins = Math.floor(Math.abs(ms) / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return ms >= 0
    ? { text: ru.admin.slaLeft(h, m), late: false }
    : { text: ru.admin.slaOver(h, m), late: true };
}

function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function AdminConsole(): ReactNode {
  return (
    <PlatformPage nav={false}>
      <AdminGate />
    </PlatformPage>
  );
}

function AdminGate(): ReactNode {
  const { api } = usePlatform();
  // undefined — loading; null — not staff (404).
  const [session, setSession] = useState<StaffSession | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setSession(await api.adminSession());
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setSession(null);
      else setError(errText(e));
    }
  }, [api]);
  useEffect(() => {
    void reload();
  }, [reload]);

  if (session === null)
    return (
      <main className={a.page} data-testid="admin-not-found">
        <section className={a.card}>
          <h1 className={a.title}>{ru.admin.notStaff}</h1>
          <div className={a.row}>
            <Button variant="secondary" onClick={() => navigate("/")}>
              {ru.errors.toStart}
            </Button>
          </div>
        </section>
      </main>
    );
  if (session === undefined)
    return (
      <main aria-busy="true" className={st.page}>
        {error ? <Alert>{error}</Alert> : <p className={st.hint}>{ru.admin.loading}</p>}
      </main>
    );
  if (!session.mfaEnrolled) return <Enroll onDone={reload} />;
  if (!session.mfaVerifiedUntil) return <Verify onDone={reload} />;
  return <Console onMfaRequired={reload} />;
}

function CodeField({ value, onChange }: { value: string; onChange(v: string): void }): ReactNode {
  return (
    <label className={a.field}>
      {ru.admin.code}
      <input
        className={`${f.control} ${a.code}`}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, ""))}
        data-testid="admin-mfa-code"
      />
    </label>
  );
}

function Enroll({ onDone }: { onDone(): void }): ReactNode {
  const { api } = usePlatform();
  const [key, setKey] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }
  const start = () => run(async () => setKey(await api.adminMfaEnroll()));
  const confirm = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => setCodes((await api.adminMfaConfirm(code)).recoveryCodes));
  };

  return (
    <main className={a.page}>
      <section className={`${a.card} ${a.wide}`} data-testid="admin-enroll">
        <h1 className={a.title}>{codes ? ru.admin.recoveryTitle : ru.admin.enrollTitle}</h1>
        {codes ? (
          <>
            <p className={a.muted}>{ru.admin.recoveryLead}</p>
            <ul className={s.codes} data-testid="admin-recovery-codes">
              {codes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <div className={a.row}>
              <Button variant="primary" onClick={onDone} data-testid="admin-recovery-done">
                {ru.admin.recoveryDone}
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className={a.muted}>{ru.admin.enrollLead}</p>
            {!key ? (
              <div className={a.row}>
                <Button
                  variant="primary"
                  loading={busy}
                  onClick={() => void start()}
                  data-testid="admin-mfa-start"
                >
                  {ru.admin.enrollStart}
                </Button>
              </div>
            ) : (
              <form className={a.form} onSubmit={confirm} noValidate>
                <p className={a.muted}>{ru.admin.secret}</p>
                <p className={s.secret} data-testid="admin-mfa-secret" data-secret={key.secret}>
                  {key.secret.replace(/(.{4})/g, "$1 ").trim()}
                </p>
                <a className={a.link} href={key.otpauthUrl} data-testid="admin-mfa-otpauth">
                  {ru.admin.otpauth}
                </a>
                <CodeField value={code} onChange={setCode} />
                <div className={a.row}>
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={code.length !== 6}
                    loading={busy}
                    data-testid="admin-mfa-confirm"
                  >
                    {ru.admin.confirm}
                  </Button>
                </div>
              </form>
            )}
          </>
        )}
        {error && (
          <p className={a.formError} role="alert" data-testid="admin-mfa-error">
            {error}
          </p>
        )}
      </section>
    </main>
  );
}

function Verify({ onDone }: { onDone(): void }): ReactNode {
  const { api } = usePlatform();
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.adminMfaVerify(recoveryMode ? { recoveryCode: code.trim() } : { code });
      onDone();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className={a.page}>
      <section className={a.card} data-testid="admin-verify">
        <h1 className={a.title}>{ru.admin.verifyTitle}</h1>
        <p className={a.muted}>{ru.admin.verifyLead}</p>
        <form className={a.form} onSubmit={(e) => void submit(e)} noValidate>
          {recoveryMode ? (
            <label className={a.field}>
              {ru.admin.recoveryCode}
              <input
                className={f.control}
                value={code}
                maxLength={20}
                autoComplete="off"
                onChange={(e) => setCode(e.target.value)}
                data-testid="admin-mfa-recovery"
              />
            </label>
          ) : (
            <CodeField value={code} onChange={setCode} />
          )}
          {error && (
            <p className={a.formError} role="alert" data-testid="admin-mfa-error">
              {error}
            </p>
          )}
          <div className={a.row}>
            <Button
              type="submit"
              variant="primary"
              loading={busy}
              disabled={recoveryMode ? code.trim().length < 10 : code.length !== 6}
              data-testid="admin-mfa-verify"
            >
              {ru.admin.verify}
            </Button>
            <button
              type="button"
              className={a.link}
              onClick={() => {
                setRecoveryMode((v) => !v);
                setCode("");
                setError(null);
              }}
              data-testid="admin-mfa-toggle"
            >
              {recoveryMode ? ru.admin.useTotp : ru.admin.useRecovery}
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}

function Console({ onMfaRequired }: { onMfaRequired(): void }): ReactNode {
  const { search } = useRoute();
  const reportId = search.get("report");
  // ?tab=support|gaps|candidates: links from the founder's Telegram message (D68) and the module factory (B2-26).
  const initial = search.get("tab");
  const [tab, setTab] = useState<"reports" | "reviews" | "pilot" | "support" | "gaps" | "candidates">(
    initial === "support" || initial === "gaps" || initial === "candidates" ? initial : "reports",
  );
  return (
    <main className={st.page} data-testid="admin-console">
      <header className={st.head}>
        <h1 className={st.title}>{ru.admin.title}</h1>
        <span className={st.spacer} />
        <div className={s.tabs}>
          <button
            type="button"
            className={s.tab}
            aria-pressed={tab === "reports"}
            onClick={() => setTab("reports")}
            data-testid="admin-tab-reports"
          >
            {ru.admin.tabReports}
          </button>
          <button
            type="button"
            className={s.tab}
            aria-pressed={tab === "reviews"}
            onClick={() => {
              setTab("reviews");
              setQueryParam("report", null);
            }}
            data-testid="admin-tab-reviews"
          >
            {ru.admin.tabReviews}
          </button>
          <button
            type="button"
            className={s.tab}
            aria-pressed={tab === "pilot"}
            onClick={() => {
              setTab("pilot");
              setQueryParam("report", null);
            }}
            data-testid="admin-tab-pilot"
          >
            {ru.admin.tabPilot}
          </button>
          <button
            type="button"
            className={s.tab}
            aria-pressed={tab === "support"}
            onClick={() => {
              setTab("support");
              setQueryParam("report", null);
            }}
            data-testid="admin-tab-support"
          >
            {support.admin.tab}
          </button>
          <button
            type="button"
            className={s.tab}
            aria-pressed={tab === "gaps"}
            onClick={() => {
              setTab("gaps");
              setQueryParam("report", null);
            }}
            data-testid="admin-tab-gaps"
          >
            {gaps.tab}
          </button>
          <button
            type="button"
            className={s.tab}
            aria-pressed={tab === "candidates"}
            onClick={() => {
              setTab("candidates");
              setQueryParam("report", null);
            }}
            data-testid="admin-tab-candidates"
          >
            {factory.tab}
          </button>
        </div>
      </header>
      {tab === "support" ? (
        <AdminSupport onMfaRequired={onMfaRequired} />
      ) : tab === "gaps" ? (
        <AdminGaps onMfaRequired={onMfaRequired} />
      ) : tab === "candidates" ? (
        <AdminCandidates onMfaRequired={onMfaRequired} />
      ) : tab === "pilot" ? (
        <PilotSection onMfaRequired={onMfaRequired} />
      ) : tab === "reviews" ? (
        <Reviews onMfaRequired={onMfaRequired} />
      ) : reportId ? (
        <Ticket key={reportId} id={reportId} onMfaRequired={onMfaRequired} />
      ) : (
        <Queue onMfaRequired={onMfaRequired} />
      )}
    </main>
  );
}

function Queue({ onMfaRequired }: { onMfaRequired(): void }): ReactNode {
  const { api } = usePlatform();
  const now = useNow();
  const [status, setStatus] = useState<AbuseStatus | "">("");
  const [items, setItems] = useState<AbuseReport[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api
      .adminListAbuseReports(status || undefined)
      .then((r) => live && setItems(r.items))
      .catch((e) => {
        if (!live) return;
        if (isMfa(e)) onMfaRequired();
        else setError(errText(e));
      });
    return () => {
      live = false;
    };
  }, [api, status, onMfaRequired]);

  return (
    <section className={st.block} data-testid="admin-queue">
      <div className={st.head}>
        <h2 className={st.blockTitle}>{ru.admin.tabReports}</h2>
        <span className={st.spacer} />
        <select
          className={f.control}
          style={{ width: "auto" }}
          value={status}
          onChange={(e) => setStatus(e.target.value as AbuseStatus | "")}
          aria-label={ru.admin.status}
          data-testid="admin-queue-filter"
        >
          <option value="">{ru.admin.filterAll}</option>
          {(Object.keys(ru.admin.statuses) as AbuseStatus[]).map((k) => (
            <option key={k} value={k}>
              {ru.admin.statuses[k]}
            </option>
          ))}
        </select>
      </div>
      {error && <Alert>{error}</Alert>}
      {items?.length === 0 && <p className={st.muted}>{ru.admin.emptyReports}</p>}
      <ul className={st.list}>
        {(items ?? []).map((r) => {
          const sla = OPEN.includes(r.status) ? slaText(r.slaDeadline, now) : null;
          return (
            <li key={r.id}>
              <button
                type="button"
                className={s.row}
                onClick={() => setQueryParam("report", r.id)}
                data-testid="admin-report-row"
                data-id={r.id}
                data-status={r.status}
              >
                <span>
                  <strong>{categoryRu(r.category)}</strong>
                  <br />
                  <span className={st.small}>{r.systemName ?? ru.admin.noSystem}</span>
                </span>
                <span className={s.url}>{r.url}</span>
                <Pill tone={STATUS_TONE[r.status]}>{ru.admin.statuses[r.status]}</Pill>
                <span className={sla?.late ? s.late : st.small} data-testid="admin-report-sla">
                  {sla ? sla.text : r.resolvedAt ? fmtTime(r.resolvedAt) : ""}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

type Act = "triage" | "access" | "takedown" | "dismiss" | "restore" | "org-suspend" | "org-restore";

function Ticket({ id, onMfaRequired }: { id: string; onMfaRequired(): void }): ReactNode {
  const { api } = usePlatform();
  const now = useNow();
  const [t, setT] = useState<AbuseTicket | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<Act | null>(null);
  const [confirmTakedown, setConfirmTakedown] = useState(false);
  const [confirmOrg, setConfirmOrg] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [data, setData] = useState<StaffData | null>(null);

  const fail = useCallback(
    (e: unknown) => {
      if (isMfa(e)) onMfaRequired();
      else setError(errText(e));
    },
    [onMfaRequired],
  );
  const load = useCallback(async () => {
    try {
      const got = await api.adminGetAbuseReport(id);
      setT(got);
      if (got.access) setData(await api.adminSystemData(id).catch(() => null));
      else setData(null);
    } catch (e) {
      fail(e);
    }
  }, [api, id, fail]);
  useEffect(() => {
    void load();
  }, [load]);

  async function act(kind: Act) {
    if (note.trim().length < 3) return setError(ru.admin.noteRequired);
    if (kind === "takedown" && !confirmTakedown) return setConfirmTakedown(true);
    if (kind === "org-suspend" && !confirmOrg) return setConfirmOrg(true);
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      const orgId = t?.system?.orgId;
      if (kind === "access") await api.adminOpenStaffAccess(id, note.trim());
      else if (kind === "org-suspend" || kind === "org-restore") {
        if (!orgId) return;
        await api.adminOrgSuspension(orgId, {
          action: kind === "org-suspend" ? "suspend" : "restore",
          note: note.trim(),
          reportId: id,
        });
      } else await api.adminAbuseAction(id, { action: kind, note: note.trim() });
      setNote("");
      setConfirmTakedown(false);
      setConfirmOrg(false);
      setNotice(ru.admin.done);
      await load();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  }

  async function pickEntity(entity: string) {
    try {
      setData(await api.adminSystemData(id, entity));
    } catch (e) {
      fail(e);
    }
  }

  const back = (
    <div>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setQueryParam("report", null)}
        data-testid="admin-back"
      >
        {ru.admin.back}
      </Button>
    </div>
  );
  if (!t)
    return (
      <>
        {back}
        {error ? <Alert>{error}</Alert> : <p className={st.muted}>{ru.admin.loading}</p>}
      </>
    );
  const sla = OPEN.includes(t.status) ? slaText(t.slaDeadline, now) : null;
  const button = (kind: Act, label: string, variant: "primary" | "secondary" | "danger" = "secondary") => (
    <Button
      key={kind}
      variant={variant}
      loading={busy === kind}
      disabled={busy !== null && busy !== kind}
      onClick={() => void act(kind)}
      data-testid={`admin-act-${kind}`}
    >
      {label}
    </Button>
  );
  const actions: ReactNode[] = [];
  if (t.status === "new") actions.push(button("triage", ru.admin.actTriage, "primary"));
  if (t.status === "triaged" && !t.access) actions.push(button("access", ru.admin.actAccess));
  if (OPEN.includes(t.status) && t.system) actions.push(button("takedown", ru.admin.actTakedown, "danger"));
  if (OPEN.includes(t.status)) actions.push(button("dismiss", ru.admin.actDismiss));
  if (t.status === "takedown") actions.push(button("restore", ru.admin.actRestore, "primary"));
  // abuse.yaml#takedown.flow: repeated violation or obvious phishing → the whole org (orgs.suspended_at).
  if (t.system?.orgId && !t.system.orgSuspended)
    actions.push(button("org-suspend", ru.admin.actOrgSuspend, "danger"));
  if (t.system?.orgId && t.system.orgSuspended)
    actions.push(button("org-restore", ru.admin.actOrgRestore, "secondary"));

  return (
    <>
      {back}
      <section className={st.block} data-testid="admin-ticket" data-status={t.status}>
        <div className={st.head}>
          <h2 className={st.blockTitle}>
            {ru.admin.ticket} · {categoryRu(t.category)}
          </h2>
          <Pill tone={STATUS_TONE[t.status]} testId="admin-ticket-status">
            {ru.admin.statuses[t.status]}
          </Pill>
          {sla && (
            <span className={sla.late ? s.late : st.small} data-testid="admin-ticket-sla">
              {sla.text}
            </span>
          )}
        </div>
        <dl className={s.facts}>
          <dt>{ru.admin.created}</dt>
          <dd>{fmtTime(t.createdAt)}</dd>
          <dt>{ru.admin.deadline}</dt>
          <dd>{fmtTime(t.slaDeadline)}</dd>
          <dt>{ru.admin.url}</dt>
          <dd data-testid="admin-ticket-url">{t.url}</dd>
          <dt>{ru.admin.text}</dt>
          <dd>{t.text ?? ru.admin.noText}</dd>
          {t.contactEmail && (
            <>
              <dt>{ru.admin.contact}</dt>
              <dd>{t.contactEmail}</dd>
            </>
          )}
          <dt>{ru.admin.system}</dt>
          <dd data-testid="admin-ticket-system">
            {t.system ? (
              <>
                {t.system.name}
                {t.system.suspended && (
                  <>
                    {" "}
                    <Pill tone="bad" testId="admin-ticket-suspended">
                      {ru.admin.suspended}
                    </Pill>
                  </>
                )}
                {t.system.orgSuspended && (
                  <>
                    {" "}
                    <Pill tone="bad" testId="admin-ticket-org-suspended">
                      {ru.admin.orgSuspended}
                    </Pill>
                  </>
                )}
                {t.system.prodUrl && (
                  <>
                    {" · "}
                    <a href={t.system.prodUrl} target="_blank" rel="noopener noreferrer" className={st.link}>
                      {ru.admin.openProd}
                    </a>
                  </>
                )}
              </>
            ) : (
              ru.admin.noSystem
            )}
          </dd>
          {t.resolutionNote && (
            <>
              <dt>{ru.admin.note}</dt>
              <dd>{t.resolutionNote}</dd>
            </>
          )}
        </dl>
        <p className={st.small} data-testid="admin-ticket-access">
          {t.access ? ru.admin.accessUntil(fmtTime(t.access.until)) : ru.admin.accessNone}
        </p>
        {t.category === "phishing" && <p className={st.small}>{ru.admin.phishingNote}</p>}
        {actions.length > 0 && (
          <div className={st.form}>
            <label className={st.field}>
              {ru.admin.note}
              <textarea
                className={f.control}
                value={note}
                maxLength={2000}
                onChange={(e) => setNote(e.target.value)}
                data-testid="admin-note"
              />
            </label>
            {confirmTakedown && (
              <p className={st.warn} role="alert" data-testid="admin-takedown-confirm-text">
                {ru.admin.takedownConfirm}
              </p>
            )}
            {confirmOrg && (
              <p className={st.warn} role="alert" data-testid="admin-org-suspend-confirm-text">
                {ru.admin.orgSuspendConfirm}
              </p>
            )}
            <div className={s.actions}>{actions}</div>
          </div>
        )}
        {error && <Alert testId="admin-ticket-error">{error}</Alert>}
        {notice && (
          <p className={st.notice} role="status" data-testid="admin-ticket-notice">
            {notice}
          </p>
        )}
      </section>
      {data && <DataPanel data={data} onPick={(e) => void pickEntity(e)} />}
      <section className={st.block}>
        <h2 className={st.blockTitle}>{ru.admin.journal}</h2>
        {t.journal.length === 0 ? (
          <p className={st.muted}>{ru.admin.journalEmpty}</p>
        ) : (
          <ul className={`${st.list} ${s.journal}`}>
            {t.journal.map((j) => (
              <li key={`${j.at}-${j.action}-${j.actor}-${j.note ?? ""}`} data-testid="admin-journal-row">
                {fmtTime(j.at)} · {j.actor} · {j.action}
                {j.note ? ` — ${j.note}` : ""}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function DataPanel({ data, onPick }: { data: StaffData; onPick(entity: string): void }): ReactNode {
  return (
    <section className={st.block} data-testid="admin-data">
      <h2 className={st.blockTitle}>{ru.admin.data}</h2>
      <label className={st.field}>
        {ru.admin.dataEntity}
        <select
          className={f.control}
          value={data.entity ?? ""}
          onChange={(e) => onPick(e.target.value)}
          data-testid="admin-data-entity"
        >
          {data.entities.map((e) => (
            <option key={e.name} value={e.name}>
              {e.label} · {ru.admin.dataRows(e.rows)}
            </option>
          ))}
        </select>
      </label>
      {data.omittedPii ? <p className={st.small}>{ru.admin.dataOmitted(data.omittedPii)}</p> : null}
      {data.rows.length === 0 ? (
        <p className={st.muted}>{ru.admin.dataEmpty}</p>
      ) : (
        <div className={s.tableWrap}>
          <table className={s.table} data-testid="admin-data-table">
            <thead>
              <tr>
                {data.columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows of a read-only snapshot
                <tr key={i}>
                  {data.columns.map((c) => (
                    <td key={c}>{r[c] ?? ""}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Reviews({ onMfaRequired }: { onMfaRequired(): void }): ReactNode {
  const { api } = usePlatform();
  const [items, setItems] = useState<FounderReviewItem[] | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setItems((await api.adminListFounderReviews()).items);
    } catch (e) {
      if (isMfa(e)) onMfaRequired();
      else setError(errText(e));
    }
  }, [api, onMfaRequired]);
  useEffect(() => {
    void load();
  }, [load]);

  // The window opens on the click (popup blockers allow only that), the one-time link is set when it arrives.
  async function preview(r: FounderReviewItem) {
    setError(null);
    const w = window.open("", "_blank");
    try {
      const out = await api.adminFounderReviewPreview(r.systemId);
      if (w) {
        w.opener = null;
        w.location.href = out.url;
      } else window.location.assign(out.url);
      if (out.revision !== out.reviewRevision)
        setError(ru.admin.previewNewer(out.revision, out.reviewRevision));
    } catch (e) {
      w?.close();
      if (isMfa(e)) onMfaRequired();
      else setError(errText(e));
    }
  }

  async function decide(r: FounderReviewItem, decision: "approve" | "reject") {
    const key = `${r.systemId}:${r.revision}`;
    const note = (notes[key] ?? "").trim();
    setError(null);
    try {
      await api.adminFounderReview(r.systemId, { revision: r.revision, decision, ...(note ? { note } : {}) });
      await load();
    } catch (e) {
      if (isMfa(e)) onMfaRequired();
      else setError(errText(e));
    }
  }

  return (
    <section className={st.block} data-testid="admin-reviews">
      <h2 className={st.blockTitle}>{ru.admin.tabReviews}</h2>
      {error && <Alert>{error}</Alert>}
      {items?.length === 0 && <p className={st.muted}>{ru.admin.emptyReviews}</p>}
      <ul className={st.list}>
        {(items ?? []).map((r) => {
          const key = `${r.systemId}:${r.revision}`;
          return (
            <li key={key} className={st.form} data-testid="admin-review-row">
              <span>
                <strong>{r.systemName}</strong> · {ru.admin.reviewRevision(r.revision)} ·{" "}
                {fmtTime(r.createdAt)}
              </span>
              <input
                className={f.control}
                placeholder={ru.admin.rejectNote}
                value={notes[key] ?? ""}
                onChange={(e) => setNotes((n) => ({ ...n, [key]: e.target.value }))}
                data-testid="admin-review-note"
              />
              <div className={s.actions}>
                <Button
                  variant="secondary"
                  onClick={() => void preview(r)}
                  data-testid="admin-review-preview"
                >
                  {ru.admin.previewReview}
                </Button>
                <Button
                  variant="primary"
                  onClick={() => void decide(r, "approve")}
                  data-testid="admin-review-approve"
                >
                  {ru.admin.approve}
                </Button>
                <Button
                  variant="danger"
                  onClick={() => void decide(r, "reject")}
                  data-testid="admin-review-reject"
                >
                  {ru.admin.reject}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
