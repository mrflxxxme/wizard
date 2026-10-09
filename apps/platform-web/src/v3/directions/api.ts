// API of «Три направления» (V3-09; api.yaml /systems/{id}/directions*), with the conventions of the platform client
// (src/api/client.ts): same base, CSRF header, Russian ApiError, idempotency keys for writes.
import { API_BASE, ApiError, csrfToken, newIdempotencyKey } from "../../api/client.js";
import type { ApiErrorBody } from "../../api/types.js";
import { directionsRu } from "./texts.js";

export interface DirectionView {
  n: number;
  archetype: string;
  name: string;
  why: string;
  texts: { title: string; lead?: string; action: string };
  textsSource: "model" | "brief";
  tuning: string[];
  header: string;
  hero: string;
  fonts: { display: string; text: string };
  palette: { background: string; foreground: string; accent: string };
  /** HTML for <iframe srcdoc sandbox="allow-scripts">. */
  previewHtml: string;
}

export interface DirectionsProposalView {
  id: string;
  briefVersion: number;
  createdAt: string;
  costRub: number;
  fallback: boolean;
  references: string[];
  picked: number | null;
  directions: DirectionView[];
}

export interface RefineAnswer {
  proposal: DirectionsProposalView;
  kind: "tuned" | "pick" | "unknown";
  changed: number[];
  reply: string;
}

export interface ReferenceAnswer {
  reference: string;
  read?: boolean;
}

export interface DirectionsApi {
  get(systemId: string): Promise<DirectionsProposalView | null>;
  propose(systemId: string, reroll?: boolean): Promise<DirectionsProposalView>;
  refine(systemId: string, proposalId: string, text: string): Promise<RefineAnswer>;
  /** n — «Выбрать»; null — «Решите за меня». */
  pick(
    systemId: string,
    proposalId: string,
    n: number | null,
  ): Promise<{ archetype: string; pinned: boolean }>;
  addUrl(systemId: string, url: string): Promise<ReferenceAnswer>;
  upload(systemId: string, kind: "logo" | "screenshot", file: Blob): Promise<ReferenceAnswer>;
}

export interface DirectionsApiOptions {
  base?: string;
  fetch?: typeof fetch;
  /** M0: X-Wizard-Dev-User. */
  devUser?: string;
}

export function createDirectionsApi(o: DirectionsApiOptions = {}): DirectionsApi {
  const base = o.base ?? API_BASE;
  const doFetch = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  async function call<T>(
    method: string,
    path: string,
    body?: Record<string, unknown> | FormData,
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (o.devUser) headers["X-Wizard-Dev-User"] = o.devUser;
    if (method !== "GET") {
      headers["Idempotency-Key"] = newIdempotencyKey();
      const csrf = csrfToken();
      if (csrf) headers["X-Wizard-CSRF"] = csrf;
    }
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, { method, headers, body: payload, credentials: "same-origin" });
    } catch {
      throw new ApiError(0, { code: "NETWORK", message_ru: directionsRu.network });
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) throw new ApiError(res.status, (data as ApiErrorBody | null) ?? null);
    return data as T;
  }
  const sys = (id: string) => `/systems/${encodeURIComponent(id)}/directions`;
  return {
    get: async (id) => (await call<{ proposal: DirectionsProposalView | null }>("GET", sys(id))).proposal,
    propose: async (id, reroll) =>
      (await call<{ proposal: DirectionsProposalView }>("POST", sys(id), reroll ? { reroll: true } : {}))
        .proposal,
    refine: (id, proposalId, text) => call<RefineAnswer>("POST", `${sys(id)}/refine`, { proposalId, text }),
    pick: (id, proposalId, n) =>
      call("POST", `${sys(id)}/pick`, n === null ? { proposalId, skip: true } : { proposalId, n }),
    addUrl: (id, url) => call<ReferenceAnswer>("POST", `${sys(id)}/references`, { url }),
    upload: (id, kind, file) => {
      const form = new FormData();
      // Only the extension leaves the browser as the file name: a name may carry personal data.
      form.set("file", file, kind === "logo" && file.type === "image/svg+xml" ? "logo.svg" : `${kind}.png`);
      form.set("kind", kind);
      return call<ReferenceAnswer>("POST", `${sys(id)}/references/upload`, form);
    },
  };
}
