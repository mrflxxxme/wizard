// Stock photos of the builder v2 (B2-38, D61): the photos stage searches Pexels and Pixabay through the platform's
// egress with the platform keys (secret://platform/stock/pexels, secret://platform/stock/pixabay — the founder adds them
// in M2-20; without them the landings keep the theme graphic) and copies the chosen files into the platform photo
// library of the shared file storage (runtime storeLibraryPhoto: WebP variants, no EXIF). WIZARD_STOCK_MODE:
// fixture — recorded answers of tools/fixtures/stock, no network (default unless WIZARD_LLM_MODE is live/record);
// live; record — live plus recording of the Pexels search answers (metadata, keys scrubbed); off — no photos;
// library (B2-43) — the photo library filled from CI (tools/deploy/stock-library.mjs: the stocks are closed for the
// server in RF), read from the shared file storage: no keys, no network, nothing re-encoded.
// Keys: the pilot release passes the founder's keys as env (WIZARD_STOCK_PEXELS_KEY / WIZARD_STOCK_PIXABAY_KEY, only with
// stock_mode=live, tools/deploy/pilot-secrets.mjs pilotStockEnv); they win over the SecretStore values, which stay the
// way for a hand-added key. Nothing is written to the store: env changes with the next release, removal included.
import {
  createLibraryStockClient,
  createStockClient,
  FIXTURE_KEYS,
  fixtureStockFetch,
  type PhotoHost,
  parseLibraryIndex,
  recordingStockFetch,
  STOCK_HOSTS,
  STOCK_PROVIDERS,
  STOCK_SECRET_REFS,
  StockCache,
  type StockProvider,
} from "@wizard/agents/builder";
import { type FileStorage, libraryPhoto, readLibraryIndex, storeLibraryPhoto } from "@wizard/runtime";

export type StockMode = "fixture" | "live" | "record" | "off" | "library";

/** WIZARD_STOCK_MODE, else live/record when the models are live/record, else fixture. */
export function stockModeOf(env: NodeJS.ProcessEnv): StockMode {
  const v = (env.WIZARD_STOCK_MODE ?? "").trim().toLowerCase();
  if (v === "fixture" || v === "live" || v === "record" || v === "off" || v === "library") return v;
  const llm = (env.WIZARD_LLM_MODE ?? "").trim().toLowerCase();
  return llm === "live" || llm === "record" ? llm : "fixture";
}

/** Env of the platform pods with the stock keys (the pilot's Secret wizard-platform-env), read before SecretStore. */
export const STOCK_KEY_ENV: Readonly<Record<StockProvider, string>> = {
  pexels: "WIZARD_STOCK_PEXELS_KEY",
  pixabay: "WIZARD_STOCK_PIXABAY_KEY",
};

/** The only hosts a live photo host requests (= tools/deploy/pilot-secrets.mjs STOCK_EGRESS_HOSTS). */
export const STOCK_EGRESS_HOSTS: readonly string[] = [
  ...new Set(STOCK_PROVIDERS.flatMap((p) => [STOCK_HOSTS[p].api, ...STOCK_HOSTS[p].images])),
];

/** fetch limited to https on STOCK_EGRESS_HOSTS: anything else is refused before the network (the client reads it as a network failure). */
export function stockEgressFetch(
  inner: (input: string, init?: RequestInit) => Promise<Response>,
): (input: string, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new TypeError("stock egress: bad url");
    }
    if (url.protocol !== "https:" || !STOCK_EGRESS_HOSTS.includes(url.hostname))
      throw new TypeError(`stock egress: host ${url.hostname} is not allowed`);
    return inner(input, init);
  };
}

/** The key of a provider: the env of the release first, then the platform secret; null — the provider is off. */
export function stockKeyOf(
  provider: StockProvider,
  secrets: { getPlatform(ref: string): string | null } | null,
  env: NodeJS.ProcessEnv,
): string | null {
  const fromEnv = (env[STOCK_KEY_ENV[provider]] ?? "").trim();
  if (fromEnv) return fromEnv;
  try {
    return secrets?.getPlatform(STOCK_SECRET_REFS[provider]) || null;
  } catch {
    return null;
  }
}

/** Search answers shared by the builds of the process (a day; Pixabay requires a 24 h cache). */
const sharedCache = new StockCache();

export interface PhotoHostOptions {
  mode: StockMode;
  /** Platform secrets (SecretStore.getPlatform) after STOCK_KEY_ENV; a missing or unreadable key turns its provider off. */
  secrets: { getPlatform(ref: string): string | null } | null;
  /** The shared file storage of systems: the library lives under wz_photos/. */
  storage: FileStorage;
  /** Egress fetch (default: global fetch of the platform process); live requests go only to STOCK_EGRESS_HOSTS. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Env with the release keys (STOCK_KEY_ENV); default process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * The photo host of library mode: searches answered from the library index of `storage` (re-read every few minutes),
 * `store` returns the copy already in the library (a photo of the index whose copy is missing fails that one pick).
 */
export function libraryPhotoHost(
  storage: FileStorage,
  o: { ttlMs?: number; now?: () => number } = {},
): PhotoHost {
  const stock = createLibraryStockClient({
    load: async () => parseLibraryIndex(await readLibraryIndex(storage)),
    ...o,
  });
  return {
    stock,
    async store(hit) {
      const file = stock.fileOf(hit);
      const copy = file ? await libraryPhoto(storage, file) : null;
      if (!copy) throw new Error(`${hit.provider}: no copy in the photo library`);
      return copy;
    },
  };
}

/** The photo host of the builder, or undefined (off). */
export function createPhotoHost(o: PhotoHostOptions): PhotoHost | undefined {
  if (o.mode === "off") return undefined;
  if (o.mode === "library") return libraryPhotoHost(o.storage);
  const store: PhotoHost["store"] = (hit, bytes) =>
    storeLibraryPhoto(o.storage, bytes, { source: `${hit.provider}:${hit.id}` });
  if (o.mode === "fixture")
    return { stock: createStockClient({ fetch: fixtureStockFetch(), keys: FIXTURE_KEYS }), store };
  const keys: Partial<Record<StockProvider, string>> = {};
  for (const p of STOCK_PROVIDERS) {
    const key = stockKeyOf(p, o.secrets, o.env ?? process.env);
    if (key) keys[p] = key;
  }
  const live = stockEgressFetch(o.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init)));
  return {
    stock: createStockClient({
      // record: Pexels search metadata only, keys scrubbed (tools/fixtures/stock/pexels.recorded.json).
      fetch:
        o.mode === "record" ? recordingStockFetch(live, undefined, { secrets: Object.values(keys) }) : live,
      keys,
      cache: sharedCache,
    }),
    store,
  };
}
