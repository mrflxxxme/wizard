// Staff console «Пилот» (/admin, tab admin-tab-pilot; platform-screens.yaml#S-admin pilot): the founder CLI `pilot` in
// the browser on the same API functions — beta_readiness with who/when and its checklist (switching on needs a second
// press and a note), invitations of pilot clients (refused with the API's Russian text while readiness is off), their
// statuses and revoke, pilot orgs with the month's spend, grants by reference, the founder-review flag, and the
// platform LLM spend vs the monthly cap with the 80 % warning. Any MFA_REQUIRED returns to the code screen.
import { Button } from "@wizard/ui-kit";
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import { ApiError } from "../../api/client.js";
import type { LlmSpend, PilotInvite, PilotOrg, PilotReadiness } from "../../api/types.js";
import { usePlatform } from "../../app/context.js";
import { Alert, Pill, type Tone } from "../../components/ui.js";
import { ru } from "../../i18n/ru.js";
import f from "../abuse/Abuse.module.css";
import st from "../settings/Settings.module.css";
import s from "./Admin.module.css";

const t = ru.admin.pilot;
const errText = (e: unknown) => (e instanceof Error ? e.message : ru.errors.generic);
const isMfa = (e: unknown) => e instanceof ApiError && e.code === "MFA_REQUIRED";
const num = (n: number, digits = 1) =>
  n.toLocaleString("ru-RU", { minimumFractionDigits: 0, maximumFractionDigits: digits });
const rub = (n: number) => `${num(n, 2)} ₽`;
const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
const fmtDay = (iso: string) =>
  new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
const INVITE_TONE: Record<PilotInvite["status"], Tone> = {
  sent: "accent",
  accepted: "ok",
  expired: "neutral",
};

interface PilotData {
  readiness: PilotReadiness;
  spend: LlmSpend;
  invites: PilotInvite[];
  orgs: { month: string; capRub: number; items: PilotOrg[] };
}

export function PilotSection({ onMfaRequired }: { onMfaRequired(): void }): ReactNode {
  const { api } = usePlatform();
  const [data, setData] = useState<PilotData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fail = useCallback(
    (e: unknown, set: (m: string) => void = setError) => {
      if (isMfa(e)) onMfaRequired();
      else set(errText(e));
    },
    [onMfaRequired],
  );
  const load = useCallback(async () => {
    try {
      const [readiness, spend, invites, orgs] = await Promise.all([
        api.adminPilotReadiness(),
        api.adminPilotSpend(),
        api.adminListPilotInvites(),
        api.adminListPilotOrgs(),
      ]);
      setData({ readiness, spend, invites: invites.items, orgs });
      setError(null);
    } catch (e) {
      fail(e);
    }
  }, [api, fail]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!data) return error ? <Alert>{error}</Alert> : <p className={st.muted}>{ru.admin.loading}</p>;
  return (
    <div className={st.form} data-testid="admin-pilot">
      {error && <Alert>{error}</Alert>}
      <Readiness value={data.readiness} onChanged={load} fail={fail} />
      <Spend value={data.spend} />
      <InviteForm onSent={load} fail={fail} />
      <Invites items={data.invites} onChanged={load} fail={fail} />
      <Orgs value={data.orgs} onChanged={load} fail={fail} />
    </div>
  );
}

type Fail = (e: unknown, set?: (m: string) => void) => void;

