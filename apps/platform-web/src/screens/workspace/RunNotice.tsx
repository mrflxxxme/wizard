// Feed entry of a publish or rollback run (platform-screens.yaml S6: «Публикация — прогон kind=publish в ленте»;
// S10: «прогон kind=rollback в ленте»): current step, result with the prod link, or the failure text.
import type { ReactNode } from "react";
import { Alert, Spinner } from "../../components/ui.js";
import { ru } from "../../i18n/ru.js";
import type { RunState } from "../../run/reducer.js";
import s from "./Workspace.module.css";

export function RunNotice({ run }: { run: RunState }): ReactNode {
  const title = run.kind === "rollback" ? ru.runs.rollback : ru.runs.publish;
  if (run.phase === "failed" && run.failure)
    return (
      <Alert testId="run-error">
        <b>{title}</b> <span>{run.failure.message_ru}</span>
      </Alert>
    );
  if (run.phase === "finished" && run.finished) {
    const url = run.finished.prodUrl;
    return (
      <div className={s.bubble} data-testid="run-result" role="status">
        <span className={s.bubbleAuthor}>{title}</span>
        <span className={s.bubbleText}>{run.finished.summary_ru ?? ru.runs.done}</span>
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
    <div className={s.bubble} data-testid="run-progress" aria-busy="true">
      <span className={s.bubbleAuthor}>{title}</span>
      <span className={s.row}>
        <Spinner label={ru.build.running} />
        <span>{step?.title ?? ru.build.running}</span>
      </span>
    </div>
  );
}
