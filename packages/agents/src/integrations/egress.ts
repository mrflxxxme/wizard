// D37 for integration code (V3-20): a function under functions/integrations/<id>/ reaches only the hosts of the
// contract <id> and uses only its key. The runtime enforces functions[].egress per call (ctx.http.fetch, egress proxy
// grants); this check keeps the spec honest before it gets there — the harness and the platform refuse a layer or a
// spec that would widen an integration's egress.
import type { AppSpec } from "@wizard/appspec";
import { INTEGRATION_FILE_RE } from "./codegen.js";
import type { IntegrationContract } from "./contract.js";

export interface EgressIssue {
  /** JSON Pointer into the spec. */
  path: string;
  message_ru: string;
}

/** Integration functions whose egress or keys go beyond their contract (or that have no contract at all). */
export function integrationEgressIssues(
  spec: AppSpec,
  contracts: readonly IntegrationContract[],
): EgressIssue[] {
  const byId = new Map(contracts.map((c) => [c.id, c]));
  const out: EgressIssue[] = [];
  (spec.functions ?? []).forEach((f, i) => {
    const m = INTEGRATION_FILE_RE.exec(f.file);
    if (!m) return;
    const c = byId.get(m[1] as string);
    const egress = f.egress ?? [];
    const keys = f.secretRefs ?? [];
    if (!c) {
      if (egress.length || keys.length)
        out.push({
          path: `/functions/${i}`,
          message_ru: `Функция «${f.name}» интеграции «${m[1]}» ходит наружу без контракта API`,
        });
      return;
    }
    const hosts = new Set(c.hosts);
    egress.forEach((h, j) => {
      if (!hosts.has(h.toLowerCase()))
        out.push({
          path: `/functions/${i}/egress/${j}`,
          message_ru: `Функция «${f.name}» обращается к ${h}, а контракт «${c.name}» разрешает только ${c.hosts.join(", ")}`,
        });
    });
    keys.forEach((k, j) => {
      if (k !== c.auth.secret)
        out.push({
          path: `/functions/${i}/secretRefs/${j}`,
          message_ru: `Функция «${f.name}» использует ключ ${k}, а у контракта «${c.name}» ключ ${c.auth.secret ?? "не нужен"}`,
        });
    });
    if (egress.length && f.kind !== "action")
      out.push({
        path: `/functions/${i}/kind`,
        message_ru: `Функция «${f.name}» ходит наружу, но она не action`,
      });
  });
  return out;
}
