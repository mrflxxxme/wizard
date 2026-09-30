// Env names: specs/platform/deploy.yaml#local.env_vars (canonical list, no new names).
import { join, resolve } from "node:path";
import { DEFAULT_DB_URL } from "./db/index.js";

export interface Config {
  dbUrl: string;
  /** "dev" in M0 (api.yaml#info.x-auth.M0); host guard also applies with unsafeLocalExec. */
  authMode: string;
  unsafeLocalExec: boolean;
  platformOrigin: string;
  runConcurrency: number;
  milestone: string;
  /** Root of .data/artifacts (deploy.yaml#local.artifacts). */
  artifactsDir: string;
  /** Base of draft preview URLs (runtime :4100, deploy.yaml#local.hosts.systems). */
  runtimePort: number;
}

export const REPO_ROOT = resolve(import.meta.dirname, "../../..");

export function loadConfig(env: NodeJS.ProcessEnv = process.env, over: Partial<Config> = {}): Config {
  const conc = Number(env.WIZARD_RUN_CONCURRENCY ?? 2);
  return {
    dbUrl: env.WIZARD_DB_URL ?? env.DATABASE_URL ?? DEFAULT_DB_URL,
    authMode: env.WIZARD_AUTH_MODE || "dev",
    unsafeLocalExec: env.WIZARD_UNSAFE_LOCAL_EXEC === "1",
    platformOrigin: env.WIZARD_PLATFORM_ORIGIN || "http://localhost:5173",
    runConcurrency: Number.isInteger(conc) && conc > 0 ? conc : 2,
    milestone: env.WIZARD_MILESTONE || "M0",
    artifactsDir: join(REPO_ROOT, ".data", "artifacts"),
    runtimePort: 4100,
    ...over,
  };
}
