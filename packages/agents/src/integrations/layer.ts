// The integrations layer of a build (V3-20; builder-v3.md C6 «backend»): for every outgoing integration of the brief
// with a stored contract — its client code and actions (mock until the key check passes, then live); for the others
// a note what is missing. Pure: the host reads the contracts and their states, the harness merges the layer into the
// backend's spec and files (V3Host.integrations).

import { createHash } from "node:crypto";
import type { AppSpec, SystemBrief } from "@wizard/appspec";
import { canonical } from "@wizard/modules";
import { type IntegrationMode, integrationCode, integrationDir, type SpecFunction } from "./codegen.js";
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

/**
 * The layer on top of a backend: integration functions replace earlier ones of the same name, integration files of
 * other contracts are dropped (functions/integrations/** belongs to the layer). Throws when the result breaks D37.
 */
export function withIntegrationLayer<T extends { spec: AppSpec; files: Record<string, string> }>(
  base: T,
  layer: IntegrationLayer,
  contracts: readonly IntegrationContract[],
): T {
  const names = new Set(layer.functions.map((f) => f.name));
  const kept = (base.spec.functions ?? []).filter(
    (f) => !names.has(f.name) && !f.file.startsWith("functions/integrations/"),
  );
  const spec = { ...base.spec, functions: [...kept, ...layer.functions] } as AppSpec;
  const files = Object.fromEntries(
    Object.entries(base.files).filter(([p]) => !p.startsWith("functions/integrations/")),
  );
  Object.assign(files, layer.files);
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
