// «Пожаловаться» (/abuse?url=<page>, security/abuse.yaml#report, M2-08): public complaint form without login. The
// link in every prod system's footer (runtime) prefills the page address. The contact e-mail is optional and needs its
// own consent checkbox (152-ФЗ); the answer never says anything about the system's status.
import { Button } from "@wizard/ui-kit";
import { type FormEvent, type ReactNode, useState } from "react";
import { ApiError } from "../../api/client.js";
import type { AbuseCategory } from "../../api/types.js";
import { usePlatform } from "../../app/context.js";
import { useRoute } from "../../app/router.js";
import { ru } from "../../i18n/ru.js";
import a from "../auth/Auth.module.css";
import s from "./Abuse.module.css";

export const ABUSE_CATEGORIES: readonly AbuseCategory[] = [
  "phishing",
  "fraud",
  "brand_impersonation",
  "illegal_content",
  "pd_violation",
  "spam",
  "other",
];

export function AbuseForm(): ReactNode {
  const { api } = usePlatform();
  const { search } = useRoute();
  const [url, setUrl] = useState(() => search.get("url") ?? "");
  const [category, setCategory] = useState<AbuseCategory>("phishing");
  const [text, setText] = useState("");
  const [contact, setContact] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (url.trim().length < 8) return setError(ru.abuse.urlRequired);
    if (contact.trim() && !consent) return setError(ru.abuse.consentRequired);
    setBusy(true);
    try {
      await api.createAbuseReport({
        url: url.trim(),
        category,
        ...(text.trim() ? { text: text.trim() } : {}),
        ...(contact.trim() ? { contactEmail: contact.trim(), contactConsent: true } : {}),
      });
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : ru.errors.generic);
    } finally {
      setBusy(false);
    }
  }

  const reset = () => {
    setSent(false);
    setText("");
  };

  return (
    <main className={a.page}>
      <section className={`${a.card} ${a.wide}`} aria-labelledby="abuse-title" data-testid="abuse-page">
        <span className={a.logo} aria-hidden="true">
          W
        </span>
        <h1 id="abuse-title" className={a.title}>
          {ru.abuse.title}
        </h1>
        <p className={a.muted}>{ru.abuse.lead}</p>
        {sent ? (
          <>
            <p className={s.done} role="status" data-testid="abuse-done">
              {ru.abuse.done}
            </p>
            <div className={a.row}>
              <Button variant="secondary" onClick={reset}>
                {ru.abuse.another}
              </Button>
            </div>
          </>
        ) : (
          <form className={a.form} onSubmit={(e) => void submit(e)} noValidate data-testid="abuse-form">
            <label className={a.field}>
              {ru.abuse.url}
              <input
                className={s.control}
                type="url"
                value={url}
                maxLength={2000}
                placeholder="https://"
                onChange={(e) => setUrl(e.target.value)}
                data-testid="abuse-url"
              />
              <span className={s.hint}>{ru.abuse.urlHint}</span>
            </label>
            <label className={a.field}>
              {ru.abuse.category}
              <select
                className={s.control}
                value={category}
                onChange={(e) => setCategory(e.target.value as AbuseCategory)}
                data-testid="abuse-category"
              >
                {ABUSE_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {ru.abuse.categories[c]}
                  </option>
                ))}
              </select>
            </label>
            <label className={a.field}>
              {ru.abuse.text}
              <textarea
                className={s.control}
                value={text}
                maxLength={4000}
                onChange={(e) => setText(e.target.value)}
                data-testid="abuse-text"
              />
              <span className={s.hint}>{ru.abuse.textHint}</span>
            </label>
            <label className={a.field}>
              {ru.abuse.contact}
              <input
                className={s.control}
                type="email"
                value={contact}
                maxLength={254}
                autoComplete="email"
                onChange={(e) => setContact(e.target.value)}
                data-testid="abuse-contact"
              />
            </label>
            {contact.trim() && (
              <label className={a.check}>
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                  data-testid="abuse-consent"
                />
                <span>{ru.abuse.consent}</span>
              </label>
            )}
            {error && (
              <p className={a.formError} role="alert" data-testid="abuse-error">
                {error}
              </p>
            )}
            <div className={a.row}>
              <Button type="submit" variant="primary" disabled={busy} data-testid="abuse-submit">
                {busy ? ru.abuse.sending : ru.abuse.submit}
              </Button>
            </div>
            <p className={s.hint}>{ru.abuse.mail}</p>
          </form>
        )}
      </section>
    </main>
  );
}
