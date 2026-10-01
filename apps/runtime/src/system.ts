// LoadedSystem cache (runtime.yaml#system_loading): registry entry → spec from the artifact folder → DataAccess.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type AppSpec, validateSpec } from "@wizard/appspec";
import { isReservedSystemSlug } from "@wizard/connectors";
import type postgres from "postgres";
import { type ComplianceInfo, complianceInfo, sha256Hex } from "./compliance.js";
import type { DataAccess, InvalidationBus } from "./data/access.js";
import { createPgDataAccess, type PgDataAccessOptions } from "./data/pg.js";
import type { FileStorage } from "./files/storage.js";
import { SystemFiles } from "./files/system-files.js";
import { schemaName } from "./migrate.js";
import type { LegalTemplates } from "./privacy/templates.js";
import type { RegistryEntry, SystemEnv, SystemRegistry } from "./registry.js";

export interface LoadedSystem {
  entry: RegistryEntry;
  spec: AppSpec;
  schema: string;
  data: DataAccess;
  compliance: ComplianceInfo;
  /** .data/artifacts/<systemId>/<revision> or the folder given to loadSystem; null when there is none. */
  artifactDir: string | null;
  /** Files of file fields (runtime.yaml#files); null when the runtime has no file storage. */
  files: SystemFiles | null;
}

export class SystemLoadError extends Error {
  override name = "SystemLoadError";
}

export interface LoadSystemInput {
  /** systems.schema_key (12 chars [a-z0-9]). */
  systemKey: string;
  env: SystemEnv;
  spec: AppSpec;
  artifactDir?: string | null;
  /** Host slug; default: systemKey. */
  slug?: string;
  revision?: number;
  features?: { phoneOtp: boolean };
  suspended?: boolean;
}

export interface SystemCacheOptions {
  sql: postgres.Sql;
  registry: SystemRegistry;
  /** Root of artifact folders (default .data/artifacts). */
  artifactsRoot: string;
  dbRole?: string | null;
  statementTimeout?: string;
  capacity?: number;
  bus: (systemId: string, env: SystemEnv) => InvalidationBus;
  /** qr_token issuer of a system (qr connector, M0-24); undefined → random tokens. */
  qrToken?: (entry: RegistryEntry, spec: AppSpec) => PgDataAccessOptions["qrToken"];
  /** Templates of the policy and consent texts; default: built-in drafts + WIZARD_LEGAL_TEMPLATES_DIR. */
  legalTemplates?: LegalTemplates;
  /** Storage of file fields (M2-14); absent — file values are not checked and nothing is stored. */
  files?: FileStorage;
  log?: (line: Record<string, unknown>) => void;
}

const key = (slug: string, env: SystemEnv) => `${slug}--${env}`;

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

/** LRU over loaded systems (runtime.yaml#system_loading.rules: 200) plus systems pinned by loadSystem. */
export class SystemCache {
  private readonly lru = new Map<string, LoadedSystem>();
  private readonly pinned = new Map<string, LoadedSystem>();
  private readonly capacity: number;

  constructor(private readonly o: SystemCacheOptions) {
    this.capacity = o.capacity ?? 200;
  }

  get size(): number {
    return this.lru.size + this.pinned.size;
  }

  private build(entry: RegistryEntry, spec: AppSpec, artifactDir: string | null): LoadedSystem {
    const schema = schemaName(entry.systemId, entry.env);
    const compliance = complianceInfo(spec, this.o.legalTemplates);
    const files = this.o.files ? new SystemFiles(this.o.files, schema, spec, this.o.log) : null;
    const sys: LoadedSystem = {
      entry,
      spec,
      schema,
      artifactDir,
      compliance,
      files,
      data: createPgDataAccess({
        sql: this.o.sql,
        spec,
        schema,
        dbRole: this.o.dbRole,
        statementTimeout: this.o.statementTimeout,
        events: this.o.bus(entry.systemId, entry.env),
        qrToken: this.o.qrToken?.(entry, spec),
        compliance,
        ...(files ? { files: files.guard() } : {}),
      }),
    };
    files?.bind(sys.data);
    return sys;
  }

