// S-auth «Регистрация и вход» (/login?next=…): email → code → for a new user (or a new offer version) two separate
// unchecked consents: the offer (acceptOffer) and the personal data consent (pdConsent), compliance.yaml#platform.
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { ApiError } from "../../api/client.js";
import { usePlatform } from "../../app/context.js";
import { navigate, safeNext, useRoute } from "../../app/router.js";
import { Button } from "../../components/v2/Button.js";
import { PlatformPage } from "../../components/v2/Shell.js";
import { ru } from "../../i18n/ru.js";
import s from "./Auth.module.css";

type Consent = "acceptOffer" | "pdConsent";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function Login(): ReactNode {
  const { api, auth, reloadMe } = usePlatform();
  const { search } = useRoute();
  const next = safeNext(search.get("next"));
  // The founder's pilot invitation links to /login?email=<address> (M2-15).
  const [email, setEmail] = useState(() => search.get("email")?.trim().slice(0, 254) ?? "");
  const [step, setStep] = useState<"email" | "code">("email");
  const [code, setCode] = useState("");
  const [offer, setOffer] = useState(false);
  const [pd, setPd] = useState(false);
  /** Consents the server asked for (422 CONSENT_REQUIRED details.missing); shown from then on. */
  const [needed, setNeeded] = useState<Consent[]>([]);
  const [missing, setMissing] = useState<Consent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (auth === "ready") navigate(next, { replace: true });
  }, [auth, next]);

  const message = (e: unknown) => {
    if (e instanceof ApiError && (e.status === 429 || e.code === "RATE_LIMITED")) return ru.auth.tooMany;
    return e instanceof Error ? e.message : ru.errors.generic;
  };

  async function requestCode(ev?: FormEvent) {
    ev?.preventDefault();
    setError(null);
    if (!EMAIL.test(email.trim())) {
      setError(ru.auth.invalidEmail);
      return;
    }
    setBusy(true);
    try {
      await api.requestOtp(email.trim());
      setStep("code");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  async function verify(ev: FormEvent) {
    ev.preventDefault();
    setError(null);
    if (!/^[0-9]{6}$/.test(code)) {
      setError(ru.auth.invalidCode);
      return;
    }
    const unchecked = needed.filter((c) => (c === "acceptOffer" ? !offer : !pd));
    setMissing(unchecked);
    if (unchecked.length > 0) return;
    setBusy(true);
    try {
      await api.verifyOtp({
        email: email.trim(),
        code,
        ...(needed.includes("acceptOffer") ? { acceptOffer: offer } : {}),
        ...(needed.includes("pdConsent") ? { pdConsent: pd } : {}),
      });
      await reloadMe();
      navigate(next, { replace: true });
    } catch (e) {
      if (e instanceof ApiError && e.code === "CONSENT_REQUIRED") {
        const m = (Array.isArray(e.details?.missing) ? e.details.missing : []).filter(
          (x): x is Consent => x === "acceptOffer" || x === "pdConsent",
        );
        setNeeded((prev) => [...new Set([...prev, ...m])]);
        setMissing(m);
      } else setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  const consent = (
    id: Consent,
    label: string,
    link: string,
    href: string,
    checked: boolean,
    set: (v: boolean) => void,
  ) => {
    const invalid = missing.includes(id);
    const testId = id === "acceptOffer" ? "auth-offer" : "auth-pd-consent";
    return (
      <div>
        <label className={s.check}>
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => {
              set(e.target.checked);
              if (e.target.checked) setMissing((m) => m.filter((x) => x !== id));
            }}
            aria-invalid={invalid}
            aria-describedby={invalid ? `${testId}-error` : undefined}
            data-testid={testId}
          />
          <span>
            {label} (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {link}
            </a>
            )
          </span>
        </label>
        {invalid && (
          <p className={s.error} id={`${testId}-error`} data-testid={`${testId}-error`} role="alert">
            {id === "acceptOffer" ? ru.auth.offerRequired : ru.auth.pdRequired}
          </p>
        )}
      </div>
    );
  };

  return (
    <PlatformPage nav={false}>
      <main className={s.page}>
        <section className={s.card} aria-labelledby="auth-title">
          <h1 id="auth-title" className={s.title}>
            {ru.auth.title}
          </h1>
          <p className={s.muted}>{ru.auth.subtitle}</p>
          {step === "email" ? (
            <form className={s.form} onSubmit={(e) => void requestCode(e)} noValidate>
              <label className={s.field}>
                <span>{ru.auth.email}</span>
                <input
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  data-testid="auth-email"
                />
              </label>
              <Button type="submit" variant="primary" loading={busy} data-testid="auth-request-code">
                {ru.auth.requestCode}
              </Button>
            </form>
          ) : (
            <form className={s.form} onSubmit={(e) => void verify(e)} noValidate>
              <p className={s.status} role="status">
                {ru.auth.sent}
              </p>
              <div className={s.row}>
                <b>{email.trim()}</b>
                <button
                  type="button"
                  className={s.link}
                  onClick={() => {
                    setStep("email");
                    setCode("");
                    setError(null);
                  }}
                >
                  {ru.auth.changeEmail}
                </button>
              </div>
              <label className={s.field}>
                <span>{ru.auth.code}</span>
                <input
                  className={s.code}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  data-testid="auth-code"
                />
              </label>
              {needed.length > 0 && (
                <fieldset className={s.consents}>
                  <legend>{ru.auth.consentsTitle}</legend>
                  {needed.includes("acceptOffer") &&
                    consent("acceptOffer", ru.auth.offer, ru.auth.offerLink, "/legal/offer", offer, setOffer)}
                  {needed.includes("pdConsent") &&
                    consent("pdConsent", ru.auth.pdConsent, ru.auth.pdLink, "/legal/pd-consent", pd, setPd)}
                </fieldset>
              )}
              <Button type="submit" variant="primary" loading={busy} data-testid="auth-submit">
                {ru.auth.submit}
              </Button>
              <button type="button" className={s.link} onClick={() => void requestCode()} disabled={busy}>
                {ru.auth.resend}
              </button>
            </form>
          )}
          {error && (
            <p className={s.formError} role="alert" data-testid="auth-error">
              {error}
            </p>
          )}
        </section>
      </main>
    </PlatformPage>
  );
}
