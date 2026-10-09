// The browser side of the visual critic (V3-13): what the host's inspector gets and returns. The platform implements it
// in its Chromium slot (apps/platform-api/src/builds-v3/critic.ts): it builds the system's files, opens each page at
// each viewport, runs CRITIC_CHECKS_SCRIPT and takes the screenshots, downscaled to the sizes asked.
import type { AppSpec } from "@wizard/appspec";
import type { CriticViewport } from "./checks.js";
import type { CriticWidth, DeterministicProblem } from "./rubric.js";

/** A screenshot to take: the first screen of a page at a width, or the whole page (an overview for the rhythm). */
export interface CriticShotRequest {
  route: string;
  width: CriticWidth;
  kind: "screen" | "page";
  /** Width of the image sent to the model, px (the screenshot is downscaled to it). */
  maxWidth: number;
  /** Height cap of the image, px (a long page is cut). */
  maxHeight: number;
}

export interface CriticShot extends CriticShotRequest {
  mime: "image/jpeg" | "image/png";
  /** Base64 of the image bytes. */
  data: string;
  /** Size of the image as sent. */
  px: { width: number; height: number };
  /** Sections in the image, top to bottom, with their place in page px («hero 80–900»). */
  sections: string[];
}

export interface CriticInspectInput {
  spec: AppSpec;
  /** Every file of the system with the critic's changes. */
  files: ReadonlyMap<string, string>;
  /** Pages to open. */
  routes: readonly string[];
  viewports: readonly CriticViewport[];
  /** Screenshots to take (none — the checks only). */
  shots: readonly CriticShotRequest[];
  /** Families of the design system the pages must load (T16). */
  fonts: readonly string[];
  signal?: AbortSignal;
}

export interface CriticInspection {
  /** false — the system did not build or no browser: `error` says why. */
  ok: boolean;
  error?: string;
  problems: DeterministicProblem[];
  shots: CriticShot[];
  /** Photos in the screenshots are stand-ins of the platform (the owner's own are not reachable from the build). */
  stubPhotos?: boolean;
  /** Wall time of the inspection, ms. */
  ms?: number;
}

/** Builds and opens the system in a browser: checks and screenshots (the host's Chromium slot). */
export type CriticInspector = (input: CriticInspectInput) => Promise<CriticInspection>;

/** Tokens a vision model reads an image as (28 px patches of Qwen-VL / MoonViT; for the budget and the fixtures). */
export const imageTokens = (width: number, height: number): number =>
  Math.ceil(width / 28) * Math.ceil(height / 28);
