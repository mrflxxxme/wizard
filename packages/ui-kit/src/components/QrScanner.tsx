// QrScanner, online part (ui-kit.yaml#components.QrScanner; offline queue is M2-03): camera via getUserMedia,
// BarcodeDetector with jsQR (Apache-2.0) fallback, manual entry, 3 s debounce, result ≥ 1.2 s, shift counters.
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { cx, useDataSource, useWzRoot } from "../data/context.js";
import type { QrCheckResponse, WzError } from "../data/types.js";
import { formatTime } from "../format.js";
import { ru } from "../i18n/ru.js";
import { ButtonImpl } from "./Button.js";
import { FieldImpl } from "./Field.js";
import styles from "./QrScanner.module.css";
import { part } from "./root.js";
import type { QrScannerProps, ScanResult } from "./types.js";

const DEBOUNCE_MS = 3000;
const RESULT_MS = 1200;
const SCAN_EVERY_MS = 150;

type Decoder = (video: HTMLVideoElement) => Promise<string | null>;
type JsQr = (
  data: Uint8ClampedArray,
  w: number,
  h: number,
  o?: { inversionAttempts?: "dontInvert" },
) => { data: string } | null;

/** CJS interop: the function may sit at `.default` or `.default.default` depending on the bundler. */
export function unwrapDefault<F>(mod: unknown): F {
  let m = mod as { default?: unknown };
  while (typeof m !== "function" && m && "default" in m) m = m.default as { default?: unknown };
  return m as F;
}
type Shown = ScanResult & { title: string; text?: string; error?: boolean };

async function createDecoder(): Promise<Decoder> {
  const BD = (
    globalThis as {
      BarcodeDetector?: new (o: {
        formats: string[];
      }) => { detect(v: unknown): Promise<{ rawValue: string }[]> };
    }
  ).BarcodeDetector;
  if (BD) {
    try {
      const det = new BD({ formats: ["qr_code"] });
      return async (v) => (await det.detect(v))[0]?.rawValue ?? null;
    } catch {
      // fall through to jsQR
    }
  }
  const jsQR = unwrapDefault<JsQr>(await import("jsqr"));
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  return async (v) => {
    if (!ctx || !v.videoWidth) return null;
    const scale = Math.min(1, 640 / v.videoWidth);
    canvas.width = Math.round(v.videoWidth * scale);
    canvas.height = Math.round(v.videoHeight * scale);
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" })?.data ?? null;
  };
}

function describe(r: QrCheckResponse): Shown {
  const base = {
    status: r.status,
    scannedAt: r.scannedAt,
    ...(r.ticketTitle ? { ticketTitle: r.ticketTitle } : {}),
  };
  if (r.status === "ok")
    return {
      ...base,
      title: ru.qrScanner.results.ok,
      ...(r.details ? { details: r.details } : {}),
      text: [r.ticketTitle, r.details].filter(Boolean).join(" · "),
    };
  if (r.status === "duplicate")
    return {
      ...base,
      title: ru.qrScanner.results.duplicate,
      text: r.firstScannedAt ? ru.qrScanner.firstScan(formatTime(r.firstScannedAt)) : r.ticketTitle,
      ...(r.firstScannedAt ? { details: r.firstScannedAt } : {}),
    };
  return { ...base, title: ru.qrScanner.results.invalid };
}

