// «Репозиторий» (V3-31, D77_v3 (3)) — a system block of S10 «Настройки»: connect GitHub (the platform's App) or GitLab
// (gitlab.com or the owner's own instance with its OAuth application), pick the repository, then the sync's state — the
// status with its Russian reason, auto-merge, pause, «Повторить сейчас», the PRs of revisions with their gates and the
// changes that came back from the repository (taken or refused, with the reason). Owner acts, others read. Hidden while
// the feature is off on the platform.
import { type FormEvent, type ReactNode, useCallback, useEffect, useId, useState } from "react";
import { ApiError } from "../../../api/client.js";
import { usePlatform } from "../../../app/context.js";
import { Alert, Pill } from "../../../components/ui.js";
import { Button } from "../../../components/v2/Button.js";
import { ru } from "../../../i18n/ru.js";
import s from "../Settings.module.css";
import type { RepoChoice, RepoSyncClient, RepoSyncLink, RepoSyncState } from "./client.js";
import r from "./RepoSync.module.css";
import { repoRu as t } from "./texts.js";

const fmt = (iso: string) =>
  new Date(iso).toLocaleString("ru-RU", {
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });

const errText = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : ru.errors.generic);

function statusPill(l: RepoSyncLink): ReactNode {
  const tone = l.status === "active" ? "ok" : l.status === "error" ? "bad" : "neutral";
  return (
    <Pill tone={tone} testId="repo-status">
      {l.statusRu}
    </Pill>
  );
}

const CHECK_TONE = { success: "ok", failure: "bad", pending: "neutral", neutral: "neutral" } as const;