function Readiness({
  value,
  onChanged,
  fail,
}: {
  value: PilotReadiness;
  onChanged(): Promise<void>;
  fail: Fail;
}): ReactNode {
  const { api } = usePlatform();
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setError(null);
    if (!value.on) {
      if (note.trim().length < 3) return setError(t.readinessNoteRequired);
      if (!confirming) return setConfirming(true);
    }
    setBusy(true);
    try {
      await api.adminSetPilotReadiness(
        value.on
          ? { on: false, ...(note.trim() ? { note: note.trim() } : {}) }
          : { on: true, confirm: true, note: note.trim() },
      );
      setNote("");
      setConfirming(false);
      await onChanged();
    } catch (e) {
      fail(e, setError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={st.block} data-testid="admin-pilot-readiness" data-on={String(value.on)}>
      <div className={st.head}>
        <h2 className={st.blockTitle}>{t.readinessTitle}</h2>
        <Pill tone={value.on ? "ok" : "warn"} testId="admin-pilot-readiness-state">
          {value.on ? t.readinessOn : t.readinessOff}
        </Pill>
      </div>
      <p className={st.small} data-testid="admin-pilot-readiness-by">
        {value.at && value.by ? t.readinessBy(value.by, fmtTime(value.at)) : t.readinessNever}
        {value.note ? ` — ${value.note}` : ""}
      </p>
      <p className={st.muted}>{t.readinessLead}</p>
      <ul data-testid="admin-pilot-checklist">
        {value.checklist.map((c) => (
          <li key={c.id} data-id={c.id}>
            {c.text}
          </li>
        ))}
      </ul>
      <label className={st.field}>
        {t.readinessNote}
        <textarea
          className={f.control}
          value={note}
          maxLength={500}
          onChange={(e) => {
            setNote(e.target.value);
            setConfirming(false);
          }}
          data-testid="admin-pilot-readiness-note"
        />
      </label>
      {confirming && (
        <p className={st.warn} role="alert" data-testid="admin-pilot-readiness-confirm-text">
          {t.readinessConfirm}
        </p>
      )}
      {error && <Alert testId="admin-pilot-readiness-error">{error}</Alert>}
      <div className={s.actions}>
        <Button
          variant={value.on ? "secondary" : "primary"}
          loading={busy}
          onClick={() => void toggle()}
          data-testid="admin-pilot-readiness-toggle"
        >
          {value.on ? t.readinessTurnOff : t.readinessTurnOn}
        </Button>
      </div>
    </section>
  );
}

function Spend({ value }: { value: LlmSpend }): ReactNode {
  return (
    <section
      className={st.block}
      data-testid="admin-pilot-spend"
      data-warn={String(value.warn)}
      data-reached={String(value.reached)}
    >
      <h2 className={st.blockTitle}>{t.spendTitle}</h2>
      <p data-testid="admin-pilot-spend-value">
        {t.spend(value.month, rub(value.spentRub), rub(value.capRub), value.sharePercent)}
      </p>
      {(value.warn || value.reached) && (
        <p className={st.warn} role="alert" data-testid="admin-pilot-spend-warn">
          {value.reached ? t.spendReached : t.spendWarn}
        </p>
      )}
    </section>
  );
}

function InviteForm({ onSent, fail }: { onSent(): Promise<void>; fail: Fail }): ReactNode {
  const { api } = usePlatform();
  const [email, setEmail] = useState("");
  const [orgName, setOrgName] = useState("");
  const [credits, setCredits] = useState("0");
  const [review, setReview] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ email: string; link: string } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSent(null);
    try {
      const n = Number(credits || "0");
      const r = await api.adminCreatePilotInvite({
        email: email.trim(),
        ...(orgName.trim() ? { orgName: orgName.trim() } : {}),
        credits: Number.isFinite(n) ? n : 0,
        requireFounderReview: review,
      });
      setSent({ email: r.email, link: r.link });
      setEmail("");
      setOrgName("");
      setCredits("0");
      setReview(true);
      await onSent();
    } catch (err) {
      fail(err, setError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={st.block} data-testid="admin-pilot-invite">
      <h2 className={st.blockTitle}>{t.inviteTitle}</h2>
      <form className={st.form} onSubmit={(e) => void submit(e)} noValidate>
        <div className={st.inviteForm}>
          <label className={st.field}>
            {t.email}
            <input
              className={f.control}
              type="email"
              autoComplete="off"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              data-testid="admin-pilot-invite-email"
            />
          </label>
          <label className={st.field}>
            {t.orgName}
            <input
              className={f.control}
              maxLength={120}
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              data-testid="admin-pilot-invite-org"
            />
          </label>
          <label className={st.field}>
            {t.credits}
            <input
              className={f.control}
              inputMode="numeric"
              value={credits}
              onChange={(e) => setCredits(e.target.value.replace(/\D/g, ""))}
              data-testid="admin-pilot-invite-credits"
            />
          </label>
        </div>
        <label className={st.check}>
          <input
            type="checkbox"
            checked={review}
            onChange={(e) => setReview(e.target.checked)}
            data-testid="admin-pilot-invite-review"
          />
          {t.review}
        </label>
        {error && (
          <p
            className={st.warn}
            role="alert"
            data-testid="admin-pilot-invite-error"
            style={{ whiteSpace: "pre-line" }}
          >
            {error}
          </p>
        )}
        {sent && (
          <p className={st.notice} role="status" data-testid="admin-pilot-invite-done">
            {t.invited(sent.email)}{" "}
            <span className={s.url} data-testid="admin-pilot-invite-link">
              {sent.link}
            </span>
          </p>
        )}
        <div className={s.actions}>
          <Button
            type="submit"
            variant="primary"
            loading={busy}
            disabled={email.trim().length < 3}
            data-testid="admin-pilot-invite-submit"
          >
            {t.invite}
          </Button>
        </div>
      </form>
    </section>
  );
}

function Invites({
  items,
  onChanged,
  fail,
}: {
  items: PilotInvite[];
  onChanged(): Promise<void>;
  fail: Fail;
}): ReactNode {
  const { api } = usePlatform();
  const [error, setError] = useState<string | null>(null);
  async function revoke(id: string) {
    setError(null);
    try {
      await api.adminRevokePilotInvite(id);
      await onChanged();
    } catch (e) {
      fail(e, setError);
    }
  }
  return (
    <section className={st.block} data-testid="admin-pilot-invites">
      <h2 className={st.blockTitle}>{t.invitesTitle}</h2>
      {error && <Alert>{error}</Alert>}
      {items.length === 0 ? (
        <p className={st.muted}>{t.invitesEmpty}</p>
      ) : (
        <ul className={st.list}>
          {items.map((i) => (
            <li key={i.id} className={st.lockRow} data-testid="admin-pilot-invite-row" data-status={i.status}>
              <strong>{i.email}</strong>
              <span>{i.orgName ?? "—"}</span>
              <span className={st.small}>{t.inviteCredits(i.credits)}</span>
              <span className={st.small}>{i.requireFounderReview ? t.reviewOn : t.reviewOff}</span>
              <Pill tone={INVITE_TONE[i.status]} testId="admin-pilot-invite-status">
                {t.inviteStatuses[i.status]}
              </Pill>
              <span className={st.small}>
                {i.status === "accepted" && i.acceptedAt
                  ? fmtDay(i.acceptedAt)
                  : t.inviteUntil(fmtDay(i.expiresAt))}
              </span>
              {i.status === "sent" && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void revoke(i.id)}
                  data-testid="admin-pilot-invite-revoke"
                >
                  {t.revoke}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Orgs({
  value,
  onChanged,
  fail,
}: {
  value: PilotData["orgs"];
  onChanged(): Promise<void>;
  fail: Fail;
}): ReactNode {
  return (
    <section className={st.block} data-testid="admin-pilot-orgs">
      <h2 className={st.blockTitle}>
        {t.orgsTitle} · {value.month}
      </h2>
      {value.items.length === 0 ? (
        <p className={st.muted}>{t.orgsEmpty}</p>
      ) : (
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th>{t.colOrg}</th>
                <th>{t.colPlan}</th>
                <th>{t.colMembers}</th>
                <th>{t.colAvailable}</th>
                <th>{t.colSpent}</th>
                <th>{t.colModels}</th>
                <th>{t.colReview}</th>
                <th>{t.colActions}</th>
              </tr>
            </thead>
            <tbody>
              {value.items.map((o) => (
                <OrgRow key={o.id} org={o} capRub={value.capRub} onChanged={onChanged} fail={fail} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function OrgRow({
  org,
  capRub,
  onChanged,
  fail,
}: {
  org: PilotOrg;
  capRub: number;
  onChanged(): Promise<void>;
  fail: Fail;
}): ReactNode {
  const { api } = usePlatform();
  const [credits, setCredits] = useState("");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function grant() {
    setError(null);
    setNotice(null);
    const n = Number(credits);
    if (!(n > 0) || reference.trim().length < 3) return setError(t.grantInvalid);
    setBusy(true);
    try {
      const r = await api.adminGrantPilotCredits(org.id, { credits: n, reference: reference.trim() });
      setNotice(r.granted ? t.granted(r.creditsAvailable) : t.grantedBefore(r.creditsAvailable));
      setCredits("");
      setReference("");
      await onChanged();
    } catch (e) {
      fail(e, setError);
    } finally {
      setBusy(false);
    }
  }
  async function toggleReview(on: boolean) {
    setError(null);
    try {
      await api.adminSetPilotFounderReview(org.id, on);
      await onChanged();
    } catch (e) {
      fail(e, setError);
    }
  }

  return (
    <tr data-testid="admin-pilot-org-row" data-id={org.id}>
      <td>{org.name}</td>
      <td>{ru.billing.planName[org.plan] ?? org.plan}</td>
      <td>{org.members}</td>
      <td data-testid="admin-pilot-org-available">{num(org.creditsAvailable)}</td>
      <td>{num(org.creditsSpentMonth)}</td>
      <td title={t.ofCap(rub(capRub))}>
        {rub(org.modelSpendRub)} <span className={st.small}>{t.ofCap(rub(capRub))}</span>
      </td>
      <td>
        <label className={st.check}>
          <input
            type="checkbox"
            checked={org.requireFounderReview}
            onChange={(e) => void toggleReview(e.target.checked)}
            aria-label={ru.admin.pilot.review}
            data-testid="admin-pilot-org-review"
          />
        </label>
      </td>
      <td>
        <div className={st.inviteForm}>
          <input
            className={f.control}
            inputMode="decimal"
            placeholder={t.grantCredits}
            aria-label={t.grantCredits}
            value={credits}
            onChange={(e) => setCredits(e.target.value.replace(/[^\d.]/g, ""))}
            data-testid="admin-pilot-grant-credits"
          />
          <input
            className={f.control}
            placeholder={t.grantReference}
            aria-label={t.grantReference}
            maxLength={200}
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            data-testid="admin-pilot-grant-reference"
          />
          <Button
            variant="secondary"
            size="sm"
            loading={busy}
            onClick={() => void grant()}
            data-testid="admin-pilot-grant"
          >
            {t.grant}
          </Button>
        </div>
        {notice && (
          <p className={st.small} role="status" data-testid="admin-pilot-org-notice">
            {notice}
          </p>
        )}
        {error && (
          <p className={st.warn} role="alert" data-testid="admin-pilot-org-error">
            {error}
          </p>
        )}
      </td>
    </tr>
  );
}
