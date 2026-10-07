// S-billing «Письма о новых возможностях» (B2-26 module factory): the client's own consent to «Теперь умеем» letters
// (api.yaml getUpdatesConsent / setUpdatesConsent, db.yaml#users.updates_consent_at). Off by default; the block hides
// itself when the API does not answer.
import { type ReactNode, useEffect, useState } from "react";
import type { UpdatesConsent } from "../../api/types.js";
import { usePlatform } from "../../app/context.js";
import { Alert } from "../../components/ui.js";
import { factory } from "../../i18n/ru/factory.js";
import { ru } from "../../i18n/ru.js";
import s from "../../screens/settings/Settings.module.css";

const t = factory.consent;

export function UpdatesConsentBlock(): ReactNode {
  const { api } = usePlatform();
  const [value, setValue] = useState<UpdatesConsent | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const v = await api.getUpdatesConsent();
        if (live) setValue(v);
      } catch {
        if (live) setValue(null);
      }
    })();
    return () => {
      live = false;
    };
  }, [api]);

  async function toggle(on: boolean) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      setValue(await api.setUpdatesConsent(on));
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : ru.errors.generic);
    } finally {
      setBusy(false);
    }
  }

  if (!value) return null;
  return (
    <section className={s.block} data-testid="billing-updates" aria-labelledby="updates-title">
      <h2 id="updates-title" className={s.blockTitle}>
        {t.title}
      </h2>
      <label className={s.check}>
        <input
          type="checkbox"
          checked={value.on}
          disabled={busy}
          onChange={(e) => void toggle(e.target.checked)}
          data-testid="billing-updates-consent"
        />
        {t.label}
      </label>
      <p className={s.hint}>{t.hint}</p>
      {saved && (
        <p className={s.small} role="status" data-testid="billing-updates-saved">
          {t.saved}
        </p>
      )}
      {error && <Alert testId="billing-updates-error">{error}</Alert>}
    </section>
  );
}
