// CLI of .github/workflows/research.yml (V3-05). `probe`: at most 3 searches of PROBE_QUERIES and one read_page with
// the real key; prints only numbers and statuses (::notice / ::warning, every line masked); writes the answers as
// fixtures (RecordedExchange[], secrets masked) and a summary to --out for the workflow artifact.
//   tsx packages/agents/src/research/ci.ts probe --out=<dir>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { guardedTransport, systemResolver } from "./net.js";
import { maskSecrets, type RecordedExchange, recordingFetch } from "./recorded.js";
import { createResearch, searchStatus } from "./research.js";
import { MemoryResearchLog } from "./store.js";
import { ResearchError, type ResearchFetch, type Resolver } from "./types.js";
import { SEARCH_FOLDER_ENV, SEARCH_KEY_ENV } from "./yandex.js";

/** Fixed queries of the probe (no chat data): niches of the mvp briefs. */
export const PROBE_QUERIES = [
  "стоматология Казань услуги",
  "ремонт квартир под ключ Екатеринбург цены",
  "курсы английского языка для детей Новосибирск",
] as const;
/** Caps of one probe run: 3 paid searches (≈ 1,5 ₽), one page, no documentation discovery. */
export const PROBE_LIMITS = { searches: 3, pages: 1, discover: 0 };
/** Page read when no search answered with a result. */
export const PROBE_FALLBACK_URL = "https://ru.wikipedia.org/wiki/Стоматология";

const TITLE = "Поиск: проба";

export interface ProbeOptions {
  env: Readonly<Record<string, string | undefined>>;
  /** Directory of exchanges.json and summary.json; null — nothing is written. */
  out: string | null;
  fetch?: ResearchFetch;
  searchFetch?: ResearchFetch;
  resolve?: Resolver;
  print?: (line: string) => void;
  clock?: () => number;
}

export interface ProbeResult {
  code: number;
  searches: number;
  costRub: number;
  pages: number;
  errors: number;
  exchanges: RecordedExchange[];
}

export async function runProbe(o: ProbeOptions): Promise<ProbeResult> {
  const secrets = [o.env[SEARCH_KEY_ENV]?.trim() ?? "", o.env[SEARCH_FOLDER_ENV]?.trim() ?? ""].filter(
    Boolean,
  );
  const print = (line: string) => (o.print ?? console.log)(maskSecrets(line, secrets));
  const clock = o.clock ?? Date.now;
  const exchanges: RecordedExchange[] = [];
  const st = searchStatus(o.env);
  if (!st.search) {
    const missing = [SEARCH_KEY_ENV, SEARCH_FOLDER_ENV].filter((k) => !o.env[k]?.trim());
    print(`::error title=${TITLE}::нет секретов: ${missing.join(", ")}`);
    return { code: 1, searches: 0, costRub: 0, pages: 0, errors: 1, exchanges };
  }
  const resolve = o.resolve ?? systemResolver;
  const research = createResearch({
    env: o.env,
    mode: "live",
    resolve,
    fetch: recordingFetch(o.fetch ?? guardedTransport(resolve), exchanges, secrets),
    searchFetch: recordingFetch(o.searchFetch ?? globalThis.fetch, exchanges, secrets),
    limits: PROBE_LIMITS,
    log: new MemoryResearchLog(),
    clock,
  });
  const statuses: { step: string; status: string; results: number; ms: number }[] = [];
  let errors = 0;
  let readUrl: string | null = null;
  for (const [i, q] of PROBE_QUERIES.entries()) {
    const t0 = clock();
    try {
      const r = await research.search(q);
      const ms = clock() - t0;
      readUrl ??= r.hits[0]?.url ?? null;
      statuses.push({ step: `search_${i + 1}`, status: "ok", results: r.hits.length, ms });
      print(
        `::notice title=${TITLE}::запрос ${i + 1}: ok, результатов ${r.hits.length}, всего ${r.found ?? "?"}, ${ms} мс`,
      );
    } catch (e) {
      errors++;
      const code = e instanceof ResearchError ? e.code : "NETWORK";
      statuses.push({ step: `search_${i + 1}`, status: code, results: 0, ms: clock() - t0 });
      print(`::warning title=${TITLE}::запрос ${i + 1}: ${code}`);
      // A rejected key or an exhausted quota fails every next request too: no more spending.
      if (code === "SEARCH_AUTH" || code === "SEARCH_RATE_LIMIT") break;
    }
  }
  const t0 = clock();
  try {
    const p = await research.readPage(readUrl ?? PROBE_FALLBACK_URL);
    const ms = clock() - t0;
    statuses.push({ step: "read_page", status: "ok", results: p.markdown.length, ms });
    print(
      `::notice title=${TITLE}::страница: ok, ${p.markdown.length} символов markdown, ${p.bytes} байт, ${ms} мс`,
    );
  } catch (e) {
    errors++;
    const code = e instanceof ResearchError ? e.code : "NETWORK";
    statuses.push({ step: "read_page", status: code, results: 0, ms: clock() - t0 });
    print(`::warning title=${TITLE}::страница: ${code}`);
  }
  const u = research.usage();
  const searchesOk = statuses.filter((s) => s.step.startsWith("search_") && s.status === "ok").length;
  print(
    `::notice title=Поиск: итог::поисков ${u.searches} (успешных ${searchesOk}), ≈ ${u.costRub.toFixed(2)} ₽, страниц ${u.pages}, ошибок ${errors}`,
  );
  if (o.out !== null) {
    mkdirSync(o.out, { recursive: true });
    writeFileSync(
      join(o.out, "exchanges.json"),
      `${maskSecrets(JSON.stringify(exchanges, null, 2), secrets)}\n`,
    );
    const summary = {
      searches: u.searches,
      searchesOk,
      costRub: u.costRub,
      pages: u.pages,
      errors,
      statuses,
    };
    writeFileSync(join(o.out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  }
  return {
    code: searchesOk > 0 ? 0 : 1,
    searches: u.searches,
    costRub: u.costRub,
    pages: u.pages,
    errors,
    exchanges,
  };
}

async function main(argv: string[]): Promise<number> {
  const [cmd] = argv;
  if (cmd !== "probe") {
    console.error("usage: ci.ts probe --out=<dir>");
    return 2;
  }
  const out = argv.find((a) => a.startsWith("--out="))?.slice(6) ?? null;
  return (await runProbe({ env: process.env, out })).code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.log(`::error title=${TITLE}::сбой пробы: ${e instanceof Error ? e.name : "unknown"}`);
      process.exit(1);
    },
  );
}