export function QrScanner(props: QrScannerProps): ReactNode {
  const root = useWzRoot("QrScanner", "wz-qrscanner", props);
  const check = useDataSource().useQrCheck(props.verifyFn);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [camera, setCamera] = useState<"starting" | "on" | "denied" | "unavailable">("starting");
  const [shown, setShown] = useState<Shown | null>(null);
  const [counters, setCounters] = useState({ ok: 0, duplicate: 0, invalid: 0 });
  const [manual, setManual] = useState("");
  const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  const [deviceId] = useState(() => `dev-${Math.random().toString(36).slice(2, 10)}`);
  const last = useRef<{ code: string; at: number } | null>(null);
  const busy = useRef(false);
  const shownAt = useRef(0);
  const onResult = useRef(props.onResult);
  onResult.current = props.onResult;

  const handle = useCallback(
    async (code: string) => {
      const now = Date.now();
      if (busy.current) return;
      if (last.current && last.current.code === code && now - last.current.at < DEBOUNCE_MS) return;
      last.current = { code, at: now };
      busy.current = true;
      try {
        const r = await check({ payload: code, checkpoint: props.checkpoint, deviceId });
        const s = describe(r);
        setCounters((c) => ({ ...c, [r.status]: c[r.status] + 1 }));
        setShown(s);
        shownAt.current = Date.now();
        navigator.vibrate?.([80]);
        const { title: _t, text: _x, error: _e, ...result } = s;
        onResult.current?.(result);
      } catch (e) {
        setShown({
          status: "invalid",
          scannedAt: new Date().toISOString(),
          title: (e as WzError).message,
          error: true,
        });
      } finally {
        // The result stays on screen at least 1.2 s before the next scan is accepted.
        setTimeout(() => {
          busy.current = false;
        }, RESULT_MS);
      }
    },
    [check, props.checkpoint, deviceId],
  );

  useEffect(() => {
    const on = () => setOnline(navigator.onLine);
    window.addEventListener("online", on);
    window.addEventListener("offline", on);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", on);
    };
  }, []);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    let stopped = false;
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCamera("unavailable");
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
      } catch (e) {
        setCamera((e as DOMException).name === "NotAllowedError" ? "denied" : "unavailable");
        return;
      }
      if (stopped) {
        for (const t of stream.getTracks()) t.stop();
        return;
      }
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play().catch(() => {});
      setCamera("on");
      const decode = await createDecoder();
      let decoding = false;
      timer = setInterval(async () => {
        if (decoding || busy.current || video.readyState < 2) return;
        decoding = true;
        try {
          const code = await decode(video);
          if (code) await handle(code);
        } catch {
          // a bad frame is not an error
        } finally {
          decoding = false;
        }
      }, SCAN_EVERY_MS);
    })();
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
      for (const t of stream?.getTracks() ?? []) t.stop();
    };
  }, [handle]);

  const submitManual = (e: FormEvent) => {
    e.preventDefault();
    const code = manual.trim();
    if (!code) return;
    last.current = null;
    busy.current = false;
    void handle(code);
    setManual("");
  };

  return (
    <section {...root} className={cx(styles.scanner, props.className)}>
      <p className={styles.status} data-testid="wz-qrscanner-status">
        {online
          ? `${ru.qrScanner.online} · ${ru.qrScanner.checkpoint(props.checkpoint)}`
          : ru.qrScanner.offline(0, 0)}
      </p>
      <div className={styles.viewport}>
        <video
          ref={videoRef}
          className={styles.video}
          data-testid="wz-qrscanner-video"
          muted
          playsInline
          aria-label={ru.qrScanner.video}
        />
        {camera === "denied" && <p className={styles.cameraNote}>{ru.qrScanner.cameraDenied}</p>}
        {camera === "unavailable" && <p className={styles.cameraNote}>{ru.qrScanner.cameraUnavailable}</p>}
        {shown && (
          <div
            className={cx(styles.result, styles[shown.error ? "invalid" : shown.status])}
            role="alert"
            data-testid="wz-qrscanner-result"
            data-status={shown.status}
          >
            <span className={styles.icon} aria-hidden="true">
              {shown.status === "ok" ? "✓" : shown.status === "duplicate" ? "↺" : "✕"}
            </span>
            <strong className={styles.resultTitle}>{shown.title}</strong>
            {shown.text && <span>{shown.text}</span>}
          </div>
        )}
      </div>
      <form className={styles.manual} data-testid="wz-qrscanner-manual" onSubmit={submitManual}>
        <FieldImpl
          root={part("wz-field-code")}
          idBase={root["data-wz-id"] ?? "qrscanner"}
          name="code"
          label={ru.qrScanner.manual}
          type="string"
          value={manual}
          onChange={(v) => setManual(String(v ?? ""))}
          autoComplete="off"
        />
        <ButtonImpl root={part("wz-qrscanner-check")} type="submit" variant="primary">
          {ru.qrScanner.check}
        </ButtonImpl>
      </form>
      <dl className={styles.counters} data-testid="wz-qrscanner-counters">
        {(["ok", "duplicate", "invalid"] as const).map((k) => (
          <div key={k} className={styles.counter} data-counter={k}>
            <dt>{ru.qrScanner.counters[k]}</dt>
            <dd>{counters[k]}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
