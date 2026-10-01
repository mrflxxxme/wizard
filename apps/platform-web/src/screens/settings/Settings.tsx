// S10 «Настройки системы» (/s/:systemId/settings, M1-11): team and invitations, «кто меняет» lock, model policy
// («только российский контур»), login methods and retention from the spec, operator of personal data (the publish
// precondition, a minimal part of M2-11's block) with the deletion journal (M2-05), revisions with prod rollback, and
// «Удалить систему» with a confirmation (M2-05, purge after 30 days). Owner-only actions are disabled for
// editor/viewer with a hint; the server answers 403 anyway (D11).
import { Button } from "@wizard/ui-kit";
import { type FormEvent, type ReactNode, useCallback, useEffect, useReducer, useRef, useState } from "react";
import { ApiError } from "../../api/client.js";
import type {
  DeletionLogEntry,
  Invite,
  LockStatus,
  Member,
  OrgRole,
  OrgSettings,
  Publication,
  Revision,
  RevisionSummary,
  RunEvent,
  SystemView,
} from "../../api/types.js";
import { canOwn, usePlatform } from "../../app/context.js";
import { navigate } from "../../app/router.js";
import { Alert, Pill } from "../../components/ui.js";
import { ru } from "../../i18n/ru.js";
import { initialRunState, type RunState, reduceRun } from "../../run/reducer.js";
import { subscribeRun } from "../../run/stream.js";
import { Rail } from "../workspace/Rail.js";
import { RunNotice } from "../workspace/RunNotice.js";
import s from "./Settings.module.css";

const ROLES: OrgRole[] = ["owner", "editor", "viewer"];

const errText = (e: unknown) => {
  if (e instanceof ApiError && e.code === "LAST_OWNER") return ru.settings.lastOwner;
  if (e instanceof ApiError && e.code === "SYSTEM_LOCKED") return ru.settings.systemLocked;
  return e instanceof Error ? e.message : ru.errors.generic;
};
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
const fmtDay = (iso: string) =>
  new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
const entityLabel = (e: DeletionLogEntry, spec: SpecLike | null | undefined) =>
  e.entity === "*"
    ? ru.settings.deletionEntityAll
    : e.entity === "users"
      ? ru.settings.deletionEntityUsers
      : (spec?.entities?.find((x) => x.name === e.entity)?.label ?? e.entity);

type RunAction = { type: "reset" } | { type: "event"; e: RunEvent };
const runReducer = (st: RunState, a: RunAction): RunState =>
  a.type === "reset" ? initialRunState() : reduceRun(st, a.e);

interface SpecLike {
  roles?: { name: string; label: string; loginMethods?: string[]; access?: string }[];
  entities?: { name: string; label: string; retention?: { deleteAfterDays: number; mode?: string } }[];
  compliance?: {
    operatorName?: string;
    operatorContact?: string;
    operatorAddress?: string;
    operatorInn?: string;
  };
}

function OwnerHint({ owner }: { owner: boolean }): ReactNode {
  return owner ? null : <p className={s.hint}>{ru.settings.ownerOnly}</p>;
}

