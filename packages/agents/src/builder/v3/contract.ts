// The seam between the build harness v3 (V3-11: orchestration, checkpoints, wallet, time, stop rules) and the page
// writer (V3-12: public pages on the pattern library and signature sections) — specs/agents/builder-v3.md §3 C6.
// Types only: V3-11 calls a PageComposer, V3-12 implements it; neither imports the other's internals.
import type { AppSpec, BriefScenario, SystemBrief, SystemPlan } from "@wizard/appspec";
import type { PublicFront } from "@wizard/modules";
import type { DesignSystemV3 } from "@wizard/ui-kit/v3/design";
import type { RouteFn } from "../../core/loop.js";

/** Files of a system: repository path → source (ui/**, functions/**, ui/design.css). */
export type SystemFiles = Map<string, string>;

/** What a stage of the v3 build reads; the harness builds it once and refreshes `files` after each step. */
export interface V3BuildContext {
  systemId: string;
  /** The latest brief version (agents re-read it before each stage, D77 (9)). */
  brief: SystemBrief;
  briefVersion: number;
  /**
   * The owner's own words about the business (the system's first message), when the host has them: the skeleton's
   * texts read the business name, what it is and offers, and its place from them (V3-18). Never sent to a model as is.
   */
  request?: string;
  /** The backend plan (modules with params and extensions) compiled with {front: "backend"} (C5). */
  plan: SystemPlan;
  spec: AppSpec;
  /** Public screens, actions and hooks the pages must give (V3-10). */
  publicFront: PublicFront;
  /** The client's design system (C2); its CSS is ui/design.css. */
  design: DesignSystemV3;
  /** Current files of the system, the backend ones included; a composer returns changes, the harness merges them. */
  files: SystemFiles;
  /** Model calls through the gateway (callTypes page_compose, signature_section — models.yaml). */
  route: RouteFn;
  /** Rubles left for model calls of this step; the composer stops before it is spent. */
  budgetRub: number;
  signal?: AbortSignal;
}

/** A page of the public site as the composer laid it out: route, title and the sections in order. */
export interface V3PagePlan {
  route: string;
  title: string;
  /**
   * The page file (ui/pages/**.tsx). The spec gets the pages from the composer's site model in the files
   * (ui/site.json → withSitePages, V3-12), so `file` and `roles` here are for the build log and the checks.
   */
  file?: string;
  /** Roles of AppSpec.pages the page is registered with (V3-12: the roles of its module screen, else everyone). */
  roles?: string[];
  /** Section instances: the library pattern (or a signature section written as code) and its content. */
  sections: { id: string; pattern: string | "signature"; props: unknown }[];
}

/** Result of a composer step: files to write (path → source; null — delete) and plain notes for the build log. */
export interface V3ComposeResult {
  files: Map<string, string | null>;
  pages: V3PagePlan[];
  /** Short Russian notes for the client («Собрал главную в стиле …»). */
  notes: string[];
  /** ₽ the step spent on models. */
  spentRub: number;
}

/** The page writer of V3-12. */
export interface PageComposer {
  /**
   * The preview skeleton (≤ 5 min after «Собрать», D77 (10)): every public page of the brief from library patterns with
   * the brief's texts and the design system — deterministic, no model calls.
   */
  skeleton(ctx: V3BuildContext): Promise<V3ComposeResult>;
  /**
   * One scenario of the brief brought to its page(s): composition, texts and the signature sections where the scenario
   * needs them (models page_compose / signature_section), checked by the composer's lint before it returns.
   */
  scenario(ctx: V3BuildContext, scenario: BriefScenario): Promise<V3ComposeResult>;
}
