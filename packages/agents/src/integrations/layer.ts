// The integrations layer of a build (V3-20; builder-v3.md C6 «backend»): for every outgoing integration of the brief
// with a stored contract — its client code and actions (mock until the key check passes, then live); for the others
// a note what is missing. Pure: the host reads the contracts and their states, the harness merges the layer into the
// backend's spec and files (V3Host.integrations).

import { createHash } from "node:crypto";
import type { AppSpec, SystemBrief } from "@wizard/appspec";
import { canonical } from "@wizard/modules";
import {
  INTEGRATION_FILE_RE,
  type IntegrationMode,
  integrationCode,
  integrationDir,
  type SpecFunction,
} from "./codegen.js";
import { contractRef, type IntegrationContract } from "./contract.js";
import { integrationEgressIssues } from "./egress.js";

/** A contract version as the platform keeps it, with the integration's state. */
export interface StoredContract {
  contract: IntegrationContract;
  version: number;
  sha256: string;
  /** mock — no key or the check did not pass; live — the key check passed. */
  mode: IntegrationMode;
}

export interface IntegrationLayer {
  /** functions/integrations/<id>/** files. */
  files: Record<string, string>;
  functions: SpecFunction[];
  /** Hash of what the layer was made of (contracts, versions, modes). */
  fingerprint: string;
  /** Russian notes for the owner (missing contracts, mock mode, incoming API). */
  notes: string[];
}

/** Builds the layer of the brief's integrations from the stored contracts. */
export function integrationLayer(o: {
  brief: SystemBrief;
  contracts: readonly StoredContract[];
}): IntegrationLayer {
  const files: Record<string, string> = {};
  const functions: SpecFunction[] = [];
  const notes: string[] = [];
  const used: { id: string; version: number; sha256: string; mode: IntegrationMode }[] = [];
  const byId = new Map(o.contracts.map((c) => [c.contract.id, c]));
  for (const integ of o.brief.integrations) {
    if (integ.direction === "in") {
      notes.push(
        `«${integ.name}» обращается к системе сама: выдайте ей ключ доступа в разделе «API системы» — описание API (OpenAPI) появится там же.`,
      );
      continue;
    }
    const stored = byId.get(integ.id);
    if (!stored) {
      notes.push(
        `Для интеграции «${integ.name}» ещё нет контракта API — пришлите ссылку на документацию или файл OpenAPI, и я подключу её.`,
      );
      continue;
    }
    const ref = contractRef(stored.contract.id, stored.version, stored.sha256);
    const code = integrationCode(stored.contract, stored.mode, ref);
    Object.assign(files, code.files);
    functions.push(...code.functions);
    notes.push(...code.skipped);
    if (stored.mode === "mock")
      notes.push(
        `«${integ.name}» пока работает на тестовых ответах (мок) — интеграция включится, как только вы введёте ключ и он пройдёт проверку.`,
      );
    used.push({ id: stored.contract.id, version: stored.version, sha256: stored.sha256, mode: stored.mode });
  }
  const fingerprint = createHash("sha256")
    .update(canonical(used.sort((a, b) => a.id.localeCompare(b.id))) ?? "[]")
    .digest("hex");
  return { files, functions, fingerprint, notes };
}

/** Integration id of a file under functions/integrations/<id>/, or null. */
const integrationOf = (path: string): string | null => INTEGRATION_FILE_RE.exec(path)?.[1] ?? null;

const CLIENT_IMPORT_RE = /from\s+["']((?:\.\.?\/)+integrations\/([a-z][a-z0-9_]{0,39})\/client)["']/g;

/**
 * Integrations whose client a module function imports (V3-23: the shop's СДЭК delivery calls
 * functions/integrations/cdek/client the module ships in mock mode): ids by the import of its source.
 */
export function clientImports(file: string, source: string): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(CLIENT_IMPORT_RE)) {
    const parts = file.split("/").slice(0, -1);
    for (const seg of (m[1] as string).split("/")) {
      if (seg === "..") parts.pop();
      else if (seg !== ".") parts.push(seg);
    }
    if (parts.join("/") === `functions/integrations/${m[2]}/client`) out.add(m[2] as string);
  }
  return [...out];
}

