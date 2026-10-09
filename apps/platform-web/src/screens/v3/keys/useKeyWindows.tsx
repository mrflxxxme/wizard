// The key window on the canvas chat (V3-21; security/data-boundary.yaml#secret_window): (1) interception — a message with
// an access key is not sent: the key moves into the window in memory, the composer keeps the message with the key
// masked, and after saving the key becomes secret://name in it; (2) windows the build agent opened (request_secret) and
// integrations still without a key show as «Нужен ключ»; (3) the window itself, the result, rotation, re-check and
// removal. The page encrypts the key (seal.ts) — only the ciphertext goes to the API.

import { detectSecrets } from "@wizard/pii/secrets";
import { ActionButton } from "@wizard/ui-kit/v2";
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ApiError } from "../../../api/client.js";
import { usePlatform } from "../../../app/context.js";
import type { KeySubmitResult, KeysState, KeyWindowWithKey, SystemKey } from "./client.js";
import { KeyResult, KeyWindowForm } from "./KeyWindow.js";
import s from "./KeyWindow.module.css";
import { canSeal, sealSecret } from "./seal.js";
import { keysRu } from "./texts.js";

const T = keysRu;
const POLL_MS = 8000;

export interface KeyWindowsOptions {
  systemId: string;
  /** A v3 system (it has a brief): windows and keys; otherwise only the interception. */
  enabled: boolean;
  /** The member may enter keys (editor or owner). */
  editable: boolean;
  /** A run is going on: windows the agent opens during a build are picked up by polling. */
  live: boolean;
  /** Changes when the chat reloads (messages, stage) — the list is read again. */
  refresh: string;
  /** The composer's current text. */
  composer: string;
  setComposer(text: string): void;
  announce(text: string): void;
}

export interface KeyWindows {
  /** true — the text carries a key: it is not sent, the window is offered instead. */
  intercept(text: string): boolean;
  /** The card above the chat dock (window, result, interception, «Нужен ключ», list); null — nothing to show. */
  card: ReactNode | null;
  /** The one-line summary of keys above the composer; null — none. */
  row: ReactNode | null;
}

type View =
  | { kind: "window"; integrationId: string | null; windowId: string | null; win: KeyWindowWithKey | null }
  | { kind: "result"; message: string; tone: "good" | "bad"; secret: SystemKey | null }
  | { kind: "intercept" }
  | { kind: "manage" };

