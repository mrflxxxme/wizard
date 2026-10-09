// RecordAction buttons shared by RecordCard and DataTable (ui-kit.yaml#components.RecordCard.behaviour).
import { type ReactNode, useState } from "react";
import { useCan, useDataSource, useNavigate } from "../data/context.js";
import type { Rec, WzError } from "../data/types.js";
import { ru } from "../i18n/ru.js";
import { ButtonImpl } from "./Button.js";
import styles from "./RecordActions.module.css";
import { part } from "./root.js";
import type { RecordAction } from "./types.js";

const OP = { update: "update", delete: "delete" } as const;

/** Actions allowed for the role and the row: can(kind→op) and no update of a readonly field. */
export function useVisibleActions<T>(
  entity: string,
  actions: RecordAction<T>[] | undefined,
  row: T | undefined,
) {
  const can = useCan();
  if (!row || !actions) return [];
  return actions.filter((a) => {
    if (a.visible && !a.visible(row)) return false;
    if (a.kind === "update") {
      if (!can("update", entity)) return false;
      return Object.keys(a.patch ?? {}).every((f) => can("update", entity, f));
    }
    if (a.kind === "delete") return can(OP.delete, entity);
    // The runtime requires the update operation on the entity for an AI action (runtime.yaml#ai_actions).
    if (a.kind === "ai") return !!a.ai && can("update", entity);
    return true;
  });
}

export function RecordActions<T>({
  entity,
  row,
  actions,
  testPrefix,
  onDone,
  onDeleted,
}: {
  entity: string;
  row: T;
  actions: RecordAction<T>[] | undefined;
  testPrefix: string;
  onDone?(): void;
  onDeleted?(): void;
}): ReactNode {
  const ds = useDataSource();
  const navigate = useNavigate();
  const update = ds.useUpdate(entity);
  const remove = ds.useRemove(entity);
  const call = ds.useCall();
  const ai = ds.useAiAction();
  const visible = useVisibleActions(entity, actions, row);
  const [confirming, setConfirming] = useState<RecordAction<T> | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const id = String((row as Rec).id);

  const run = async (a: RecordAction<T>) => {
    setConfirming(null);
    setStatus(null);
    if (a.kind === "link") {
      if (a.href) navigate(a.href.replace(":id", encodeURIComponent(id)));
      return;
    }
    setPending(a.id);
    try {
      if (a.kind === "update") await update.mutate(id, a.patch ?? {});
      else if (a.kind === "delete") await remove.mutate(id);
      else if (a.kind === "ai" && a.ai) {
        const r = await ai.mutate(a.ai, entity, id);
        setStatus({ ok: true, text: r.filled.length > 0 ? ru.ai.done : ru.ai.nothing });
        onDone?.();
        return;
      } else if (a.fn) await call.mutate(a.fn, { ...a.args, id });
      setStatus({ ok: true, text: ru.states.saved });
      if (a.kind === "delete") onDeleted?.();
      onDone?.();
    } catch (e) {
      setStatus({ ok: false, text: (e as WzError).message });
    } finally {
      setPending(null);
    }
  };

  if (!visible.length && !status) return null;
  return (
    <div className={styles.actions}>
      {confirming ? (
        // biome-ignore lint/a11y/useSemanticElements: an inline confirmation, not a form fieldset
        <div className={styles.confirm} role="group" aria-label={confirming.label}>
          <span>{confirming.confirm}</span>
          <ButtonImpl
            root={part(`${testPrefix}-confirm`)}
            variant={confirming.tone === "danger" ? "danger" : "primary"}
            size="sm"
            onClick={() => void run(confirming)}
          >
            {ru.recordCard.confirm}
          </ButtonImpl>
          <ButtonImpl
            root={part(`${testPrefix}-cancel`)}
            size="sm"
            variant="ghost"
            onClick={() => setConfirming(null)}
          >
            {ru.recordCard.cancel}
          </ButtonImpl>
        </div>
      ) : (
        visible.map((a) => (
          <ButtonImpl
            key={a.id}
            root={part(`${testPrefix}-${a.id}`)}
            size="sm"
            variant={a.tone === "primary" ? "primary" : a.tone === "danger" ? "danger" : "secondary"}
            loading={pending === a.id}
            onClick={(e) => {
              e.stopPropagation();
              if (a.confirm || a.kind === "delete") setConfirming(a);
              else void run(a);
            }}
          >
            {a.label}
          </ButtonImpl>
        ))
      )}
      {status && (
        <p role={status.ok ? "status" : "alert"} className={status.ok ? styles.ok : styles.bad}>
          {status.text}
        </p>
      )}
    </div>
  );
}
