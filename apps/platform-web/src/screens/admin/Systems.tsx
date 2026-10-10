// Staff console «Системы и сбои» (/admin, tab admin-tab-systems; V3-18): every client system with its org, stage,
// published revision, the last build and the spend (GET /admin/systems), and the failed runs with the error code and
// the Russian text the client saw (GET /admin/runs?status=failed). Read only. Any MFA_REQUIRED returns to the code screen.
import { type ReactNode, useEffect, useState } from "react";
import { ApiError } from "../../api/client.js";
import type { AdminRun, AdminSystem } from "../../api/types.js";
import { usePlatform } from "../../app/context.js";
import { Alert, Pill, type Tone } from "../../components/ui.js";
import { ru } from "../../i18n/ru.js";
import st from "../settings/Settings.module.css";
import s from "./Admin.module.css";

export const systemsRu = {
  tab: "Системы и сбои",
  systemsTitle: "Системы клиентов",
  systemsEmpty: "Систем пока нет",
  runsTitle: "Сбои сборок и публикаций",
  runsEmpty: "Сбоев нет",
  colOrg: "Организация",
  colSystem: "Система",
  colStage: "Этап",
  colPublished: "Опубликована",
  colBuild: "Последняя сборка",
  colSpend: "Модели",
  colCredits: "Кредиты",
  colKind: "Тип",
  colCode: "Код",
  colMessage: "Что увидел клиент",
  colCost: "Стоимость",
  colTime: "Когда",
  notPublished: "нет",
  noBuild: "не было",
  suspended: "снята",
  stage: {
    interview: "интервью",
    card: "карточка",
    building: "сборка",
    ready: "готова",
    failed: "сбой",
  } as Record<string, string>,
  status: {
    queued: "в очереди",
    waiting_lock: "ждёт",
    running: "идёт",
    needs_input: "ждёт ответа",
    succeeded: "успешно",
    failed: "сбой",
    cancelled: "отменена",
  } as Record<string, string>,
  kind: {
    interview_turn: "интервью",
    build: "сборка",
    publish: "публикация",
    rollback: "откат",
    import_table: "импорт",
    retention: "хранение",
    nightly_eval: "ночной замер",
    export: "выгрузка",
  } as Record<string, string>,
};

const T = systemsRu;
const STATUS_TONE: Record<string, Tone> = {
  succeeded: "ok",
  failed: "bad",
  cancelled: "neutral",
  running: "accent",
  queued: "accent",
};
const rub = (n: number) =>
  `${n.toLocaleString("ru-RU", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ₽`;
const credits = (n: number) => n.toLocaleString("ru-RU", { maximumFractionDigits: 1 });
const fmtTime = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("ru-RU", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";

export function SystemsSection({ onMfaRequired }: { onMfaRequired(): void }): ReactNode {
  const { api } = usePlatform();
  const [systems, setSystems] = useState<AdminSystem[] | null>(null);
  const [runs, setRuns] = useState<AdminRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([api.adminListSystems(), api.adminListRuns("failed")])
      .then(([a, b]) => {
        if (!live) return;
        setSystems(a.items);
        setRuns(b.items);
      })
      .catch((e: unknown) => {
        if (!live) return;
        if (e instanceof ApiError && e.code === "MFA_REQUIRED") onMfaRequired();
        else setError(e instanceof Error ? e.message : ru.errors.generic);
      });
    return () => {
      live = false;
    };
  }, [api, onMfaRequired]);

  if (!systems || !runs)
    return error ? <Alert>{error}</Alert> : <p className={st.muted}>{ru.admin.loading}</p>;
  return (
    <div className={st.form} data-testid="admin-systems">
      <section className={st.block} data-testid="admin-systems-list">
        <h2 className={st.blockTitle}>{T.systemsTitle}</h2>
        {systems.length === 0 ? (
          <p className={st.muted}>{T.systemsEmpty}</p>
        ) : (
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>{T.colOrg}</th>
                  <th>{T.colSystem}</th>
                  <th>{T.colStage}</th>
                  <th>{T.colPublished}</th>
                  <th>{T.colBuild}</th>
                  <th>{T.colSpend}</th>
                  <th>{T.colCredits}</th>
                </tr>
              </thead>
              <tbody>
                {systems.map((x) => (
                  <tr key={x.id} data-testid="admin-system-row" data-system={x.id}>
                    <td>{x.org.name}</td>
                    <td>{x.name}</td>
                    <td>
                      {T.stage[x.stage] ?? x.stage}
                      {x.suspended ? ` · ${T.suspended}` : ""}
                    </td>
                    <td>{x.publishedRevision === null ? T.notPublished : `r${x.publishedRevision}`}</td>
                    <td>
                      {x.lastBuild ? (
                        <>
                          <Pill tone={STATUS_TONE[x.lastBuild.status] ?? "neutral"}>
                            {T.status[x.lastBuild.status] ?? x.lastBuild.status}
                          </Pill>{" "}
                          {x.lastBuild.failureCode ? `${x.lastBuild.failureCode} · ` : ""}
                          {fmtTime(x.lastBuild.at)}
                        </>
                      ) : (
                        T.noBuild
                      )}
                    </td>
                    <td>{rub(x.modelSpendRub)}</td>
                    <td>{credits(x.creditsUsed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className={st.block} data-testid="admin-runs-failed">
        <h2 className={st.blockTitle}>{T.runsTitle}</h2>
        {runs.length === 0 ? (
          <p className={st.muted}>{T.runsEmpty}</p>
        ) : (
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>{T.colTime}</th>
                  <th>{T.colOrg}</th>
                  <th>{T.colSystem}</th>
                  <th>{T.colKind}</th>
                  <th>{T.colCode}</th>
                  <th>{T.colMessage}</th>
                  <th>{T.colCost}</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} data-testid="admin-run-row" data-run={r.id}>
                    <td>{fmtTime(r.finishedAt ?? r.createdAt)}</td>
                    <td>{r.org.name}</td>
                    <td>{r.system?.name ?? "—"}</td>
                    <td>{T.kind[r.kind] ?? r.kind}</td>
                    <td>{r.errorCode ?? "—"}</td>
                    <td>{r.messageRu ?? "—"}</td>
                    <td>
                      {rub(r.modelSpendRub)} · {credits(r.creditsUsed)} кр.
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
