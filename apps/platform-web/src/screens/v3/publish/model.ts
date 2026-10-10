// The publication of a v3 system on the canvas (V3-19) — pure: what stops it (GET /systems/:id publishBlockers is the
// source of truth, the gate reports only name the failed checks), whether «Опубликовать» is on, the publish run of the
// canvas events and the addresses of the published system and its owner's cabinet.
import type { GateReport, RunEvent } from "../../../api/types.js";
import { initialRunState, type RunState, reduceRun } from "../../../run/reducer.js";
import { BILLING_BLOCKERS, publishBlockers, SETTINGS_BLOCKERS } from "../../workspace/GateReport.js";

/** The owner role of a compiled system (modules engine BASE_ROLES, isAdmin). */
export const OWNER_ROLE = "owner";
/** The owner's cabinet of a compiled system (modules engine CABINET_ROUTE). */
export const CABINET_PATH = "/cabinet";

export interface V3PublishInput {
  /** publishBlockers of GET /systems/:id (codes). */
  codes: readonly string[];
  /** GET /systems/:id/gates/latest reports (they only name the checks of GATES_FAILED). */
  reports: readonly GateReport[];
  /** Revision «Опубликовать» would publish (publishTarget), null — nothing to publish. */
  target: number | null;
  prodRevision: number | null;
  /** A publish run is in flight. */
  running: boolean;
}

export interface V3PublishModel {
  /** What stops the publication, in words — without the operator's data and «not the owner» (shown on their own). */
  blockers: string[];
  /** The owner gives the personal data operator's data (OPERATOR_*_REQUIRED, INN_INVALID). */
  operator: boolean;
  /** The address is asked (OPERATOR_ADDRESS_REQUIRED). */
  address: boolean;
  /** The INN given is wrong (INN_INVALID). */
  inn: boolean;
  /** V3-18: the seller's ОГРН/ОГРНИП asked (a shop: SELLER_REQUISITES_REQUIRED or OGRN_INVALID). */
  ogrn: boolean;
  /** A blocker fixed on S-billing (card, plan); `card` — the card binding. */
  billing: boolean;
  card: boolean;
  /** The founder's review before the first publication. */
  review: boolean;
  /** Checks did not pass (GATES_FAILED): the build is not publishable. */
  gates: boolean;
  /** The user may publish (not NOT_OWNER). */
  owner: boolean;
  /** The revision to publish is already in prod. */
  upToDate: boolean;
  /** «Опубликовать» is on. */
  canPublish: boolean;
}

/**
 * The publication of the system as the owner sees it. Only the server's codes block: a failed report of the build
 * (G2-PII-06 before the owner gave the operator's data) does not, once the server says the revision is publishable.
 */
export function v3PublishModel(i: V3PublishInput): V3PublishModel {
  const owner = !i.codes.includes("NOT_OWNER");
  const rest = i.codes.filter((c) => c !== "NOT_OWNER" && !SETTINGS_BLOCKERS.has(c));
  const gates = rest.includes("GATES_FAILED");
  const blockers = [...new Set(publishBlockers(rest, gates ? [...i.reports] : []))];
  const upToDate = i.prodRevision !== null && i.target === i.prodRevision;
  return {
    blockers,
    operator: i.codes.some((c) => SETTINGS_BLOCKERS.has(c)),
    address: i.codes.includes("OPERATOR_ADDRESS_REQUIRED") || i.codes.includes("SELLER_REQUISITES_REQUIRED"),
    inn: i.codes.includes("INN_INVALID") || i.codes.includes("SELLER_REQUISITES_REQUIRED"),
    ogrn: i.codes.includes("OGRN_INVALID") || i.codes.includes("SELLER_REQUISITES_REQUIRED"),
    billing: i.codes.some((c) => BILLING_BLOCKERS.has(c)),
    card: i.codes.includes("CARD_BINDING_REQUIRED"),
    review: i.codes.includes("FOUNDER_REVIEW_PENDING"),
    gates,
    owner,
    upToDate,
    canPublish: owner && i.codes.length === 0 && i.target !== null && !upToDate && !i.running,
  };
}

/** The state of the publish run the canvas follows (its events), null when they are of another run kind. */
export function publishRunState(events: readonly RunEvent[]): RunState | null {
  const started = events.find((e) => e.type === "run_started");
  if (started?.payload?.kind !== "publish") return null;
  return events.reduce(reduceRun, initialRunState());
}

/** A run that has not ended yet (queued, running or waiting for input). */
export const runInFlight = (run: RunState | null): boolean =>
  run !== null && (run.phase === "idle" || run.phase === "running" || run.phase === "needs_input");

/** The owner's cabinet of the published system: its sign-in page leading to the cabinet. */
export function ownerCabinetUrl(prodUrl: string): string | null {
  try {
    const u = new URL("/login", prodUrl);
    u.searchParams.set("next", CABINET_PATH);
    return u.toString();
  } catch {
    return null;
  }
}

/** INN of 10 or 12 digits (the server checks the checksum: INN_INVALID). */
export const innShapeOk = (inn: string): boolean => /^[0-9]{10}([0-9]{2})?$/.test(inn);
/** An e-mail as api.yaml#setCompliance takes it (format: email), checked before the request. */
export const emailOk = (s: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