/**
 * The layer on top of a backend: integration functions replace earlier ones of the same name; files and functions of
 * an integration the layer generates replace the backend's (functions/integrations/<id>/** belongs to the layer), and a
 * module's own client of an integration the layer does not have stays (V3-23: the shop's СДЭК mock). A module function
 * that imports the client of an integration in live mode gets exactly that contract's hosts and key (D37); in mock mode
 * none. Throws when the result breaks D37.
 */
export function withIntegrationLayer<T extends { spec: AppSpec; files: Record<string, string> }>(
  base: T,
  layer: IntegrationLayer,
  contracts: readonly IntegrationContract[],
): T {
  const names = new Set(layer.functions.map((f) => f.name));
  const generated = new Set(
    [...Object.keys(layer.files), ...layer.functions.map((f) => f.file)]
      .map(integrationOf)
      .filter((x): x is string => x !== null),
  );
  const replaced = (path: string) => {
    const id = integrationOf(path);
    return id !== null && generated.has(id);
  };
  const files = Object.fromEntries(Object.entries(base.files).filter(([p]) => !replaced(p)));
  Object.assign(files, layer.files);
  // Live integrations of the layer: a function of the contract declares its hosts (codegen live mode).
  const live = new Map<string, IntegrationContract>();
  for (const f of layer.functions) {
    const id = integrationOf(f.file);
    const c = id ? contracts.find((x) => x.id === id) : undefined;
    if (c && f.egress?.length) live.set(c.id, c);
  }
  const kept = (base.spec.functions ?? [])
    .filter((f) => !names.has(f.name) && !replaced(f.file))
    .map((f) => {
      if (integrationOf(f.file) !== null) return f;
      const uses = clientImports(f.file, files[f.file] ?? "").filter((id) => generated.has(id));
      if (uses.length === 0) return f;
      const { egress: _e, secretRefs: _s, ...rest } = f;
      const via = uses.map((id) => live.get(id)).filter((c): c is IntegrationContract => c !== undefined);
      const egress = [...new Set(via.flatMap((c) => c.hosts))];
      const keys = [...new Set(via.flatMap((c) => (c.auth.secret ? [c.auth.secret] : [])))];
      return {
        ...rest,
        ...(egress.length ? { egress } : {}),
        ...(keys.length ? { secretRefs: keys } : {}),
      } as typeof f;
    });
  const spec = { ...base.spec, functions: [...kept, ...layer.functions] } as AppSpec;
  const issues = integrationEgressIssues(spec, contracts);
  if (issues.length) throw new Error(`integration egress: ${issues.map((i) => i.message_ru).join("; ")}`);
  return { ...base, spec, files };
}

/** Folder of an integration (re-export for hosts). */
export { integrationDir };

/** What V3Host.integrations returns: the merged spec and files, the layer's fingerprint and notes. */
export interface IntegrationsHookResult {
  spec: AppSpec;
  files: Record<string, string>;
  fingerprint: string;
  notes: string[];
}

/**
 * V3Host.integrations over a reader of the stored contracts (the platform: platform.system_integration_contracts):
 * a brief without integrations changes nothing (null).
 */
export function integrationsHook(
  read: () => Promise<readonly StoredContract[]>,
): (input: {
  brief: SystemBrief;
  spec: AppSpec;
  files: Readonly<Record<string, string>>;
}) => Promise<IntegrationsHookResult | null> {
  return async ({ brief, spec, files }) => {
    if (brief.integrations.length === 0) return null;
    const stored = await read();
    const layer = integrationLayer({ brief, contracts: stored });
    const merged = withIntegrationLayer(
      { spec, files: { ...files } },
      layer,
      stored.map((s) => s.contract),
    );
    return { spec: merged.spec, files: merged.files, fingerprint: layer.fingerprint, notes: layer.notes };
  };
}
