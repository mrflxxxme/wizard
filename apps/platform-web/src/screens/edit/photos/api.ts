// API of the photos of a system (V4-16, /systems/{id}/photos): the choice for a photo slot and the owner's uploads.
import { API_BASE, ApiError, csrfToken, newIdempotencyKey } from "../../../api/client.js";
import type { ApiErrorBody } from "../../../api/types.js";
import { photosRu } from "./ru.js";

export interface PhotoChoice {
  id: string;
  source: "owner" | "library";
  thumb: string;
  author?: string;
  pageUrl?: string;
  provider?: string;
}

export interface PhotosApi {
  list(systemId: string, o: { ref?: string; q?: string }): Promise<{ query: string; photos: PhotoChoice[] }>;
  upload(systemId: string, file: Blob): Promise<{ photo: PhotoChoice }>;
}

export function createPhotosApi(o: { base?: string; fetch?: typeof fetch } = {}): PhotosApi {
  const base = o.base ?? API_BASE;
  const doFetch = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  async function call<T>(method: string, path: string, body?: FormData): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (method !== "GET") {
      headers["Idempotency-Key"] = newIdempotencyKey();
      const csrf = csrfToken();
      if (csrf) headers["X-Wizard-CSRF"] = csrf;
    }
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers,
        ...(body ? { body } : {}),
        credentials: "same-origin",
      });
    } catch {
      throw new ApiError(0, { code: "NETWORK", message_ru: photosRu.network });
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
  const sys = (id: string) => `/systems/${encodeURIComponent(id)}/photos`;
  return {
    list: (id, q) => {
      const p = new URLSearchParams();
      if (q.ref) p.set("ref", q.ref);
      if (q.q) p.set("q", q.q);
      const qs = p.toString();
      return call("GET", `${sys(id)}${qs ? `?${qs}` : ""}`);
    },
    upload: (id, file) => {
      const form = new FormData();
      // Only the extension leaves the browser as the file name: a name may carry personal data.
      form.set("file", file, file.type === "image/png" ? "photo.png" : "photo.jpg");
      return call("POST", sys(id), form);
    },
  };
}

/** The new value of an image literal: the library id changes, the width (and the rest of the path) stays. */
export function swapPhotoValue(value: string, id: string): string {
  const out = value.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/, id);
  // An owner upload of /api/files/… becomes a library path (the slot keeps a library width).
  return out.startsWith("/_wizard/photos/") ? out : `/_wizard/photos/${id}/1600`;
}

/** HEIC (iPhone) as JPEG when the browser can decode it (Safari); null — it cannot, the owner saves it as JPEG. */
export async function asUploadable(file: File): Promise<Blob | null> {
  if (file.type === "image/jpeg" || file.type === "image/png") return file;
  if (!/heic|heif/i.test(file.type) && !/\.(heic|heif)$/i.test(file.name)) return file;
  try {
    const bmp = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    canvas.getContext("2d")?.drawImage(bmp, 0, 0);
    return await new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", 0.92));
  } catch {
    return null;
  }
}