export function RepoSync({
  systemId,
  owner,
  client,
  go = (url) => window.location.assign(url),
  origin = typeof window === "undefined" ? "" : window.location.origin,
}: {
  systemId: string;
  owner: boolean;
  /** Tests pass a fake; default — `api.repoSync` of the platform client (absent in older fakes → no section). */
  client?: RepoSyncClient;
  /** Leaves for GitHub / GitLab (tests record it). */
  go?: (url: string) => void;
  origin?: string;
}): ReactNode {
  const platform = usePlatform();
  const api: RepoSyncClient | null =
    client ?? (platform.api as { repoSync?: RepoSyncClient }).repoSync ?? null;
  const [state, setState] = useState<RepoSyncState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [gitlabOpen, setGitlabOpen] = useState(false);
  const [own, setOwn] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [repos, setRepos] = useState<RepoChoice[] | null>(null);
  const [choice, setChoice] = useState("");
  const [confirmOff, setConfirmOff] = useState(false);
  const id = useId();

  const load = useCallback(
    async (alive: { current: boolean }) => {
      if (!api) return;
      try {
        const next = await api.get(systemId);
        if (alive.current) setState(next);
      } catch {
        if (alive.current) setState(null);
      }
    },
    [api, systemId],
  );

  useEffect(() => {
    const alive = { current: true };
    void load(alive);
    return () => {
      alive.current = false;
    };
  }, [load]);

  const pending = state?.link?.status === "pending";
  useEffect(() => {
    if (!api || !pending || !owner || repos !== null) return;
    let alive = true;
    api
      .repos(systemId)
      .then((res) => {
        if (!alive) return;
        setRepos(res.items);
        setChoice(res.items[0]?.id ?? "");
      })
      .catch((e: unknown) => {
        if (alive) {
          setRepos([]);
          setError(errText(e));
        }
      });
    return () => {
      alive = false;
    };
  }, [api, pending, owner, repos, systemId]);

  if (!api || !state?.available) return null;
  const sync = api;
  const link = state.link;

  async function act<T>(name: string, fn: () => Promise<T>, done?: string): Promise<T | null> {
    setBusy(name);
    setError(null);
    setNotice(null);
    try {
      const out = await fn();
      if (done) setNotice(done);
      return out;
    } catch (e) {
      setError(errText(e));
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function github() {
    const res = await act("github", () => sync.connectGithub(systemId));
    if (res) go(res.url);
  }

  async function gitlab(ev: FormEvent) {
    ev.preventDefault();
    const body = own ? { baseUrl: baseUrl.trim(), clientId: clientId.trim(), clientSecret } : {};
    const res = await act("gitlab", () => sync.connectGitlab(systemId, body));
    if (res) {
      setClientSecret("");
      go(res.url);
    }
  }

  async function select() {
    const next = await act("select", () => sync.selectRepo(systemId, choice), t.selectedNotice);
    if (next) {
      setState(next);
      setRepos(null);
    }
  }

  async function update(body: { autoMerge?: boolean; paused?: boolean }) {
    const next = await act("update", () => sync.update(systemId, body), t.saved);
    if (next) setState(next);
  }

  async function retry() {
    const next = await act("retry", () => sync.retry(systemId));
    if (next) setState(next);
  }

  async function disconnect() {
    setConfirmOff(false);
    const next = await act("disconnect", () => sync.disconnect(systemId), t.disconnected);
    if (next) {
      setState(next);
      setRepos(null);
    }
  }

  const canGitlab = own
    ? /^https:\/\/[^/\s]+\/?$/.test(baseUrl.trim()) && clientId.trim() !== "" && clientSecret !== ""
    : true;

  return (
    <section
      id="repo"
      className={`${s.block} ${s.wide}`}
      aria-labelledby={`${id}-title`}
      data-testid="settings-repo"
    >
      <h2 id={`${id}-title`} className={s.blockTitle}>
        {t.title}
      </h2>
      <p className={s.small}>{t.lead}</p>
      <p className={s.hint}>{t.how}</p>
      {error && <Alert testId="repo-error">{error}</Alert>}
      {notice && (
        <p className={s.notice} role="status" data-testid="repo-notice">
          {notice}
        </p>
      )}
      {!owner && <p className={s.hint}>{t.ownerOnly}</p>}

      {!link && owner && (
        <div className={r.row}>
          <Button
            variant="primary"
            onClick={() => void github()}
            disabled={!state.providers.github || busy !== null}
            loading={busy === "github"}
            data-testid="repo-connect-github"
          >
            {t.connectGithub}
          </Button>
          <Button
            onClick={() => {
              setGitlabOpen((v) => !v);
              setOwn(!state.providers.gitlab);
            }}
            aria-expanded={gitlabOpen}
            disabled={busy !== null}
            data-testid="repo-connect-gitlab"
          >
            {t.connectGitlab}
          </Button>
          {!state.providers.github && <p className={s.hint}>{t.githubOff}</p>}
        </div>
      )}

      {!link && owner && gitlabOpen && (
        <form
          className={s.form}
          onSubmit={(ev) => void gitlab(ev)}
          autoComplete="off"
          data-testid="repo-gitlab-form"
        >
          <fieldset className={r.choice}>
            <legend className={s.small}>{t.connectGitlab}</legend>
            <label className={s.check}>
              <input
                type="radio"
                name={`${id}-gl`}
                checked={!own}
                disabled={!state.providers.gitlab}
                onChange={() => setOwn(false)}
                data-testid="repo-gitlab-com"
              />
              <span>{t.gitlabCom}</span>
            </label>
            <label className={s.check}>
              <input
                type="radio"
                name={`${id}-gl`}
                checked={own}
                onChange={() => setOwn(true)}
                data-testid="repo-gitlab-own"
              />
              <span>{t.gitlabOwn}</span>
            </label>
          </fieldset>
          {own && (
            <div className={r.grid}>
              <label className={s.field}>
                {t.gitlabUrl}
                <input
                  type="url"
                  inputMode="url"
                  placeholder="https://gitlab.company.ru"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  spellCheck={false}
                  autoCapitalize="off"
                  required
                  aria-describedby={`${id}-gl-url`}
                  data-testid="repo-gitlab-url"
                />
              </label>
              <label className={s.field}>
                {t.gitlabAppId}
                <input
                  type="text"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  spellCheck={false}
                  autoCapitalize="off"
                  required
                  data-testid="repo-gitlab-app-id"
                />
              </label>
              <label className={s.field}>
                {t.gitlabAppSecret}
                <input
                  type="password"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  autoComplete="off"
                  required
                  data-testid="repo-gitlab-app-secret"
                />
              </label>
            </div>
          )}
          {own && (
            <>
              <p id={`${id}-gl-url`} className={s.hint}>
                {t.gitlabUrlHint}
              </p>
              <p className={s.hint}>{t.gitlabAppHint(`${origin}/api/v1/git-sync/gitlab/callback`)}</p>
            </>
          )}
          <div className={r.row}>
            <Button
              type="submit"
              variant="primary"
              disabled={!canGitlab || busy !== null}
              loading={busy === "gitlab"}
              data-testid="repo-gitlab-go"
            >
              {t.gitlabGo}
            </Button>
            <Button variant="secondary" onClick={() => setGitlabOpen(false)}>
              {t.cancel}
            </Button>
          </div>
        </form>
      )}

      {link && pending && owner && (
        <div className={s.form} data-testid="repo-pick">
          <h3 className={r.subTitle}>{t.pickTitle}</h3>
          <p className={s.hint}>{t.pickHint}</p>
          {repos === null ? (
            <p className={s.hint}>{t.loadRepos}</p>
          ) : repos.length === 0 ? (
            <p className={s.hint} data-testid="repo-pick-empty">
              {t.noRepos}
            </p>
          ) : (
            <>
              <label className={s.field}>
                {t.provider[link.provider]}
                <select
                  value={choice}
                  onChange={(e) => setChoice(e.target.value)}
                  data-testid="repo-pick-select"
                >
                  {repos.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.path}
                      {x.private ? ` (${t.privateRepo})` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <div className={r.row}>
                <Button
                  variant="primary"
                  onClick={() => void select()}
                  disabled={!choice || busy !== null}
                  loading={busy === "select"}
                  data-testid="repo-pick-submit"
                >
                  {t.pick}
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {link && !pending && link.repo && (
        <div className={r.state} data-testid="repo-linked">
          <div className={r.head}>
            <span className={r.repoName}>
              {t.provider[link.provider]} ·{" "}
              {link.repo.webUrl ? (
                <a href={link.repo.webUrl} target="_blank" rel="noreferrer noopener" data-testid="repo-link">
                  {link.repo.path}
                </a>
              ) : (
                link.repo.path
              )}
            </span>
            {statusPill(link)}
          </div>
          <p className={s.hint}>
            {t.branch(link.repo.defaultBranch)}
            {link.lastSyncAt ? ` · ${t.lastSync(fmt(link.lastSyncAt))}` : ""}
          </p>
          {link.lastError && (
            <p className={`${s.small} ${s.warn}`} data-testid="repo-last-error">
              {link.lastError.message_ru}
            </p>
          )}
          {state.queue.failing > 0 && (
            <p className={s.hint} data-testid="repo-queue">
              {t.queue(
                state.queue.failing,
                state.queue.nextAttemptAt ? fmt(state.queue.nextAttemptAt) : null,
              )}
            </p>
          )}
          {state.queue.stopped > 0 && (
            <p className={`${s.small} ${s.warn}`} data-testid="repo-stopped">
              {t.stopped(state.queue.stopped)}
            </p>
          )}
          {state.publishGate.required ? (
            <p className={s.hint} data-testid="repo-publish-gate">
              {t.publishAfterMerge(state.publishGate.mergedRevision)}
            </p>
          ) : link.status === "paused" ? (
            <p className={s.hint}>{t.pausedHint}</p>
          ) : null}

          {owner && (
            <div className={r.actions}>
              <label className={s.check}>
                <input
                  type="checkbox"
                  role="switch"
                  aria-checked={link.autoMerge}
                  checked={link.autoMerge}
                  disabled={busy !== null}
                  onChange={(e) => void update({ autoMerge: e.target.checked })}
                  aria-describedby={`${id}-am`}
                  data-testid="repo-auto-merge"
                />
                <span>{t.autoMerge}</span>
              </label>
              <span className={s.spacer} />
              <Button
                size="sm"
                onClick={() => void update({ paused: link.status !== "paused" })}
                disabled={busy !== null}
                data-testid="repo-pause"
              >
                {link.status === "paused" ? t.resume : t.pause}
              </Button>
              {(link.status === "error" || state.queue.stopped > 0 || state.queue.failing > 0) && (
                <Button
                  size="sm"
                  onClick={() => void retry()}
                  disabled={busy !== null}
                  loading={busy === "retry"}
                  data-testid="repo-retry"
                >
                  {t.retry}
                </Button>
              )}
              <Button
                size="sm"
                variant="danger"
                onClick={() => setConfirmOff(true)}
                disabled={busy !== null}
                data-testid="repo-disconnect"
              >
                {t.disconnect}
              </Button>
            </div>
          )}
          {owner && (
            <p id={`${id}-am`} className={s.hint}>
              {t.autoMergeHint}
            </p>
          )}
          {confirmOff && (
            <div
              className={r.confirm}
              role="alertdialog"
              aria-labelledby={`${id}-off`}
              data-testid="repo-disconnect-confirm"
            >
              <p id={`${id}-off`} className={s.small}>
                {t.disconnectConfirm(link.repo.path)}
              </p>
              <div className={r.row}>
                <Button
                  variant="secondary"
                  onClick={() => setConfirmOff(false)}
                  data-testid="repo-disconnect-no"
                >
                  {t.cancel}
                </Button>
                <Button variant="danger" onClick={() => void disconnect()} data-testid="repo-disconnect-yes">
                  {t.disconnect}
                </Button>
              </div>
            </div>
          )}

          <h3 className={r.subTitle}>{t.prs}</h3>
          {state.prs.length === 0 ? (
            <p className={s.hint}>{t.noPrs}</p>
          ) : (
            <ul className={s.list} data-testid="repo-prs" aria-label={t.prs}>
              {state.prs.map((p) => (
                <li key={p.revision} className={r.item} data-testid="repo-pr">
                  <div className={r.head}>
                    <span className={r.itemName}>
                      {t.rev(p.revision)}
                      {p.number && p.url ? (
                        <>
                          {" · "}
                          <a href={p.url} target="_blank" rel="noreferrer noopener">
                            #{p.number}
                          </a>
                        </>
                      ) : null}
                    </span>
                    <Pill tone={p.state === "merged" || p.state === "direct" ? "ok" : "neutral"}>
                      {t.prState[p.state]}
                    </Pill>
                  </div>
                  {p.checks.length > 0 && (
                    <div className={r.checks}>
                      {p.checks.map((c) => (
                        <Pill
                          key={c.key}
                          tone={CHECK_TONE[c.state]}
                          title={c.title}
                          testId={`repo-check-${c.key}`}
                        >
                          {t.check[c.key]}: {t.checkState[c.state]}
                        </Pill>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          <h3 className={r.subTitle}>{t.imports}</h3>
          {state.imports.length === 0 ? (
            <p className={s.hint}>{t.noImports}</p>
          ) : (
            <ul className={s.list} data-testid="repo-imports" aria-label={t.imports}>
              {state.imports.map((i) => (
                <li key={i.headOid} className={r.item} data-testid="repo-import">
                  <div className={r.head}>
                    <span className={`${r.itemName} ${r.mono}`}>{i.headOid.slice(0, 7)}</span>
                    <Pill tone={i.status === "imported" ? "ok" : i.status === "rejected" ? "bad" : "neutral"}>
                      {t.importState[i.status]}
                      {i.revision ? ` · ${t.importRev(i.revision)}` : ""}
                    </Pill>
                  </div>
                  {i.reason_ru && (
                    <p className={`${s.small} ${s.warn}`} data-testid="repo-import-reason">
                      {i.reason_ru}
                    </p>
                  )}
                  {i.warnings.map((w) => (
                    <p key={w} className={s.hint}>
                      {w}
                    </p>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
