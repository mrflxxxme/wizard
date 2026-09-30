// Deployment registry (runtime.yaml#system_loading.registry). M0: FileRegistry over .data/artifacts/registry.json;
// M0-26 adds DbRegistry over platform.deployments with the same entry shape.
import { readFile, stat } from "node:fs/promises";

export type SystemEnv = "draft" | "prod";

export interface RegistryEntry {
  /** systems.schema_key: 12 chars [a-z0-9]; names the schema app_<systemId>_<env> and the artifact folder. */
  systemId: string;
  slug: string;
  env: SystemEnv;
  revision: number;
  specHash: string;
  bundleKey: string;
  publishedAt: string;
  suspended: boolean;
  features: { phoneOtp: boolean };
}

export interface SystemRegistry {
  /** Published deployment for a host, or null (→ 404 «Система не найдена»). */
  resolve(slug: string, env: SystemEnv): Promise<RegistryEntry | null>;
}

export const SYSTEM_ID_RE = /^[a-z0-9]{12}$/;
export const SLUG_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;

function asEntry(raw: unknown): RegistryEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.systemId !== "string" || !SYSTEM_ID_RE.test(r.systemId)) return null;
  if (typeof r.slug !== "string" || !SLUG_RE.test(r.slug) || r.slug.includes("--")) return null;
  if (r.env !== "draft" && r.env !== "prod") return null;
  const features = (typeof r.features === "object" && r.features !== null ? r.features : {}) as Record<
    string,
    unknown
  >;
  return {
    systemId: r.systemId,
    slug: r.slug,
    env: r.env,
    revision: typeof r.revision === "number" ? r.revision : 0,
    specHash: typeof r.specHash === "string" ? r.specHash : "",
    bundleKey: typeof r.bundleKey === "string" ? r.bundleKey : "",
    publishedAt: typeof r.publishedAt === "string" ? r.publishedAt : "",
    suspended: r.suspended === true,
    features: { phoneOtp: features.phoneOtp === true },
  };
}

/** Parses registry.json: `{deployments: RegistryEntry[]}` or a bare array. Invalid entries are skipped. */
export function parseRegistry(json: unknown): RegistryEntry[] {
  const list = Array.isArray(json) ? json : (json as { deployments?: unknown } | null)?.deployments;
  if (!Array.isArray(list)) return [];
  return list.map(asEntry).filter((e): e is RegistryEntry => e !== null);
}

/** Reads the registry file on demand, re-parsing only when its mtime changes. A missing file = no systems. */
export class FileRegistry implements SystemRegistry {
  private cache: { mtimeMs: number; entries: RegistryEntry[] } | undefined;

  constructor(readonly path: string) {}

  async entries(): Promise<RegistryEntry[]> {
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(this.path)).mtimeMs;
    } catch {
      this.cache = undefined;
      return [];
    }
    if (this.cache?.mtimeMs !== mtimeMs) {
      const entries = parseRegistry(JSON.parse(await readFile(this.path, "utf8")));
      this.cache = { mtimeMs, entries };
    }
    return this.cache.entries;
  }

  async resolve(slug: string, env: SystemEnv): Promise<RegistryEntry | null> {
    return (await this.entries()).find((e) => e.slug === slug && e.env === env) ?? null;
  }
}

/** In-memory registry (tests, previews). */
export class MemoryRegistry implements SystemRegistry {
  constructor(readonly list: RegistryEntry[] = []) {}
  async resolve(slug: string, env: SystemEnv): Promise<RegistryEntry | null> {
    return this.list.find((e) => e.slug === slug && e.env === env) ?? null;
  }
}
