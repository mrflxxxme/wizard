// «Свои ключи моделей» (V3-33, security/data-boundary.yaml#byok) — an org block of S10 «Настройки». Hidden while the
// feature is off for the org (GET /orgs/:id/byok → available: false, the flag until V3-35). The owner reads and accepts
// the versioned terms once (a modal), adds a key in a masked field (it is sent once and cleared), sees its last 4
// characters, the «не проверена нами» mark of an unknown model, the check verdict, pauses, re-checks and revokes it.
import { type FormEvent, type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { ApiError } from "../../../api/client.js";
import { usePlatform } from "../../../app/context.js";
import { Alert, Pill } from "../../../components/ui.js";
import { Button } from "../../../components/v2/Button.js";
import { ru } from "../../../i18n/ru.js";
import s from "../Settings.module.css";
import b from "./ByokKeys.module.css";
import type { ByokClient, ByokKey, ByokState } from "./client.js";
import { byokRu as t } from "./texts.js";

const fmtDay = (iso: string) =>
  new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });

const errText = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : ru.errors.generic);

function statusPill(k: ByokKey): ReactNode {
  if (k.status === "paused")
    return (
      <Pill tone="neutral" testId="byok-key-status">
        {t.statusPaused}
      </Pill>
    );
  if (k.check.status === "ok")
    return (
      <Pill tone="ok" testId="byok-key-status">
        {t.statusOk}
      </Pill>
    );
  if (k.check.status === "failed")
    return (
      <Pill tone="bad" testId="byok-key-status">
        {t.statusFailed}
      </Pill>
    );
  return (
    <Pill tone="neutral" testId="byok-key-status">
      {t.statusPending}
    </Pill>
  );
}

/** Modal shell: focus inside on open, Esc closes, focus returns to the opener. */
function Modal({
  labelledBy,
  testId,
  onClose,
  children,
}: {
  labelledBy: string;
  testId: string;
  onClose(): void;
  children: ReactNode;
}): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close.current();
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
        aria-labelledby={labelledBy}
        className={`${s.dialog} ${b.dialog}`}
        data-testid={testId}
      >
        {children}
      </div>
    </div>
  );
}

