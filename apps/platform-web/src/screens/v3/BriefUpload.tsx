// «Приложить ТЗ» on the canvas (V3-04 POST /systems/:id/brief/upload, api.yaml uploadSystemBrief): the paperclip of the
// input row sends the file with the share sent so far, the server's Russian reason of a refusal (413, 415, 400, 412)
// goes back to the row, and the answer — the new version of the brief with its diagrams — is taken by the canvas at
// once; the card in the chat shows the short brief and what the interview will still ask (gaps).
import { type BriefDiagramKey, BriefSummary, type ComposerAttach } from "@wizard/ui-kit/v2";
import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { ApiError } from "../../api/client.js";
import type { BriefUpload } from "../../api/types.js";
import { usePlatform } from "../../app/context.js";
import s from "./BriefUpload.module.css";
import { v3Ru } from "./ru.js";

const T = v3Ru.upload;

/** The Russian reason of a failed upload: the server's message, or a plain one by the status. */
export function uploadErrorText(e: unknown): string {
  if (e instanceof ApiError) {
    const own = /[а-яё]/i.test(e.message) && e.code !== "INTERNAL" ? e.message : null;
    if (own) return own;
    if (e.status === 413) return T.tooLarge;
    if (e.status === 415) return T.unsupported;
    return e.message || T.failed;
  }
  return e instanceof Error && /[а-яё]/i.test(e.message) ? e.message : T.failed;
}

export interface BriefUploadOptions {
  /** The new version of the brief (the canvas takes it without asking again). */
  onUploaded(r: BriefUpload): void;
  /** Opens the «Бриф» panel (a thumbnail or «Открыть бриф целиком» of the card). */
  onOpen?(diagram?: BriefDiagramKey): void;
  announce?(text: string): void;
}

export interface BriefUploadState {
  /** The paperclip of Composer. */
  attach: ComposerAttach;
  /** The share sent while the file goes up (role=status line), null otherwise. */
  progress: ReactNode;
  /** The result card for the chat (null before an upload or after «Понятно»). */
  card: ReactNode;
}

export function useBriefUpload(systemId: string, o: BriefUploadOptions): BriefUploadState {
  const { api } = usePlatform();
  const [pct, setPct] = useState<number | null>(null);
  const [result, setResult] = useState<BriefUpload | null>(null);
  const cb = useRef(o);
  cb.current = o;

  const onFile = useCallback(
    async (file: File) => {
      setResult(null);
      setPct(0);
      try {
        const r = await api.uploadBrief(systemId, file, (share) =>
          setPct(Math.min(100, Math.round(share * 100))),
        );
        setResult(r);
        cb.current.onUploaded(r);
        cb.current.announce?.(r.changed ? T.title : T.titleSame);
      } catch (e) {
        throw new Error(uploadErrorText(e));
      } finally {
        setPct(null);
      }
    },
    [api, systemId],
  );
  const attach = useMemo<ComposerAttach>(() => ({ onFile }), [onFile]);

  const progress =
    pct !== null && pct < 100 ? (
      <p className={s.progress} role="status" data-testid="canvas-upload-progress">
        <span>{T.sending(pct)}</span>
        <span className={s.bar} aria-hidden="true">
          <span className={s.fill} style={{ transform: `scaleX(${pct / 100})` }} />
        </span>
      </p>
    ) : null;
  const card = result ? (
    <UploadCard result={result} onClose={() => setResult(null)} {...(o.onOpen ? { onOpen: o.onOpen } : {})} />
  ) : null;
  return { attach, progress, card };
}

/** The result of an upload in the chat: where the draft came from, the short brief and the gaps of the interview. */
export function UploadCard({
  result,
  onOpen,
  onClose,
}: {
  result: BriefUpload;
  onOpen?(diagram?: BriefDiagramKey): void;
  onClose(): void;
}): ReactNode {
  const src = result.source;
  const meta = [
    T.format[src.format] ?? src.format,
    src.pages ? T.pages(src.pages) : "",
    src.truncated ? T.truncated : "",
    src.method === "heuristic" ? T.heuristic : "",
    src.piiReplaced > 0 ? T.pii(src.piiReplaced) : "",
  ].filter(Boolean);
  const missing = result.gaps.sections.filter((x) => x.status !== "filled");
  const filled = result.gaps.sections.filter((x) => x.status === "filled").map((x) => x.label);
  return (
    <section className={s.card} aria-label={T.title} data-testid="canvas-upload-card">
      <div className={s.head}>
        <p className={s.title}>{result.changed ? T.title : T.titleSame}</p>
        <button type="button" className={s.close} data-testid="canvas-upload-close" onClick={onClose}>
          {T.close}
        </button>
      </div>
      <p className={s.meta} data-testid="canvas-upload-source">
        {meta.join(" · ")}
      </p>
      {missing.length > 0 ? (
        <div className={s.gaps} data-testid="canvas-upload-gaps">
          <p className={s.sub}>{T.ask}:</p>
          <ul>
            {missing.map((g) => (
              <li
                key={g.section}
                data-testid="canvas-upload-gap"
                data-section={g.section}
                data-blocking={g.blocking || undefined}
              >
                <b>{g.label}</b>
                {g.blocking && <span className={s.must}> · {T.blocking}</span>}
                {g.notes.length > 0 && <span className={s.note}>: {g.notes.join("; ")}</span>}
              </li>
            ))}
          </ul>
          {filled.length > 0 && <p className={s.meta}>{T.filled(filled.join(", "))}</p>}
        </div>
      ) : (
        <p className={s.sub}>{T.none}</p>
      )}
      <BriefSummary
        testId="canvas-upload-summary"
        brief={result.brief.brief}
        diagrams={result.diagrams}
        version={result.brief.version}
        title="Черновик брифа по ТЗ"
        {...(onOpen ? { onOpen } : {})}
      />
    </section>
  );
}
