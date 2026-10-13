// V4-04 (D79 (10)): a failed build of the founder becomes an agent's task — an issue in the platform repository with
// the link to the build report and to the records of its model calls. A sweep every 10 minutes over the failed v3
// builds of the last two days that have a report; one issue per run (platform.ops_alerts key build_issue:<runId>; a
// failed POST frees the key for the next sweep). No token — nothing is sent (the log says it once).
import { type BuildReport, loadBuildReport, renderReportMd } from "@wizard/platform-api";
import type postgres from "postgres";

export interface GitHubIssues {
  token: string;
  /** owner/repo of the platform. */
  repo: string;
}

/** WIZARD_GITHUB_ISSUES_TOKEN and WIZARD_GITHUB_ISSUES_REPO (owner/repo); either missing — null. */
export function githubIssuesFromEnv(
  env: Record<string, string | undefined> = process.env,
): GitHubIssues | null {
  const token = env.WIZARD_GITHUB_ISSUES_TOKEN?.trim();
  const repo = env.WIZARD_GITHUB_ISSUES_REPO?.trim();
  return token && repo && /^[\w.-]+\/[\w.-]+$/.test(repo) ? { token, repo } : null;
}

export interface BuildIssuesOptions {
  pg: postgres.Sql;
  files: Parameters<typeof loadBuildReport>[0];
  platformOrigin: string;
  founderEmail: string | null;
  github: GitHubIssues | null;
  fetch?: typeof fetch;
  now?: () => Date;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

export function issueTitle(r: BuildReport): string {
  return `Сборка основателя упала: ${r.systemName ? `«${r.systemName}»` : (r.systemId ?? r.runId)} — ${r.failure?.code ?? r.status}`.slice(
    0,
    200,
  );
}

export function issueBody(r: BuildReport, platformOrigin: string): string {
  const base = `${platformOrigin}/api/v1/admin/runs/${r.runId}/report`;
  return [
    "Сборка основателя не прошла приёмку (D79 (10), V4-04). Разберите отчёт, воспроизведите на записях вызовов и почините.",
    "",
    `- Отчёт: ${base} (Markdown: ${base}?format=md)`,
    r.records
      ? `- Записи вызовов модели (V4-03, jsonl): ${base}/files/${r.records} — положите в tools/fixtures/records/ и проиграйте`
      : "- Записей вызовов нет (сборка не основателя или вызовов не было).",
    "",
    renderReportMd(r, base),
  ]
    .join("\n")
    .slice(0, 60_000);
}

/** Opens the issues of failed founder builds not filed yet; returns how many were opened. */
export async function fileBuildIssues(o: BuildIssuesOptions): Promise<number> {
  if (!o.github) return 0;
  const since = new Date((o.now ?? (() => new Date()))().getTime() - 2 * 24 * 3600_000);
  const runs = await o.pg<{ id: string }[]>`
    select r.id from platform.runs r
    join platform.orgs g on g.id = r.org_id
    left join platform.users u on u.id = r.started_by
    where r.kind = 'build' and r.status = 'failed' and r.finished_at >= ${since}
      and (g.kind = 'staff' or (${o.founderEmail ?? ""} <> '' and lower(u.email) = ${o.founderEmail ?? ""}))
      and not exists (select 1 from platform.ops_alerts a where a.key = 'build_issue:' || r.id::text)
    order by r.finished_at limit 20`;
  const f = o.fetch ?? fetch;
  let opened = 0;
  for (const { id } of runs) {
    const report = await loadBuildReport(o.files, id);
    if (!report) continue;
    const key = `build_issue:${id}`;
    const [claimed] = await o.pg<{ key: string }[]>`
      insert into platform.ops_alerts (key) values (${key}) on conflict (key) do nothing returning key`;
    if (!claimed) continue;
    try {
      const res = await f(`https://api.github.com/repos/${o.github.repo}/issues`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${o.github.token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "content-type": "application/json",
        },
        body: JSON.stringify({ title: issueTitle(report), body: issueBody(report, o.platformOrigin) }),
      });
      if (!res.ok) throw new Error(`GitHub API: HTTP ${res.status}`);
      const issue = (await res.json()) as { html_url?: string };
      o.log?.("build_issue_opened", { runId: id, url: issue.html_url ?? null });
      opened++;
    } catch (e) {
      await o.pg`delete from platform.ops_alerts where key = ${key}`;
      o.log?.("build_issue_failed", { runId: id, error: String((e as Error)?.message ?? e).slice(0, 200) });
    }
  }
  return opened;
}
