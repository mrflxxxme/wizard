// Publish / rollback run of a v2 screen (S10 «прогон kind=rollback», B2-33): current step, the result with the prod
// link, or the failure text. Same test ids as the legacy workspace feed entry (run-progress, run-result, run-error).
import type { ReactNode } from "react";
import { ru } from "../../i18n/ru.js";
import type { RunState } from "../../run/reducer.js";
import { Alert, Spinner } from "../ui.js";
import s from "./RunStatus.module.css";

export function RunStatus({ run }: { run: RunState }): ReactNode {
  const title =
    run.kind === "rollback"
      ? ru.runs.rollback
      : run.kind === "import_table"
        ? ru.runs.import
        : ru.runs.publish;
  if (run.phase === "failed" && run.failure)
    return (
      <Alert testId="run-error">
        <b>{title}</b> <span>{run.failure.message_ru}</span>
      </Alert>
    );
  if (run.phase === "finished" && run.finished) {
    const url = run.finished.prodUrl;
    return (
      <div className={s.card} data-testid="run-result" role="status">
        <span className={s.title}>{title}</span>
        <span>{run.finished.summary_ru ?? ru.runs.done}</span>
        {url && (
          <a href={url} target="_blank" rel="noopener noreferrer" data-testid="run-prod-url">
            {ru.runs.open(url)}
          </a>
        )}
      </div>
    );
  }
  const step = [...run.steps].reverse().find((x) => x.status === "running");
  return (
    <div className={s.card} data-testid="run-progress" aria-busy="true">
      <span className={s.title}>{title}</span>
      <span className={s.row}>
        <Spinner label={ru.build.running} />
        <span>{step?.title ?? ru.build.running}</span>
      </span>
    </div>
  );
}
