// Starting one sandbox pod for the orchestrator (M2-18): the create, retried while the namespace ResourceQuota has no
// room, and the wait until the pod is Ready and answers from this process. Deadlines are on the caller's clock.
import { WizardError } from "@wizard/sdk";
import { type KubeApi, KubeError, type KubePodStatus } from "./kube.js";

export interface PodStartContext {
  kube: KubeApi;
  now(): number;
  wait(ms: number): Promise<void>;
  pollMs: number;
  log(line: Record<string, unknown>): void;
  fetch: typeof fetch;
}

/** Container states that will not become ready by waiting. */
const STUCK = new Set([
  "ErrImagePull",
  "ImagePullBackOff",
  "InvalidImageName",
  "CreateContainerConfigError",
  "CreateContainerError",
  "CrashLoopBackOff",
  "RunContainerError",
]);
/** Reasons of a container that ran and exited (its code or the memory limit), not of the node or the image. */
const CRASH = new Set(["CrashLoopBackOff", "Error", "OOMKilled"]);
const PROBE_TIMEOUT_MS = 2000;

const unavailable = (message: string) => new WizardError("FUNCTIONS_DISABLED", { message });
const crashes = new WeakSet<object>();

/** Whether a start failed because workerd ran and exited (CrashLoopBackOff, OOMKilled…): its config, not the node. */
export const podCrashed = (e: unknown): boolean => typeof e === "object" && e !== null && crashes.has(e);

/**
 * The pod's state for a log line (kubectl logs of the worker explain a failed start without kubectl describe):
 * "CrashLoopBackOff, last Error exit 1, restarts 2", "Pending, Unschedulable". Kubernetes reasons and numbers only.
 */
export function podReason(p: KubePodStatus): string {
  const parts = [p.reason ?? p.phase];
  if (p.lastReason) parts.push(`last ${p.lastReason}${p.exitCode != null ? ` exit ${p.exitCode}` : ""}`);
  if (p.restarts) parts.push(`restarts ${p.restarts}`);
  if (p.unscheduled) parts.push(p.unscheduled);
  return parts.join(", ");
}
const isQuota = (e: unknown) => e instanceof KubeError && e.status === 403 && /quota/i.test(e.message);

/**
 * Creates the pod, retried while the namespace quota refuses it until `until`; false when it still does. Names are
 * unique per start, so a 409 is an error: a pod of that name is never adopted (it may be one being removed).
 */
export async function createWithinQuota(
  c: PodStartContext,
  pod: Record<string, unknown>,
  name: string,
  until: number,
): Promise<boolean> {
  for (let first = true; ; first = false) {
    try {
      await c.kube.createPod(pod);
      return true;
    } catch (e) {
      if (!isQuota(e)) throw e;
      if (first) c.log({ msg: "sandbox_quota_wait", level: "warn", step: name });
      if (c.now() >= until) return false;
      await c.wait(c.pollMs);
    }
  }
}

/** Waits until the pod is Ready and answers from this process; returns its IP. The caller drops it on failure. */
export async function waitReachable(
  c: PodStartContext,
  name: string,
  probePort: number,
  deadline: number,
): Promise<string> {
  let unreachable = false;
  let seen = "Unknown";
  for (;;) {
    const p = await c.kube.getPod(name);
    if (!p) {
      // Created a moment ago and gone (evicted, deleted): waiting cannot bring it back.
      c.log({ msg: "sandbox_pod_failed", level: "error", step: name, reason: "Missing" });
      throw unavailable("Песочница функций не запустилась");
    }
    seen = podReason(p);
    if (p.ready && p.podIP) {
      // Ready for the kubelet is not yet reachable from here: the NetworkPolicy rules of a new pod's address are
      // programmed after it starts, and a call in that gap would fail. The endpoints switch only once it answers.
      if (await answers(c, p.podIP, probePort)) return p.podIP;
      if (!unreachable) c.log({ msg: "sandbox_pod_unreachable", level: "warn", step: name });
      unreachable = true;
      seen = "Unreachable";
    } else if (p.phase === "Failed" || (p.reason && STUCK.has(p.reason))) {
      c.log({ msg: "sandbox_pod_failed", level: "error", step: name, reason: seen });
      const e = unavailable("Песочница функций не запустилась");
      if (p.phase === "Failed" || CRASH.has(p.reason ?? "") || CRASH.has(p.lastReason ?? "")) crashes.add(e);
      throw e;
    }
    if (c.now() >= deadline) break;
    await c.wait(c.pollMs);
  }
  c.log({ msg: "sandbox_pod_timeout", level: "error", step: name, reason: seen });
  throw unavailable("Песочница функций не запустилась вовремя");
}

/** Whether a socket of the pod answers HTTP from this process (any status: workerd is there). */
async function answers(c: PodStartContext, ip: string, port: number): Promise<boolean> {
  try {
    const res = await c.fetch(`http://${ip}:${port}/__wizard/health`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    await res.body?.cancel().catch(() => {});
    return true;
  } catch {
    return false;
  }
}
