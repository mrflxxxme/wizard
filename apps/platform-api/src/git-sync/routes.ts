// /systems/:id/repo-sync* and the redirects of GitHub and GitLab (V3-31; api.yaml «V3-31»): the state of the sync for a
// viewer of the system; connecting, choosing the repository, auto-merge, pause, «Повторить» and disconnecting for its
// owner; the preview of a PR's revision at a stable address. Another org's system is 404; tokens never leave the server.
// Webhooks (no session, signature or token instead) are separate: webhookRoutes.
import { Hono } from "hono";
import { z } from "zod";
import { notFound } from "../errors.js";
import { type AppEnv, type AuthUser, checkOrgAccess, isUuid, type OrgRole } from "../http/auth.js";
import { type Deps, jsonBody, parseQuery } from "../http/util.js";
import { draftPreviewUrl } from "../publish/preview-url.js";
import { loadSpec } from "../services/revisions.js";
import type { GitSync } from "./service.js";

const settings = (d: Pick<Deps, "config">, systemId: string, q = "") =>
  `${d.config.platformOrigin}/s/${systemId}/settings${q}#repo`;

/** V3-32: the callbacks of an agent state (repo-agent/routes.ts agentRedirects) — the address to redirect to. */
export interface AgentRedirects {
  github(user: AuthUser, q: { installationId: string; state: string; code: string }): Promise<string>;
  gitlab(user: AuthUser, q: { code: string; state: string }): Promise<string>;
}

