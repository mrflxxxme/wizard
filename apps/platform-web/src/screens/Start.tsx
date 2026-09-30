// S1 «Старт» (platform-screens.yaml#screens S1).
import { Button } from "@wizard/ui-kit";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { ApiError, newIdempotencyKey } from "../api/client.js";
import type { System } from "../api/types.js";
import { usePlatform } from "../app/context.js";
import { navigate } from "../app/router.js";
import { Alert, Pill } from "../components/ui.js";
import { ru } from "../i18n/ru.js";
import s from "./Start.module.css";

export function Start(): ReactNode {
  const { api, settings } = usePlatform();
  const [prompt, setPrompt] = useState("");
  const [templateId, setTemplateId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [systems, setSystems] = useState<System[]>([]);
  const keyRef = useRef<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .listSystems()
      .then((r) => live && setSystems(r.items))
      .catch(() => live && setSystems([]));
    return () => {
      live = false;
    };
  }, [api]);

  const empty = prompt.trim().length < 3;

  async function submit() {
    if (empty || busy) return;
    setBusy(true);
    setError(null);
    keyRef.current ??= newIdempotencyKey();
    try {
      const r = await api.createSystem(
        { prompt: prompt.trim(), ...(templateId && templateId !== "custom" ? { templateId } : {}) },
        keyRef.current,
      );
      keyRef.current = null;
      navigate(`/s/${r.system.id}`);
    } catch (e) {
      keyRef.current = null;
      setError(e instanceof ApiError ? e : new ApiError(0, null));
      setBusy(false);
    }
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <div className={s.page}>
      <header className={s.topbar}>
        <a
          className={s.logo}
          href="/"
          aria-label={ru.rail.home}
          onClick={(e) => {
            e.preventDefault();
            navigate("/");
          }}
        >
          W
        </a>
        <span className={s.policy} data-testid="start-policy">
          {ru.start.policy(settings?.buildModelLabel)}
        </span>
        <span className={s.spacer} />
        <label className={s.ruOnly} title={ru.start.ruOnlyHint}>
          <input
            type="checkbox"
            data-testid="start-ru-only"
            checked={settings?.ruOnly ?? false}
            disabled
            readOnly
          />
          {ru.start.ruOnly}
        </label>
        <span data-testid="start-credits" title={ru.start.creditsHint}>
          <Pill tone="neutral">{ru.start.credits}: —</Pill>
        </span>
      </header>

      <main className={s.hero}>
        <h1 className={s.title}>{ru.start.title}</h1>
        <p className={s.subtitle}>{ru.start.subtitle}</p>
        <label className={s.promptLabel} htmlFor="start-prompt">
          {ru.start.promptLabel}
        </label>
        <textarea
          id="start-prompt"
          className={s.prompt}
          data-testid="start-prompt"
          value={prompt}
          maxLength={8000}
          rows={6}
          placeholder={ru.start.promptPlaceholder}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={onKey}
        />
        <fieldset className={s.templates}>
          <legend className={s.templatesLabel}>{ru.start.templates}:</legend>
          {ru.templates.map((t) => (
            <button
              key={t.id}
              type="button"
              className={s.chip}
              data-testid={`start-template-${t.id}`}
              aria-pressed={templateId === t.id}
              onClick={() => {
                setTemplateId(t.id);
                setPrompt(t.prompt);
              }}
            >
              {t.label}
            </button>
          ))}
        </fieldset>
        <div className={s.actions}>
          <span className={s.uploadHint}>
            <Button variant="ghost" size="sm" data-testid="start-upload" disabled title={ru.start.uploadHint}>
              {ru.start.upload}
            </Button>
            <span>{ru.start.uploadHint}</span>
          </span>
          <Button
            variant="primary"
            data-testid="start-submit"
            disabled={empty}
            loading={busy}
            onClick={() => void submit()}
            title={ru.start.submitHint}
          >
            {ru.start.submit}
          </Button>
        </div>
        {error && (
          <Alert>
            {error.message}{" "}
            {error.code === "INSUFFICIENT_CREDITS" && (
              <Button size="sm" variant="secondary" disabled title={ru.start.creditsHint}>
                {ru.errors.topUp}
              </Button>
            )}
          </Alert>
        )}
      </main>

      {systems.length > 0 && (
        <section className={s.systems} aria-label={ru.start.systems}>
          <h2 className={s.systemsTitle}>{ru.start.systems}</h2>
          <ul className={s.systemsList}>
            {systems.map((sys) => (
              <li key={sys.id}>
                <a
                  href={`/s/${sys.id}`}
                  className={s.systemCard}
                  data-testid="start-system-card"
                  onClick={(e) => {
                    e.preventDefault();
                    navigate(`/s/${sys.id}`);
                  }}
                >
                  <span className={s.systemName}>{sys.name}</span>
                  <span title={sys.prodRevision ? ru.start.prodTitle : ru.start.draftTitle}>
                    <Pill tone={sys.prodRevision ? "ok" : "neutral"}>
                      {sys.prodRevision ? ru.start.stageProd : ru.start.stageDraft}
                    </Pill>
                  </span>
                  <span className={s.systemStage}>{ru.workspace.stage[sys.stage] ?? sys.stage}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
