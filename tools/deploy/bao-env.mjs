#!/usr/bin/env node
// Short-lived deploy credentials for GitHub Actions on the self-hosted runner (deploy.yaml#cloud.secrets.ci, L3-38):
// GitHub OIDC token → OpenBao JWT auth (role bound to this repo, branch and environment) → one KV v2 read →
// values exported to $GITHUB_ENV (masked) → the OpenBao token is revoked at once. Nothing long-lived lives in GitHub.
//   node tools/deploy/bao-env.mjs --role wizard-deploy-staging --path secret/data/wizard/staging/deploy
// Env: OPENBAO_ADDR (GitHub variable), ACTIONS_ID_TOKEN_REQUEST_URL/_TOKEN (job permission id-token: write),
// GITHUB_ENV. Optional OPENBAO_CACERT (CA of the in-cluster OpenBao, PEM path on the runner) via NODE_EXTRA_CA_CERTS.
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const NAME = /^[A-Z][A-Z0-9_]{0,127}$/;

export function parseArgs(argv) {
  const o = { role: "", path: "", audience: "openbao" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--role") o.role = argv[++i] ?? "";
    else if (a === "--path") o.path = argv[++i] ?? "";
    else if (a === "--audience") o.audience = argv[++i] ?? "";
    else throw new Error(`unknown argument ${a}`);
  }
  if (!/^[a-z0-9-]{1,64}$/.test(o.role)) throw new Error("--role is required");
  if (!/^[a-z0-9_-]+(\/[a-z0-9_-]+)+$/.test(o.path)) throw new Error("--path is required (KV v2 data path)");
  return o;
}

/** Lines for $GITHUB_ENV (multi-line safe) and the ::add-mask:: commands for stdout. */
export function exportLines(data, delim = `WZ_${randomBytes(8).toString("hex")}`) {
  const env = [];
  const masks = [];
  for (const [k, v] of Object.entries(data)) {
    if (!NAME.test(k)) throw new Error(`secret key ${k} is not an env name`);
    const value = String(v);
    if (value.includes(delim)) throw new Error("delimiter collision");
    for (const line of value.split(/\r?\n/)) if (line.trim()) masks.push(`::add-mask::${line}`);
    env.push(`${k}<<${delim}`, value, delim);
  }
  return { env: `${env.join("\n")}\n`, masks };
}

export async function fetchDeployEnv(o, vars = process.env, f = fetch) {
  const addr = (vars.OPENBAO_ADDR ?? "").replace(/\/$/, "");
  if (!addr) throw new Error("OPENBAO_ADDR is not set");
  if (!vars.ACTIONS_ID_TOKEN_REQUEST_URL || !vars.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    throw new Error("no GitHub OIDC (permissions: id-token: write)");
  }
  const oidcUrl = `${vars.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${encodeURIComponent(o.audience)}`;
  const oidc = await f(oidcUrl, {
    headers: { authorization: `bearer ${vars.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
  });
  if (!oidc.ok) throw new Error(`GitHub OIDC: HTTP ${oidc.status}`);
  const jwt = (await oidc.json())?.value;
  if (typeof jwt !== "string") throw new Error("GitHub OIDC: no token");
  const login = await f(`${addr}/v1/auth/jwt/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role: o.role, jwt }),
  });
  if (!login.ok) throw new Error(`OpenBao login: HTTP ${login.status}`);
  const token = (await login.json())?.auth?.client_token;
  if (typeof token !== "string") throw new Error("OpenBao login: no token");
  try {
    const r = await f(`${addr}/v1/${o.path}`, { headers: { "x-vault-token": token } });
    if (!r.ok) throw new Error(`OpenBao read ${o.path}: HTTP ${r.status}`);
    const data = (await r.json())?.data?.data;
    if (!data || typeof data !== "object") throw new Error(`OpenBao read ${o.path}: not a KV v2 secret`);
    return data;
  } finally {
    await f(`${addr}/v1/auth/token/revoke-self`, {
      method: "POST",
      headers: { "x-vault-token": token },
    }).catch(() => {});
  }
}

export async function main(argv = process.argv.slice(2), vars = process.env, f = fetch) {
  const o = parseArgs(argv);
  if (!vars.GITHUB_ENV) throw new Error("GITHUB_ENV is not set (run inside GitHub Actions)");
  const data = await fetchDeployEnv(o, vars, f);
  const { env, masks } = exportLines(data);
  for (const m of masks) console.log(m);
  appendFileSync(vars.GITHUB_ENV, env);
  console.log(`OpenBao: ${Object.keys(data).length} values exported for this job; token revoked.`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    (c) => process.exit(c),
    (e) => {
      console.error(`bao-env: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
