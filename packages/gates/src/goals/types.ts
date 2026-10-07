// Goal scenarios of beta v2 modules in the browser (specs/quality/gates.yaml#G1.browser, specs/modules/modules.yaml
// #manifest.goal_scenarios): the compiled scenario (Russian steps and expectations) and the program that executes it.

import type { Page } from "@playwright/test";
import type { AppSpec } from "@wizard/appspec";

export const GOAL_ACTORS = ["visitor", "client", "owner", "staff", "system"] as const;
export type GoalActor = (typeof GOAL_ACTORS)[number];

/** A goal scenario as compilePlan emits it (structural copy: gates never imports @wizard/modules). */
export interface GoalScenarioInput {
  id: string;
  module?: string;
  goal: string;
  title: string;
  steps: readonly { actor: string; text: string }[];
  expect: readonly { kind: string; text: string }[];
}

export interface GoalViewport {
  width: number;
  height: number;
}

export type ColorScheme = "light" | "dark";

/** A message the runtime's connectors would have sent (connectors: 'outbox'). */
export interface GoalOutboxMessage {
  integration: string;
  action: string;
  userId?: string | null;
  payload: unknown;
  /** systemKey of the sender (absent — a runtime that does not say). */
  system?: string | null;
}

/** Values a filled form received: field label (or name) → value typed or chosen. */
export type FilledForm = Record<string, string>;

/**
 * What a program drives: one browser context of the system draft in the ephemeral G1 schema on the seed. Every helper
 * throws a GoalFailure with a Russian reason; `step` names the scenario step a failure is reported under.
 */
export interface GoalRun {
  readonly spec: AppSpec;
  readonly scenario: GoalScenarioInput;
  /** Files of the system draft (page sources: which page shows which entity). */
  readonly files: ReadonlyMap<string, string>;
  readonly viewport: GoalViewport;
  readonly scheme: ColorScheme;
  /** Unique text of this run: text fields of filled forms carry it, so the run finds its own records. */
  readonly marker: string;
  /** Contacts fillForm types (unique per run: login codes and anti-abuse limits never collide between runs). */
  readonly contact: { readonly email: string; readonly phone: string };
  /** The page of the current actor (Playwright). */
  readonly page: Page;
  /** Names the step that follows (shown when it fails). */
  step(text: string): void;
  /** Switches the browser to an actor: visitor/client — no session; owner — the admin of the seed; staff — a non-admin login role. */
  as(actor: Exclude<GoalActor, "system"> | { role: string }): Promise<void>;
  /** A second tab of the current actor (same session); `useTab` makes it (or the first) the current page. */
  newTab(): Promise<Page>;
  useTab(page: Page): void;
  /** Opens a path of the system and waits until the page settles. */
  open(path: string): Promise<void>;
  /** Fills every editable field of the first form inside `within` with synthetic values, ticks checkboxes (consent). */
  fillForm(within?: string): Promise<FilledForm>;
  /** Waits until the page settles (network idle, one frame). */
  settle(): Promise<void>;
  /** Clicks the submit button of the form inside `within` and waits for the page to settle. */
  submit(within?: string): Promise<void>;
  /** The text (case-insensitive) is visible inside `within` (default: the page). */
  expectText(text: string, opts?: { within?: string; timeoutMs?: number }): Promise<void>;
  /** An element showing `anchor` (e.g. the marker) also shows `text` — a row of a list or a card. */
  expectNear(anchor: string, text: string): Promise<void>;
  /** Rows of an entity in the ephemeral schema (as the system role, RLS-free), newest first. */
  rows(entity: string): Promise<Record<string, unknown>[]>;
  /** Rows the run created: not in the seed. */
  newRows(entity: string): Promise<Record<string, unknown>[]>;
  /** Rows of the seed (what must not leak to a visitor). */
  seedRows(entity: string): readonly Record<string, unknown>[];
  /** Ids of the seed users of the owner role (isAdmin) or the staff roles. */
  userIds(actor: "owner" | "staff"): string[];
  /** The run's clock (starts at the G1 run's moment; advance moves it). */
  readonly now: Date;
  /** One job-runner pass (workflow triggers, due jobs) at the run's clock. */
  runJobs(): Promise<void>;
  /** Moves the run's clock forward and runs the jobs due by then. */
  advance(minutes: number): Promise<void>;
  /** Outbox messages since the run started, of the system's integrations with this connector. */
  outbox(connector: "email" | "telegram"): GoalOutboxMessage[];
  /** Messages of the platform since the run started: login codes and invitations by e-mail (_platform), SMS codes (_sms). */
  serviceMessages(): GoalOutboxMessage[];
  /** User id of an actor of the seed (owner, staff) or null. */
  actorId(actor: "owner" | "staff" | { role: string }): string | null;
  /** HTTP request to the runtime as the current actor (data API). */
  api(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }>;
  /** Ends the run with a failure. */
  fail(reason: string, evidence?: string): never;
}

/** Executable form of a goal scenario: browser steps and checks of its expectations. */
export type GoalProgram = (t: GoalRun) => Promise<void>;

/** Reason a goal scenario failed (the step it failed on is attached by the runner). */
export class GoalFailure extends Error {
  constructor(
    message: string,
    readonly evidence?: string,
  ) {
    super(message);
  }
}
