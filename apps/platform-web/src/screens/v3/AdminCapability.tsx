// /admin «Пока не умею» (V3-06, D77 (12)): the monthly share of requirements of v3 briefs the platform does not cover
// yet — a table with a bar per month (GET /admin/capability-share). In the «Запросы на развитие» tab: the requests show
// what was asked, this block whether the share falls.
import { type ReactNode, useEffect, useState } from "react";
import { ApiError } from "../../api/client.js";
import type { CapabilityMonth } from "../../api/types.js";
import { usePlatform } from "../../app/context.js";
import { Alert } from "../../components/ui.js";
import { ru } from "../../i18n/ru.js";
import s from "../admin/Admin.module.css";
import st from "../settings/Settings.module.css";
import c from "./AdminCapability.module.css";
import { v3Ru } from "./ru.js";

const T = v3Ru.admin;
const pct = (share: number) => `${Math.round(share * 1000) / 10} %`;
const monthRu = (m: string) =>
  new Date(`${m}-01T00:00:00Z`).toLocaleString("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" });

export function AdminCapability({ onMfaRequired }: { onMfaRequired(): void }): ReactNode {
  const { api } = usePlatform();
  const [months, setMonths] = useState<CapabilityMonth[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .adminCapabilityShare()
      .then((r) => live && setMonths(r.months))
      .catch((e: unknown) => {
        if (!live) return;
        if (e instanceof ApiError && e.code === "MFA_REQUIRED") onMfaRequired();
        else setError(e instanceof Error ? e.message : ru.errors.generic);
      });
    return () => {
      live = false;
    };
  }, [api, onMfaRequired]);

  const counted = (months ?? []).filter((m) => m.requirements > 0);
  const first = counted[0];
  const last = counted[counted.length - 1];
  return (
    <section className={st.block} data-testid="admin-capability">
      <h2 className={st.blockTitle}>{T.title}</h2>
      <p className={st.hint}>{T.lead}</p>
      {error && <Alert>{error}</Alert>}
      {months && counted.length === 0 && <p className={st.muted}>{T.empty}</p>}
      {months && counted.length > 0 && (
        <>
          {first && last && first !== last && (
            <p className={st.hint} data-testid="admin-capability-trend">
              {T.trend(pct(first.share), pct(last.share))}
            </p>
          )}
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>{T.month}</th>
                  <th>{T.share}</th>
                  <th>{T.notYet}</th>
                  <th>{T.requirements}</th>
                  <th>{T.briefs}</th>
                </tr>
              </thead>
              <tbody>
                {[...months].reverse().map((m) => (
                  <tr key={m.month} data-testid="admin-capability-row" data-month={m.month}>
                    <td>{monthRu(m.month)}</td>
                    <td>
                      <span className={c.share}>
                        <span className={c.bar} aria-hidden="true">
                          <span className={c.fill} style={{ transform: `scaleX(${m.share})` }} />
                        </span>
                        <span data-testid="admin-capability-share">
                          {m.requirements ? pct(m.share) : "—"}
                        </span>
                      </span>
                    </td>
                    <td>{m.notYet}</td>
                    <td>{m.requirements}</td>
                    <td>{m.briefs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
