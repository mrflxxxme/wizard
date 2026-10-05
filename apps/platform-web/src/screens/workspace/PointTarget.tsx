// S5 «Укажи и измени» in the chat (M3-01): the element picked in the preview as a context chip of the next message.
// The excerpt is the source line of the element (GET /systems/:id/files/*path at the shown revision), never the
// element's text from the preview: record data does not cross the bridge (platform-screens.yaml#preview_contract).
import { type ReactNode, useEffect, useState } from "react";
import type { MessageTarget } from "../../api/types.js";
import { usePlatform } from "../../app/context.js";
import { Specialist } from "../../components/ui.js";
import { ru } from "../../i18n/ru.js";
import s from "./Workspace.module.css";

/** builder.yaml#point_and_edit cap held by a point_edit run (platform-api POINT_EDIT_CAP_CREDITS). */
export const POINT_EDIT_CAP = 6;
const EXCERPT_MAX = 120;

/** Line `line` (1-based) of the source, whitespace collapsed, ≤ 120 chars; "" when out of range. */
export function sourceExcerpt(source: string, line: number): string {
  const text = (source.split("\n")[line - 1] ?? "").replace(/\s+/g, " ").trim();
  return text.length > EXCERPT_MAX ? `${text.slice(0, EXCERPT_MAX - 1)}…` : text;
}

export function TargetChip({
  systemId,
  revision,
  target,
  onClear,
}: {
  systemId: string;
  /** Revision whose source holds target.line (the one shown in the preview). */
  revision: number;
  target: MessageTarget;
  onClear(): void;
}): ReactNode {
  const { api } = usePlatform();
  const [excerpt, setExcerpt] = useState("");
  useEffect(() => {
    setExcerpt("");
    if (typeof api.getFileText !== "function" || revision < 1) return;
    let live = true;
    api
      .getFileText(systemId, target.file, revision)
      .then((src) => live && setExcerpt(sourceExcerpt(src, target.line)))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [api, systemId, revision, target.file, target.line]);

  return (
    <div className={s.targetChip} data-testid="chat-target" data-wz-id={target.wzId}>
      <span className={s.targetName}>{ru.point.chip(target.componentName)}</span>
      <button
        type="button"
        className={s.targetClear}
        aria-label={ru.point.clear}
        title={ru.point.clear}
        data-testid="chat-target-clear"
        onClick={onClear}
      >
        ×
      </button>
      <span className={s.small}>{ru.point.cost}</span>
      {/* D28: the file, line and source excerpt — only for a specialist. */}
      <Specialist testId="chat-target-specialist">
        <span data-testid="chat-target-file">{ru.point.where(target.file, target.line)}</span>
        {excerpt && (
          <code className={s.targetCode} data-testid="chat-target-excerpt">
            {excerpt}
          </code>
        )}
      </Specialist>
    </div>
  );
}
