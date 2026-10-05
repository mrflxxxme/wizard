// «На пилоте бесплатно» and what is left in words (D70, M2-56 mvp_scope): GET /orgs/:id/usage; the cabinet shows no
// credits. needsTeam(code) — errors after which the client gets «Написать команде» instead of «Докупить».
import { type ReactNode, useEffect, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import type { PilotUsage } from "../../api/types.js";
import { pricing, ruDate } from "../../i18n/ru/pricing.js";

/** Usage of `orgId`; null — unknown (no API, error) or not loaded yet. */
export function useUsage(api: Partial<ApiClient>, orgId: string, enabled = true): PilotUsage | null {
  const [usage, setUsage] = useState<PilotUsage | null>(null);
  useEffect(() => {
    if (!enabled || typeof api.getUsage !== "function") return;
    let live = true;
    api
      .getUsage(orgId)
      .then((u) => live && setUsage(u))
      .catch(() => live && setUsage(null));
    return () => {
      live = false;
    };
  }, [api, orgId, enabled]);
  return usage;
}

/** «На пилоте бесплатно · ещё 2 сборки · ещё 15 правок»; null for an org that is not on the pilot. */
export function usageText(u: PilotUsage | null): string | null {
  if (!u?.pilot) return null;
  return pricing.pill(u.builds.left ?? 0, u.edits.left ?? 0);
}

export const needsTeam = (code: string | null | undefined): boolean =>
  !!code && (pricing.teamCodes as readonly string[]).includes(code);

/** S-billing block of a pilot org: free, what is left, the rule and when the next one frees up. */
export function UsageDetails({ usage }: { usage: PilotUsage }): ReactNode {
  const next = [usage.builds, usage.edits]
    .filter((c) => c.left === 0 && c.nextAt)
    .map((c) => c.nextAt as string)
    .sort()[0];
  return (
    <div data-testid="usage-details">
      <p data-testid="usage-free">
        <b>{pricing.free}</b>
      </p>
      <p data-testid="usage-left">
        {pricing.buildsLeft(usage.builds.left ?? 0)} · {pricing.editsLeft(usage.edits.left ?? 0)}
      </p>
      <p>{pricing.window(usage.builds.limit ?? 0, usage.edits.limit ?? 0)}</p>
      {next && <p data-testid="usage-next">{pricing.next(ruDate(next))}</p>}
      <p>{pricing.more}</p>
    </div>
  );
}
