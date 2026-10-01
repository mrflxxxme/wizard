// Platform side of the preview bridge (platform-screens.yaml#preview_contract): exact origin and source checks,
// zod validation of every payload from the preview (L3-16), request/response by id with a 2 s timeout.
import { z } from "zod";

const ROUTE = z
  .string()
  .max(2000)
  .regex(/^\/(?![/\\])/);

/** ui-kit.yaml#wz_id.format: <fileKey 8 hex>:<ordinal> (api.yaml#postMessage.target.wzId). */
export const WZ_ID_RE = /^[0-9a-f]{8}:[0-9]+$/;
/** api.yaml#postMessage.target.file: a page or component of the system UI, never functions/** (L3-16). */
export const UI_FILE_RE = /^ui\/(?!.*\.\.)[A-Za-z0-9_/.-]+\.tsx$/;

export const envelopeSchema = z.object({
  wz: z.literal(1),
  type: z.string().max(64),
  id: z.string().max(100).optional(),
  payload: z.unknown(),
});

export const fromPreviewSchemas = {
  ready: z.object({
    protocol: z.literal(1),
    route: ROUTE,
    role: z.string().max(100).nullable(),
    revision: z.number().int(),
  }),
  "route-changed": z.object({ route: ROUTE }),
  "element-selected": z.object({
    componentName: z.string().min(1).max(60),
    wzId: z.string().max(32).regex(WZ_ID_RE),
    file: z.string().max(300).regex(UI_FILE_RE),
    line: z.number().int().min(1),
    route: ROUTE.optional(),
    rect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  }),
  "select-cancelled": z.object({}),
  error: z.object({ message: z.string().max(300) }),
  "theme-applied": z.object({}).optional(),
} as const;

export type FromPreviewType = keyof typeof fromPreviewSchemas;
export type FromPreview = {
  [K in FromPreviewType]: { type: K; id?: string; payload: z.infer<(typeof fromPreviewSchemas)[K]> };
}[FromPreviewType];

export type ToPreview =
  | { type: "set-role"; payload: { role: string; url: string } }
  | {
      type: "apply-theme-tokens";
      payload: { tokens: Record<string, string>; mode: "light" | "dark" | "auto" };
    }
  | { type: "navigate"; payload: { route: string } }
  | { type: "select-mode"; payload: { enabled: boolean } }
  | { type: "highlight"; payload: { wzId: string | null } };

export interface BridgeOptions {
  /** The iframe whose contentWindow is the only accepted source. */
  frame(): HTMLIFrameElement | null;
  /** origin(url) of the current preview URL; null → nothing is accepted or sent. */
  origin(): string | null;
  /** Expected revision of the preview (ready.revision is compared with it). */
  revision(): number | null;
  /**
   * Files of the current revision: element-selected.file must be one of them, else the message is dropped (L3-16:
   * the system code runs in the bridge's window and may forge it). null → unknown yet, reject.
   */
  files?(): ReadonlySet<string> | null;
  onMessage(m: FromPreview): void;
  timeoutMs?: number;
}

export class PreviewBridge {
  readonly #o: BridgeOptions;
  readonly #pending = new Map<
    string,
    { resolve(m: FromPreview): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }
  >();
  #seq = 0;

  constructor(o: BridgeOptions) {
    this.#o = o;
  }

  /** Validated message or null (ignored). Exposed for tests; the window listener calls it. */
  accept(ev: MessageEvent): FromPreview | null {
    const origin = this.#o.origin();
    const win = this.#o.frame()?.contentWindow ?? null;
    if (!origin || ev.origin !== origin) return null;
    if (!win || ev.source !== win) return null;
    const env = envelopeSchema.safeParse(ev.data);
    if (!env.success) return null;
    const { type, id } = env.data;
    if (!Object.hasOwn(fromPreviewSchemas, type)) {
      console.warn(`[wizard] превью: неизвестный тип сообщения ${type}`);
      return null;
    }
    const schema = fromPreviewSchemas[type as FromPreviewType];
    const parsed = schema.safeParse(env.data.payload);
    if (!parsed.success) return null;
    const msg = { type, ...(id ? { id } : {}), payload: parsed.data ?? {} } as FromPreview;
    if (msg.type === "ready") {
      const expected = this.#o.revision();
      if (expected !== null && msg.payload.revision !== expected) return null;
    }
    if (msg.type === "element-selected") {
      const files = this.#o.files?.() ?? null;
      if (!files?.has(msg.payload.file)) return null;
    }
    return msg;
  }

  readonly listener = (ev: MessageEvent): void => {
    const msg = this.accept(ev);
    if (!msg) return;
    if (msg.id) {
      const p = this.#pending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        this.#pending.delete(msg.id);
        p.resolve(msg);
      }
    }
    this.#o.onMessage(msg);
  };

  start(win: Window): () => void {
    win.addEventListener("message", this.listener);
    return () => {
      win.removeEventListener("message", this.listener);
      for (const [id, p] of this.#pending) {
        clearTimeout(p.timer);
        p.reject(new Error("bridge closed"));
        this.#pending.delete(id);
      }
    };
  }

  /** Posts with the exact targetOrigin; with reply=true resolves on the answer with the same id or rejects in 2 s. */
  send(msg: ToPreview, reply = false): Promise<FromPreview | null> {
    const origin = this.#o.origin();
    const win = this.#o.frame()?.contentWindow;
    if (!origin || !win) return Promise.reject(new Error("preview is not loaded"));
    const id = `p${++this.#seq}`;
    win.postMessage({ wz: 1, type: msg.type, id, payload: msg.payload }, origin);
    if (!reply) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error("timeout"));
      }, this.#o.timeoutMs ?? 2000);
      this.#pending.set(id, { resolve, reject, timer });
    });
  }
}

/** origin of a URL or null. */
export function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Preview src with next = current route (^/(?![/\\])) and a cache-bust by revision. */
export function previewSrc(url: string, route: string, revision: number): string {
  const u = new URL(url);
  if (/^\/(?![/\\])/.test(route)) u.searchParams.set("next", route);
  u.searchParams.set("wzrev", String(revision));
  return u.toString();
}
