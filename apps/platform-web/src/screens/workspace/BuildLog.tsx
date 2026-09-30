// S4 «Ход сборки»: steps, gates, agent messages, needs_input, budget, errors (platform-screens.yaml#sse.events).
import { Button } from "@wizard/ui-kit";
import { type ReactNode, useState } from "react";
import type { GateLevel, GateReport } from "../../api/types.js";
import { Alert, Pill, StatusIcon } from "../../components/ui.js";
import { ru } from "../../i18n/ru.js";
import type { GateRow, NeedsInput, RunState } from "../../run/reducer.js";
import s from "./Workspace.module.css";

const LEVELS: GateLevel[] = ["G0", "G1", "G2"];

function gateFromReport(r: GateReport | undefined): GateRow | null {
  if (!r) return null;
  return {
    status: r.passed ? "passed" : "failed",
    totalChecks: r.checks.length,
    failedChecks: r.checks
      .filter((c) => c.status === "fail" || c.status === "error")
      .map((c) => ({ id: c.id, message_ru: c.message_ru, ...(c.file ? { file: c.file } : {}) })),
  };
}

function GateLine({ level, row }: { level: GateLevel; row: GateRow }): ReactNode {
  const [open, setOpen] = useState(false);
  const total = row.totalChecks;
  const passedCount = total !== undefined ? total - row.failedChecks.length : undefined;
  const icon =
    row.status === "passed"
      ? "done"
      : row.status === "failed"
        ? "failed"
        : row.status === "running"
          ? "running"
          : "queued";
  return (
    <li className={s.gateRow} data-testid={`gate-row-${level}`} data-status={row.status}>
      <StatusIcon status={icon} />
      <span title={ru.build.gate[level]} className={s.gateLevel}>
        {level}
      </span>
      <span className={s.muted}>
        {row.status === "pending" && level === "G2" ? ru.build.afterG1 : ru.build.gateStatus[row.status]}
      </span>
      {passedCount !== undefined && total !== undefined && (
        <span className={s.muted}>{ru.build.gateCount(passedCount, total)}</span>
      )}
      {row.failedChecks.length > 0 && (
        <button type="button" className={s.linkButton} aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? ru.gates.hideChecks : ru.gates.showChecks}
        </button>
      )}
      {open && (
        <ul className={s.checks}>
          {row.failedChecks.map((c) => (
            <li key={c.id}>
              {c.message_ru}
              {c.file ? ` (${c.file}${c.line ? `:${c.line}` : ""})` : ""}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function Decision({
  input,
  onAnswer,
}: {
  input: NeedsInput;
  onAnswer(body: { inputId: string; choice?: string; text?: string; secretValue?: string }): Promise<void>;
}): ReactNode {
  const rec = input.options.find((o) => o.recommended)?.id ?? input.options[0]?.id ?? "";
  const [choice, setChoice] = useState(rec);
  const [text, setText] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const selected = input.options.find((o) => o.id === choice);
  const send = async (body: { inputId: string; choice?: string; text?: string; secretValue?: string }) => {
    setBusy(true);
    try {
      await onAnswer(body);
    } finally {
      setBusy(false);
    }
  };
  if (input.kind === "secret") {
    const test = input.options.find((o) => o.id === "test");
    return (
      <form
        className={s.decision}
        data-testid="secret-request"
        onSubmit={(e) => {
          e.preventDefault();
          const v = secret;
          setSecret("");
          void send({ inputId: input.inputId, secretValue: v });
        }}
      >
        <p>{ru.build.secretTitle(input.secretName ?? input.prompt_ru)}</p>
        <label className={s.field}>
          {ru.build.secretLabel}
          <input
            type="password"
            autoComplete="off"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            maxLength={4096}
          />
        </label>
        <div className={s.row}>
          <Button type="submit" variant="primary" disabled={!secret || busy}>
            {ru.build.secretEnter}
          </Button>
          {test && (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => void send({ inputId: input.inputId, choice: "test" })}
            >
              {test.label || ru.build.secretTest}
            </Button>
          )}
        </div>
      </form>
    );
  }
  return (
    <form
      className={s.decision}
      data-testid="needs-input-decision"
      onSubmit={(e) => {
        e.preventDefault();
        void send({
          inputId: input.inputId,
          choice,
          ...(selected?.freeText && text.trim() ? { text: text.trim() } : {}),
        });
      }}
    >
      <p className={s.decisionPrompt}>{input.prompt_ru}</p>
      <div role="radiogroup" aria-label={input.prompt_ru} className={s.options}>
        {input.options.map((o) => (
          <label key={o.id} className={s.option} data-testid={`needs-input-option-${o.id}`}>
            <input
              type="radio"
              name={`input-${input.inputId}`}
              value={o.id}
              checked={choice === o.id}
              onChange={() => setChoice(o.id)}
            />
            <span className={s.optionLabel}>
              {o.label} {o.recommended && <Pill tone="accent">{ru.build.recommended}</Pill>}
            </span>
          </label>
        ))}
      </div>
      {selected?.freeText && (
        <textarea
          className={s.textarea}
          aria-label={ru.build.freeTextPlaceholder}
          placeholder={ru.build.freeTextPlaceholder}
          maxLength={2000}
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      )}
      <Button
        type="submit"
        variant="primary"
        loading={busy}
        disabled={!choice || (selected?.freeText && !text.trim())}
      >
        {ru.build.decisionSend}
      </Button>
    </form>
  );
}

export function BuildLog({
  run,
  reports,
  active,
  onCancel,
  onAnswer,
  onFix,
  onRetry,
}: {
  run: RunState;
  reports: GateReport[];
  active: boolean;
  onCancel(): void;
  onAnswer(body: { inputId: string; choice?: string; text?: string; secretValue?: string }): Promise<void>;
  onFix(): void;
  onRetry(): void;
}): ReactNode {
  const warn = run.credits.cap !== null && run.credits.used >= 0.8 * run.credits.cap;
  const gate = (l: GateLevel): GateRow => {
    const fromRun = run.gates[l];
    if (fromRun.status !== "pending") return fromRun;
    return gateFromReport(reports.find((r) => r.level === l)) ?? fromRun;
  };
  return (
    <section className={s.buildLog} data-testid="build-progress" aria-label={ru.build.progress}>
      <header className={s.buildHead}>
        <h3 className={s.blockTitle}>{ru.build.progress}</h3>
        <span data-testid="build-credits">
          <Pill tone={warn ? "warn" : "neutral"}>{ru.build.credits(run.credits.used, run.credits.cap)}</Pill>
        </span>
        {active && (
          <Button size="sm" variant="ghost" data-testid="build-cancel" onClick={onCancel}>
            {ru.build.cancel}
          </Button>
        )}
      </header>
      {run.lock && (
        <div className={s.lock} role="status">
          {ru.build.lock(run.lock.holderName, run.lock.position)}
        </div>
      )}
      <ol className={s.steps} data-testid="build-plan">
        {run.steps.map((st) => (
          <li key={st.id} className={s.step} data-testid="build-step" data-status={st.status}>
            <StatusIcon status={st.status} />
            <span className={s.stepBody}>
              <span>
                {st.title}
                {st.status === "queued" && <span className={s.muted}> · {ru.build.queued}</span>}
                {st.attempt > 1 && <span className={s.muted}> · {ru.build.attempt(st.attempt)}</span>}
              </span>
              {st.details.length > 0 && (
                <ul className={s.stepDetails}>
                  {st.details.map((d, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: details are append-only
                    <li key={i}>{d}</li>
                  ))}
                </ul>
              )}
            </span>
          </li>
        ))}
      </ol>
      {run.ruFallback && (
        <p className={s.small} data-testid="build-model-notice">
          {ru.build.modelNotice}
        </p>
      )}
      <ul className={s.gates}>
        {LEVELS.map((l) => (
          <GateLine key={l} level={l} row={gate(l)} />
        ))}
      </ul>
      {run.messages.length > 0 && (
        <ol className={s.feed}>
          {run.messages.map((m) => (
            <li key={m.id} className={s.bubble} data-testid="agent-message">
              <span className={s.bubbleAuthor}>{ru.chat.agents[m.agent] ?? m.agent}</span>
              <span className={s.bubbleText}>{m.text}</span>
            </li>
          ))}
        </ol>
      )}
      {run.budgetExceeded && (
        <div role="alert" className={s.alertBox} data-testid="budget-exceeded">
          {ru.build.budgetExceeded(run.budgetExceeded.cap)}
        </div>
      )}
      {run.input && <Decision key={run.input.inputId} input={run.input} onAnswer={onAnswer} />}
      {run.finished?.status === "cancelled" && <p className={s.muted}>{ru.build.stopped}</p>}
      {run.failure && (
        <Alert testId="run-error">
          <span>{run.failure.message_ru}</span>
          {run.kind === "build" ? (
            <Button size="sm" variant="primary" data-testid="run-fix" onClick={onFix}>
              {ru.build.fix}
            </Button>
          ) : run.failure.retryable ? (
            <Button size="sm" variant="secondary" onClick={onRetry}>
              {ru.build.retry}
            </Button>
          ) : null}
        </Alert>
      )}
    </section>
  );
}
