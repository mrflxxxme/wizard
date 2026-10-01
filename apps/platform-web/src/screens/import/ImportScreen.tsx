// S-import /s/:systemId/import/:importId (platform-screens.yaml S-import, M1-12): column profiles without cell
// values, the proposed mapping (existing field / new field / skip) with the PII mark, confirmation of the import_table
// run (needs_input import_confirm), progress and result. State is polled from GET /systems/:id/imports/:importId.
import { Button } from "@wizard/ui-kit";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { ApiError } from "../../api/client.js";
import type { ImportColumnMapping, ImportProfileItem, ImportView, SystemView } from "../../api/types.js";
import { canEdit, usePlatform } from "../../app/context.js";
import { navigate } from "../../app/router.js";
import { Alert, Note, Spinner } from "../../components/ui.js";
import { ru } from "../../i18n/ru.js";
import { Rail } from "../workspace/Rail.js";
import s from "./Import.module.css";

/** Field types the import loads values into (platform-api imports/load.ts IMPORTABLE). */
export const IMPORTABLE_TYPES: ReadonlySet<string> = new Set([
  "string",
  "text",
  "int",
  "decimal",
  "money",
  "bool",
  "date",
  "datetime",
  "enum",
  "email",
  "phone",
  "url",
]);

export interface EntityRef {
  name: string;
  label?: string;
  fields: { name: string; label?: string; type: string }[];
}

const POLL_MS = 800;
const ACTIVE = new Set(["profiling", "mapping", "importing"]);

const errText = (e: unknown) => (e instanceof Error ? e.message : ru.errors.generic);

/** <select> value of a mapping item: skip | map:<entity>.<field> | new:<entity>. */
export function targetValue(m: ImportColumnMapping | undefined): string {
  if (!m || m.action === "skip" || !m.entity) return "skip";
  if (m.action === "map" && m.field) return `map:${m.entity}.${m.field}`;
  if (m.action === "new_field") return `new:${m.entity}`;
  return "skip";
}

/** Applies a target <select> value to a mapping item (pii and the new field name are kept where they apply). */
export function applyTarget(m: ImportColumnMapping, value: string): ImportColumnMapping {
  const pii = m.pii ? { pii: m.pii } : {};
  if (value.startsWith("map:")) {
    const [entity, field] = value.slice(4).split(".");
    return { column: m.column, action: "map", entity: entity as string, field: field as string, ...pii };
  }
  if (value.startsWith("new:")) {
    const entity = value.slice(4);
    const keep = m.action === "new_field" && m.entity === entity && m.field ? { field: m.field } : {};
    return { column: m.column, action: "new_field", entity, ...keep, ...pii };
  }
  return { column: m.column, action: "skip", ...pii };
}

/** Full mapping for PUT: one item per profile column; unknown columns default to skip with the PII guess. */
export function fullMapping(
  profile: readonly ImportProfileItem[],
  draft: ReadonlyMap<string, ImportColumnMapping>,
): ImportColumnMapping[] {
  return profile.map(
    (p) =>
      draft.get(p.column) ?? {
        column: p.column,
        action: "skip",
        pii: p.piiKindGuess !== null ? "basic" : "none",
      },
  );
}

function entitiesOf(spec: unknown): EntityRef[] {
  const list = (spec as { entities?: unknown } | null)?.entities;
  return Array.isArray(list) ? (list as EntityRef[]) : [];
}

