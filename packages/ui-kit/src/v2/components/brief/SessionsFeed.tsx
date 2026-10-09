import { type ReactNode, useId } from "react";
import { cx, type PBase, pRoot } from "../../util.js";
import s from "./SessionsFeed.module.css";
import { clip, dateRu, durationRu } from "./text.js";

export const SESSION_KINDS = ["interview", "build", "edit"] as const;
export const SESSION_STATUSES = ["running", "waiting", "done", "failed", "cancelled"] as const;

/** One session of a system: the interview, a build or an edit of the brief (api.yaml#SystemSession). */
export interface BriefSession {
  id: string;
  kind: (typeof SESSION_KINDS)[number];
  /** Edit: chat — said in words, panel — changed in the «Бриф» panel. */
  source?: "chat" | "panel" | null;
  status: (typeof SESSION_STATUSES)[number];
  /** RFC 3339. */
  startedAt: string;
  finishedAt?: string | null;
  /** Versions of the brief written in this session. */
  briefVersions?: number[];
  /** Russian lines of what changed in the brief (the first few). */
  changes?: string[];
  /** How many changes there were in all. */
  changesTotal?: number;
  /** Build: mode, the system version it made and why it stopped. */
  build?: { mode?: string | null; revision?: number | null; failure?: string | null } | null;
}

export interface SessionsFeedProps extends PBase {
  /** Sessions, newest first. */
  sessions: readonly BriefSession[];
  /** A brief version of a session was pressed (open it in «Версии»). */
  onOpenVersion?(version: number): void;
  /** Text when there are no sessions yet. */
  empty?: string;
  /** At most this many lines of changes per session (default 3). */
  maxChanges?: number;
}

const BUILD_TITLE: Record<string, string> = {
  create: "Сборка",
  change: "Пересборка",
  fix: "Исправление",
  point_edit: "Точечная правка",
};

export const SESSION_STATUS_RU: Readonly<Record<BriefSession["status"], string>> = {
  running: "идёт",
  waiting: "ждёт вашего ответа",
  done: "готово",
  failed: "не получилось",
  cancelled: "отменено",
};

/** Title of a session in plain words. */
export function sessionTitle(x: BriefSession): string {
  if (x.kind === "interview") return "Интервью";
  if (x.kind === "build") return BUILD_TITLE[x.build?.mode ?? "create"] ?? "Сборка";
  return x.source === "panel"
    ? "Правка в панели «Бриф»"
    : x.source === "chat"
      ? "Правка словами в чате"
      : "Правка";
}

function Icon({ kind }: { kind: BriefSession["kind"] }): ReactNode {
  return (
    <svg className={s.icon} viewBox="0 0 24 24" aria-hidden="true">
      {kind === "interview" ? (
        <path d="M5 5h14v10H10l-5 4z" />
      ) : kind === "build" ? (
        <>
          <rect x="4" y="4" width="7" height="7" rx="2" />
          <rect x="13" y="13" width="7" height="7" rx="2" />
          <path d="M11 7.5h3.5a2 2 0 0 1 2 2V13" />
        </>
      ) : (
        <path d="M5 19l1-4L15.5 5.5a2.1 2.1 0 0 1 3 3L9 18z" />
      )}
    </svg>
  );
}

/** The feed of a system's sessions (D77 (9)): interviews, builds and brief edits with their versions and changes. */
export function SessionsFeed({
  sessions,
  onOpenVersion,
  empty = "Сессий пока нет: они появятся после интервью.",
  maxChanges = 3,
  className,
  testId,
}: SessionsFeedProps): ReactNode {
  const hid = useId();
  if (sessions.length === 0)
    return (
      <p {...pRoot("SessionsFeed", testId, "p-sessions")} className={cx(s.empty, className)}>
        {empty}
      </p>
    );
  return (
    <section
      {...pRoot("SessionsFeed", testId, "p-sessions")}
      aria-labelledby={hid}
      className={cx(s.feed, className)}
    >
      <h3 id={hid} className={s.srOnly}>
        Сессии системы
      </h3>
      <ol className={s.list}>
        {sessions.map((x) => {
          const changes = x.changes ?? [];
          const total = Math.max(x.changesTotal ?? changes.length, changes.length);
          const shown = changes.slice(0, maxChanges);
          const when = [dateRu(x.startedAt), durationRu(x.startedAt, x.finishedAt ?? null)].filter(Boolean);
          return (
            <li
              key={x.id}
              className={cx(s.item, s[x.kind])}
              data-kind={x.kind}
              data-status={x.status}
              data-testid="p-session"
            >
              <span className={s.mark}>
                <Icon kind={x.kind} />
              </span>
              <div className={s.body}>
                <p className={s.line}>
                  <b className={s.title}>{sessionTitle(x)}</b>
                  <span className={cx(s.status, s[`st_${x.status}`])}>{SESSION_STATUS_RU[x.status]}</span>
                </p>
                <p className={s.when}>{when.join(" · ")}</p>
                {x.kind === "build" && x.build?.revision != null && x.status === "done" && (
                  <p className={s.detail}>Готова версия системы {x.build.revision}</p>
                )}
                {x.kind === "build" && x.build?.failure && (
                  <p className={s.detail}>{clip(x.build.failure, 200)}</p>
                )}
                {(x.briefVersions?.length ?? 0) > 0 && (
                  <p className={s.versions}>
                    <span>Бриф:</span>
                    {x.briefVersions?.map((v) =>
                      onOpenVersion ? (
                        <button
                          key={v}
                          type="button"
                          className={s.ver}
                          data-testid={`p-session-version-${v}`}
                          onClick={() => onOpenVersion(v)}
                        >
                          версия {v}
                        </button>
                      ) : (
                        <span key={v} className={s.verText}>
                          версия {v}
                        </span>
                      ),
                    )}
                  </p>
                )}
                {shown.length > 0 && (
                  <ul className={s.changes}>
                    {shown.map((c, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: change lines of one session never reorder
                      <li key={i}>{clip(c, 160)}</li>
                    ))}
                    {total > shown.length && <li className={s.more}>и ещё {total - shown.length}</li>}
                  </ul>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
