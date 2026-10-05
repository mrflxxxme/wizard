// M2-72 (platform-screens.yaml S7, product.yaml#decisions.D56/D72): before publishing a change that removes data the
// owner reads the consequences counted on live data («Удаление поля „Телефон“ в разделе „Заявки“ затронет 112
// записей…») and confirms them; the confirmation holds for this revision and this list only. «Отменить правку»
// (UndoPanel) brings the last such change back from the archive. The API enforces both (owner only, D11).
import { Button } from "@wizard/ui-kit";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { ApiError } from "../../api/client.js";
import type { DestructiveConsequences, DestructiveJournal } from "../../api/types.js";
import { usePlatform } from "../../app/context.js";
import { Alert, Pill } from "../../components/ui.js";
import { destructiveRu as t } from "../../i18n/ru/destructive.js";
import s from "../../screens/workspace/Workspace.module.css";

const errText = (e: unknown) => (e instanceof Error ? e.message : t.loadError);

/** Publishing is allowed: nothing to confirm, or a fresh confirmation and no blocking line. */
export function destructiveReady(d: DestructiveConsequences | null): boolean {
  if (!d) return false;
  if (!d.required) return true;
  return !d.blocking && d.confirmation?.status === "confirmed";
}

export function DestructivePanel({
  systemId,
  revision,
  onReady,
}: {
  systemId: string;
  revision: number;
  /** Called with whether «Опубликовать» may be enabled. */
  onReady(ready: boolean): void;
}): ReactNode {
  const { api } = usePlatform();
  const [data, setData] = useState<DestructiveConsequences | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.getDestructive(systemId, revision));
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  }, [api, systemId, revision]);

  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  useEffect(() => onReady(destructiveReady(data)), [data, onReady]);

  async function confirm() {
    if (!data?.hash) return;
    setBusy(true);
    setNote(null);
    try {
      await api.confirmDestructive(systemId, { revision, hash: data.hash });
    } catch (e) {
      setNote(
        e instanceof ApiError && e.code === "DESTRUCTIVE_CONSEQUENCES_CHANGED" ? t.changed : errText(e),
      );
    } finally {
      setBusy(false);
      await load();
    }
  }

  if (error) return <Alert testId="destructive-error">{error}</Alert>;
  if (!data) return <p className={s.small}>{t.loading}</p>;
  if (!data.required) return null;
  const fresh = data.confirmation?.status === "confirmed";
  return (
    <section className={s.block} data-testid="destructive-panel" aria-label={t.title}>
      <h4 className={s.blockTitle}>{t.title}</h4>
      <p className={s.small}>{t.intro}</p>
      <ul className={s.diffList}>
        {data.changes.map((c) => (
          <li
            key={`${c.kind}:${c.entity}:${c.field ?? ""}`}
            className={c.blocking ? s.blocker : s.destructive}
            data-testid="destructive-line"
            data-blocking={c.blocking ? "true" : undefined}
          >
            {c.text_ru}
          </li>
        ))}
      </ul>
      {data.blocking ? (
        <Alert testId="destructive-blocking">{t.blocking}</Alert>
      ) : (
        <p className={s.small}>{t.archiveNote}</p>
      )}
      {fresh && !data.blocking && (
        <Pill tone="ok" testId="destructive-confirmed">
          {t.confirmed}
        </Pill>
      )}
      {data.confirmation?.status === "stale" && <Alert testId="destructive-stale">{t.stale}</Alert>}
      {!fresh && !data.blocking && (
        <div className={s.row}>
          {data.canConfirm ? (
            <Button
              variant="primary"
              data-testid="destructive-confirm"
              loading={busy}
              onClick={() => void confirm()}
            >
              {t.confirm}
            </Button>
          ) : (
            <p className={s.small} data-testid="destructive-owner-only">
              {t.ownerOnly}
            </p>
          )}
        </div>
      )}
      {note && <Alert testId="destructive-note">{note}</Alert>}
    </section>
  );
}

/** «Отменить правку»: shown while the last applied destructive change can still be undone. */
export function UndoPanel({
  systemId,
  prodRevision,
  onRun,
}: {
  systemId: string;
  /** Reload trigger: the journal changes with every publication. */
  prodRevision: number | null;
  onRun(runId: string): void;
}): ReactNode {
  const { api } = usePlatform();
  const [journal, setJournal] = useState<DestructiveJournal | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void prodRevision;
    api
      .listDestructiveChanges(systemId)
      .then((j) => live && setJournal(j))
      .catch(() => live && setJournal(null));
    return () => {
      live = false;
    };
  }, [api, systemId, prodRevision]);

  const change = journal?.undo ? journal.items.find((x) => x.id === journal.undo?.changeId) : undefined;
  if (!journal?.undo || !change) return null;

  async function undo(changeId: string) {
    setBusy(true);
    setNote(null);
    try {
      const r = await api.undoDestructiveChange(systemId, changeId);
      setNote(t.undoStarted);
      setJournal((j) => (j ? { ...j, undo: null } : j));
      onRun(r.run.id);
    } catch (e) {
      setNote(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={s.block} data-testid="destructive-undo" aria-label={t.undoTitle}>
      <h4 className={s.blockTitle}>{t.undoTitle}</h4>
      <ul className={s.diffList}>
        {change.consequences.map((c) => (
          <li key={`${c.kind}:${c.entity}:${c.field ?? ""}`} className={s.small}>
            {c.text_ru}
          </li>
        ))}
      </ul>
      <p className={s.small}>{t.undoIntro}</p>
      {journal.canUndo ? (
        <Button
          variant="secondary"
          data-testid="destructive-undo-submit"
          title={t.undoConfirm}
          loading={busy}
          onClick={() => void undo(change.id)}
        >
          {t.undo}
        </Button>
      ) : (
        <p className={s.small} data-testid="destructive-undo-owner-only">
          {t.undoOwnerOnly}
        </p>
      )}
      {note && <p className={s.small}>{note}</p>}
    </section>
  );
}
