// /orgs/{orgId}/repo-agent* of specs/platform/api.yaml (V3-32): the agent for compatible repositories of an org.
// Reading — any member (viewer); connecting, choosing the repository, checks, tasks and disconnecting — the owner.
// Tokens never leave the server (secretRef is only the secret:// reference). The GitHub App and GitLab OAuth callbacks
// are the repository sync's (/git-sync/*): an agent state is handed over here (agentRedirects).
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { OrgRole } from "../auth/accounts.js";
import { notFound } from "../errors.js";
import { type AppEnv, type AuthUser, checkOrgAccess, isUuid } from "../http/auth.js";
import { type Deps, jsonBody } from "../http/util.js";
import type { RepoAgent } from "./service.js";

/** Where the owner lands after connecting a repository for the agent (the org settings «Репозитории»). */
const landing = (d: Pick<Deps, "config">, repoId: string) =>
  `${d.config.platformOrigin}/settings/repos?agentRepo=${repoId}#repo-agent`;

/** The GitHub App and GitLab OAuth callbacks of an agent state (git-sync/routes.ts dispatches by the state). */
export function agentRedirects(d: Pick<Deps, "config">, agent: RepoAgent) {
  const owner = (user: AuthUser) => (orgId: string) =>
    checkOrgAccess(user, orgId, "owner", "Организация", "NOT_OWNER");
  return {
    async github(
      user: AuthUser,
      q: { installationId: string; state: string; code: string },
    ): Promise<string> {
      const r = await agent.githubSetup(user, q, owner(user));
      return landing(d, r.repoId);
    },
    async gitlab(user: AuthUser, q: { code: string; state: string }): Promise<string> {
      const r = await agent.gitlabCallback(user, q, owner(user));
      return landing(d, r.repoId);
    },
  };
}

export function repoAgentRoutes(agent: RepoAgent): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const org = (c: Context<AppEnv>, min: OrgRole): string => {
    const id = c.req.param("orgId");
    if (!isUuid(id)) throw notFound("Организация");
    checkOrgAccess(c.get("user"), id, min, "Организация", min === "owner" ? "NOT_OWNER" : "FORBIDDEN");
    return id;
  };
  const repo = (c: Context<AppEnv>): string => {
    const id = c.req.param("repoId");
    if (!isUuid(id)) throw notFound("Репозиторий");
    return id;
  };

  r.get("/orgs/:orgId/repo-agent", async (c) => c.json(await agent.view(org(c, "viewer"))));

  r.post("/orgs/:orgId/repo-agent/github", async (c) => {
    const o = org(c, "owner");
    return c.json({ url: agent.githubInstallUrl(o, c.get("user").id) });
  });

  r.post("/orgs/:orgId/repo-agent/gitlab", async (c) => {
    const o = org(c, "owner");
    const b = await jsonBody(
      c,
      z.strictObject({
        baseUrl: z.string().max(300).nullish(),
        clientId: z.string().max(200).nullish(),
        clientSecret: z.string().max(300).nullish(),
      }),
    );
    return c.json({ url: await agent.gitlabAuthorize(o, c.get("user").id, b) });
  });

  r.get("/orgs/:orgId/repo-agent/:repoId", async (c) => {
    const o = org(c, "viewer");
    return c.json(await agent.repoView(o, repo(c)));
  });

  r.get("/orgs/:orgId/repo-agent/:repoId/choices", async (c) => {
    const o = org(c, "owner");
    const items = await agent.choices(o, repo(c));
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

  r.post("/orgs/:orgId/repo-agent/:repoId/repo", async (c) => {
    const o = org(c, "owner");
    const id = repo(c);
    const b = await jsonBody(c, z.strictObject({ repoId: z.string().regex(/^[0-9]{1,20}$/) }));
    await agent.select(o, id, b.repoId, c.get("user").id);
    return c.json(await agent.repoView(o, id));
  });

  r.post("/orgs/:orgId/repo-agent/:repoId/check", async (c) => {
    const o = org(c, "owner");
    const id = repo(c);
    await agent.recheck(o, id, c.get("user").id);
    return c.json(await agent.repoView(o, id));
  });

  r.post("/orgs/:orgId/repo-agent/:repoId/tasks", async (c) => {
    const o = org(c, "owner");
    const b = await jsonBody(c, z.strictObject({ task: z.string().min(1).max(4000) }));
    return c.json(await agent.createTask(o, repo(c), c.get("user").id, b.task), 202);
  });

  r.delete("/orgs/:orgId/repo-agent/:repoId", async (c) => {
    const o = org(c, "owner");
    await agent.disconnect(o, repo(c));
    return c.json(await agent.view(o));
  });

  return r;
}
