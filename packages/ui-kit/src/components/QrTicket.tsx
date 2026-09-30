// QrTicket (ui-kit.yaml#components.QrTicket): renders the qr_token issued by the QR connector as-is,
// black-on-white SVG (level M, 4-module quiet zone), never shows the token text.
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { cx, useDataSource, useWzRoot } from "../data/context.js";
import type { Rec } from "../data/types.js";
import { ru } from "../i18n/ru.js";
import { qrMatrix, qrPath } from "../qr/encode.js";
import { ButtonImpl } from "./Button.js";
import styles from "./QrTicket.module.css";
import { part } from "./root.js";
import { DataState } from "./States.js";
import type { QrTicketProps } from "./types.js";

type InstallPrompt = Event & { prompt(): Promise<void> };

export function QrCode({ value, label }: { value: string; label: string }): ReactNode {
  const { size, d } = useMemo(() => {
    const m = qrMatrix(value);
    return { size: m.length + 8, d: qrPath(m, 4) };
  }, [value]);
  return (
    <svg
      className={styles.code}
      data-testid="wz-qrticket-code"
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width={size} height={size} fill="#FFFFFF" />
      <path d={d} fill="#000000" />
    </svg>
  );
}

export function QrTicket(props: QrTicketProps): ReactNode {
  const root = useWzRoot("QrTicket", "wz-qrticket", props);
  const rec = useDataSource().useRecord<Rec>(props.entity, props.id);
  const token = rec.data?.[props.tokenField];
  const [install, setInstall] = useState<InstallPrompt | null>(null);
  useEffect(() => {
    const on = (e: Event) => {
      e.preventDefault();
      setInstall(e as InstallPrompt);
    };
    window.addEventListener("beforeinstallprompt", on);
    return () => window.removeEventListener("beforeinstallprompt", on);
  }, []);

  return (
    <article {...root} className={cx(styles.ticket, props.className)} aria-busy={rec.isLoading || undefined}>
      <header className={styles.head}>
        <h2 className={styles.title}>{props.title}</h2>
        {props.subtitle && <p className={styles.subtitle}>{props.subtitle}</p>}
      </header>
      {typeof token === "string" && token ? (
        <div className={styles.codeWrap}>
          <QrCode value={token} label={ru.qrTicket.code} />
        </div>
      ) : (
        <DataState result={rec} lines={4} />
      )}
      {props.meta && props.meta.length > 0 && (
        <dl className={styles.meta} data-testid="wz-qrticket-meta">
          {props.meta.map((m) => (
            <div key={m.label} className={styles.metaItem}>
              <dt>{m.label}</dt>
              <dd>{m.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {props.hint && <p className={styles.hint}>{props.hint}</p>}
      {install && (
        <ButtonImpl
          root={part("wz-qrticket-install")}
          onClick={() => {
            void install.prompt();
            setInstall(null);
          }}
        >
          {ru.qrTicket.install}
        </ButtonImpl>
      )}
    </article>
  );
}
