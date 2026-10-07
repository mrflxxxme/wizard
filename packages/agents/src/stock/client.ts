// Stock photo client of the platform (B2-38, D61): search and download at Pexels and Pixabay through the platform's
// egress (the host passes its fetch), keys only from platform secrets (secret://platform/stock/*; never in code, logs,
// errors or systems). Search answers are cached for a day (Pixabay requires a 24 h cache; Pexels allows 200 requests an
// hour). A download goes only to the stock's image hosts over https, without redirects, ≤ 15 МБ and image/* — the bytes
// then go to the platform photo library (runtime storeLibraryPhoto) and are never hotlinked.
import { z } from "zod";
import type { StockQuery } from "./query.js";

export type StockProvider = "pexels" | "pixabay";
/** Order of the providers: Pexels first (D61), Pixabay for what Pexels did not give. */
export const STOCK_PROVIDERS: readonly StockProvider[] = ["pexels", "pixabay"];

/** References of the platform keys (platform SecretStore; M2-20 — the founder adds them, the build works without). */
export const STOCK_SECRET_REFS: Readonly<Record<StockProvider, string>> = {
  pexels: "secret://platform/stock/pexels",
  pixabay: "secret://platform/stock/pixabay",
};

/** Hosts of a provider: the API and the image CDNs a download may come from (egress allowlist of platform-api). */
export const STOCK_HOSTS: Readonly<Record<StockProvider, { api: string; images: readonly string[] }>> = {
  pexels: { api: "api.pexels.com", images: ["images.pexels.com"] },
  pixabay: { api: "pixabay.com", images: ["pixabay.com", "cdn.pixabay.com"] },
};

/** Licences as the «Источники фото» page names them (Russian), with the licence pages. */
export const STOCK_LICENSES: Readonly<Record<StockProvider, { license: string; licenseUrl: string }>> = {
  pexels: { license: "Лицензия Pexels", licenseUrl: "https://www.pexels.com/license/" },
  pixabay: {
    license: "Лицензия на контент Pixabay",
    licenseUrl: "https://pixabay.com/service/license-summary/",
  },
};

/** One photo of a search answer. */
export interface StockHit {
  provider: StockProvider;
  id: string;
  width: number;
  height: number;
  author: string;
  authorUrl?: string;
  /** Page of the photo at the stock. */
  pageUrl: string;
  /** The file to download (≈1600–1900 px wide). */
  downloadUrl: string;
}

export type StockErrorCode =
  | "NO_KEY"
  | "RATE_LIMITED"
  | "HTTP"
  | "TIMEOUT"
  | "BAD_RESPONSE"
  | "HOST"
  | "TOO_LARGE"
  | "NOT_IMAGE";

/** A stock failure; the message never carries a key or a URL with a key. */
export class StockError extends Error {
  override name = "StockError";
  constructor(
    readonly code: StockErrorCode,
    readonly provider: StockProvider,
    detail?: string,
  ) {
    super(`${provider}: ${code}${detail ? ` (${detail})` : ""}`);
  }
}

