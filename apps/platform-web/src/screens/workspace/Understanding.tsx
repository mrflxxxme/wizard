// S2 main: «Как я понял задачу» from payload.analysis of the last kind=questions message (L4-26); hidden without it.
import type { ReactNode } from "react";
import type { Message, Question } from "../../api/types.js";
import { Pill } from "../../components/ui.js";
import { ru } from "../../i18n/ru.js";
import s from "./Workspace.module.css";

type Analysis = {
  title?: string;
  roles: string[];
  skeleton: string[];
  specifics: string[];
  constraints: string[];
  forks: { forkId: string; status: string; title?: string; choice?: string }[];
};

const strings = (v: unknown): string[] =>
  Array.isArray(v)
    ? v
        .map((x) =>
          typeof x === "string"
            ? x
            : x && typeof x === "object" && "label" in x && typeof x.label === "string"
              ? x.label
              : null,
        )
        .filter((x): x is string => x !== null)
    : [];

export function analysisOf(messages: Message[]): Analysis | null {
  const m = [...messages]
    .sort((a, b) => b.seq - a.seq)
    .find((x) => x.kind === "questions" && x.payload?.analysis);
  const a = m?.payload?.analysis;
  if (!a || typeof a !== "object") return null;
  const o = a as Record<string, unknown>;
  const forks = Array.isArray(o.forks)
    ? o.forks
        .map((f) => (f && typeof f === "object" ? (f as Record<string, unknown>) : {}))
        .filter((f) => typeof f.forkId === "string")
        .map((f) => ({
          forkId: String(f.forkId),
          status: typeof f.status === "string" ? f.status : "pending",
          ...(typeof f.title === "string" && f.title ? { title: f.title } : {}),
          ...(typeof f.choice === "string" && f.choice ? { choice: f.choice } : {}),
        }))
    : [];
  return {
    ...(typeof o.title === "string" ? { title: o.title } : {}),
    roles: strings(o.roles),
    skeleton: strings(o.skeleton),
    specifics: strings(o.specifics ?? o.goals),
    constraints: strings(o.constraints),
    forks,
  };
}

export function Understanding({
  messages,
  analyzing,
  questions = [],
}: {
  messages: Message[];
  analyzing: boolean;
  questions?: Question[];
}): ReactNode {
  const a = analysisOf(messages);
  // Asked forks read as their question; the rest as a short title (+ the option taken). Raw ids never show.
  const forkLabel = (f: Analysis["forks"][number]) => {
    const question = questions.find((q) => q.forkId === f.forkId)?.text;
    if (f.status === "asking" && question) return question;
    return f.title ?? question ?? ru.understanding.forkFallback;
  };
  if (!a) {
    return analyzing ? (
      <div className={s.skeleton} aria-busy="true">
        {ru.chat.analyzing}
      </div>
    ) : null;
  }
  return (
    <section className={s.panel} data-testid="understanding-panel" aria-label={ru.understanding.title}>
      <h2 className={s.panelTitle}>{ru.understanding.title}</h2>
      {a.title && <p className={s.lead}>{a.title}</p>}
      {a.roles.length > 0 && (
        <div className={s.block}>
          <h3 className={s.blockTitle}>{ru.understanding.roles}</h3>
          <div className={s.pills}>
            {a.roles.map((r) => (
              <Pill key={r}>{r}</Pill>
            ))}
          </div>
        </div>
      )}
      {a.skeleton.length > 0 && (
        <div className={s.block}>
          <h3 className={s.blockTitle}>{ru.understanding.core}</h3>
          <div className={s.pills}>
            {a.skeleton.map((k) => (
              <Pill key={k} tone="accent">
                {ru.understanding.skeleton[k] ?? k}
              </Pill>
            ))}
          </div>
        </div>
      )}
      {a.specifics.length > 0 && (
        <div className={s.block}>
          <h3 className={s.blockTitle}>{ru.understanding.specifics}</h3>
          <ul className={s.list}>
            {a.specifics.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </div>
      )}
      {a.constraints.length > 0 && (
        <div className={s.block}>
          <h3 className={s.blockTitle}>{ru.understanding.constraints}</h3>
          <ul className={s.list}>
            {a.constraints.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </div>
      )}
      <div className={s.block}>
        <h3 className={s.blockTitle}>{ru.understanding.forks}</h3>
        <ul className={s.list} data-testid="forks-list">
          {a.forks.map((f) => (
            <li key={f.forkId} className={s.forkRow} data-fork-id={f.forkId}>
              <span>
                {forkLabel(f)}
                {f.status !== "asking" && f.choice && <span className={s.forkChoice}> — {f.choice}</span>}
              </span>
              <Pill tone={f.status === "resolved" ? "ok" : f.status === "asking" ? "accent" : "neutral"}>
                {ru.understanding.forkStatus[f.status] ?? f.status}
              </Pill>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
