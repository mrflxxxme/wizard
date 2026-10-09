// «Опубликовать» of a v3 system on the canvas (V3-19; platform-screens.yaml#S-canvas v3_publish): once the system is
// built (stage ready) the chat shows what stops the publication in words (GET /systems/:id publishBlockers), the
// owner's data of the personal data operator right here (PUT /systems/:id/compliance, as S10 «Персональные данные»
// saves it) with the link to the settings, «Опубликовать» (POST /systems/:id/publish) on when nothing stops it, the
// publish run as it goes and its result, then the published site and the owner's cabinet. The UI is not the
// protection (D8, D11): the server's refusals are shown in its words.
import { ActionButton } from "@wizard/ui-kit/v2";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { ApiError } from "../../../api/client.js";
import type { GateReport, RevisionSummary, Run, SystemView } from "../../../api/types.js";
import { usePlatform } from "../../../app/context.js";
import { AppLink } from "../../../components/v2/Shell.js";
import { previewSrc } from "../../../preview/bridge.js";
import type { RunState } from "../../../run/reducer.js";
import { publishTarget } from "../../workspace/GateReport.js";
import {
  CABINET_PATH,
  emailOk,
  innShapeOk,
  OWNER_ROLE,
  ownerCabinetUrl,
  runInFlight,
  v3PublishModel,
} from "./model.js";
import s from "./PublishCard.module.css";
import { publishRu as T } from "./ru.js";

/** A refusal in words: the server's message_ru, a lost connection, or the generic text. */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.status === 0 ? T.network : e.message;
  return e instanceof Error && e.message ? e.message : T.generic;
}

/** A call of an optional API method (a test double may not have it): its failure is the fallback. */
async function attempt<R>(fn: () => Promise<R>, fallback: R): Promise<R> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

interface Operator {
  name: string;
  contact: string;
  address: string;
  inn: string;
}

/** The operator's data typed by the owner, checked before the request (Russian text) or null when it is fine. */
export function operatorProblem(o: Operator, need: { address: boolean }): string | null {
  if (o.name.trim().length < 3) return T.operator.nameShort;
  if (!emailOk(o.contact.trim())) return T.operator.contactBad;
  if (need.address && !o.address.trim()) return T.operator.addressNeeded;
  if (o.inn.trim() && !innShapeOk(o.inn.trim())) return T.operator.innBad;
  return null;
}