  /** Registers a system directly (previews, G1: runtime_handle.loadSystem); takes precedence over the registry. */
  pin(input: LoadSystemInput): LoadedSystem {
    const v = validateSpec(input.spec);
    if (!v.ok) throw new SystemLoadError(`invalid spec: ${v.errors.map((e) => e.code).join(", ")}`);
    if (isReservedSystemSlug(input.slug ?? input.systemKey))
      throw new SystemLoadError("reserved system slug");
    const entry: RegistryEntry = {
      systemId: input.systemKey,
      slug: input.slug ?? input.systemKey,
      env: input.env,
      revision: input.revision ?? 0,
      specHash: sha256Hex(JSON.stringify(v.spec)),
      bundleKey: "",
      publishedAt: new Date(0).toISOString(),
      suspended: input.suspended === true,
      features: input.features ?? { phoneOtp: false },
    };
    const sys = this.build(entry, v.spec, input.artifactDir ?? null);
    this.pinned.set(key(entry.slug, entry.env), sys);
    return sys;
  }

  /** Drops a system registered by pin (G1 runs pin one per run); true when it was pinned. */
  unpin(slug: string, env: SystemEnv): boolean {
    return this.pinned.delete(key(slug, env));
  }

  /**
   * POST /_wizard/internal/reload (runtime.yaml#system_loading.rules): drops the cached LoadedSystem of a deployment;
   * the next request reloads it from the registry. Requests in flight keep the old object. true when one was cached.
   */
  evict(systemId: string, env: SystemEnv): boolean {
    let hit = false;
    for (const [k, sys] of this.lru) {
      if (sys.entry.systemId === systemId && sys.entry.env === env) {
        this.lru.delete(k);
        hit = true;
      }
    }
    return hit;
  }

  /** Loaded system for a host, or null when the registry has no such deployment. Throws SystemLoadError (→ 503). */
  async resolve(slug: string, env: SystemEnv): Promise<LoadedSystem | null> {
    const k = key(slug, env);
    const pinned = this.pinned.get(k);
    if (pinned) return pinned;
    const entry = await this.o.registry.resolve(slug, env);
    if (!entry) {
      this.lru.delete(k);
      return null;
    }
    const cached = this.lru.get(k);
    if (
      cached &&
      cached.entry.revision === entry.revision &&
      cached.entry.specHash === entry.specHash &&
      cached.entry.systemId === entry.systemId
    ) {
      cached.entry = entry; // suspended/features may change without a new revision
      this.lru.delete(k);
      this.lru.set(k, cached);
      return cached;
    }
    const sys = await this.load(entry);
    this.lru.delete(k);
    this.lru.set(k, sys);
    while (this.lru.size > this.capacity) {
      const oldest = this.lru.keys().next().value;
      if (oldest === undefined) break;
      this.lru.delete(oldest);
    }
    return sys;
  }

  /** Loaded system by its key (pinned, cached, then the registry); null when unknown. */
  async byId(systemId: string, env: SystemEnv): Promise<LoadedSystem | null> {
    for (const sys of [...this.pinned.values(), ...this.lru.values()]) {
      if (sys.entry.systemId === systemId && sys.entry.env === env) return sys;
    }
    const entry = await this.o.registry.resolveById?.(systemId, env);
    return entry ? this.resolve(entry.slug, env) : null;
  }

  private async load(entry: RegistryEntry): Promise<LoadedSystem> {
    const dir = join(this.o.artifactsRoot, entry.systemId, String(entry.revision));
    let manifest: Record<string, unknown>;
    let raw: unknown;
    try {
      manifest = (await readJson(join(dir, "manifest.json"))) as Record<string, unknown>;
      raw = await readJson(join(dir, "spec.json"));
    } catch {
      throw new SystemLoadError("artifact is missing");
    }
    if (manifest.specHash !== entry.specHash || manifest.bundleKey !== entry.bundleKey) {
      throw new SystemLoadError("manifest does not match the registry entry");
    }
    const v = validateSpec(raw);
    if (!v.ok) throw new SystemLoadError("spec.json is invalid");
    return this.build(entry, v.spec, dir);
  }
}
