// M0-26: @wizard/agents/host adapters — host.route gets the agent's call without ctx/orgPolicy/signal and with
// upper_bound(call); the QA agent built on the host routes its calls through it.
import { emptySpec } from "@wizard/appspec";
import type { RouteOutput } from "@wizard/llm";
import { describe, expect, test } from "vitest";
import { upperBoundCredits } from "../src/builder/index.js";
import { createHostQa, type HostRouteInput, hostRouteFn } from "../src/host/index.js";

const OUT: RouteOutput = {
  tier: "T0",
  model: "m",
  result: { text: "ok", toolCalls: [], finishReason: "stop" },
  usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1 },
  creditsCharged: 0,
  creditsMilli: 0,
  routeReason: "default_T0",
  scrubbed: false,
  ruFallback: false,
};

describe("hostRouteFn", () => {
  test("drops ctx/orgPolicy/signal, sets step and upperBoundCredits", async () => {
    const seen: HostRouteInput[] = [];
    const route = hostRouteFn(
      async (i) => {
        seen.push(i);
        return OUT;
      },
      { step: "orchestrate" },
    );
    const messages = [{ role: "user" as const, content: "Привет" }];
    await route({
      callType: "interview",
      messages,
      orgPolicy: { ruOnly: false, t1Restricted: false },
      ctx: { orgId: "o" },
      signal: new AbortController().signal,
    });
    expect(seen).toHaveLength(1);
    const call = seen[0] as HostRouteInput & Record<string, unknown>;
    expect(call.ctx).toBeUndefined();
    expect(call.orgPolicy).toBeUndefined();
    expect(call.signal).toBeUndefined();
    expect(call.step).toBe("orchestrate");
    expect(call.upperBoundCredits).toBe(upperBoundCredits("interview", messages));
    expect(call.upperBoundCredits).toBeGreaterThan(0);
  });

  test("createHostQa routes qa_explain through host.route with step = callType", async () => {
    const seen: HostRouteInput[] = [];
    const qa = createHostQa({
      route: async (i) => {
        seen.push(i);
        return OUT;
      },
      runStep: (_n, fn) => fn(),
    });
    // A scenario AC without steps needs qa_generate; the model answers without a tool call → check_invalid.
    const checks = await qa.generate({
      card: { roles: [], acceptance: [{ id: "AC1", text: "Сценарий", check: { type: "scenario" } }] },
      spec: emptySpec("x"),
      specVersion: 1,
    });
    expect(checks.some((c) => c.acId === "AC1")).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    for (const c of seen) {
      expect(c.callType).toBe("qa_generate");
      expect(c.step).toBe("qa_generate");
      expect(c.upperBoundCredits).toBeGreaterThan(0);
    }
  });
});