export interface StockClient {
  /** Providers the client can search (a key in live mode, recorded answers in fixtures). */
  readonly providers: readonly StockProvider[];
  search(provider: StockProvider, q: StockQuery, perPage: number, signal?: AbortSignal): Promise<StockHit[]>;
  download(hit: StockHit, signal?: AbortSignal): Promise<Uint8Array>;
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface StockClientOptions {
  /** fetch of the platform egress (tests: recorded answers). */
  fetch: FetchFn;
  /** Keys resolved from STOCK_SECRET_REFS; a provider without a key is skipped. */
  keys: Partial<Record<StockProvider, string>>;
  /** Time of one request (default 8 s). */
  timeoutMs?: number;
  /** Largest download (default 15 МБ). */
  maxBytes?: number;
  /** Search cache shared by the builds of the process (default: per client). */
  cache?: StockCache;
  now?: () => number;
}

/** Search answers by provider and query for a day (Pixabay API terms: cache requests for 24 hours). */
export class StockCache {
  private readonly map = new Map<string, { at: number; hits: StockHit[] }>();
  constructor(
    private readonly ttlMs = 24 * 3600_000,
    private readonly max = 500,
  ) {}
  get(key: string, now: number): StockHit[] | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (now - hit.at > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    return hit.hits;
  }
  set(key: string, hits: StockHit[], now: number): void {
    this.map.delete(key);
    this.map.set(key, { at: now, hits });
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }
}

const pexelsAnswer = z.looseObject({
  photos: z.array(
    z.looseObject({
      id: z.number().int(),
      width: z.number().int(),
      height: z.number().int(),
      url: z.string(),
      photographer: z.string(),
      photographer_url: z.string().optional(),
      src: z.looseObject({ large2x: z.string(), original: z.string().optional() }),
    }),
  ),
});

const pixabayAnswer = z.looseObject({
  hits: z.array(
    z.looseObject({
      id: z.number().int(),
      pageURL: z.string(),
      largeImageURL: z.string(),
      imageWidth: z.number().int(),
      imageHeight: z.number().int(),
      user: z.string(),
      user_id: z.number().int(),
      type: z.string().optional(),
    }),
  ),
});

const https = (u: string | undefined, hosts: readonly string[]): string | undefined => {
  if (!u) return undefined;
  try {
    const url = new URL(u);
    return url.protocol === "https:" && hosts.includes(url.hostname) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
};

const PIXABAY_ORIENTATION = { landscape: "horizontal", portrait: "vertical", square: "all" } as const;

/** The live client over the platform egress. */
export function createStockClient(o: StockClientOptions): StockClient {
  const timeoutMs = o.timeoutMs ?? 8000;
  const maxBytes = o.maxBytes ?? 15 * 1024 * 1024;
  const cache = o.cache ?? new StockCache();
  const now = o.now ?? Date.now;
  const providers = STOCK_PROVIDERS.filter((p) => !!o.keys[p]);

  const request = async (provider: StockProvider, url: string, init: RequestInit, signal?: AbortSignal) => {
    const ctl = AbortSignal.timeout(timeoutMs);
    const sig = signal ? AbortSignal.any([signal, ctl]) : ctl;
    let res: Response;
    try {
      res = await o.fetch(url, { ...init, redirect: "manual", signal: sig });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new StockError(ctl.aborted ? "TIMEOUT" : "HTTP", provider, ctl.aborted ? undefined : "network");
    }
    if (res.status === 429) throw new StockError("RATE_LIMITED", provider);
    if (res.status !== 200) throw new StockError("HTTP", provider, String(res.status));
    return res;
  };

  return {
    providers,
    async search(provider, q, perPage, signal) {
      const key = o.keys[provider];
      if (!key) throw new StockError("NO_KEY", provider);
      const ck = `${provider}|${q.text}|${q.orientation}|${perPage}`;
      const cached = cache.get(ck, now());
      if (cached) return cached;
      let hits: StockHit[];
      if (provider === "pexels") {
        const url = new URL(`https://${STOCK_HOSTS.pexels.api}/v1/search`);
        url.searchParams.set("query", q.text);
        url.searchParams.set("orientation", q.orientation);
        url.searchParams.set("per_page", String(Math.min(80, Math.max(1, perPage))));
        const res = await request(provider, url.toString(), { headers: { Authorization: key } }, signal);
        const body = pexelsAnswer.safeParse(await res.json().catch(() => null));
        if (!body.success) throw new StockError("BAD_RESPONSE", provider);
        hits = body.data.photos.flatMap((p) => {
          const downloadUrl = https(p.src.large2x, STOCK_HOSTS.pexels.images);
          const pageUrl = https(p.url, ["www.pexels.com", "pexels.com"]);
          if (!downloadUrl || !pageUrl || !p.photographer.trim()) return [];
          const authorUrl = https(p.photographer_url, ["www.pexels.com", "pexels.com"]);
          return [
            {
              provider,
              id: String(p.id),
              width: p.width,
              height: p.height,
              author: p.photographer.trim().slice(0, 120),
              ...(authorUrl ? { authorUrl } : {}),
              pageUrl,
              downloadUrl,
            },
          ];
        });
      } else {
        const url = new URL(`https://${STOCK_HOSTS.pixabay.api}/api/`);
        url.searchParams.set("key", key);
        url.searchParams.set("q", q.text.slice(0, 100));
        url.searchParams.set("image_type", "photo");
        url.searchParams.set("orientation", PIXABAY_ORIENTATION[q.orientation]);
        url.searchParams.set("safesearch", "true");
        url.searchParams.set("lang", "en");
        url.searchParams.set("per_page", String(Math.min(200, Math.max(3, perPage))));
        const res = await request(provider, url.toString(), {}, signal);
        const body = pixabayAnswer.safeParse(await res.json().catch(() => null));
        if (!body.success) throw new StockError("BAD_RESPONSE", provider);
        hits = body.data.hits.flatMap((p) => {
          const downloadUrl = https(p.largeImageURL, STOCK_HOSTS.pixabay.images);
          const pageUrl = https(p.pageURL, ["pixabay.com"]);
          if (!downloadUrl || !pageUrl || !p.user.trim() || (p.type && p.type !== "photo")) return [];
          const slug = p.user.trim().replace(/[^A-Za-z0-9_-]/g, "");
          return [
            {
              provider,
              id: String(p.id),
              width: p.imageWidth,
              height: p.imageHeight,
              author: p.user.trim().slice(0, 120),
              ...(slug ? { authorUrl: `https://pixabay.com/users/${slug}-${p.user_id}/` } : {}),
              pageUrl,
              downloadUrl,
            },
          ];
        });
      }
      cache.set(ck, hits, now());
      return hits;
    },
    async download(hit, signal) {
      const url = https(hit.downloadUrl, STOCK_HOSTS[hit.provider].images);
      if (!url) throw new StockError("HOST", hit.provider);
      const res = await request(hit.provider, url, {}, signal);
      const type = res.headers.get("content-type") ?? "";
      if (!/^image\//i.test(type)) throw new StockError("NOT_IMAGE", hit.provider);
      if (Number(res.headers.get("content-length") ?? "0") > maxBytes)
        throw new StockError("TOO_LARGE", hit.provider);
      const reader = res.body?.getReader();
      if (!reader) throw new StockError("BAD_RESPONSE", hit.provider);
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new StockError("TOO_LARGE", hit.provider);
        }
        chunks.push(value);
      }
      const out = new Uint8Array(total);
      let at = 0;
      for (const c of chunks) {
        out.set(c, at);
        at += c.byteLength;
      }
      return out;
    },
  };
}