interface Typed {
  value: string;
  masked: string;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const reason = (e: unknown): string | undefined =>
  e instanceof ApiError ? (e.details?.reason as string | undefined) : undefined;

export function useKeyWindows(o: KeyWindowsOptions): KeyWindows {
  const { api } = usePlatform();
  const groupId = useId();
  const [keys, setKeys] = useState<KeysState | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [typed, setTyped] = useState<Typed | null>(null);
  const [busy, setBusy] = useState<"save" | "check" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [pick, setPick] = useState<string | null>(null);
  const composerRef = useRef(o.composer);
  composerRef.current = o.composer;
  const { systemId, enabled, announce, setComposer } = o;

  const load = useCallback(async () => {
    if (!enabled) return;
    try {
      setKeys(await api.keys.list(systemId));
    } catch {
      // No key routes (an older platform) or a network blip: the chat works without the window.
    }
  }, [api, systemId, enabled]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh is the reload signal of the chat
  useEffect(() => {
    void load();
  }, [load, o.refresh]);
  useEffect(() => {
    if (!enabled || !o.live) return;
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [enabled, o.live, load]);

  const currentOf = useCallback(
    (name: string | undefined): SystemKey | null =>
      (name && keys?.items.find((k) => k.name === name && k.env === "draft")) || null,
    [keys],
  );

  /** Open windows and integrations without a key that have a contract (their hosts are known). */
  const asks = useMemo(() => {
    if (!keys) return [];
    const out: {
      id: string;
      integrationId: string | null;
      windowId: string | null;
      name: string;
      hosts: string[];
      agent: boolean;
      /** A per-account passport: the key goes to the account typed into the window. */
      account: { label_ru: string; suffixes: string[] } | null;
    }[] = [];
    for (const w of keys.windows)
      out.push({
        id: `w:${w.id}`,
        integrationId: w.integrationId,
        windowId: w.id,
        name: w.integrationName ?? w.name,
        hosts: w.hosts,
        agent: w.requestedBy === "agent",
        account: keys.needed.find((n) => n.name === w.name)?.account ?? null,
      });
    for (const n of keys.needed)
      if (n.hosts && !n.present && !n.keyless && !keys.windows.some((w) => w.name === n.name))
        out.push({
          id: `n:${n.integrationId}`,
          integrationId: n.integrationId,
          windowId: null,
          name: n.integrationName,
          hosts: n.hosts,
          agent: false,
          account: n.account,
        });
    return out;
  }, [keys]);

  const openWindow = useCallback(
    async (a: { integrationId: string | null; windowId: string | null }) => {
      setError(null);
      setView({ kind: "window", integrationId: a.integrationId, windowId: a.windowId, win: null });
      try {
        const r = a.windowId
          ? await api.keys.window(systemId, a.windowId)
          : await api.keys.open(systemId, a.integrationId as string);
        setView({
          kind: "window",
          integrationId: r.window.integrationId,
          windowId: r.window.id,
          win: r.window,
        });
      } catch (e) {
        setError(errText(e));
        if (reason(e) === "WINDOW_CLOSED") void load();
      }
    },
    [api, systemId, load],
  );

  const close = useCallback(() => {
    setView(null);
    setError(null);
  }, []);

  const submit = useCallback(
    async (win: KeyWindowWithKey, value: string) => {
      if (!canSeal()) {
        setError(T.window.noCrypto);
        return;
      }
      setBusy("save");
      setError(null);
      try {
        const sealed = await sealSecret(win, value.trim());
        const r: KeySubmitResult = await api.keys.submit(systemId, win.id, sealed);
        const good = r.saved && r.secret?.status !== "failed";
        setView({ kind: "result", message: r.message_ru, tone: good ? "good" : "bad", secret: r.secret });
        announce(r.message_ru);
        // The intercepted message comes back to the composer with the reference instead of the key.
        if (r.saved && typed) {
          if (composerRef.current === typed.masked)
            setComposer(typed.masked.split(T.intercept.masked).join(win.secretRef));
          setTyped(null);
        }
        void load();
      } catch (e) {
        setError(errText(e));
        if (reason(e) === "WINDOW_CLOSED" || reason(e) === "HOSTS_CHANGED") void load();
      } finally {
        setBusy(null);
      }
    },
    [api, systemId, typed, announce, setComposer, load],
  );

  const check = useCallback(
    async (secret: SystemKey) => {
      setBusy("check");
      try {
        const r = await api.keys.check(systemId, secret.name, secret.env);
        setView({
          kind: "result",
          message: r.message_ru,
          tone: r.secret.status === "ok" ? "good" : "bad",
          secret: r.secret,
        });
        announce(r.message_ru);
        void load();
      } catch (e) {
        setView({ kind: "result", message: errText(e), tone: "bad", secret });
      } finally {
        setBusy(null);
      }
    },
    [api, systemId, announce, load],
  );

  const remove = useCallback(
    async (secret: SystemKey) => {
      setBusy("remove");
      try {
        await api.keys.remove(systemId, secret.name, secret.env);
        setView({ kind: "result", message: T.result.removed, tone: "good", secret: null });
        announce(T.result.removed);
        void load();
      } catch (e) {
        setView({ kind: "result", message: errText(e), tone: "bad", secret });
      } finally {
        setBusy(null);
      }
    },
    [api, systemId, announce, load],
  );

  const intercept = useCallback(
    (text: string): boolean => {
      const found = detectSecrets(text);
      const first = found[0];
      if (!first) return false;
      let masked = "";
      let at = 0;
      for (const f of found) {
        masked += text.slice(at, f.start) + T.intercept.masked;
        at = f.end;
      }
      masked += text.slice(at);
      setTyped({ value: text.slice(first.start, first.end), masked });
      setComposer(masked);
      setPick(null);
      setError(null);
      setView({ kind: "intercept" });
      announce(T.intercept.title);
      void load();
      return true;
    },
    [setComposer, announce, load],
  );

  let card: ReactNode = null;
  if (view?.kind === "window") {
    const name = view.win?.name;
    card = (
      <KeyWindowForm
        key={view.windowId ?? view.integrationId ?? "loading"}
        window={view.win}
        current={currentOf(name)}
        {...(typed ? { initialValue: typed.value } : {})}
        editable={o.editable}
        busy={busy === "save"}
        error={error}
        onSubmit={(v) => view.win && void submit(view.win, v)}
        onCancel={() => {
          // A key the chat intercepted does not stay in memory once its window is closed.
          setTyped(null);
          close();
        }}
      />
    );
  } else if (view?.kind === "result") {
    const secret = view.secret;
    card = (
      <KeyResult
        message={view.message}
        tone={view.tone}
        secret={secret}
        editable={o.editable}
        busy={busy === "check" || busy === "remove" ? busy : null}
        onDone={close}
        onRotate={() =>
          secret?.integrationId && void openWindow({ integrationId: secret.integrationId, windowId: null })
        }
        onCheck={() => secret && void check(secret)}
        onRemove={() => secret && void remove(secret)}
      />
    );
  } else if (view?.kind === "intercept") {
    const options = o.enabled && o.editable ? asks : [];
    const chosen = options.find((a) => a.id === pick) ?? (options.length === 1 ? options[0] : undefined);
    card = (
      <section
        className={`${s.card} ${s.alert}`}
        role="alert"
        aria-labelledby={`${groupId}-it`}
        data-testid="key-intercept"
      >
        <p className={s.title} id={`${groupId}-it`}>
          {T.intercept.title}
        </p>
        <p className={s.purpose}>{T.intercept.text}</p>
        {options.length > 1 && (
          <fieldset className={s.options}>
            <legend className={s.legend}>{T.intercept.pick}</legend>
            {options.map((a) => (
              <label key={a.id} className={s.option}>
                <input
                  type="radio"
                  name={`${groupId}-pick`}
                  checked={chosen?.id === a.id}
                  onChange={() => setPick(a.id)}
                  data-testid="key-intercept-option"
                />
                <span>
                  {a.name}{" "}
                  <span className={s.host}>
                    {a.account ? a.account.suffixes.map((x) => `*.${x}`).join(", ") : a.hosts.join(", ")}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
        )}
        {o.enabled && o.editable && options.length === 0 && keys && (
          <p className={s.meta}>{T.intercept.noIntegration}</p>
        )}
        <div className={s.actions}>
          {chosen && (
            <ActionButton
              variant="primary"
              onClick={() => void openWindow(chosen)}
              testId="key-intercept-open"
            >
              {T.intercept.open}
            </ActionButton>
          )}
          <ActionButton
            variant="ghost"
            onClick={() => {
              setTyped(null);
              close();
            }}
            testId="key-intercept-strip"
          >
            {T.intercept.strip}
          </ActionButton>
        </div>
      </section>
    );
  } else if (view?.kind === "manage" && keys) {
    card = (
      <section className={s.card} aria-labelledby={`${groupId}-mt`} data-testid="key-manage">
        <p className={s.title} id={`${groupId}-mt`}>
          {T.row.label}
        </p>
        <ul className={s.list}>
          {keys.needed
            .filter((n) => !n.keyless)
            .map((n) => {
              const k = currentOf(n.name);
              return (
                <li key={n.integrationId} className={s.item} data-testid="key-manage-item">
                  <p className={s.itemText}>
                    {k ? T.row.item(n.integrationName, k.last4, k.status) : T.row.missing(n.integrationName)}
                  </p>
                  {o.editable && n.hosts && (
                    <ActionButton
                      size="sm"
                      onClick={() => void openWindow({ integrationId: n.integrationId, windowId: null })}
                      testId="key-manage-open"
                    >
                      {k ? T.result.rotate : T.needed.enter}
                    </ActionButton>
                  )}
                  {o.editable && k && (
                    <ActionButton
                      size="sm"
                      variant="ghost"
                      onClick={() => void check(k)}
                      testId="key-manage-check"
                    >
                      {T.result.check}
                    </ActionButton>
                  )}
                </li>
              );
            })}
        </ul>
        <div className={s.actions}>
          <ActionButton variant="ghost" size="sm" onClick={close} testId="key-manage-close">
            {T.row.close}
          </ActionButton>
        </div>
      </section>
    );
  } else if (o.enabled) {
    const open = asks.filter((a) => !hidden.has(a.id));
    if (open.length > 0)
      card = (
        <section className={s.card} aria-labelledby={`${groupId}-nt`} data-testid="key-needed">
          <p className={s.title} id={`${groupId}-nt`}>
            {T.needed.title}
          </p>
          <ul className={s.list}>
            {open.map((a) => (
              <li key={a.id} className={s.item} data-testid="key-needed-item">
                <p className={s.itemText}>
                  {a.account
                    ? T.needed.lineAccount(a.name, a.account.suffixes)
                    : T.needed.line(a.name, a.hosts.join(", "))}
                  {a.agent ? ` · ${T.needed.agent}` : ""}
                </p>
                {o.editable && (
                  <ActionButton
                    size="sm"
                    variant="primary"
                    onClick={() => void openWindow(a)}
                    testId="key-needed-enter"
                  >
                    {T.needed.enter}
                  </ActionButton>
                )}
              </li>
            ))}
          </ul>
          <div className={s.actions}>
            <ActionButton
              size="sm"
              variant="ghost"
              onClick={() => setHidden(new Set([...hidden, ...open.map((a) => a.id)]))}
              testId="key-needed-later"
            >
              {T.needed.later}
            </ActionButton>
          </div>
        </section>
      );
  }

  const saved = keys?.items.filter((k) => k.env === "draft") ?? [];
  const row =
    o.enabled && saved.length > 0 && view === null ? (
      <p className={s.row} data-testid="key-row">
        <span className={s.rowText}>
          {T.row.label}:{" "}
          {saved.map((k) => T.row.item(k.integrationName ?? k.name, k.last4, k.status)).join("; ")}
        </span>
        <ActionButton
          size="sm"
          variant="ghost"
          onClick={() => setView({ kind: "manage" })}
          testId="key-row-manage"
        >
          {T.row.manage}
        </ActionButton>
      </p>
    ) : null;

  return { intercept, card, row };
}
