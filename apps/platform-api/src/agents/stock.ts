// Stock photos of the builder v2 (B2-38, D61): the photos stage searches Pexels and Pixabay through the platform's
// egress with the platform keys (secret://platform/stock/pexels, secret://platform/stock/pixabay — the founder adds them
// in M2-20; without them the landings keep the theme graphic) and copies the chosen files into the platform photo
// library of the shared file storage (runtime storeLibraryPhoto: WebP variants, no EXIF). WIZARD_STOCK_MODE:
// fixture — recorded answers of tools/fixtures/stock, no network (default unless WIZARD_LLM_MODE is live/record);
// live; record — live plus recording of the search answers; off — no photos.
import {
  createStockClient,
  FIXTURE_KEYS,
  fixtureStockFetch,
  type PhotoHost,
  recordingStockFetch,
  STOCK_PROVIDERS,
  STOCK_SECRET_REFS,
  StockCache,
  type StockProvider,
} from "@wizard/agents/builder";
import { type FileStorage, storeLibraryPhoto } from "@wizard/runtime";

export type StockMode = "fixture" | "live" | "record" | "off";

/** WIZARD_STOCK_MODE, else live/record when the models are live/record, else fixture. */
export function stockModeOf(env: NodeJS.ProcessEnv): StockMode {
  const v = (env.WIZARD_STOCK_MODE ?? "").trim().toLowerCase();
  if (v === "fixture" || v === "live" || v === "record" || v === "off") return v;
  const llm = (env.WIZARD_LLM_MODE ?? "").trim().toLowerCase();
  return llm === "live" || llm === "record" ? llm : "fixture";
}

/** Search answers shared by the builds of the process (a day; Pixabay requires a 24 h cache). */
const sharedCache = new StockCache();

export interface PhotoHostOptions {
  mode: StockMode;
  /** Platform secrets (SecretStore.getPlatform); a missing or unreadable key turns its provider off. */
  secrets: { getPlatform(ref: string): string | null } | null;
  /** The shared file storage of systems: the library lives under wz_photos/. */
  storage: FileStorage;
  /** Egress fetch (default: global fetch of the platform process). */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

/** The photo host of the builder, or undefined (off). */
export function createPhotoHost(o: PhotoHostOptions): PhotoHost | undefined {
  if (o.mode === "off") return undefined;
  const store: PhotoHost["store"] = (hit, bytes) =>
    storeLibraryPhoto(o.storage, bytes, { source: `${hit.provider}:${hit.id}` });
  if (o.mode === "fixture")
    return { stock: createStockClient({ fetch: fixtureStockFetch(), keys: FIXTURE_KEYS }), store };
  const keys: Partial<Record<StockProvider, string>> = {};
  for (const p of STOCK_PROVIDERS) {
    let key: string | null = null;
    try {
      key = o.secrets?.getPlatform(STOCK_SECRET_REFS[p]) ?? null;
    } catch {
      key = null;
    }
    if (key) keys[p] = key;
  }
  const live = o.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
  return {
    stock: createStockClient({
      fetch: o.mode === "record" ? recordingStockFetch(live) : live,
      keys,
      cache: sharedCache,
    }),
    store,
  };
}
