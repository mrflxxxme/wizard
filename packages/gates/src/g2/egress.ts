// G2-EGRESS-01/02 (M2-52, D71; gates.yaml#G2.checks): hosts of outgoing requests of functions. 01 (blocker) — every
// functions[].egress host is a public DNS name: not an IP, not an internal zone, not a platform domain; ctx.http is
// for actions only. 02 (warning → founder review before prod) — hosts the published revision did not have.
import type { AppSpec } from "@wizard/appspec";
import { egressHostProblem, newEgressHosts, platformDomains } from "@wizard/connectors";
import type { Finding } from "../report.js";

const WHY_RU = {
  format: "это не доменное имя (IP-адрес, порт или ошибка в имени)",
  internal: "это внутреннее или служебное имя, а не публичный сайт",
  platform: "это домен самой платформы",
} as const;

/** G2-EGRESS-01: declared hosts are valid public targets. */
export function egressHosts(
  spec: AppSpec,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Finding[] {
  const platform = platformDomains(env);
  const out: Finding[] = [];
  (spec.functions ?? []).forEach((f, fi) => {
    const hosts = f.egress ?? [];
    if (hosts.length > 0 && f.kind !== "action")
      out.push({
        message_ru: `Функция «${f.name}» объявляет внешние адреса, но запросы наружу делает только action`,
        path: `/functions/${fi}/egress`,
        fixHint: "Сделайте функцию action или уберите egress",
      });
    hosts.forEach((h, hi) => {
      const problem = egressHostProblem(h, platform);
      if (problem)
        out.push({
          message_ru: `Функции «${f.name}» нельзя ходить на ${h}: ${WHY_RU[problem]}`,
          path: `/functions/${fi}/egress/${hi}`,
          evidence: `egress ${h}: ${problem}`,
          fixHint: "Укажите публичный адрес сервиса, например api.example.ru",
        });
    });
  });
  return out;
}

/** G2-EGRESS-02: hosts new relative to the published revision (prod) — the founder reviews them before prod. */
export function egressNewHosts(spec: AppSpec, prev: AppSpec | null, env: "draft" | "prod"): Finding[] {
  if (env !== "prod") return [];
  const hosts = newEgressHosts(spec, prev);
  if (hosts.length === 0) return [];
  return [
    {
      message_ru: `Система будет отправлять запросы на новые адреса: ${hosts.join(", ")} — их посмотрит модератор перед публикацией`,
      evidence: `new_egress_hosts: ${hosts.join(",")}; founder_review`,
    },
  ];
}
