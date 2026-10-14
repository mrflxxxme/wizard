// V4-24 «Укажи и измени» on a section written as code (ui/sections/<page>-<id>.tsx, V4-06): the owner points at it on
// the page (the build wraps its element with data-wz-id), the edit goes to the section's own file — not to the page,
// whose element only passes the props — with those props in the prompt; a pattern of the page is edited in the page
// file as before.
import { codeSectionTarget } from "@wizard/agents/builder";
import type { RouteInput, RouteOutput } from "@wizard/llm";
import { describe, expect, test } from "vitest";
import { pointEditBuild } from "../src/builds-v3/edit/point.js";
import type { BuildHost } from "../src/runs/types.js";

const PAGE = "ui/pages/site/Home.tsx";
const PAGE_SOURCE = [
  'import HeaderFloating from "../../patterns/header-floating";',
  'import HomeHero from "../../sections/home-hero";',
  "export default function HomePage() {",
  "  return (",
  "    <>",
  '      <HeaderFloating {...{"brand":{"name":"Белая линия"}}} />',
  '      <main id="main">',
  '        <div id="hero">',
  '          <HomeHero {...{"title":"Лечим зубы без боли","lead":"Перезвоним за 15 минут"}} />',
  "        </div>",
  "      </main>",
  "    </>",
  "  );",
  "}",
].join("\n");
const SECTION = "ui/sections/home-hero.tsx";
const SECTION_SOURCE = [
  "export default function HomeHero({ title, lead }: { title: string; lead: string }) {",
  "  return (",
  '    <section className="py-24">',
  '      <h1 className="text-5xl">{title}</h1>',
  "      <p>{lead}</p>",
  "    </section>",
  "  );",
  "}",
].join("\n");
const SHORTER = SECTION_SOURCE.replace("py-24", "py-12").replace("text-5xl", "text-4xl");

const target = (componentName: string, line: number) => ({
  wzId: "614c5a59:2",
  componentName,
  file: PAGE,
  line,
  route: "/",
  instruction: "Сделай первый экран короче",
});

/** A build host over files in memory; the model answers `answer` with submit_file. */
function host(answer: string) {
  const files = new Map([
    [PAGE, PAGE_SOURCE],
    [SECTION, SECTION_SOURCE],
  ]);
  const calls: RouteInput[] = [];
  const passed = { level: "G0", passed: true, checks: [] };
  const h = {
    runStep: <T>(_name: string, fn: () => Promise<T>) => fn(),
    runGates: async () => passed,
    route: async (input: RouteInput): Promise<RouteOutput> => {
      calls.push(input);
      return {
        tier: "T1",
        model: "glm-5.3",
        result: {
          toolCalls: [
            { id: "c1", name: "submit_file", args: { content: answer, summary: "Первый экран ниже" } },
          ],
          finishReason: "tool-calls",
        },
        usage: { inputTokens: 100, cachedTokens: 0, outputTokens: 100 },
        creditsCharged: 0.1,
        creditsMilli: 100,
        routeReason: "default_T1",
        scrubbed: false,
        ruFallback: false,
      } as RouteOutput;
    },
    store: {
      readFile: async (p: string) => files.get(p) ?? null,
      writeFile: async (p: string, v: string) => void files.set(p, v),
      commitFiles: async () => {},
    },
  };
  return { host: h as unknown as BuildHost, files, calls };
}

describe("V4-24: «Укажи и измени» on a section written as code", () => {
  test("codeSectionTarget: the section's own file and the props its page passes; a pattern — null", () => {
    expect(codeSectionTarget(target("HomeHero", 9), PAGE_SOURCE)).toEqual({
      target: { ...target("HomeHero", 9), file: SECTION, line: 1 },
      props: '{"title":"Лечим зубы без боли","lead":"Перезвоним за 15 минут"}',
    });
    expect(codeSectionTarget(target("HeaderFloating", 6), PAGE_SOURCE)).toBeNull();
  });

  test("the edit reaches the section's file with its props in the prompt; the page stays as it was", async () => {
    const h = host(SHORTER);
    const r = await pointEditBuild(h.host, target("HomeHero", 9));
    expect(r.status).toBe("succeeded");
    expect(h.files.get(SECTION)).toBe(SHORTER);
    expect(h.files.get(PAGE)).toBe(PAGE_SOURCE);
    const user = String(h.calls[0]?.messages.at(-1)?.content ?? "");
    expect(user).toContain(`Файл: ${SECTION}`);
    expect(user).toContain('Props секции сейчас: {"title":"Лечим зубы без боли"');
    expect(user).toContain("py-24");
  });

  test("a pattern of the page: the page file is edited as before", async () => {
    const edited = PAGE_SOURCE.replace("Белая линия", "Белая линия — стоматология");
    const h = host(edited);
    await pointEditBuild(h.host, {
      ...target("HeaderFloating", 6),
      instruction: "Добавь в название «стоматология»",
    });
    expect(h.files.get(PAGE)).toBe(edited);
    expect(h.files.get(SECTION)).toBe(SECTION_SOURCE);
    expect(String(h.calls[0]?.messages.at(-1)?.content ?? "")).not.toContain("Props секции");
  });
});