export function ByokKeys({
  orgId,
  owner,
  client,
}: {
  orgId: string;
  owner: boolean;
  /** Tests pass a fake; default — `api.byok` of the platform client (absent in older fakes → no section). */
  client?: ByokClient;
}): ReactNode {
  const platform = usePlatform();
  const api: ByokClient | null = client ?? (platform.api as { byok?: ByokClient }).byok ?? null;
  const [state, setState] = useState<ByokState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [consentOpen, setConsentOpen] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [revoking, setRevoking] = useState<ByokKey | null>(null);
  const [provider, setProvider] = useState("");
  const [gatewayUrl, setGatewayUrl] = useState("");
  const [model, setModel] = useState("");
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const id = useId();

  const load = useCallback(
    async (alive: { current: boolean }) => {
      if (!api) return;
      try {
        const next = await api.get(orgId);
        if (alive.current) setState(next);
      } catch {
        // No section when the API cannot tell (older API, network): the feature is off for the user.
        if (alive.current) setState({ available: false });
      }
    },
    [api, orgId],
  );

  useEffect(() => {
    const alive = { current: true };
    void load(alive);
    return () => {
      alive.current = false;
    };
  }, [load]);

  const providers = state?.providers ?? [];
  const current = providers.find((p) => p.id === provider) ?? providers[0];
  useEffect(() => {
    if (!provider && providers[0]) setProvider(providers[0].id);
  }, [provider, providers]);

  if (!api || !state?.available || !state.consent) return null;
  const byok = api;
  const consent = state.consent;
  const accepted = consent.acceptedAt !== null;
  const keys = state.keys ?? [];

  async function act<T>(name: string, fn: () => Promise<T>, done?: string): Promise<T | null> {
    setBusy(name);
    setError(null);
    setNotice(null);
    try {
      const out = await fn();
      if (done) setNotice(done);
      return out;
    } catch (e) {
      setError(errText(e));
      return null;
    } finally {
      setBusy(null);
    }
  }

  const replaceKey = (k: ByokKey) =>
    setState((st) =>
      st
        ? {
            ...st,
            keys:
              k.status === "revoked"
                ? (st.keys ?? []).filter((x) => x.id !== k.id)
                : (st.keys ?? []).some((x) => x.id === k.id)
                  ? (st.keys ?? []).map((x) => (x.id === k.id ? k : x))
                  : [k, ...(st.keys ?? [])],
          }
        : st,
    );

  async function acceptTerms() {
    const next = await act("consent", () => byok.accept(orgId, consent.version));
    if (next) {
      setState(next);
      setConsentOpen(false);
      setAgreed(false);
    }
  }

  async function add(ev: FormEvent) {
    ev.preventDefault();
    if (!current) return;
    const res = await act("add", () =>
      byok.add(orgId, {
        provider: current.id,
        model: model.trim(),
        key,
        ...(current.direct ? {} : { gatewayUrl: gatewayUrl.trim() }),
      }),
    );
    if (res) {
      // The key leaves the page state as soon as the server has it.
      setKey("");
      setShowKey(false);
      replaceKey(res.key);
      setNotice(res.key.check.status === "ok" ? t.added : (res.key.check.message_ru ?? t.added));
    }
  }

  async function check(k: ByokKey) {
    const res = await act(`check:${k.id}`, () => byok.check(orgId, k.id), t.checked);
    if (res) replaceKey(res.key);
  }

  async function toggle(k: ByokKey, on: boolean) {
    const res = await act(`status:${k.id}`, () => byok.setStatus(orgId, k.id, on ? "active" : "paused"));
    if (res) replaceKey(res.key);
  }

  async function revoke(k: ByokKey) {
    setRevoking(null);
    const res = await act(`revoke:${k.id}`, () => byok.revoke(orgId, k.id), t.revoked);
    if (res) replaceKey(res.key);
  }

  const canAdd =
    !!current && model.trim().length > 0 && key.length >= 8 && (current.direct || gatewayUrl.trim() !== "");

  return (
    <section className={`${s.block} ${s.wide}`} aria-labelledby={`${id}-title`} data-testid="settings-byok">
      <h2 id={`${id}-title`} className={s.blockTitle}>
        {t.title}
      </h2>
      <p className={s.small}>{t.lead}</p>
      <p className={s.hint}>{t.how}</p>
      {error && <Alert testId="byok-error">{error}</Alert>}
      {notice && (
        <p className={s.notice} role="status" data-testid="byok-notice">
          {notice}
        </p>
      )}

      {accepted ? (
        <p className={s.hint} data-testid="byok-consent-accepted">
          {t.termsAccepted(fmtDay(consent.acceptedAt as string))}{" "}
          <button type="button" className={s.link} onClick={() => setConsentOpen(true)}>
            {consent.title}
          </button>
        </p>
      ) : (
        <div className={b.row}>
          <Button
            variant="primary"
            onClick={() => setConsentOpen(true)}
            disabled={!owner || busy !== null}
            data-testid="byok-consent-open"
          >
            {t.readTerms}
          </Button>
        </div>
      )}
      {!owner && <p className={s.hint}>{t.ownerOnly}</p>}

      {keys.length === 0 ? (
        <p className={s.hint} data-testid="byok-empty">
          {t.none}
        </p>
      ) : (
        <ul className={s.list} data-testid="byok-keys" aria-label={t.title}>
          {keys.map((k) => (
            <li key={k.id} className={b.key} data-testid="byok-key">
              <div className={b.keyHead}>
                <span className={b.keyName}>
                  {k.providerName} · <span className={b.model}>{k.model}</span>
                </span>
                {k.verified ? (
                  <Pill tone="ok">{t.verified}</Pill>
                ) : (
                  <Pill tone="warn" title={t.unverifiedTitle} testId="byok-unverified">
                    {t.unverified}
                  </Pill>
                )}
                {statusPill(k)}
              </div>
              <p className={`${s.hint} ${b.meta}`}>
                <span className={b.mono} data-testid="byok-key-last4">
                  {t.last4(k.last4)}
                </span>
                {k.gatewayHost ? ` · ${t.via(k.gatewayHost)}` : ` · ${t.direct}`}
                {k.lastUsedAt ? ` · ${t.lastUsed(fmtDay(k.lastUsedAt))}` : ""}
              </p>
              {k.check.status === "failed" && k.check.message_ru && (
                <p className={`${s.small} ${s.warn}`} data-testid="byok-key-check">
                  {k.check.message_ru}
                </p>
              )}
              {owner && (
                <div className={b.actions}>
                  <label className={s.check}>
                    <input
                      type="checkbox"
                      role="switch"
                      aria-checked={k.status === "active"}
                      checked={k.status === "active"}
                      disabled={busy !== null}
                      onChange={(e) => void toggle(k, e.target.checked)}
                      data-testid="byok-key-use"
                    />
                    <span>{t.use}</span>
                  </label>
                  <span className={s.spacer} />
                  <Button
                    size="sm"
                    onClick={() => void check(k)}
                    loading={busy === `check:${k.id}`}
                    disabled={busy !== null}
                    data-testid="byok-key-check-btn"
                  >
                    {t.check}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => setRevoking(k)}
                    disabled={busy !== null}
                    data-testid="byok-key-revoke"
                  >
                    {t.revoke}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {owner && accepted && current && (
        <form className={s.form} onSubmit={(ev) => void add(ev)} autoComplete="off" data-testid="byok-add">
          <div className={b.grid}>
            <label className={s.field}>
              {t.provider}
              <select
                value={current.id}
                onChange={(e) => setProvider(e.target.value)}
                disabled={busy !== null}
                data-testid="byok-provider"
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {p.direct ? t.direct : t.viaGateway}
                  </option>
                ))}
              </select>
            </label>
            {!current.direct && (
              <label className={s.field}>
                {t.gateway}
                <input
                  type="url"
                  inputMode="url"
                  placeholder="https://"
                  value={gatewayUrl}
                  onChange={(e) => setGatewayUrl(e.target.value)}
                  spellCheck={false}
                  autoCapitalize="off"
                  required
                  aria-describedby={`${id}-provider-hint`}
                  data-testid="byok-gateway"
                />
              </label>
            )}
            <label className={s.field}>
              {t.model}
              <input
                type="text"
                list={`${id}-models`}
                value={model}
                onChange={(e) => setModel(e.target.value)}
                spellCheck={false}
                autoCapitalize="off"
                maxLength={128}
                required
                aria-describedby={`${id}-model-hint`}
                data-testid="byok-model"
              />
              <datalist id={`${id}-models`}>
                {current.suggestedModels.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </label>
            <div className={s.field}>
              <label htmlFor={`${id}-key`}>{t.key}</label>
              <div className={b.keyField}>
                <input
                  id={`${id}-key`}
                  type={showKey ? "text" : "password"}
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  autoCapitalize="off"
                  maxLength={512}
                  required
                  aria-describedby={`${id}-key-hint`}
                  data-testid="byok-key-input"
                />
                <button
                  type="button"
                  className={b.reveal}
                  aria-pressed={showKey}
                  aria-label={showKey ? t.hideKey : t.showKey}
                  onClick={() => setShowKey((v) => !v)}
                  data-testid="byok-key-reveal"
                >
                  {showKey ? t.hideKey : t.showKey}
                </button>
              </div>
            </div>
          </div>
          <p id={`${id}-provider-hint`} className={s.hint}>
            {current.direct ? t.directHint : t.gatewayHint}
          </p>
          <p id={`${id}-model-hint`} className={s.hint}>
            {t.modelHint}
          </p>
          <p id={`${id}-key-hint`} className={s.hint}>
            {t.keyHint}
          </p>
          <div className={b.row}>
            <Button
              type="submit"
              variant="primary"
              loading={busy === "add"}
              disabled={!canAdd || busy !== null}
              data-testid="byok-add-submit"
            >
              {busy === "add" ? t.adding : t.add}
            </Button>
          </div>
        </form>
      )}

      {consentOpen && (
        <Modal labelledBy={`${id}-consent-title`} testId="byok-consent" onClose={() => setConsentOpen(false)}>
          <h3 id={`${id}-consent-title`} className={s.dialogText}>
            {consent.title}
          </h3>
          <ol className={b.terms} data-testid="byok-consent-text">
            {consent.paragraphs.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ol>
          {accepted ? (
            <div className={s.row}>
              <Button variant="primary" onClick={() => setConsentOpen(false)} data-autofocus="">
                {t.close}
              </Button>
            </div>
          ) : (
            <>
              <label className={s.check}>
                <input
                  type="checkbox"
                  checked={agreed}
                  onChange={(e) => setAgreed(e.target.checked)}
                  data-autofocus=""
                  data-testid="byok-consent-check"
                />
                <span>{t.acceptCheck}</span>
              </label>
              <div className={s.row}>
                <Button
                  variant="secondary"
                  onClick={() => setConsentOpen(false)}
                  data-testid="byok-consent-no"
                >
                  {t.cancel}
                </Button>
                <Button
                  variant="primary"
                  onClick={() => void acceptTerms()}
                  disabled={!agreed || busy !== null}
                  loading={busy === "consent"}
                  data-testid="byok-consent-yes"
                >
                  {t.accept}
                </Button>
              </div>
            </>
          )}
        </Modal>
      )}

      {revoking && (
        <Modal labelledBy={`${id}-revoke-title`} testId="byok-revoke" onClose={() => setRevoking(null)}>
          <p id={`${id}-revoke-title`} className={s.dialogText}>
            {t.revokeConfirm(revoking.providerName, revoking.last4)}
          </p>
          <div className={s.row}>
            <Button
              variant="secondary"
              onClick={() => setRevoking(null)}
              data-autofocus=""
              data-testid="byok-revoke-no"
            >
              {t.cancel}
            </Button>
            <Button variant="danger" onClick={() => void revoke(revoking)} data-testid="byok-revoke-yes">
              {t.revoke}
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}
