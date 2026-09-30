// Test helpers: golden demo/forum fixture, fixture router, scripted fake route.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  createRouter,
  type FixtureLine,
  type LlmResult,
  MemoryUsageSink,
  type RouteInput,
  type RouteOutput,
} from "@wizard/llm";

export const ROOT = new URL("../../../", import.meta.url);

export function fixtureLines(name = "forum"): FixtureLine[] {
  return readFileSync(new URL(`tools/fixtures/demo/${name}.jsonl`, ROOT), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as FixtureLine);
}

/** The forum brief as recorded in the golden fixture (first user message of interview #1). */
export function forumBrief(): string {
  const first = fixtureLines()[0];
  const msg = first?.request.messages[0];
  if (msg?.role !== "user") throw new Error("unexpected fixture");
  return msg.content;
}

export function forumRouter() {
  const sink = new MemoryUsageSink();
  const router = createRouter({ mode: "fixture", fixture: { suite: "demo", name: "forum" }, sink, env: {} });
  return { router, sink };
}

export const OPEN_POLICY = { ruOnly: false, t1Restricted: false } as const;
export const CTX = { orgId: "00000000-0000-4000-8000-000000000001" } as const;

/** Scripted route(): returns the given results in order and records the inputs. */
export function scriptedRoute(results: (LlmResult | Error)[]) {
  const inputs: RouteInput[] = [];
  let i = 0;
  const route = async (input: RouteInput): Promise<RouteOutput> => {
    inputs.push(input);
    const r = results[i++];
    if (r === undefined) throw new Error(`scriptedRoute: no result #${i}`);
    if (r instanceof Error) throw r;
    return {
      tier: "T1",
      model: "glm-5.3",
      result: r,
      usage: { inputTokens: 100, cachedTokens: 0, outputTokens: 50 },
      creditsCharged: 0.01,
      creditsMilli: 10,
      routeReason: "default_T1",
      scrubbed: true,
      ruFallback: false,
    };
  };
  return { route, inputs };
}

export const toolResult = (name: string, args: unknown, id = `call_${name}`): LlmResult => ({
  toolCalls: [{ id, name, args }],
  finishReason: "tool-calls",
});

/** YAML → JSON via python3 + PyYAML (same requirement as tools/specs/validate.mjs). */
export function loadYaml(relPath: string): unknown {
  const r = spawnSync(
    process.env.PYTHON || "python3",
    [
      "-c",
      "import sys, json, yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1], encoding='utf-8'))))",
      relPath,
    ],
    { cwd: new URL(".", ROOT).pathname, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (r.status !== 0) throw new Error(`python3/PyYAML failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}