/** The owner's data of the personal data operator in the chat (S10 «Персональные данные» keeps the rest). */
function OperatorForm({
  systemId,
  draftRevision,
  address,
  inn,
  onSaved,
}: {
  systemId: string;
  draftRevision: number;
  address: boolean;
  inn: boolean;
  onSaved(): void;
}): ReactNode {
  const { api } = usePlatform();
  const [o, setO] = useState<Operator>({ name: "", contact: "", address: "", inn: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // What the draft already has (the owner may have filled a part in the settings) — once per form.
  // biome-ignore lint/correctness/useExhaustiveDependencies: prefilled once, typing is not overwritten
  useEffect(() => {
    if (draftRevision < 1) return;
    let live = true;
    void attempt(() => api.getRevision(systemId, draftRevision), null).then((r) => {
      const c = (r?.spec as { compliance?: Record<string, unknown> } | undefined)?.compliance ?? {};
      const str = (v: unknown) => (typeof v === "string" ? v : "");
      if (live)
        setO((cur) => ({
          name: cur.name || str(c.operatorName),
          contact: cur.contact || str(c.operatorContact),
          address: cur.address || str(c.operatorAddress),
          inn: cur.inn || str(c.operatorInn),
        }));
    });
    return () => {
      live = false;
    };
  }, [api, systemId]);

  async function save(ev: FormEvent) {
    ev.preventDefault();
    const problem = operatorProblem(o, { address });
    setSaved(false);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      await api.setCompliance(systemId, {
        expectedVersion: draftRevision,
        operatorName: o.name.trim(),
        operatorContact: o.contact.trim(),
        ...(o.address.trim() ? { operatorAddress: o.address.trim() } : {}),
        ...(o.inn.trim() ? { operatorInn: o.inn.trim() } : {}),
      });
      setSaved(true);
      onSaved();
    } catch (e) {
      const stale = e instanceof ApiError && (e.status === 412 || e.code === "VERSION_CONFLICT");
      setError(stale ? T.operator.stale : errorText(e));
      if (stale) onSaved();
    } finally {
      setBusy(false);
    }
  }

  const field = (key: keyof Operator, label: string, extra: Record<string, unknown> = {}) => (
    <label className={s.field}>
      <span className={s.label}>{label}</span>
      <input
        className={s.input}
        value={o[key]}
        onChange={(e) => setO({ ...o, [key]: e.target.value })}
        disabled={busy}
        data-testid={`canvas-v3-operator-${key}`}
        {...extra}
      />
    </label>
  );

  return (
    <form
      className={s.operator}
      noValidate
      aria-labelledby="canvas-v3-operator-title"
      data-testid="canvas-v3-operator"
      onSubmit={(e) => void save(e)}
    >
      <p id="canvas-v3-operator-title" className={s.subTitle}>
        {T.operator.title}
      </p>
      <p className={s.note}>{T.operator.why}</p>
      {field("name", T.operator.name, { maxLength: 300, autoComplete: "organization" })}
      {field("contact", T.operator.contact, { type: "email", inputMode: "email", autoComplete: "email" })}
      {field("address", T.operator.address, { maxLength: 300, autoComplete: "street-address" })}
      {inn && field("inn", T.operator.inn, { inputMode: "numeric", maxLength: 12 })}
      <div className={s.row}>
        <ActionButton
          type="submit"
          variant="primary"
          size="sm"
          testId="canvas-v3-operator-save"
          busy={busy}
          disabled={busy}
        >
          {busy ? T.operator.saving : T.operator.save}
        </ActionButton>
        <AppLink to={`/s/${systemId}/settings#pd`} className={s.link} testId="canvas-v3-operator-settings">
          {T.operator.more}
        </AppLink>
      </div>
      {saved && !error && (
        <p className={s.ok} role="status" data-testid="canvas-v3-operator-saved">
          {T.operator.saved}
        </p>
      )}
      {error && (
        <p className={s.error} role="alert" data-testid="canvas-v3-operator-error">
          {error}
        </p>
      )}
    </form>
  );
}

export interface V3PublishCardProps {
  systemId: string;
  /** GET /systems/:id the canvas holds (publishBlockers, revisions, prod address). */
  view: SystemView;
  /** The publish run the canvas follows (publishRunState of its events), null — none. */
  run: RunState | null;
  /** The publication started: the canvas follows its run. */
  onStarted(run: Run): void;
  /** The system changed (the operator's data saved): the canvas re-reads it. */
  onChanged(): void;
  /** The canvas live region. */
  announce?(text: string): void;
  /** V3-18: checks did not pass — «Исправить» repeats the build by the brief (POST /systems/:id/fix); absent — no button. */
  onFix?(): void;
  /** The fix build is being started. */
  fixing?: boolean;
}

/** The chat card of a built v3 system: what stops the publication, the owner's data, «Опубликовать» and its result. */
export function V3PublishCard({
  systemId,
  view,
  run,
  onStarted,
  onChanged,
  announce,
  onFix,
  fixing = false,
}: V3PublishCardProps): ReactNode {
  const { api } = usePlatform();
  const sys = view.system;
  const codes = view.publishBlockers ?? [];
  const techreview = view.techreviewBlockers ?? [];
  const [reports, setReports] = useState<GateReport[]>([]);
  const [latest, setLatest] = useState<RevisionSummary | undefined>();
  const [busy, setBusy] = useState<"publish" | "cabinet" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = runInFlight(run);

  // The latest revision (what «Опубликовать» publishes) and the gate reports — re-read when the system changes.
  const key = `${sys.draftRevision}:${sys.previewRevision ?? ""}:${sys.prodRevision ?? ""}:${codes.join()}:${run?.phase ?? ""}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: key is the re-read trigger
  useEffect(() => {
    let live = true;
    void Promise.all([
      attempt(async () => (await api.getLatestGates(systemId)).reports, [] as GateReport[]),
      attempt(async () => (await api.listRevisions(systemId, 1)).items[0], undefined),
    ]).then(([g, l]) => {
      if (!live) return;
      setReports(g);
      setLatest(l);
    });
    return () => {
      live = false;
    };
  }, [api, systemId, key]);

  const target = publishTarget(latest, sys.previewRevision ?? null);
  const prodRevision = sys.prodRevision ?? null;
  const m = v3PublishModel({ codes, reports, target, prodRevision, running });
  const prodUrl = prodRevision !== null ? (sys.prodUrl ?? null) : null;
  const cabinet = prodUrl ? ownerCabinetUrl(prodUrl) : null;

  async function publish() {
    if (target === null) return;
    setBusy("publish");
    setError(null);
    try {
      const r = await api.publish(systemId, target);
      announce?.(T.started);
      onStarted(r.run);
    } catch (e) {
      setError(errorText(e));
      // A refusal may mean the system changed meanwhile (blockers, a new revision): the canvas re-reads it.
      onChanged();
    } finally {
      setBusy(null);
    }
  }

  /** The cabinet in the draft: a one-time preview sign-in as the owner, opened in a new tab. */
  async function draftCabinet() {
    setBusy("cabinet");
    setError(null);
    const w = window.open("", "_blank");
    try {
      const i = await api.getPreviewUrl(systemId, OWNER_ROLE);
      const src = previewSrc(i.url, CABINET_PATH, i.revision);
      if (!w) return setError(T.popupBlocked);
      w.opener = null;
      w.location.href = src;
    } catch (e) {
      w?.close();
      setError(e instanceof ApiError && e.status === 422 ? T.noCabinet : errorText(e));
    } finally {
      setBusy(null);
    }
  }

  const step = run ? [...run.steps].reverse().find((x) => x.status === "running")?.title : undefined;
  const showOperator = m.operator && m.owner && !running;
  const nothingToDo = m.upToDate && !running;

  return (
    <section className={s.card} aria-label={T.title} data-testid="canvas-v3-publish">
      <div className={s.head}>
        <p className={s.title}>{T.title}</p>
        {prodRevision !== null && (
          <span className={s.pill} data-testid="canvas-v3-publish-prod">
            {T.published(prodRevision)}
          </span>
        )}
      </div>
      {prodRevision === null && !running && <p className={s.note}>{T.lead}</p>}

      {!m.owner && (
        <p className={s.note} data-testid="canvas-v3-publish-owner-only">
          {T.ownerOnly}
        </p>
      )}

      {m.blockers.length > 0 && !running && (
        <div className={s.blockers}>
          <p className={s.subTitle}>{T.before}</p>
          <ul className={s.list}>
            {m.blockers.map((b) => (
              <li key={b} data-testid="canvas-v3-publish-blocker">
                {b}
              </li>
            ))}
          </ul>
          {m.gates && techreview.length > 0 && (
            <ul className={s.list} data-testid="canvas-v3-publish-techreview">
              {techreview.map((b) => (
                <li key={b}>{T.techreview(b)}</li>
              ))}
            </ul>
          )}
          {m.gates && <p className={s.note}>{onFix ? T.gatesFix : T.gates}</p>}
          {m.gates && onFix && (
            <ActionButton
              variant="primary"
              size="sm"
              testId="canvas-v3-publish-fix"
              busy={fixing}
              disabled={fixing || busy !== null}
              onClick={onFix}
            >
              {fixing ? T.fixing : T.fix}
            </ActionButton>
          )}
          {m.review && (
            <p className={s.note} data-testid="canvas-v3-publish-review">
              {T.review}
            </p>
          )}
          {m.billing && (
            <AppLink to="/billing" className={s.link} testId="canvas-v3-publish-billing">
              {m.card ? T.bindCard : T.billing}
            </AppLink>
          )}
        </div>
      )}

      {showOperator && (
        <OperatorForm
          key={sys.draftRevision}
          systemId={systemId}
          draftRevision={sys.draftRevision}
          address={m.address}
          inn={m.inn}
          onSaved={onChanged}
        />
      )}

      {running && (
        <p className={s.progress} aria-busy="true" data-testid="canvas-v3-publish-progress">
          <span className={s.spark} aria-hidden="true" />
          {step ? T.runningStep(step) : T.running}
        </p>
      )}
      {run?.phase === "finished" && (
        <p className={s.ok} role="status" data-testid="canvas-v3-publish-result">
          {T.done}
          {run.finished?.summary_ru ? ` · ${run.finished.summary_ru}` : ""}
        </p>
      )}
      {run?.phase === "failed" && (
        <p className={s.error} role="alert" data-testid="canvas-v3-publish-failed">
          {T.failed}: {run.failure?.message_ru || T.generic}
        </p>
      )}

      {prodUrl && (
        <div className={s.links}>
          <a
            className={s.linkBtn}
            href={prodUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="canvas-v3-publish-site"
          >
            {T.openSite}
          </a>
          {cabinet && (
            <a
              className={s.linkBtn}
              href={cabinet}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="canvas-v3-publish-cabinet"
            >
              {T.openCabinet}
            </a>
          )}
          <p className={s.note}>{T.cabinetHint}</p>
        </div>
      )}
      {nothingToDo && (
        <p className={s.note} data-testid="canvas-v3-publish-uptodate">
          {T.upToDate}
        </p>
      )}

      <div className={s.row}>
        {m.owner && !nothingToDo && (
          <ActionButton
            variant="create"
            testId="canvas-v3-publish-submit"
            busy={busy === "publish" || running}
            disabled={!m.canPublish || busy !== null}
            onClick={() => void publish()}
          >
            {busy === "publish"
              ? T.starting
              : prodRevision !== null && target !== null
                ? T.submitRevision(target)
                : T.submit}
          </ActionButton>
        )}
        {prodRevision === null && sys.previewRevision != null && (
          <ActionButton
            size="sm"
            variant="ghost"
            testId="canvas-v3-publish-draft-cabinet"
            title={T.draftCabinetHint}
            disabled={busy !== null}
            onClick={() => void draftCabinet()}
          >
            {T.draftCabinet}
          </ActionButton>
        )}
        <AppLink to={`/s/${systemId}/settings`} className={s.link} testId="canvas-v3-publish-settings">
          {T.settings}
        </AppLink>
      </div>
      {error && (
        <p className={s.error} role="alert" data-testid="canvas-v3-publish-error">
          {error}
        </p>
      )}
    </section>
  );
}