function TargetSelect({
  item,
  entities,
  disabled,
  invalid,
  describedBy,
  onChange,
}: {
  item: ImportColumnMapping;
  entities: readonly EntityRef[];
  disabled: boolean;
  invalid: boolean;
  describedBy: string | undefined;
  onChange(value: string): void;
}): ReactNode {
  const value = targetValue(item);
  const known = entities.some((e) =>
    e.fields.some((f) => value === `map:${e.name}.${f.name}` && IMPORTABLE_TYPES.has(f.type)),
  );
  return (
    <select
      className={s.select}
      value={value}
      disabled={disabled}
      aria-label={ru.import.targetLabel(item.column)}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      data-testid={`import-target-${item.column}`}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="skip">{ru.import.skip}</option>
      {value.startsWith("map:") && !known && <option value={value}>{value.slice(4)}</option>}
      {entities.map((e) => {
        const fields = e.fields.filter((f) => IMPORTABLE_TYPES.has(f.type));
        if (fields.length === 0) return null;
        return (
          <optgroup key={e.name} label={e.label ?? e.name}>
            {fields.map((f) => (
              <option key={f.name} value={`map:${e.name}.${f.name}`}>
                {`${e.label ?? e.name} · ${f.label ?? f.name}`}
              </option>
            ))}
          </optgroup>
        );
      })}
      {entities.length > 0 && (
        <optgroup label={ru.import.newGroup}>
          {entities.map((e) => (
            <option key={e.name} value={`new:${e.name}`}>
              {ru.import.newIn(e.label ?? e.name)}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
}

export function ImportScreen({ systemId, importId }: { systemId: string; importId: string }): ReactNode {
  const { api, roleIn, auth } = usePlatform();
  const [system, setSystem] = useState<SystemView | null>(null);
  const [entities, setEntities] = useState<EntityRef[]>([]);
  const [view, setView] = useState<ImportView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Map<string, ImportColumnMapping>>(new Map());
  const [seeded, setSeeded] = useState(false);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"confirm" | "cancel" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const role = roleIn(system?.system.orgId);
  const editor = canEdit(role, auth);
  const denied = system !== null && !editor;

  // System (name, org role) and the preview spec: targets are fields of the revision the rows are loaded into.
  useEffect(() => {
    let live = true;
    api
      .getSystem(systemId)
      .then(async (v) => {
        if (!live) return;
        setSystem(v);
        const rev = v.system.previewRevision ?? null;
        if (rev === null) return;
        const r = await api.getRevision(systemId, rev).catch(() => null);
        if (live && r) setEntities(entitiesOf(r.spec));
      })
      .catch(
        (e) =>
          live &&
          setLoadError(e instanceof ApiError && e.status === 404 ? ru.errors.systemNotFound : errText(e)),
      );
    return () => {
      live = false;
    };
  }, [api, systemId]);

  const load = useCallback(async () => {
    try {
      const v = await api.getImport(systemId, importId);
      setView(v);
      return v;
    } catch (e) {
      setLoadError(errText(e));
      return null;
    }
  }, [api, systemId, importId]);

  // Polling while the run profiles, maps or loads rows; awaiting_confirm waits for its inputId (needs_input).
  useEffect(() => {
    if (!system || denied || loadError) return;
    const waiting =
      view === null ||
      ACTIVE.has(view.status) ||
      (view.status === "awaiting_confirm" && view.inputId === null);
    if (!waiting) return;
    const t = setTimeout(() => void load(), view === null ? 0 : POLL_MS);
    return () => clearTimeout(t);
  }, [system, denied, loadError, view, load]);

  // The proposed mapping becomes the editable draft once (later polls must not overwrite the user's edits).
  useEffect(() => {
    if (seeded || !view || view.mapping.length === 0) return;
    setDraft(new Map(view.mapping.map((m) => [m.column, m])));
    setSeeded(true);
  }, [view, seeded]);

  // Failure text of the run (cancelled → «Импорт отменён»).
  useEffect(() => {
    if (view?.status !== "failed" || !view.runId) return;
    let live = true;
    api
      .getRun(view.runId)
      .then((r) => {
        if (!live) return;
        setFailure(r.status === "cancelled" ? ru.import.cancelled : (r.failure?.message_ru ?? null));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [api, view?.status, view?.runId]);

  const profile = view?.profile ?? [];
  const mapping = useMemo(() => fullMapping(profile, draft), [profile, draft]);
  const editable = view?.status === "awaiting_confirm" && view.inputId !== null && busy === null;
  const loading = mapping.filter((m) => m.action !== "skip").length;

  function update(column: string, fn: (m: ImportColumnMapping) => ImportColumnMapping) {
    const current = mapping.find((m) => m.column === column);
    if (!current) return;
    setDraft((d) => new Map(d).set(column, fn(current)));
    setProblems(({ [column]: _drop, ...rest }) => rest);
  }

  async function confirm() {
    if (!view?.runId || !view.inputId) return;
    setBusy("confirm");
    setError(null);
    setProblems({});
    try {
      await api.updateImportMapping(systemId, importId, mapping);
    } catch (e) {
      const list =
        e instanceof ApiError ? (e.details?.problems as { column: string; message_ru: string }[]) : null;
      if (Array.isArray(list) && list.length > 0) {
        setProblems(Object.fromEntries(list.map((p) => [p.column, p.message_ru])));
        setError(ru.import.problems);
      } else setError(errText(e));
      if (e instanceof ApiError && e.status === 409) void load();
      setBusy(null);
      return;
    }
    try {
      await api.provideInput(view.runId, { inputId: view.inputId, choice: "confirm" });
      setView({ ...view, status: "importing", inputId: null });
    } catch (e) {
      setError(errText(e));
      void load();
    } finally {
      setBusy(null);
    }
  }

  async function cancel() {
    if (!view) return;
    setBusy("cancel");
    setError(null);
    try {
      if (view.runId && view.inputId)
        await api.provideInput(view.runId, { inputId: view.inputId, choice: "cancel" });
      else if (view.runId && ACTIVE.has(view.status)) await api.cancelRun(view.runId);
      navigate(`/s/${systemId}`);
    } catch (e) {
      setError(errText(e));
      setBusy(null);
    }
  }

  const toSystem = () => navigate(`/s/${systemId}`);
  const status = view?.status;
  const showTable =
    profile.length > 0 && (status === "awaiting_confirm" || status === "importing" || status === "done");

  let body: ReactNode;
  if (loadError) body = <Alert testId="import-error">{loadError}</Alert>;
  else if (denied) body = <Alert testId="import-error">{ru.import.editorOnly}</Alert>;
  else if (!view)
    body = (
      <p className={s.muted} aria-busy="true">
        {ru.import.loading}
      </p>
    );
  else
    body = (
      <>
        {status && ru.import.status[status] && (
          <p className={s.progress} role="status" aria-live="polite" data-testid="import-progress">
            <Spinner label={ru.import.status[status]} />
            <span>{ru.import.status[status]}</span>
          </p>
        )}
        {status === "awaiting_confirm" && view.inputId === null && (
          <p className={s.progress} aria-busy="true">
            <Spinner label={ru.import.status.mapping} />
            <span>{ru.import.status.mapping}</span>
          </p>
        )}
        {status === "done" && (
          <div className={s.result} role="status" data-testid="import-result">
            <b>{ru.import.done(view.rowsImported ?? 0)}</b>
            <Button variant="primary" size="sm" data-testid="import-open-system" onClick={toSystem}>
              {ru.import.toSystem}
            </Button>
          </div>
        )}
        {(status === "failed" || status === "expired") && (
          <Alert testId="import-failed">
            <b>{ru.import.failed}.</b>{" "}
            <span>{status === "expired" ? ru.import.expired : (failure ?? ru.errors.generic)}</span>
            <Button variant="secondary" size="sm" onClick={toSystem}>
              {ru.import.again}
            </Button>
          </Alert>
        )}
        {showTable && (
          <>
            {status === "awaiting_confirm" && <p className={s.lead}>{ru.import.lead}</p>}
            <div className={s.tableWrap}>
              <table className={s.table}>
                <caption className={s.visuallyHidden}>{ru.import.caption}</caption>
                <thead>
                  <tr>
                    <th scope="col">{ru.import.colColumn}</th>
                    <th scope="col">{ru.import.colType}</th>
                    <th scope="col">{ru.import.colFill}</th>
                    <th scope="col">{ru.import.colPii}</th>
                    <th scope="col">{ru.import.colTarget}</th>
                  </tr>
                </thead>
                <tbody>
                  {profile.map((p, i) => {
                    const m = mapping[i] as ImportColumnMapping;
                    const problem = problems[p.column];
                    const problemId = problem ? `import-problem-${i}` : undefined;
                    const guessId = p.piiKindGuess ? `import-guess-${i}` : undefined;
                    return (
                      <tr
                        key={p.column}
                        data-testid={`import-row-${p.column}`}
                        className={problem ? s.rowInvalid : undefined}
                      >
                        <th scope="row" className={s.column}>
                          {p.column}
                        </th>
                        <td data-label={ru.import.colType}>{ru.import.types[p.typeGuess] ?? p.typeGuess}</td>
                        <td data-label={ru.import.colFill} className={s.muted}>
                          {ru.import.fill(p.nullShare, p.distinct)}
                        </td>
                        <td data-label={ru.import.colPii}>
                          <select
                            className={s.select}
                            value={m.pii ?? "none"}
                            disabled={!editable}
                            aria-label={ru.import.piiLabel(p.column)}
                            aria-describedby={guessId}
                            data-testid={`import-pii-${p.column}`}
                            onChange={(e) =>
                              update(p.column, (x) => ({ ...x, pii: e.target.value as "none" | "basic" }))
                            }
                          >
                            <option value="none">{ru.import.piiNone}</option>
                            <option value="basic">{ru.import.piiBasic}</option>
                          </select>
                          {p.piiKindGuess && (
                            <span id={guessId} className={s.hint}>
                              {ru.import.piiGuess(ru.import.piiKinds[p.piiKindGuess] ?? p.piiKindGuess)}
                            </span>
                          )}
                        </td>
                        <td data-label={ru.import.colTarget}>
                          <div className={s.target}>
                            <TargetSelect
                              item={m}
                              entities={entities}
                              disabled={!editable}
                              invalid={!!problem}
                              describedBy={problemId}
                              onChange={(value) => update(p.column, (x) => applyTarget(x, value))}
                            />
                            {m.action === "new_field" && (
                              <input
                                className={s.input}
                                value={m.field ?? ""}
                                disabled={!editable}
                                maxLength={63}
                                placeholder={ru.import.newNamePlaceholder}
                                aria-label={ru.import.newName(p.column)}
                                data-testid={`import-new-field-${p.column}`}
                                onChange={(e) => {
                                  const field = e.target.value.trim();
                                  update(p.column, ({ field: _f, ...x }) => (field ? { ...x, field } : x));
                                }}
                              />
                            )}
                            {problem && (
                              <span id={problemId} className={s.problem}>
                                {problem}
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
        {error && <Alert testId="import-action-error">{error}</Alert>}
        {(status === "awaiting_confirm" || status === "profiling" || status === "mapping") && (
          <footer className={s.footer}>
            <Button
              variant="primary"
              data-testid="import-confirm"
              disabled={!editable || loading === 0}
              loading={busy === "confirm"}
              title={loading === 0 ? ru.import.confirmHint : undefined}
              onClick={() => void confirm()}
            >
              {ru.import.confirm(loading)}
            </Button>
            <Button
              variant="secondary"
              data-testid="import-cancel"
              disabled={busy !== null}
              loading={busy === "cancel"}
              onClick={() => void cancel()}
            >
              {ru.import.cancel}
            </Button>
          </footer>
        )}
      </>
    );

  return (
    <div className={s.shell}>
      <Rail systemId={systemId} />
      <main className={s.page}>
        <header className={s.head}>
          <h1 className={s.title}>
            {ru.import.title}
            {system?.system.name ? ` · ${system.system.name}` : ""}
          </h1>
          <span className={s.spacer} />
          <a
            href={`/s/${systemId}`}
            className={s.link}
            onClick={(e) => {
              e.preventDefault();
              toSystem();
            }}
          >
            {ru.import.back}
          </a>
        </header>
        <Note testId="import-notice">{ru.import.notice}</Note>
        {body}
      </main>
    </div>
  );
}
