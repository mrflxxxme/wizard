// S-code «Код — только чтение» (/s/:systemId/code?rev=N&path=…): file tree of a revision and a viewer with
// highlighting, «весь файл / изменения ревизии». No editing, no archive, no copy of the project (D14, non_goals).
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { ApiError } from "../../api/client.js";
import type { Revision, RevisionSummary, SystemView } from "../../api/types.js";
import { usePlatform } from "../../app/context.js";
import { navigate, setQueryParam, useRoute } from "../../app/router.js";
import { highlightLines, type Token } from "../../code/highlight.js";
import { type DiffRow, hunks, lineDiff } from "../../code/linediff.js";
import { Alert, Note, Pill } from "../../components/ui.js";
import { ru } from "../../i18n/ru.js";
import { MainTabs } from "../workspace/MainTabs.js";
import { Rail } from "../workspace/Rail.js";
import s from "./Code.module.css";

type Mode = "whole" | "changes";
type FileState =
  | { status: "idle" | "loading" }
  | { status: "ready"; text: string; before: string | null }
  | { status: "error"; message: string };

const errText = (e: unknown) => (e instanceof Error ? e.message : ru.errors.generic);

/** Tokens keyed by their offset in the line (stable for a given text). */
function Line({ tokens }: { tokens: Token[] }): ReactNode {
  let offset = 0;
  const keyed = tokens.map((t) => {
    const at = offset;
    offset += t.v.length;
    return { at, t };
  });
  return (
    <>
      {keyed.map(({ at, t }) =>
        t.k === "plain" ? (
          <span key={at}>{t.v}</span>
        ) : (
          <span key={at} className={s[t.k]}>
            {t.v}
          </span>
        ),
      )}
    </>
  );
}

function WholeFile({ text }: { text: string }): ReactNode {
  const lines = useMemo(() => highlightLines(text).map((tokens, i) => ({ n: i + 1, tokens })), [text]);
  return (
    <ol className={s.lines}>
      {lines.map(({ n, tokens }) => (
        <li key={n} className={s.line}>
          <span className={s.num} aria-hidden="true">
            {n}
          </span>
          <code className={s.code}>
            <Line tokens={tokens} />
          </code>
        </li>
      ))}
    </ol>
  );
}

function Changes({ before, after }: { before: string; after: string }): ReactNode {
  const rows = useMemo<{ id: number; r: DiffRow }[] | null>(() => {
    const d = lineDiff(before, after);
    return d ? hunks(d).map((r, id) => ({ id, r })) : null;
  }, [before, after]);
  if (!rows)
    return (
      <>
        <p className={s.muted}>{ru.code.tooBig}</p>
        <WholeFile text={after} />
      </>
    );
  if (rows.every(({ r }) => r.t === "gap" || r.t === "same"))
    return <p className={s.muted}>{ru.code.noChanges}</p>;
  return (
    <ol className={s.lines}>
      {rows.map(({ id, r }) =>
        r.t === "gap" ? (
          <li key={id} className={s.gap}>
            … {ru.code.lines(r.skipped)}
          </li>
        ) : (
          <li
            key={id}
            className={`${s.line} ${r.t === "add" ? s.add : r.t === "del" ? s.del : ""}`}
            data-diff={r.t}
          >
            <span className={s.num} aria-hidden="true">
              {r.n}
            </span>
            <span className={s.mark} aria-hidden="true">
              {r.t === "add" ? "+" : r.t === "del" ? "−" : " "}
            </span>
            {r.t !== "same" && (
              <span className={s.visuallyHidden}>{r.t === "add" ? ru.code.added : ru.code.removed}: </span>
            )}
            <code className={s.code}>
              <Line tokens={highlightLines(r.text)[0] ?? []} />
            </code>
          </li>
        ),
      )}
    </ol>
  );
}

/** Files grouped by their top directory (ui/, functions/…). */
function groupFiles(files: Revision["files"]): { dir: string; files: Revision["files"] }[] {
  const by = new Map<string, Revision["files"]>();
  for (const f of files) {
    const dir = f.path.includes("/") ? `${f.path.split("/")[0]}/` : "";
    by.set(dir, [...(by.get(dir) ?? []), f]);
  }
  const order = (d: string) => (d === "ui/" ? 0 : d === "functions/" ? 1 : d === "" ? 3 : 2);
  return [...by.entries()]
    .sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b))
    .map(([dir, fs]) => ({ dir, files: fs }));
}

