// get_ui_kit_docs / get_sdk_docs and prompt fragments: assets/builder.json, generated from specs/ by
// scripts/gen-builder-assets.mjs (no second copy of the documentation is maintained by hand).
import assets from "../../assets/builder.json" with { type: "json" };

export const SDK_TOPICS = [
  "query",
  "mutation",
  "action",
  "db",
  "hooks",
  "connectors",
  "errors",
  "limits",
] as const;
export type SdkTopic = (typeof SDK_TOPICS)[number];

export const UI_KIT_COMPONENTS: readonly string[] = Object.keys(assets.uiKit.components);

export function uiKitDocs(components?: readonly string[]): { docs: string; unknown?: string[] } {
  if (!components || components.length === 0) return { docs: assets.uiKit.toc };
  const table = assets.uiKit.components as Record<string, string>;
  const unknown = components.filter((c) => table[c] === undefined);
  const docs = components
    .filter((c) => table[c] !== undefined)
    .map((c) => table[c])
    .join("\n\n");
  return unknown.length > 0 ? { docs, unknown } : { docs };
}

export function sdkDocs(topic?: SdkTopic): { docs: string } {
  if (!topic) return { docs: assets.sdk.toc };
  return { docs: (assets.sdk.topics as Record<SdkTopic, string>)[topic] };
}

export const PROMPT_PARTS: { conventions: string; ops: string; semantic: string; phases: string } =
  assets.prompt;

export interface CapabilityCard {
  title: string;
  summary: string;
  body: string;
}

const CARDS = (assets as unknown as { capabilities?: Record<string, CapabilityCard> }).capabilities ?? {};

/** Ids of the capability cards (assets/capabilities/*.md via gen-builder-assets.mjs). */
export const CAPABILITY_IDS: readonly string[] = Object.keys(CARDS);

/** Prompt TOC of the capability cards: "- id: title — summary". */
export function capabilityToc(): string {
  return Object.entries(CARDS)
    .map(([id, c]) => `- ${id}: ${c.title} — ${c.summary}`)
    .join("\n");
}

/** get_capability: the full card, or the list of ids for an unknown one. */
export function capabilityDoc(id: string): { doc: string } | { unknown: string; available: string[] } {
  const c = CARDS[id];
  return c ? { doc: c.body } : { unknown: id, available: [...CAPABILITY_IDS] };
}
