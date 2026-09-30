// AppShell.Login: /login page of the runtime template (ui-kit.yaml#components.AppShell, runtime.yaml#auth).
import { type FormEvent, type ReactNode, useState } from "react";
import { useDataSource, useLocation, useNavigate, useRoleSpec } from "../data/context.js";
import { toWzError } from "../data/mutation.js";
import type { LoginMethod } from "../data/roleSpec.js";
import { ru } from "../i18n/ru.js";
import styles from "./AppShell.module.css";
import { ButtonImpl } from "./Button.js";
import { FieldImpl } from "./Field.js";
import { part } from "./root.js";

type Step = { challengeId: string; to: string } | null;

export function safeNextPath(next: string | null | undefined): string {
  return next && /^\/(?![/\\])/.test(next) ? next : "/";
}

export function Login({ next }: { next?: string }): ReactNode {
  const spec = useRoleSpec();
  const auth = useDataSource().useAuth();
  const navigate = useNavigate();
  const { search } = useLocation();
  const target = safeNextPath(next ?? new URLSearchParams(search).get("next"));
  const methods = spec.loginMethods;
  const [method, setMethod] = useState<LoginMethod | undefined>(methods[0]);
  const [dest, setDest] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<Step>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const choose = (m: LoginMethod) => {
    setMethod(m);
    setStep(null);
    setDest("");
    setCode("");
    setError(undefined);
    if (m === "telegram") auth.redirect("telegram", target);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    setBusy(true);
    try {
      if (!step) {
        const channel = method === "phone_otp" ? "phone" : "email";
        const r = await auth.start(channel, dest.trim());
        setStep({ challengeId: r.challengeId, to: dest.trim() });
      } else {
        await auth.verify(step.challengeId, code.trim());
        navigate(target);
      }
    } catch (err) {
      setError(toWzError(err).message || ru.login.failed);
    } finally {
      setBusy(false);
    }
  };

  const phone = method === "phone_otp";
  return (
    <section className={styles.login} data-testid="wz-login" aria-labelledby="wz-login-title">
      <h1 id="wz-login-title" className={styles.loginTitle}>
        {ru.login.title}
      </h1>
      <div className={styles.methods}>
        {methods.map((m) => (
          <ButtonImpl
            key={m}
            root={part(`wz-login-method-${m}`)}
            variant={m === method ? "primary" : "secondary"}
            aria-pressed={m === method}
            onClick={() => choose(m)}
          >
            {ru.login.methods[m]}
          </ButtonImpl>
        ))}
      </div>
      {phone && spec.phoneOtpPlanNote && <p className={styles.note}>{ru.login.phonePlanNote}</p>}
      {method && method !== "telegram" && (
        <form className={styles.loginForm} onSubmit={(e) => void submit(e)} noValidate>
          {!step ? (
            <FieldImpl
              root={part(`wz-field-${phone ? "phone" : "email"}`)}
              idBase="login"
              name={phone ? "phone" : "email"}
              label={phone ? ru.login.phone : ru.login.email}
              type={phone ? "phone" : "email"}
              value={dest}
              onChange={(v) => setDest(String(v ?? ""))}
              autoComplete={phone ? "tel" : "email"}
              required
            />
          ) : (
            <>
              <p role="status" className={styles.note}>
                {ru.login.codeSent(step.to)}
              </p>
              <FieldImpl
                root={part("wz-field-code")}
                idBase="login"
                name="code"
                label={ru.login.code}
                hint={ru.login.codeHint}
                type="string"
                value={code}
                onChange={(v) => setCode(String(v ?? ""))}
                autoComplete="one-time-code"
                maxLength={6}
                required
              />
            </>
          )}
          {error && (
            <p role="alert" className={styles.alert}>
              {error}
            </p>
          )}
          <div className={styles.methods}>
            <ButtonImpl root={part("wz-login-submit")} type="submit" variant="primary" loading={busy}>
              {step ? ru.login.submit : ru.login.getCode}
            </ButtonImpl>
            {step && (
              <ButtonImpl root={part("wz-login-back")} variant="ghost" onClick={() => setStep(null)}>
                {ru.login.back}
              </ButtonImpl>
            )}
          </div>
        </form>
      )}
    </section>
  );
}
