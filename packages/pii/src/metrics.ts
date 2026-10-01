// Minimal Prometheus text-format registry (deploy.yaml#cloud.observability, #pilot.observability: VictoriaMetrics
// scrapes /metrics of annotated pods). Like the allowlist logger, metrics leave the process: label values are checked
// against a strict token pattern (ids, kinds, codes) and anything else becomes "other", so no free text or personal
// data can travel in a label. No client library: counters, gauges and histograms are all the platform needs (M2-09).
import { createServer, type Server } from "node:http";

/** Label values allowed as-is: identifiers and enum-like tokens. */
const LABEL_VALUE = /^[A-Za-z0-9_.:-]{1,64}$/;
const NAME = /^[a-z_][a-z0-9_]*$/;

export type Labels = Readonly<Record<string, string | number>>;

/** Default histogram buckets of run durations, seconds. */
export const DURATION_BUCKETS_S: readonly number[] = [1, 5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600];

export function safeLabelValue(v: string | number): string {
  const s = String(v);
  return LABEL_VALUE.test(s) ? s : "other";
}

function key(names: readonly string[], labels: Labels | undefined): string {
  const l = labels ?? {};
  for (const k of Object.keys(l)) if (!names.includes(k)) throw new Error(`unknown label ${k}`);
  return JSON.stringify(names.map((n) => safeLabelValue(l[n] ?? "")));
}

function fmtLabels(names: readonly string[], values: readonly string[], extra?: [string, string]): string {
  const parts = names.map((n, i) => `${n}="${values[i] ?? ""}"`);
  if (extra) parts.push(`${extra[0]}="${extra[1]}"`);
  return parts.length > 0 ? `{${parts.join(",")}}` : "";
}

const num = (v: number): string => (Number.isFinite(v) ? String(v) : v > 0 ? "+Inf" : "-Inf");

