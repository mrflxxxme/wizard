// «Написать команде» (product.yaml#decisions.D68_support_button, M2-57 mvp_scope): one button on every cabinet screen
// opens a form — text and «Хочу, чтобы доделала команда»; the message goes to the founder (POST /support/requests) with
// the open system and screen; the client sees the confirmation with the reply time (D60). Other screens open the same
// form with openSupport() (limits, failed runs). The dialog keeps focus, closes on Esc and announces the result.
import { Button } from "@wizard/ui-kit";
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { ApiError } from "../../api/client.js";
import { usePlatform } from "../../app/context.js";
import { type Route, useRoute } from "../../app/router.js";
import { support } from "../../i18n/ru/support.js";
import s from "./Support.module.css";

const EVENT = "wz:support";

export interface SupportOpen {
  /** Pre-ticks «Хочу, чтобы доделала команда». */
  wantsTeam?: boolean;
  /** Pre-filled text (e.g. the limit message the client saw). */
  text?: string;
}

/** Opens the «Написать команде» form from anywhere in the cabinet. */
export function openSupport(o: SupportOpen = {}): void {
  window.dispatchEvent(new CustomEvent<SupportOpen>(EVENT, { detail: o }));
}

/** «Написать команде» next to an error (limits, failed runs): the same form. */
export function TeamButton({ testId = "team-button", ...o }: SupportOpen & { testId?: string }): ReactNode {
  return (
    <Button size="sm" variant="secondary" data-testid={testId} onClick={() => openSupport(o)}>
      {support.open}
    </Button>
  );
}

/** Routes of the client cabinet that show the button (not /admin, not sign-in, not public pages). */
const CABINET: ReadonlySet<Route["name"]> = new Set([
  "start",
  "system",
  "code",
  "settings",
  "import",
  "billing",
  "welcome",
]);

const systemOf = (r: Route): string | null => ("systemId" in r ? r.systemId : null);

export function SupportWidget(): ReactNode {
  const { route } = useRoute();
  const { auth } = usePlatform();
  const [open, setOpen] = useState<SupportOpen | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const on = (e: Event) => {
      opener.current = document.activeElement as HTMLElement | null;
      setOpen((e as CustomEvent<SupportOpen>).detail ?? {});
    };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  const close = useCallback(() => {
    setOpen(null);
    opener.current?.focus?.();
  }, []);
  if (!CABINET.has(route.name) || auth === "anon" || auth === "loading") return null;
  return (
    <>
      <button
        type="button"
        className={s.fab}
        data-testid="support-open"
        aria-haspopup="dialog"
        onClick={(e) => {
          opener.current = e.currentTarget;
          setOpen({});
        }}
      >
        {support.open}
      </button>
      {open && (
        <SupportDialog
          key={JSON.stringify(open)}
          initial={open}
          systemId={systemOf(route)}
          screen={route.name}
          onClose={close}
        />
      )}
    </>
  );
}

function SupportDialog({
  initial,
  systemId,
  screen,
  onClose,
}: {
  initial: SupportOpen;
  systemId: string | null;
  screen: string;
  onClose(): void;
}): ReactNode {
  const { api, orgId, auth } = usePlatform();
  const [text, setText] = useState(initial.text ?? "");
  const [wantsTeam, setWantsTeam] = useState(initial.wantsTeam ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [systemName, setSystemName] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const titleId = useId();
  const textId = useId();

  useEffect(() => {
    ref.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
      if (e.key !== "Tab" || !ref.current) return;
      // Focus stays inside the dialog.
      const items = [...ref.current.querySelectorAll<HTMLElement>("textarea, input, button:not([disabled])")];
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!systemId) return;
    let live = true;
    api
      .getSystem(systemId)
      .then((v) => live && setSystemName(v.system.name || null))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [api, systemId]);

  async function send() {
    const body = text.trim();
    if (!body) {
      setError(support.empty);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api.createSupportRequest({
        text: body,
        wantsTeam,
        screen,
        ...(systemId ? { systemId } : auth === "ready" ? { orgId } : {}),
      });
      setDone(r.message_ru);
    } catch (e) {
      setError(e instanceof ApiError && e.status !== 0 && e.status < 500 ? e.message : support.failed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={s.backdrop}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={s.dialog}
        data-testid="support-dialog"
      >
        <h2 id={titleId} className={s.title}>
          {support.title}
        </h2>
        {done ? (
          <>
            <p role="status" className={s.done} data-testid="support-done">
              {done}
            </p>
            <div className={s.row}>
              <Button variant="primary" onClick={onClose} data-testid="support-close">
                {support.close}
              </Button>
            </div>
          </>
        ) : (
          <form
            className={s.form}
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <p className={s.lead}>{support.lead}</p>
            {systemId && (
              <p className={s.small} data-testid="support-system">
                {systemName ? support.system(systemName) : support.systemUnnamed}
              </p>
            )}
            <label className={s.label} htmlFor={textId}>
              {support.text}
            </label>
            <textarea
              id={textId}
              className={s.textarea}
              data-testid="support-text"
              rows={5}
              maxLength={4000}
              placeholder={support.placeholder}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <label className={s.check} title={support.wantsTeamHint}>
              <input
                type="checkbox"
                data-testid="support-wants-team"
                checked={wantsTeam}
                onChange={(e) => setWantsTeam(e.target.checked)}
              />
              {support.wantsTeam}
            </label>
            {error && (
              <p role="alert" className={s.error} data-testid="support-error">
                {error}
              </p>
            )}
            <div className={s.row}>
              <Button variant="secondary" onClick={onClose} data-testid="support-cancel">
                {support.cancel}
              </Button>
              <Button type="submit" variant="primary" loading={busy} data-testid="support-send">
                {support.send}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
