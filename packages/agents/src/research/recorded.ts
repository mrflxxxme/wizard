// Recorded answers (builder-v3.md §4: search spends the Yandex Cloud balance, so answers are recorded once and reused).
// The CI probe records exchanges in this format; tests replay them. Request headers and bodies are never kept:
// the search body names the folder, the headers carry the key.
import { ResearchError, type ResearchFetch } from "./types.js";
import { YANDEX_SEARCH_ENDPOINT } from "./yandex.js";

export interface RecordedExchange {
  /** "GET <url>" or, for search, "SEARCH <queryText>|<region>|<page>". */
  key: string;
  status: number;
  /** content-type and location only. */
  headers: Record<string, string>;
  body: string;
}

/** Replay key of a request. */
export function exchangeKey(url: string, init?: RequestInit): string {
  if (url === YANDEX_SEARCH_ENDPOINT) {
    let body: { query?: { queryText?: unknown; page?: unknown }; region?: unknown } = {};
    try {
      body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as typeof body;
    } catch {
      // A malformed body has no recording.
    }
    return `SEARCH ${String(body.query?.queryText ?? "")}|${String(body.region ?? "")}|${String(body.query?.page ?? "0")}`;
  }
  return `${(init?.method ?? "GET").toUpperCase()} ${url}`;
}

const NULL_BODY = new Set([204, 205, 304]);

function toResponse(x: RecordedExchange): Response {
  return new Response(NULL_BODY.has(x.status) ? null : x.body, { status: x.status, headers: x.headers });
}

/**
 * fetch over recorded exchanges; a request without a recording → ResearchError FIXTURE_MISSING (never the network).
 * `onRequest` sees every request (tests check headers and counts).
 */
export function recordedFetch(
  exchanges: readonly RecordedExchange[],
  onRequest?: (url: string, init: RequestInit | undefined) => void,
): ResearchFetch {
  const byKey = new Map(exchanges.map((x) => [x.key, x]));
  return async (url, init) => {
    onRequest?.(url, init);
    const x = byKey.get(exchangeKey(url, init));
    if (!x)
      throw new ResearchError("FIXTURE_MISSING", "Нет записанного ответа для этого запроса (режим фикстур).");
    return toResponse(x);
  };
}

/** Every occurrence of the secrets replaced (recordings and printed lines never carry them). */
export function maskSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s.length >= 4) out = out.split(s).join("***");
  return out;
}

/** Wraps a fetch: each answer is appended to `sink` as a RecordedExchange with the secrets masked. */
export function recordingFetch(
  inner: ResearchFetch,
  sink: RecordedExchange[],
  secrets: readonly string[],
): ResearchFetch {
  return async (url, init) => {
    const res = await inner(url, init);
    const body = NULL_BODY.has(res.status) ? "" : await res.text();
    const headers: Record<string, string> = {};
    for (const h of ["content-type", "location"]) {
      const v = res.headers.get(h);
      if (v !== null) headers[h] = maskSecrets(v, secrets);
    }
    const x: RecordedExchange = {
      key: maskSecrets(exchangeKey(url, init), secrets),
      status: res.status,
      headers,
      body: maskSecrets(body, secrets),
    };
    sink.push(x);
    return new Response(NULL_BODY.has(res.status) ? null : body, {
      status: res.status,
      headers: res.headers,
    });
  };
}