abstract class Metric {
  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly string[],
  ) {
    if (!NAME.test(name)) throw new Error(`bad metric name ${name}`);
    for (const l of labelNames) if (!NAME.test(l)) throw new Error(`bad label name ${l}`);
  }
  abstract readonly type: "counter" | "gauge" | "histogram";
  abstract lines(): string[];
  render(): string {
    const body = this.lines();
    return [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} ${this.type}`, ...body].join("\n");
  }
}

export class Counter extends Metric {
  readonly type = "counter";
  readonly #values = new Map<string, number>();
  inc(labels?: Labels, by = 1): void {
    if (!(by >= 0)) throw new Error("counter can only grow");
    const k = key(this.labelNames, labels);
    this.#values.set(k, (this.#values.get(k) ?? 0) + by);
  }
  get(labels?: Labels): number {
    return this.#values.get(key(this.labelNames, labels)) ?? 0;
  }
  lines(): string[] {
    return [...this.#values].map(
      ([k, v]) => `${this.name}${fmtLabels(this.labelNames, JSON.parse(k) as string[])} ${num(v)}`,
    );
  }
}

export class Gauge extends Metric {
  readonly type = "gauge";
  readonly #values = new Map<string, number>();
  set(labels: Labels | undefined, v: number): void {
    this.#values.set(key(this.labelNames, labels), v);
  }
  get(labels?: Labels): number | undefined {
    return this.#values.get(key(this.labelNames, labels));
  }
  /** Drops all series (a collector re-reads the full set on every scrape). */
  reset(): void {
    this.#values.clear();
  }
  lines(): string[] {
    return [...this.#values].map(
      ([k, v]) => `${this.name}${fmtLabels(this.labelNames, JSON.parse(k) as string[])} ${num(v)}`,
    );
  }
}

export class Histogram extends Metric {
  readonly type = "histogram";
  readonly #series = new Map<string, { counts: number[]; sum: number; count: number }>();
  constructor(
    name: string,
    help: string,
    labelNames: readonly string[],
    readonly buckets: readonly number[] = DURATION_BUCKETS_S,
  ) {
    super(name, help, labelNames);
    if (labelNames.includes("le")) throw new Error("le is reserved");
  }
  observe(labels: Labels | undefined, v: number): void {
    if (!Number.isFinite(v)) return;
    const k = key(this.labelNames, labels);
    let s = this.#series.get(k);
    if (!s) {
      s = { counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.#series.set(k, s);
    }
    for (let i = 0; i < this.buckets.length; i++)
      if (v <= (this.buckets[i] as number)) s.counts[i] = (s.counts[i] ?? 0) + 1;
    s.sum += v;
    s.count += 1;
  }
  count(labels?: Labels): number {
    return this.#series.get(key(this.labelNames, labels))?.count ?? 0;
  }
  lines(): string[] {
    const out: string[] = [];
    for (const [k, s] of this.#series) {
      const values = JSON.parse(k) as string[];
      for (const [i, b] of this.buckets.entries())
        out.push(`${this.name}_bucket${fmtLabels(this.labelNames, values, ["le", num(b)])} ${s.counts[i]}`);
      out.push(`${this.name}_bucket${fmtLabels(this.labelNames, values, ["le", "+Inf"])} ${s.count}`);
      out.push(`${this.name}_sum${fmtLabels(this.labelNames, values)} ${num(s.sum)}`);
      out.push(`${this.name}_count${fmtLabels(this.labelNames, values)} ${s.count}`);
    }
    return out;
  }
}

export type Collector = () => Promise<void> | void;

/** A set of metrics rendered together; collectors refresh gauges (e.g. from the database) before each scrape. */
export class Registry {
  readonly #metrics = new Map<string, Metric>();
  readonly #collectors: Collector[] = [];
  readonly #collectErrors: Counter;

  constructor(readonly prefix = "wizard") {
    this.#collectErrors = this.counter(
      `${prefix}_metrics_collect_errors_total`,
      "Collectors that failed during a scrape",
    );
  }

  #add<M extends Metric>(m: M): M {
    const prev = this.#metrics.get(m.name);
    if (prev) {
      if (prev.type !== m.type) throw new Error(`metric ${m.name} already registered as ${prev.type}`);
      return prev as M;
    }
    this.#metrics.set(m.name, m);
    return m;
  }

  /** Same name again returns the registered metric (modules may be loaded twice in tests). */
  counter(name: string, help: string, labelNames: readonly string[] = []): Counter {
    return this.#add(new Counter(name, help, labelNames));
  }
  gauge(name: string, help: string, labelNames: readonly string[] = []): Gauge {
    return this.#add(new Gauge(name, help, labelNames));
  }
  histogram(
    name: string,
    help: string,
    labelNames: readonly string[] = [],
    buckets?: readonly number[],
  ): Histogram {
    return this.#add(new Histogram(name, help, labelNames, buckets));
  }

  /** Registers a collector; returns a function that removes it. */
  collect(fn: Collector): () => void {
    this.#collectors.push(fn);
    return () => {
      const i = this.#collectors.indexOf(fn);
      if (i >= 0) this.#collectors.splice(i, 1);
    };
  }

  /** Prometheus text exposition format 0.0.4. A failing collector is counted, the rest is still rendered. */
  async render(): Promise<string> {
    for (const c of this.#collectors) {
      try {
        await c();
      } catch {
        this.#collectErrors.inc();
      }
    }
    return `${[...this.#metrics.values()].map((m) => m.render()).join("\n")}\n`;
  }
}

export const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

export interface MetricsServer {
  port: number;
  close(): Promise<void>;
}

/**
 * Dedicated metrics listener: GET /metrics (Prometheus text) and GET /healthz; everything else 404. Bind it to a port
 * that only the observability namespace reaches (NetworkPolicy), never to a public one.
 */
export function serveMetrics(o: {
  registry: Registry;
  port: number;
  hostname?: string;
}): Promise<MetricsServer> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").replace(/[?#].*$/s, "");
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET" }).end();
      return;
    }
    if (path === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
      return;
    }
    if (path !== "/metrics") {
      res.writeHead(404).end();
      return;
    }
    o.registry.render().then(
      (text) => res.writeHead(200, { "content-type": METRICS_CONTENT_TYPE }).end(text),
      () => res.writeHead(500).end(),
    );
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, o.hostname ?? "127.0.0.1", () => {
      server.off("error", reject);
      const addr = server.address();
      resolve({
        port: typeof addr === "object" && addr ? addr.port : o.port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

/** WIZARD_METRICS_PORT / WIZARD_METRICS_HOST: null when the port is unset, empty or "off". */
export function metricsListenFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): { port: number; hostname: string } | null {
  const raw = (env.WIZARD_METRICS_PORT ?? "").trim();
  if (!raw || raw === "off") return null;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`WIZARD_METRICS_PORT=${raw}`);
  return { port, hostname: env.WIZARD_METRICS_HOST || "127.0.0.1" };
}
