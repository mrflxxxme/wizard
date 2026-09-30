// StatsReport (ui-kit.yaml#components.StatsReport): KPI tiles and a bar list; aggregates come from a query function.
import type { CSSProperties, ReactNode } from "react";
import { cx, useDataSource, useWzRoot } from "../data/context.js";
import type { WzError } from "../data/types.js";
import { formatInt, formatMoneyCompact, formatNumber, formatPercent } from "../format.js";
import { ru } from "../i18n/ru.js";
import type { RootAttrs } from "./root.js";
import { DataState } from "./States.js";
import styles from "./StatsReport.module.css";
import type { StatsData, StatsReportProps } from "./types.js";

type Kpi = StatsData["kpis"][number];

export function formatKpi(v: number, format: Kpi["format"]): string {
  if (format === "money") return formatMoneyCompact(v);
  if (format === "percent") return formatPercent(v);
  if (format === "int") return formatInt(v);
  return formatNumber(v);
}

export function StatsReport(props: StatsReportProps): ReactNode {
  const root = useWzRoot("StatsReport", "wz-stats", props);
  return props.fn ? (
    <FromFn {...props} fn={props.fn} root={root} />
  ) : (
    <View {...props} root={root} data={props.data} />
  );
}

function FromFn(props: StatsReportProps & { fn: string; root: RootAttrs }): ReactNode {
  const r = useDataSource().useFn<StatsData>(props.fn, {});
  return <View {...props} data={r.data} state={r} />;
}

function View({
  root,
  title,
  subtitle,
  data,
  className,
  state,
}: StatsReportProps & {
  root: RootAttrs;
  state?: { data?: unknown; error?: WzError; isLoading: boolean; refetch(): void };
}): ReactNode {
  return (
    <section {...root} className={cx(styles.stats, className)} aria-busy={state?.isLoading || undefined}>
      <header className={styles.head}>
        <h2 className={styles.title}>{title ?? ru.stats.title}</h2>
        {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
      </header>
      {!data ? (
        state ? (
          <DataState result={state} lines={2} />
        ) : null
      ) : (
        <>
          <dl className={styles.kpis}>
            {data.kpis.map((k) => (
              <div key={k.id} className={styles.kpi} data-testid={`wz-stats-kpi-${k.id}`}>
                <dt className={styles.kpiLabel}>{k.label}</dt>
                <dd className={styles.kpiValue}>
                  {formatKpi(k.value, k.format)}
                  {k.total !== undefined && ` / ${formatKpi(k.total, k.format)}`}
                </dd>
                {k.hint && <dd className={styles.kpiHint}>{k.hint}</dd>}
              </div>
            ))}
          </dl>
          {data.bars && (
            <div className={styles.bars}>
              <h3 className={styles.barsTitle}>{data.bars.title}</h3>
              <ul className={styles.barList}>
                {data.bars.items.map((b) => {
                  const pct = b.max > 0 ? Math.min(100, Math.max(0, (b.value / b.max) * 100)) : 0;
                  return (
                    <li key={b.label} className={styles.bar} data-testid="wz-stats-bar">
                      <span className={styles.barLabel}>{b.label}</span>
                      {/* biome-ignore lint/a11y/useSemanticElements: <meter> cannot be styled with tokens portably */}
                      <span
                        className={styles.meter}
                        role="meter"
                        aria-label={b.label}
                        aria-valuemin={0}
                        aria-valuemax={b.max}
                        aria-valuenow={b.value}
                        style={{ "--w-bar": `${pct}%` } as CSSProperties}
                      >
                        <span className={styles.fill} />
                      </span>
                      <span className={styles.barValue}>{`${formatInt(b.value)}/${formatInt(b.max)}`}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}
