// /admin «Кандидаты в модули» (B2-26 module factory, platform-screens.yaml#S-admin candidates): the weekly rating of
// «Запросы на развитие» and successful custom parts by frequency, a filter by status, «Пересчитать сейчас», and the
// candidate card — quotes (already without personal data, rendered as text), linked requests with their systems, the
// catalog module to link, and the founder's decisions «Одобрить в работу» / «Выключить» / «Модуль готов» (the last one
// needs a module and a second press: requests become «done», clients who agreed get «Теперь умеем»).
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { ApiError } from "../../api/client.js";
import type {
  CandidateFilter,
  CatalogModuleRef,
  ModuleCandidate,
  ModuleCandidateCard,
  ModuleCandidates,
} from "../../api/types.js";
import { usePlatform } from "../../app/context.js";
import { Alert, Pill, type Tone } from "../../components/ui.js";
import { Button } from "../../components/v2/Button.js";
import { factory as t } from "../../i18n/ru/factory.js";
import { gaps } from "../../i18n/ru/gaps.js";
import { ru } from "../../i18n/ru.js";
import f from "../../screens/abuse/Abuse.module.css";
import s from "../../screens/admin/Admin.module.css";
import st from "../../screens/settings/Settings.module.css";

const FILTERS: CandidateFilter[] = ["open", "new", "approved", "disabled", "ready", "all"];
const TONE: Record<ModuleCandidate["status"], Tone> = {
  new: "warn",
  approved: "accent",
  disabled: "neutral",
  ready: "ok",
};
const fmt = (iso: string) =>
  new Date(iso).toLocaleString("ru-RU", {
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow",
  });
const isMfa = (e: unknown) => e instanceof ApiError && e.code === "MFA_REQUIRED";
const errText = (e: unknown) => (e instanceof Error ? e.message : ru.errors.generic);
const label = (c: string) => gaps.category[c] ?? c;

