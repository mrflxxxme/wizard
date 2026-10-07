// F4 (orchestrator.yaml: phone_otp only on the start and business plans) for the beta v2 path: a plan of an org whose
// tariff has no SMS login gets «Код на почту» instead of «Код по телефону» in every login parameter of its modules,
// before the plan card — else it builds and is refused at publication (PHONE_LOGIN_PLAN_REQUIRED, mvp-04 of D76).
import type { SystemPlan } from "@wizard/appspec";
import type { ModuleRegistry } from "@wizard/modules";

const PHONE = "phone_otp";
const EMAIL = "email_otp";

/** The plan with every enum parameter set to phone_otp switched to email_otp (where the module offers it); changed — any. */
export function withoutPhoneLogin(
  plan: SystemPlan,
  registry: ModuleRegistry,
): { plan: SystemPlan; changed: boolean } {
  const manifests = new Map(registry.modules.map((d) => [d.manifest.id, d.manifest]));
  let changed = false;
  const modules = plan.modules.map((m) => {
    const params = m.params as Record<string, unknown> | undefined;
    if (!params) return m;
    const loginParams = (manifests.get(m.id)?.params ?? []).filter(
      (p) =>
        p.type === "enum" &&
        p.options.some((o) => o.value === PHONE) &&
        p.options.some((o) => o.value === EMAIL) &&
        params[p.name] === PHONE,
    );
    if (loginParams.length === 0) return m;
    changed = true;
    const next = { ...params };
    for (const p of loginParams) next[p.name] = EMAIL;
    return { ...m, params: next };
  });
  return changed ? { plan: { ...plan, modules }, changed } : { plan, changed };
}
