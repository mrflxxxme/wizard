// QrScanner (ui-kit.yaml#components.QrScanner): camera via getUserMedia, BarcodeDetector with jsQR (Apache-2.0)
// fallback, manual entry, 3 s debounce, result ≥ 1.2 s, shift counters. offline (M2-03): the ticket package and
// the scan queue in IndexedDB, hash check without the network, sync every 15 s and on reconnect (../qr/offline.ts).
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { cx, useDataSource, useWzRoot } from "../data/context.js";
import type { QrCheckResponse, WzError } from "../data/types.js";
import { formatTime } from "../format.js";
import { ru } from "../i18n/ru.js";
import {
  MANIFEST_REFRESH_MS,
  OfflineScanner,
  type OfflineVerdict,
  openQrStorage,
  SYNC_EVERY_MS,
} from "../qr/offline.js";
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

function describeOffline(v: OfflineVerdict): Shown {
  const base = {
    status: v.status,
    scannedAt: v.scannedAt,
    ...(v.entry?.d ? { ticketTitle: v.entry.d } : {}),
  };
  if (v.status === "queued") return { ...base, title: ru.qrScanner.results.queued, text: v.entry?.d ?? "" };
  if (v.status === "duplicate") {
    return {
      ...base,
      title: ru.qrScanner.results.duplicate,
      text: [ru.qrScanner.repeatEntry, v.entry?.d].filter(Boolean).join(" · "),
    };
  }
  return {
    ...base,
    title: ru.qrScanner.results.invalid,
    ...(v.reason ? { text: ru.qrScanner.offlineReasons[v.reason] } : {}),
  };
}

const isNetworkError = (e: unknown) => {
  const x = e as { code?: string; status?: number };
  return x?.code === "NETWORK" || x?.status === 0;
};

export function QrScanner(props: QrScannerProps): ReactNode {
  const root = useWzRoot("QrScanner", "wz-qrscanner", props);
  const ds = useDataSource();
  const check = ds.useQrCheck(props.verifyFn);
  const offlineApi = ds.useQrOffline();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [camera, setCamera] = useState<"starting" | "on" | "denied" | "unavailable">("starting");
  const [shown, setShown] = useState<Shown | null>(null);
  const [counters, setCounters] = useState({ ok: 0, duplicate: 0, invalid: 0 });
  const [manual, setManual] = useState("");
  const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  const [sessionDevice] = useState(() => `dev-${Math.random().toString(36).slice(2, 10)}`);
  const offlineRef = useRef<OfflineScanner | null>(null);
  const [memory, setMemory] = useState({ tickets: 0, pending: 0 });
  const [syncNote, setSyncNote] = useState<string | null>(null);
  /** Queue events of this screen: sync outcomes correct the shift counters. */
  const mine = useRef(new Set<string>());
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
      const off = offlineRef.current;
      const show = (s: Shown) => {
        const key = s.status === "queued" ? "ok" : s.status;
        setCounters((c) => ({ ...c, [key]: c[key] + 1 }));
        setShown(s);
        shownAt.current = Date.now();
        navigator.vibrate?.([80]);
        const { title: _t, text: _x, error: _e, ...result } = s;
        onResult.current?.(result);
      };
      const offlineScan = async (scanner: OfflineScanner) => {
        const v = await scanner.scan(code);
        if (v.clientEventId) mine.current.add(v.clientEventId);
        show(describeOffline(v));
      };
      try {
        if (off && !navigator.onLine) {
          await offlineScan(off);
        } else {
          const deviceId = off?.deviceId || sessionDevice;
          let r: QrCheckResponse | null = null;
          try {
            r = await check({ payload: code, checkpoint: props.checkpoint, deviceId });
          } catch (e) {
            if (!off || !isNetworkError(e)) throw e;
          }
          if (r) {
            if (off && r.status !== "invalid") void off.markSeen(code);
            show(describe(r));
          } else if (off) await offlineScan(off);
        }
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
    [check, props.checkpoint, sessionDevice],
  );

  // Offline package and queue (connectors/qr.yaml#offline): load, refresh every 60 s, sync every 15 s and on reconnect.
  useEffect(() => {
    if (!props.offline) return;
    const scanner = new OfflineScanner(offlineApi, openQrStorage(), {
      gate: props.checkpoint,
      onChange: () => setMemory({ tickets: scanner.tickets, pending: scanner.pending }),
    });
    offlineRef.current = scanner;
    let stopped = false;
    const sync = async () => {
      if (stopped || !navigator.onLine) return;
      const results = await scanner.sync();
      if (stopped || results.length === 0) return;
      let dup = 0;
      let bad = 0;
      for (const r of results) {
        if (!mine.current.delete(r.clientEventId)) continue;
        if (r.result === "duplicate") dup++;
        else if (r.result !== "accepted") bad++;
      }
      if (dup + bad > 0) {
        setCounters((c) => ({
          ok: c.ok - dup - bad,
          duplicate: c.duplicate + dup,
          invalid: c.invalid + bad,
        }));
      }
      setSyncNote(ru.qrScanner.synced(results.filter((r) => r.result === "duplicate").length));
    };
    const refresh = async () => {
      if (!stopped && navigator.onLine) await scanner.refresh();
    };
    const reconnect = async () => {
      await sync();
      await refresh();
    };
    void scanner.ready.then(reconnect);
    const syncTimer = setInterval(() => {
      if (scanner.pending > 0) void sync();
    }, SYNC_EVERY_MS);
    const refreshTimer = setInterval(() => void refresh(), MANIFEST_REFRESH_MS);
    window.addEventListener("online", reconnect);
    return () => {
      stopped = true;
      clearInterval(syncTimer);
      clearInterval(refreshTimer);
      window.removeEventListener("online", reconnect);
      offlineRef.current = null;
    };
  }, [props.offline, props.checkpoint, offlineApi]);

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
      <p
        className={styles.status}
        data-testid="wz-qrscanner-status"
        data-online={online ? "true" : "false"}
        {...(props.offline ? { "data-tickets": memory.tickets, "data-pending": memory.pending } : {})}
      >
        {online
          ? [
              ru.qrScanner.online,
              ru.qrScanner.checkpoint(props.checkpoint),
              ...(props.offline ? [ru.qrScanner.memory(memory.tickets, memory.pending)] : []),
              ...(syncNote && memory.pending === 0 ? [syncNote] : []),
            ].join(" · ")
          : ru.qrScanner.offline(memory.tickets, memory.pending)}
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
              {shown.status === "ok" || shown.status === "queued"
                ? "✓"
                : shown.status === "duplicate"
                  ? "↺"
                  : "✕"}
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
