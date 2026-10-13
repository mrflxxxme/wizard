// API of the edits in three layers (V4-12 over the server of V4-15, api of /systems/{id}/edit/*): the texts and photos
// of the draft by source ref, the design sliders; the conventions of the platform client (same base, CSRF, idempotency
// keys, Russian ApiError). «Укажи и измени» goes through the usual POST /messages with a target (client.ts).
import { API_BASE, ApiError, csrfToken, newIdempotencyKey } from "../../api/client.js";
import type { ApiErrorBody } from "../../api/types.js";
import { editRu } from "./ru.js";

export type LiteralKind = "text" | "image" | "alt";

export interface Literal {
  ref: string;
  kind: LiteralKind;
  value: string;
  file: string;
  route?: string;
}

export interface EditResult {
  revision: number;
  previewRevision: number;
  ms: number;
}

export type Radius = "sharp" | "crisp" | "soft" | "round";
export type Density = "compact" | "regular" | "airy";
export type Contrast = "normal" | "high";

export interface DesignControls {
  radius: Radius;
  density: Density;
  contrast: Contrast;
  fontPair: string;
}

export interface DesignView extends DesignControls {
  revision: number;
  fontPairs: { id: string; label: string }[];
  /** For every value of every control: the --ds-* variables it changes against the current style (current → {}). */
  preview: {
    radius: Partial<Record<Radius, Record<string, string>>>;
    density: Partial<Record<Density, Record<string, string>>>;
    contrast: Partial<Record<Contrast, Record<string, string>>>;
    fontPair: Record<string, Record<string, string>>;
  };
}

export interface EditApi {
  literals(systemId: string): Promise<{ revision: number; literals: Literal[] }>;
  saveLiterals(
    systemId: string,
    revision: number,
    edits: { ref: string; value: string }[],
  ): Promise<EditResult>;
  design(systemId: string): Promise<DesignView>;
  saveDesign(
    systemId: string,
    revision: number,
    controls: Partial<DesignControls>,
  ): Promise<EditResult & { controls?: DesignControls }>;
}

export function createEditApi(o: { base?: string; fetch?: typeof fetch } = {}): EditApi {
  const base = o.base ?? API_BASE;
  const doFetch = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  async function call<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (method !== "GET") {
      headers["Idempotency-Key"] = newIdempotencyKey();
      const csrf = csrfToken();
      if (csrf) headers["X-Wizard-CSRF"] = csrf;
      headers["Content-Type"] = "application/json";
    }
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
        credentials: "same-origin",
      });
    } catch {
      throw new ApiError(0, { code: "NETWORK", message_ru: editRu.network });
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
  const sys = (id: string) => `/systems/${encodeURIComponent(id)}/edit`;
  return {
    literals: (id) => call("GET", `${sys(id)}/literals`),
    saveLiterals: (id, revision, edits) => call("POST", `${sys(id)}/literals`, { revision, edits }),
    design: (id) => call("GET", `${sys(id)}/design`),
    saveDesign: (id, revision, controls) => call("POST", `${sys(id)}/design`, { revision, ...controls }),
  };
}