export function Settings({ systemId }: { systemId: string }): ReactNode {
  const platform = usePlatform();
  const { api, me, roleIn } = platform;
  const [view, setView] = useState<SystemView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [lock, setLock] = useState<LockStatus | null>(null);
  const [orgSettings, setOrgSettings] = useState<OrgSettings | null>(null);
  const [revisions, setRevisions] = useState<RevisionSummary[]>([]);
  const [pubs, setPubs] = useState<Publication[]>([]);
  // Draft spec: login methods, retention and the operator of personal data.
  const [spec, setSpec] = useState<SpecLike | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<OrgRole>("editor");
  const [operator, setOperator] = useState({ name: "", contact: "", address: "", inn: "" });
  const [confirm, setConfirm] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Deletion journal (owner): newest first, «Показать ещё» follows nextCursor.
  const [journal, setJournal] = useState<DeletionLogEntry[] | null>(null);
  const [journalCursor, setJournalCursor] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [run, dispatch] = useReducer(runReducer, undefined, initialRunState);

  const orgId = view?.system.orgId;
  const role = roleIn(orgId);
  const owner = canOwn(role);

  const loadSystem = useCallback(async () => {
    const v = await api.getSystem(systemId);
    setView(v);
    return v;
  }, [api, systemId]);

  const loadHistory = useCallback(async () => {
    const [r, p] = await Promise.all([
      api.listRevisions(systemId, 50).catch(() => ({ items: [] })),
      api.listPublications(systemId).catch(() => ({ items: [] })),
    ]);
    setRevisions(r.items);
    setPubs(p.items);
  }, [api, systemId]);

  const loadTeam = useCallback(
    async (org: string, isOwner: boolean) => {
      const m = await api.listMembers(org).catch(() => ({ items: [] as Member[] }));
      setMembers(m.items);
      if (isOwner) setInvites((await api.listInvites(org).catch(() => ({ items: [] as Invite[] }))).items);
    },
    [api],
  );

  useEffect(() => {
    let live = true;
    loadSystem()
      .then(async (v) => {
        if (!live) return;
        const [st, lk, r] = await Promise.all([
          api.getOrgSettings(v.system.orgId).catch(() => null),
          api.getLock(systemId).catch(() => null),
          v.system.draftRevision > 0
            ? api.getRevision(systemId, v.system.draftRevision).catch(() => null)
            : null,
        ]);
        if (!live) return;
        setOrgSettings(st);
        setLock(lk);
        const sp = (r as Revision | null)?.spec as SpecLike | undefined;
        setSpec(sp ?? null);
        const c = sp?.compliance ?? {};
        setOperator({
          name: c.operatorName ?? "",
          contact: c.operatorContact ?? "",
          address: c.operatorAddress ?? "",
          inn: c.operatorInn ?? "",
        });
      })
      .catch(
        (e) =>
          live &&
          setLoadError(e instanceof ApiError && e.status === 404 ? ru.errors.systemNotFound : errText(e)),
      );
    void loadHistory();
    return () => {
      live = false;
    };
  }, [api, systemId, loadSystem, loadHistory]);

  useEffect(() => {
    if (orgId) void loadTeam(orgId, owner);
  }, [orgId, owner, loadTeam]);

  const loadJournal = useCallback(
    async (cursor?: string) => {
      const page = await api.listDeletionLog(systemId, cursor);
      setJournal((prev) => (cursor ? [...(prev ?? []), ...page.items] : page.items));
      setJournalCursor(page.nextCursor);
    },
    [api, systemId],
  );
  useEffect(() => {
    if (owner) void loadJournal().catch(() => setJournal([]));
  }, [owner, loadJournal]);

  // #pd from the S6 blocker link: scroll to the operator block once it is rendered.
  const scrolled = useRef(false);
  useEffect(() => {
    if (!view || scrolled.current || window.location.hash !== "#pd") return;
    scrolled.current = true;
    document.getElementById("pd")?.scrollIntoView();
  }, [view]);

  // Rollback run in this page's feed; the end re-reads prod revision and history.
  const onEvent = useCallback(
    (e: RunEvent) => {
      dispatch({ type: "event", e });
      if (e.type === "run_finished" || e.type === "run_failed") {
        void loadSystem().catch(() => {});
        void loadHistory();
      }
    },
    [loadSystem, loadHistory],
  );
  useEffect(() => {
    if (!runId) return;
    dispatch({ type: "reset" });
    return subscribeRun({ url: (after) => api.eventsUrl(runId, after), after: 0, onEvent });
  }, [api, runId, onEvent]);

  async function act(name: string, fn: () => Promise<unknown>, done?: string) {
    setBusy(name);
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (done) setNotice(done);
      return true;
    } catch (e) {
      setError(errText(e));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function invite(ev: FormEvent) {
    ev.preventDefault();
    if (!orgId) return;
    const email = inviteEmail.trim();
    const ok = await act(
      "invite",
      () => api.createInvite(orgId, { email, role: inviteRole }),
      ru.settings.invited(email),
    );
    if (ok) {
      setInviteEmail("");
      await loadTeam(orgId, owner);
    }
  }

  async function changeRole(m: Member, r: OrgRole) {
    if (!orgId) return;
    if (await act(`role:${m.userId}`, () => api.updateMemberRole(orgId, m.userId, r)))
      await loadTeam(orgId, owner);
    else await loadTeam(orgId, owner);
  }

  async function remove(m: Member) {
    if (!orgId) return;
    if (await act(`remove:${m.userId}`, () => api.removeMember(orgId, m.userId)))
      await loadTeam(orgId, owner);
  }

  async function revoke(i: Invite) {
    if (!orgId) return;
    if (await act(`revoke:${i.id}`, () => api.revokeInvite(orgId, i.id))) await loadTeam(orgId, owner);
  }

  async function releaseLock() {
    if (await act("lock", () => api.releaseLock(systemId)))
      setLock(await api.getLock(systemId).catch(() => null));
  }

  /** Optimistic switch: the box follows the click, a refusal (403 for non-owners) puts it back. */
  async function toggleRuOnly(ruOnly: boolean) {
    if (!orgId || !orgSettings) return;
    const prev = orgSettings;
    setOrgSettings({ ...prev, ruOnly });
    const ok = await act("ru", async () => {
      const next = await api.updateOrgSettings(orgId, { ruOnly });
      setOrgSettings(next);
      if (orgId === platform.orgId) platform.setSettings(next);
    });
    if (!ok) setOrgSettings(prev);
  }

  async function saveOperator(ev: FormEvent) {
    ev.preventDefault();
    if (!view) return;
    const body = {
      expectedVersion: view.system.draftRevision,
      operatorName: operator.name.trim(),
      operatorContact: operator.contact.trim(),
      ...(operator.address.trim() ? { operatorAddress: operator.address.trim() } : {}),
      ...(operator.inn.trim() ? { operatorInn: operator.inn.trim() } : {}),
    };
    if (await act("pd", () => api.setCompliance(systemId, body), ru.settings.saved)) {
      await loadSystem().catch(() => {});
      await loadHistory();
    }
  }

  async function deleteSystem() {
    setConfirmDelete(false);
    if (await act("delete", () => api.deleteSystem(systemId))) navigate("/");
  }

  async function rollback(v: number) {
    setConfirm(null);
    setBusy("rollback");
    setError(null);
    try {
      const r = await api.rollback(systemId, { env: "prod", toRevision: v });
      setRunId(r.run.id);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  }

  if (loadError)
    return (
      <div className={s.shell}>
        <Rail />
        <main className={s.page}>
          <Alert>{loadError}</Alert>
        </main>
      </div>
    );
  if (!view)
    return (
      <div className={s.shell}>
        <Rail systemId={systemId} />
        <main className={s.page} aria-busy="true">
          {ru.code.loading}
        </main>
      </div>
    );

  const system = view.system;
  const prod = system.prodRevision ?? null;
  const wasLive = new Set(
    pubs.filter((p) => p.status === "live" || p.status === "superseded").map((p) => p.revision),
  );
  const rollbackRunning = runId !== null && (run.phase === "idle" || run.phase === "running");
  const restricted = orgSettings?.t1Restricted === true;
  const loginRoles = (spec?.roles ?? []).filter(
    (r) => r.access !== "public" || (r.loginMethods?.length ?? 0) > 0,
  );
  const retention = (spec?.entities ?? []).filter((e) => e.retention);

  return (
    <div className={s.shell}>
      <Rail systemId={systemId} />
      <main className={s.page}>
        <header className={s.head}>
          <h1 className={s.title}>{ru.settings.title(system.name)}</h1>
          {prod !== null ? (
            <Pill tone="ok" title={ru.start.prodTitle} testId="settings-prod-revision">
              {ru.publish.published(prod)}
            </Pill>
          ) : (
            <Pill tone="neutral" testId="settings-prod-revision">
              {ru.settings.notPublished}
            </Pill>
          )}
          <span className={s.spacer} />
          <Button variant="secondary" size="sm" onClick={() => navigate(`/s/${systemId}`)}>
            {ru.settings.back}
          </Button>
        </header>
        {error && <Alert testId="settings-error">{error}</Alert>}
        {notice && (
          <p className={s.notice} role="status" data-testid="settings-notice">
            {notice}
          </p>
        )}
        {runId && (run.kind === "rollback" || run.phase !== "idle") && (
          <RunNotice run={{ ...run, kind: "rollback" }} />
        )}

        <div className={s.grid}>
          <section className={s.block} data-testid="settings-team" aria-labelledby="team-title">
            <h2 id="team-title" className={s.blockTitle}>
              {ru.settings.team}
            </h2>
            <ul className={s.list}>
              {members.map((m) => {
                const who = m.name || m.email;
                const self = m.userId === me?.user.id;
                return (
                  <li key={m.userId} className={s.member} data-testid="settings-member" data-role={m.role}>
                    <span className={s.memberName}>
                      {who}
                      {self && <span className={s.muted}> ({ru.settings.you})</span>}
                    </span>
                    {owner ? (
                      <select
                        aria-label={ru.settings.roleLabel(who)}
                        value={m.role}
                        disabled={busy !== null}
                        onChange={(e) => void changeRole(m, e.target.value as OrgRole)}
                        data-testid="settings-member-role"
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {ru.settings.roleHint[r]}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className={s.muted}>{ru.settings.roleHint[m.role] ?? m.role}</span>
                    )}
                    {owner && !self && (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={ru.settings.removeLabel(who)}
                        disabled={busy !== null}
                        onClick={() => void remove(m)}
                      >
                        {ru.settings.remove}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
            <div className={s.lockRow}>
              <p className={s.small} data-testid="settings-lock" data-held={lock?.held === true}>
                {lock?.held && lock.holder ? ru.settings.lockHeld(lock.holder.name) : ru.settings.lockFree}
              </p>
              {lock?.held && (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!owner || busy !== null}
                  title={owner ? undefined : ru.settings.ownerOnly}
                  onClick={() => void releaseLock()}
                  data-testid="settings-lock-release"
                >
                  {ru.settings.lockRelease}
                </Button>
              )}
            </div>
            <form className={s.inviteForm} onSubmit={(e) => void invite(e)} aria-label={ru.settings.invite}>
              <label className={s.field}>
                <span>{ru.settings.inviteEmail}</span>
                <input
                  type="email"
                  required
                  value={inviteEmail}
                  disabled={!owner}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  data-testid="settings-invite-email"
                />
              </label>
              <label className={s.field}>
                <span>{ru.settings.inviteRole}</span>
                <select
                  value={inviteRole}
                  disabled={!owner}
                  onChange={(e) => setInviteRole(e.target.value as OrgRole)}
                  data-testid="settings-invite-role"
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ru.settings.roleHint[r]}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={!owner || !inviteEmail.trim() || busy !== null}
                loading={busy === "invite"}
                title={owner ? undefined : ru.settings.ownerOnly}
                data-testid="settings-invite"
              >
                {ru.settings.invite}
              </Button>
            </form>
            <OwnerHint owner={owner} />
            {owner && invites.length > 0 && (
              <div className={s.sub}>
                <h3 className={s.subTitle}>{ru.settings.invites}</h3>
                <ul className={s.list}>
                  {invites.map((i) => (
                    <li key={i.id} className={s.member} data-testid="settings-invite-row">
                      <span className={s.memberName}>{i.email}</span>
                      <span className={s.muted}>
                        {ru.settings.roleHint[i.role]} · {ru.settings.until(fmtDate(i.expiresAt))}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy !== null}
                        onClick={() => void revoke(i)}
                      >
                        {ru.settings.revoke}
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          <section className={s.block} aria-labelledby="models-title">
            <h2 id="models-title" className={s.blockTitle}>
              {ru.settings.models}
            </h2>
            <p className={s.small}>{ru.settings.build(orgSettings?.buildModelLabel)}</p>
            <p className={s.small}>{ru.settings.liveData}</p>
            {restricted ? (
              <p className={s.small} data-testid="settings-ru-only" data-restricted="true">
                {ru.settings.restricted}
              </p>
            ) : (
              <label className={s.check} title={owner ? ru.settings.ruOnlyHint : ru.settings.ownerOnly}>
                <input
                  type="checkbox"
                  role="switch"
                  aria-checked={orgSettings?.ruOnly === true}
                  checked={orgSettings?.ruOnly === true}
                  disabled={!owner || !orgSettings || busy !== null}
                  onChange={(e) => void toggleRuOnly(e.target.checked)}
                  data-testid="settings-ru-only"
                />
                <span>{ru.settings.ruOnly}</span>
              </label>
            )}
            {!restricted && <OwnerHint owner={owner} />}
          </section>

          <section className={s.block} aria-labelledby="data-title">
            <h2 id="data-title" className={s.blockTitle}>
              {ru.settings.data}
            </h2>
            <div data-testid="settings-login-methods">
              <h3 className={s.subTitle}>{ru.settings.loginMethods}</h3>
              <ul className={s.list}>
                {loginRoles.map((r) => (
                  <li key={r.name} className={s.small}>
                    <b>{r.label}</b>:{" "}
                    {(r.loginMethods ?? []).length > 0
                      ? (r.loginMethods ?? []).map((m) => ru.settings.loginMethod[m] ?? m).join(" · ")
                      : ru.settings.noLogin}
                    {(r.loginMethods ?? []).includes("phone_otp") && (
                      <span className={s.warn}> — {ru.settings.phonePlan}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
            <div data-testid="settings-retention">
              <p className={s.small}>{ru.settings.storage}</p>
              {retention.length === 0 ? (
                <p className={s.small}>{ru.settings.noRetention}</p>
              ) : (
                <ul className={s.list}>
                  {retention.map((e) => (
                    <li key={e.name} className={s.small}>
                      {ru.settings.retention(
                        e.label,
                        e.retention?.deleteAfterDays ?? 0,
                        e.retention?.mode === "anonymize",
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <a
              href={`/s/${systemId}/code`}
              className={s.link}
              data-testid="settings-code"
              onClick={(e) => {
                e.preventDefault();
                navigate(`/s/${systemId}/code`);
              }}
            >
              {ru.settings.code}
            </a>
          </section>

          <section className={s.block} id="pd" aria-labelledby="pd-title">
            <h2 id="pd-title" className={s.blockTitle}>
              {ru.settings.pd}
            </h2>
            <form
              className={s.form}
              onSubmit={(e) => void saveOperator(e)}
              data-testid="settings-pd-operator"
            >
              <fieldset className={s.fieldset} disabled={!owner || busy !== null || spec === undefined}>
                <label className={s.field}>
                  <span>{ru.settings.operatorName}</span>
                  <input
                    required
                    minLength={3}
                    maxLength={300}
                    value={operator.name}
                    onChange={(e) => setOperator({ ...operator, name: e.target.value })}
                    data-testid="settings-pd-name"
                  />
                </label>
                <label className={s.field}>
                  <span>{ru.settings.operatorContact}</span>
                  <input
                    type="email"
                    required
                    value={operator.contact}
                    onChange={(e) => setOperator({ ...operator, contact: e.target.value })}
                    data-testid="settings-pd-contact"
                  />
                </label>
                <label className={s.field}>
                  <span>{ru.settings.operatorAddress}</span>
                  <input
                    maxLength={300}
                    value={operator.address}
                    onChange={(e) => setOperator({ ...operator, address: e.target.value })}
                    data-testid="settings-pd-address"
                  />
                </label>
                <label className={s.field}>
                  <span>{ru.settings.operatorInn}</span>
                  <input
                    inputMode="numeric"
                    pattern="[0-9]{10}([0-9]{2})?"
                    value={operator.inn}
                    onChange={(e) => setOperator({ ...operator, inn: e.target.value })}
                    data-testid="settings-pd-inn"
                  />
                </label>
              </fieldset>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={!owner || busy !== null || spec === undefined}
                loading={busy === "pd"}
                data-testid="settings-pd-save"
              >
                {ru.settings.save}
              </Button>
              <OwnerHint owner={owner} />
            </form>
            <div className={s.sub} data-testid="settings-deletion-log">
              <h3 className={s.subTitle}>{ru.settings.deletionLog}</h3>
              <p className={s.hint}>{ru.settings.deletionLogHint}</p>
              {!owner ? (
                <OwnerHint owner={owner} />
              ) : journal === null ? (
                <p className={s.small}>{ru.code.loading}</p>
              ) : journal.length === 0 ? (
                <p className={s.small} data-testid="settings-deletion-empty">
                  {ru.settings.deletionLogEmpty}
                </p>
              ) : (
                <ul className={s.list}>
                  {journal.map((e) => (
                    <li
                      key={`${e.createdAt}|${e.env}|${e.entity}|${e.mode}`}
                      className={s.logRow}
                      data-testid="settings-deletion-row"
                      data-mode={e.mode}
                      data-env={e.env}
                    >
                      <span className={s.muted}>{fmtTime(e.createdAt)}</span>
                      <b>{entityLabel(e, spec)}</b>
                      <span>{ru.settings.deletionMode[e.mode] ?? e.mode}</span>
                      <span>{ru.settings.deletionRows(e.rowsAffected)}</span>
                      {e.cutoff && (
                        <span className={s.muted}>{ru.settings.deletionCutoff(fmtDay(e.cutoff))}</span>
                      )}
                      <span className={s.muted}>{ru.settings.deletionEnv[e.env] ?? e.env}</span>
                    </li>
                  ))}
                </ul>
              )}
              {owner && journalCursor && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void loadJournal(journalCursor).catch(() => {})}
                  data-testid="settings-deletion-more"
                >
                  {ru.settings.deletionLogMore}
                </Button>
              )}
            </div>
          </section>

          <section className={`${s.block} ${s.wide}`} aria-labelledby="rev-title">
            <h2 id="rev-title" className={s.blockTitle}>
              {ru.settings.revisions}
            </h2>
            <ul className={s.list}>
              {revisions.map((r) => (
                <li
                  key={r.version}
                  className={s.revision}
                  data-testid="revision-row"
                  data-version={r.version}
                >
                  <span className={s.revNum}>{ru.settings.revision(r.version)}</span>
                  <span className={s.revText} title={r.summary_ru}>
                    {r.summary_ru ?? ""}
                  </span>
                  {r.version === prod && (
                    <Pill tone="ok" testId="revision-prod" title={ru.start.prodTitle}>
                      {ru.settings.prod}
                    </Pill>
                  )}
                  {wasLive.has(r.version) && r.version !== prod && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={!owner || busy !== null || rollbackRunning}
                      title={owner ? undefined : ru.settings.ownerOnly}
                      onClick={() => setConfirm(r.version)}
                      data-testid="revision-rollback"
                    >
                      {ru.settings.rollback}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </section>

          <section className={`${s.block} ${s.wide} ${s.danger}`} aria-labelledby="danger-title">
            <h2 id="danger-title" className={s.blockTitle}>
              {ru.settings.danger}
            </h2>
            <p className={s.small}>{ru.settings.dangerHint}</p>
            <div>
              <Button
                variant="danger"
                size="sm"
                disabled={!owner || busy !== null}
                loading={busy === "delete"}
                title={owner ? undefined : ru.settings.ownerOnly}
                onClick={() => setConfirmDelete(true)}
                data-testid="settings-delete-system"
              >
                {ru.settings.deleteSystem}
              </Button>
            </div>
            <OwnerHint owner={owner} />
          </section>
        </div>
      </main>
      {confirm !== null && (
        <ConfirmDialog
          text={ru.settings.rollbackConfirm(confirm)}
          yes={ru.settings.rollbackYes}
          no={ru.settings.rollbackNo}
          onYes={() => void rollback(confirm)}
          onNo={() => setConfirm(null)}
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          text={ru.settings.deleteConfirm(system.name)}
          yes={ru.settings.deleteYes}
          no={ru.settings.rollbackNo}
          danger
          testId="settings-delete"
          onYes={() => void deleteSystem()}
          onNo={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
}

/**
 * Modal confirmation: focus on the confirm button (on «Отмена» for a destructive one), Esc cancels, focus returns to
 * the page on close. Test ids: <testId>-confirm, -yes, -no.
 */
function ConfirmDialog({
  text,
  yes,
  no,
  onYes,
  onNo,
  danger = false,
  testId = "rollback",
}: {
  text: string;
  yes: string;
  no: string;
  onYes(): void;
  onNo(): void;
  danger?: boolean;
  testId?: string;
}): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null);
  const cancel = useRef(onNo);
  cancel.current = onNo;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLButtonElement>("[data-autofocus]")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus();
    };
  }, []);
  return (
    <div className={s.backdrop}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-text"
        className={s.dialog}
        data-testid={`${testId}-confirm`}
      >
        <p id="confirm-text" className={s.dialogText}>
          {text}
        </p>
        <div className={s.row}>
          <Button
            variant="secondary"
            onClick={onNo}
            {...(danger ? { "data-autofocus": "" } : {})}
            data-testid={`${testId}-no`}
          >
            {no}
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            onClick={onYes}
            {...(danger ? {} : { "data-autofocus": "" })}
            data-testid={`${testId}-yes`}
          >
            {yes}
          </Button>
        </div>
      </div>
    </div>
  );
}