export function CodeScreen({ systemId }: { systemId: string }): ReactNode {
  const { api } = usePlatform();
  const { search } = useRoute();
  const [view, setView] = useState<SystemView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<RevisionSummary[]>([]);
  const [rev, setRev] = useState<Revision | null>(null);
  const [parent, setParent] = useState<Revision | null>(null);
  const [file, setFile] = useState<FileState>({ status: "idle" });
  const revParam = Number(search.get("rev"));
  const path = search.get("path");
  const mode: Mode = search.get("view") === "changes" ? "changes" : "whole";
  const version = Number.isInteger(revParam) && revParam > 0 ? revParam : (view?.system.draftRevision ?? 0);

  useEffect(() => {
    let live = true;
    api
      .getSystem(systemId)
      .then((v) => live && setView(v))
      .catch(
        (e) =>
          live && setError(e instanceof ApiError && e.status === 404 ? ru.errors.systemNotFound : errText(e)),
      );
    api
      .listRevisions(systemId, 50)
      .then((r) => live && setRevisions(r.items))
      .catch(() => live && setRevisions([]));
    return () => {
      live = false;
    };
  }, [api, systemId]);

  useEffect(() => {
    if (version < 1) return;
    let live = true;
    setRev(null);
    setParent(null);
    api
      .getRevision(systemId, version)
      .then(async (r) => {
        if (!live) return;
        setRev(r);
        if (r.parentVersion) {
          const p = await api.getRevision(systemId, r.parentVersion).catch(() => null);
          if (live) setParent(p);
        }
      })
      .catch((e) => live && setError(errText(e)));
    return () => {
      live = false;
    };
  }, [api, systemId, version]);

  const files = rev?.files ?? [];
  const selected = path && files.some((f) => f.path === path) ? path : null;
  const parentSha = useMemo(() => new Map((parent?.files ?? []).map((f) => [f.path, f.sha256])), [parent]);
  const changed = (p: string, sha: string) => rev?.parentVersion != null && parentSha.get(p) !== sha;

  // Without ?path the first ui/ file (else the first file) opens.
  useEffect(() => {
    if (!rev || selected) return;
    const first = groupFiles(rev.files)[0]?.files[0];
    if (first) setQueryParam("path", first.path);
  }, [rev, selected]);

  useEffect(() => {
    if (!selected || !rev) return;
    let live = true;
    setFile({ status: "loading" });
    const inParent = parentSha.has(selected) && rev.parentVersion != null;
    Promise.all([
      api.getFileText(systemId, selected, rev.version),
      inParent ? api.getFileText(systemId, selected, rev.parentVersion as number).catch(() => null) : null,
    ])
      .then(([text, before]) => live && setFile({ status: "ready", text, before }))
      .catch((e) => live && setFile({ status: "error", message: errText(e) }));
    return () => {
      live = false;
    };
  }, [api, systemId, selected, rev, parentSha]);

  const name = view?.system.name ?? "";
  return (
    <div className={s.shell}>
      <Rail systemId={systemId} />
      <main className={s.page}>
        <header className={s.head}>
          <h1 className={s.title}>
            {name ? `${name} · ` : ""}
            {ru.code.title} <Pill tone="neutral">{ru.code.readOnly}</Pill>
          </h1>
          <MainTabs systemId={systemId} active="code" />
          <span className={s.spacer} />
          {revisions.length > 0 && (
            <label className={s.revSelect}>
              <span>{ru.code.revisionSelect}</span>
              <select
                value={version}
                onChange={(e) => {
                  const u = new URL(window.location.href);
                  u.searchParams.set("rev", e.target.value);
                  navigate(u.pathname + u.search, { replace: true });
                }}
              >
                {revisions.map((r) => (
                  <option key={r.version} value={r.version}>
                    {ru.code.revision(r.version)}
                    {r.summary_ru ? ` · ${r.summary_ru}` : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
        </header>
        {error && <Alert>{error}</Alert>}
        <Note>{ru.code.aiNotice}</Note>
        <div className={s.body}>
          <nav className={s.tree} aria-label={ru.code.tree} data-testid="code-tree">
            {rev && files.length === 0 && <p className={s.muted}>{ru.code.noFiles}</p>}
            {!rev && !error && <p className={s.muted}>{ru.code.loading}</p>}
            {groupFiles(files).map((g) => (
              <div key={g.dir} className={s.group}>
                {g.dir && <h2 className={s.dir}>{g.dir}</h2>}
                <ul className={s.files}>
                  {g.files.map((f) => (
                    <li key={f.path}>
                      <a
                        href={`/s/${systemId}/code?rev=${version}&path=${encodeURIComponent(f.path)}`}
                        className={f.path === selected ? s.fileOn : s.file}
                        aria-current={f.path === selected ? "page" : undefined}
                        data-testid="code-file"
                        data-path={f.path}
                        onClick={(e) => {
                          e.preventDefault();
                          setQueryParam("path", f.path);
                        }}
                      >
                        {g.dir ? f.path.slice(g.dir.length) : f.path}
                        {changed(f.path, f.sha256) && (
                          <span className={s.changedMark} title={ru.code.changes}>
                            {" "}
                            •
                          </span>
                        )}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
          <section className={s.viewer} aria-label={selected ?? ru.code.pickFile} data-testid="code-viewer">
            <div className={s.viewerBar}>
              <span className={s.path}>{selected ?? ru.code.pickFile}</span>
              <span className={s.spacer} />
              <fieldset className={s.segmented}>
                <legend className={s.visuallyHidden}>{ru.code.viewMode}</legend>
                {(["whole", "changes"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={mode === m ? s.segOn : s.seg}
                    aria-pressed={mode === m}
                    onClick={() => setQueryParam("view", m === "whole" ? null : m)}
                  >
                    {m === "whole" ? ru.code.whole : ru.code.changes}
                  </button>
                ))}
              </fieldset>
            </div>
            {file.status === "loading" && <p className={s.muted}>{ru.code.loading}</p>}
            {file.status === "error" && <Alert>{file.message}</Alert>}
            {file.status === "ready" &&
              (mode === "whole" ? (
                <WholeFile text={file.text} />
              ) : file.before === null ? (
                <>
                  <p className={s.muted}>{ru.code.newFile}</p>
                  <WholeFile text={file.text} />
                </>
              ) : (
                <Changes before={file.before} after={file.text} />
              ))}
          </section>
        </div>
      </main>
    </div>
  );
}