export function repoSyncRoutes(
  d: Pick<Deps, "db" | "config">,
  sync: GitSync,
  agent?: AgentRedirects,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  async function loadSystem(user: AuthUser, id: string | undefined, min: OrgRole) {
    if (!isUuid(id)) throw notFound("Система");
    const s = await d.db
      .selectFrom("platform.systems")
      .select(["id", "org_id", "slug", "name", "schema_key", "preview_revision"])
      .where("id", "=", id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!s) throw notFound("Система");
    checkOrgAccess(user, s.org_id, min, "Система", min === "owner" ? "NOT_OWNER" : "FORBIDDEN");
    return s;
  }

  /** org of a system for a callback: the caller must still be its owner. */
  const ownerOrg = (user: AuthUser) => async (systemId: string) =>
    (await loadSystem(user, systemId, "owner")).org_id;

  r.get("/systems/:id/repo-sync", async (c) => {
    const s = await loadSystem(c.get("user"), c.req.param("id"), "viewer");
    return c.json(await sync.view(s.id, s.org_id));
  });

  r.post("/systems/:id/repo-sync/github", async (c) => {
    const s = await loadSystem(c.get("user"), c.req.param("id"), "owner");
    return c.json({ url: sync.githubInstallUrl(s.id, c.get("user").id) });
  });

  r.post("/systems/:id/repo-sync/gitlab", async (c) => {
    const s = await loadSystem(c.get("user"), c.req.param("id"), "owner");
    const b = await jsonBody(
      c,
      z.strictObject({
        baseUrl: z.string().max(300).nullish(),
        clientId: z.string().max(200).nullish(),
        clientSecret: z.string().max(300).nullish(),
      }),
    );
    return c.json({ url: await sync.gitlabAuthorize(s.id, s.org_id, c.get("user").id, b) });
  });

  r.get("/systems/:id/repo-sync/repos", async (c) => {
    const s = await loadSystem(c.get("user"), c.req.param("id"), "owner");
    const items = await sync.repos(s.id, s.org_id);
    return c.json({
      items: items.map((x) => ({
        id: x.id,
        path: x.path,
        defaultBranch: x.defaultBranch,
        private: x.private,
        webUrl: x.webUrl,
      })),
    });
  });

  r.post("/systems/:id/repo-sync/repo", async (c) => {
    const s = await loadSystem(c.get("user"), c.req.param("id"), "owner");
    const b = await jsonBody(c, z.strictObject({ repoId: z.string().regex(/^[0-9]{1,20}$/) }));
    await sync.selectRepo(s.id, s.org_id, b.repoId);
    return c.json(await sync.view(s.id, s.org_id));
  });

  r.patch("/systems/:id/repo-sync", async (c) => {
    const s = await loadSystem(c.get("user"), c.req.param("id"), "owner");
    const b = await jsonBody(
      c,
      z.strictObject({ autoMerge: z.boolean().optional(), paused: z.boolean().optional() }),
    );
    await sync.setOptions(s.id, s.org_id, b);
    return c.json(await sync.view(s.id, s.org_id));
  });

  r.post("/systems/:id/repo-sync/retry", async (c) => {
    const s = await loadSystem(c.get("user"), c.req.param("id"), "owner");
    await sync.retry(s.id, s.org_id);
    return c.json(await sync.view(s.id, s.org_id));
  });

  r.delete("/systems/:id/repo-sync", async (c) => {
    const s = await loadSystem(c.get("user"), c.req.param("id"), "owner");
    await sync.disconnect(s.id, s.org_id);
    return c.json(await sync.view(s.id, s.org_id));
  });

  // The PR's preview link: a fresh preview login for the signed-in viewer while the revision is the draft preview;
  // otherwise the system's page (the revision was replaced by a newer one).
  r.get("/systems/:id/repo-sync/preview/:rev", async (c) => {
    const user = c.get("user");
    const s = await loadSystem(user, c.req.param("id"), "viewer");
    const rev = Number(c.req.param("rev"));
    const current = Number.isInteger(rev) && rev >= 1 && s.preview_revision === rev;
    const url = current
      ? draftPreviewUrl(d.config, s, rev, await loadSpec(d.db, s, rev), user.id).url
      : `${d.config.platformOrigin}/s/${s.id}`;
    // A browser (the link in the PR) is sent there; an API client gets the address.
    if ((c.req.header("accept") ?? "").includes("text/html")) return c.redirect(url, 302);
    return c.json({ url, current });
  });

  // V3-32: the preview of a developer's PR (its stable address in the PR checks): the state for an API client, the
  // «Репозиторий» settings with the PR for a browser.
  r.get("/systems/:id/repo-sync/pulls/:number", async (c) => {
    const s = await loadSystem(c.get("user"), c.req.param("id"), "viewer");
    const n = Number(c.req.param("number"));
    if (!Number.isInteger(n) || n < 1 || n > 2_147_483_647) throw notFound("PR");
    if ((c.req.header("accept") ?? "").includes("text/html"))
      return c.redirect(settings(d, s.id, `?pr=${n}`), 302);
    const v = await sync.pull(s.id, s.org_id, n);
    if (!v) throw notFound("Превью PR");
    return c.json(v);
  });

  // Setup URL of the GitHub App: installation_id, setup_action, state and the user's OAuth code.
  r.get("/git-sync/github/setup", async (c) => {
    const q = parseQuery(
      c,
      z.object({
        installation_id: z.string().max(20),
        state: z.string().max(2000),
        code: z.string().max(200).optional(),
        setup_action: z.string().max(20).optional(),
      }),
    );
    const input = { installationId: q.installation_id, state: q.state, code: q.code ?? "" };
    // The same App installs for the agent of an org (V3-32): its state says so.
    if (agent && sync.stateTarget(q.state) === "agent")
      return c.redirect(await agent.github(c.get("user"), input), 302);
    const systemId = await sync.githubSetup(c.get("user"), input, ownerOrg(c.get("user")));
    return c.redirect(settings(d, systemId, "?repo=select"), 302);
  });

  r.get("/git-sync/gitlab/callback", async (c) => {
    const q = parseQuery(c, z.object({ code: z.string().max(500), state: z.string().max(2000) }));
    if (agent && sync.stateTarget(q.state) === "agent")
      return c.redirect(await agent.gitlab(c.get("user"), q), 302);
    const systemId = await sync.gitlabCallback(c.get("user"), q, ownerOrg(c.get("user")));
    return c.redirect(settings(d, systemId, "?repo=select"), 302);
  });

  return r;
}

/** Webhooks of the providers: no session and no Origin — the signature (GitHub) or the hook token (GitLab) instead. */
export function repoWebhookRoutes(sync: GitSync): Hono {
  const r = new Hono();
  r.post("/webhooks/git/github", async (c) => {
    const raw = Buffer.from(await c.req.arrayBuffer());
    const out = await sync.githubWebhook((n) => c.req.header(n), raw);
    return c.json(out.body, out.status as 200);
  });
  r.post("/webhooks/git/gitlab/:linkId", async (c) => {
    const id = c.req.param("linkId");
    if (!isUuid(id)) return c.json({ code: "NOT_FOUND", message_ru: "Не найдено" }, 404);
    const raw = Buffer.from(await c.req.arrayBuffer());
    const out = await sync.gitlabWebhook(id, (n) => c.req.header(n), raw);
    return c.json(out.body, out.status as 200);
  });
  return r;
}