export function AdminCandidates({ onMfaRequired }: { onMfaRequired(): void }): ReactNode {
  const { api } = usePlatform();
  const [filter, setFilter] = useState<CandidateFilter>("open");
  const [data, setData] = useState<ModuleCandidates | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fail = useCallback(
    (e: unknown) => {
      if (isMfa(e)) onMfaRequired();
      else setError(errText(e));
    },
    [onMfaRequired],
  );
  const load = useCallback(async () => {
    try {
      setData(await api.adminModuleCandidates(filter));
      setError(null);
    } catch (e) {
      fail(e);
    }
  }, [api, filter, fail]);
  useEffect(() => {
    void load();
  }, [load]);

  async function recompute() {
    setBusy(true);
    setNotice(null);
    try {
      const r = await api.adminRecomputeModuleCandidates();
      setNotice(t.recomputed(r.candidates, r.sent));
      await load();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  if (open && data)
    return (
      <CandidateCard
        id={open}
        modules={data.modules}
        onBack={() => {
          setOpen(null);
          void load();
        }}
        fail={fail}
      />
    );

  return (
    <section className={st.block} data-testid="admin-candidates">
      <div className={st.head}>
        <h2 className={st.blockTitle}>{t.tab}</h2>
        <span className={st.spacer} />
        <select
          className={f.control}
          style={{ width: "auto" }}
          value={filter}
          onChange={(e) => setFilter(e.target.value as CandidateFilter)}
          aria-label={t.filter}
          data-testid="admin-candidates-filter"
        >
          {FILTERS.map((x) => (
            <option key={x} value={x}>
              {t.filters[x]}
            </option>
          ))}
        </select>
      </div>
      <p className={st.hint}>{t.lead}</p>
      <div className={s.actions}>
        <span className={st.small} data-testid="admin-candidates-computed">
          {data?.computedAt ? t.computed(fmt(data.computedAt)) : t.never}
        </span>
        <Button
          size="sm"
          loading={busy}
          onClick={() => void recompute()}
          data-testid="admin-candidates-recompute"
        >
          {t.recompute}
        </Button>
      </div>
      {notice && (
        <p className={st.notice} role="status" data-testid="admin-candidates-notice">
          {notice}
        </p>
      )}
      {error && <Alert testId="admin-candidates-error">{error}</Alert>}
      {data && data.items.length === 0 && (
        <p className={st.muted} data-testid="admin-candidates-empty">
          {t.empty}
        </p>
      )}
      {data && data.items.length > 0 && (
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th>{t.colRank}</th>
                <th>{t.colTitle}</th>
                <th>{t.colCategory}</th>
                <th>{t.colWeek}</th>
                <th>{t.colTotal}</th>
                <th>{t.colSystems}</th>
                <th>{t.colClients}</th>
                <th>{t.colStatus}</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((c) => (
                <tr key={c.id} data-testid="admin-candidate-row" data-id={c.id} data-status={c.status}>
                  <td>{c.rank ?? "—"}</td>
                  <td>
                    <button
                      type="button"
                      className={st.link}
                      onClick={() => setOpen(c.id)}
                      data-testid="admin-candidate-open"
                    >
                      {c.title}
                    </button>
                    {c.moduleName && <div className={st.small}>{t.moduleLinked(c.moduleName)}</div>}
                  </td>
                  <td>{label(c.category)}</td>
                  <td>{t.week(c.weekRequests, c.weekCustom)}</td>
                  <td>{c.totalRequests + c.totalCustom}</td>
                  <td>{c.systems}</td>
                  <td>{c.clients}</td>
                  <td>
                    <Pill tone={TONE[c.status]}>{t.status[c.status]}</Pill>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function CandidateCard({
  id,
  modules,
  onBack,
  fail,
}: {
  id: string;
  modules: CatalogModuleRef[];
  onBack(): void;
  fail(e: unknown): void;
}): ReactNode {
  const { api } = usePlatform();
  const [card, setCard] = useState<ModuleCandidateCard | null>(null);
  const [moduleId, setModuleId] = useState("");
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .adminModuleCandidate(id)
      .then((c) => {
        if (!live) return;
        setCard(c);
        setModuleId(c.candidate.moduleId ?? "");
        setNote(c.candidate.note ?? "");
      })
      .catch((e: unknown) => live && fail(e));
    return () => {
      live = false;
    };
  }, [api, id, fail]);

  async function decide(action: "approve" | "disable" | "ready") {
    setError(null);
    setNotice(null);
    if (action === "ready") {
      if (!moduleId) return setError(t.readyNeedsModule);
      if (!confirming) return setConfirming(true);
    }
    setBusy(action);
    try {
      const r = await api.adminDecideModuleCandidate(id, {
        action,
        ...(moduleId ? { moduleId } : {}),
        note,
      });
      setConfirming(false);
      setNotice(
        r.announced ? t.announced(r.announced.done, r.announced.sent, r.announced.noConsent) : t.saved,
      );
      setCard(await api.adminModuleCandidate(id));
    } catch (e) {
      if (isMfa(e)) fail(e);
      else setError(errText(e));
    } finally {
      setBusy(null);
    }
  }

  if (!card) return <p className={st.muted}>{ru.admin.loading}</p>;
  const c = card.candidate;
  const final = c.status === "ready";
  return (
    <section className={st.block} data-testid="admin-candidate-card" data-status={c.status}>
      <div className={st.head}>
        <button type="button" className={st.link} onClick={onBack} data-testid="admin-candidate-back">
          ← {t.back}
        </button>
      </div>
      <div className={st.head}>
        <h2 className={st.blockTitle} data-testid="admin-candidate-title">
          {c.title}
        </h2>
        <span className={st.spacer} />
        <Pill tone={TONE[c.status]} testId="admin-candidate-status">
          {t.status[c.status]}
        </Pill>
      </div>
      <p className={st.small} data-testid="admin-candidate-counts">
        {label(c.category)} ·{" "}
        {t.counts(c.weekRequests + c.weekCustom, c.totalRequests + c.totalCustom, c.systems, c.clients)}
      </p>
      {c.suggested && !c.moduleId && (
        <p className={st.small} data-testid="admin-candidate-suggested">
          {t.suggested(c.suggested.name, c.suggested.status === "ready")}
        </p>
      )}
      {c.examples.length > 0 && (
        <>
          <h3 className={st.subTitle}>{t.examplesTitle}</h3>
          <ul className={st.list}>
            {c.examples.map((x) => (
              <li key={x.quote} data-testid="admin-candidate-example" data-source={x.source}>
                «{x.quote}»{" "}
                <span className={st.small}>— {x.source === "custom" ? t.sourceCustom : t.sourceRequest}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {final ? (
        <p className={st.small} data-testid="admin-candidate-final">
          {c.moduleName ? `${t.moduleLinked(c.moduleName)}. ` : ""}
          {t.readyFinal} {t.notified(card.notified)}
        </p>
      ) : (
        <div className={st.form}>
          <label className={st.field}>
            {t.module}
            <select
              className={f.control}
              value={moduleId}
              onChange={(e) => {
                setModuleId(e.target.value);
                setConfirming(false);
              }}
              data-testid="admin-candidate-module"
            >
              <option value="">{t.moduleNone}</option>
              {modules.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} — {m.available ? t.moduleReady : t.moduleSoon}
                </option>
              ))}
            </select>
          </label>
          <label className={st.field}>
            {t.note}
            <textarea
              className={f.control}
              value={note}
              maxLength={500}
              onChange={(e) => setNote(e.target.value)}
              data-testid="admin-candidate-note"
            />
          </label>
          {confirming && (
            <p className={st.warn} role="alert" data-testid="admin-candidate-ready-confirm">
              {t.readyConfirm}
            </p>
          )}
          {error && <Alert testId="admin-candidate-error">{error}</Alert>}
          <div className={s.actions}>
            {c.status !== "approved" && (
              <Button
                variant="primary"
                loading={busy === "approve"}
                disabled={busy !== null}
                onClick={() => void decide("approve")}
                data-testid="admin-candidate-approve"
              >
                {t.approve}
              </Button>
            )}
            <Button
              variant="create"
              loading={busy === "ready"}
              disabled={busy !== null}
              onClick={() => void decide("ready")}
              data-testid="admin-candidate-ready"
            >
              {t.ready}
            </Button>
            {c.status !== "disabled" && (
              <Button
                variant="ghost"
                loading={busy === "disable"}
                disabled={busy !== null}
                onClick={() => void decide("disable")}
                data-testid="admin-candidate-disable"
              >
                {t.disable}
              </Button>
            )}
          </div>
        </div>
      )}
      {notice && (
        <p className={st.notice} role="status" data-testid="admin-candidate-notice">
          {notice}
        </p>
      )}
      <h3 className={st.subTitle}>{t.requestsTitle}</h3>
      <ul className={st.list}>
        {card.requests.map((r) => (
          <li key={r.id} data-testid="admin-candidate-request" data-status={r.status}>
            <span className={st.small}>
              {fmt(r.createdAt)} ·{" "}
              {r.systemId ? (
                <a href={`/s/${r.systemId}`} target="_blank" rel="noopener noreferrer">
                  {r.systemName ?? r.systemId}
                </a>
              ) : (
                t.noSystem
              )}{" "}
              ·{" "}
              <Pill tone={r.status === "done" ? "ok" : "neutral"}>
                {r.status === "done" ? t.requestDone : t.requestOpen}
              </Pill>
            </span>
            <br />
            <span data-testid="admin-candidate-request-quote">{r.quote}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
