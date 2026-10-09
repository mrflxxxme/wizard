// The stop rule of the v3 interview (grill-8 № 8), by code and not by the model: the interview ends when no blocking
// unclarity is left — the brief has goals, at least one must scenario, roles, and data when its modules keep records —
// or at the cap of 15 questions, or when the owner presses «Дальше решай сам». The tree goes forward: a question may
// not skip a topic that still has a blocking gap.
import type { SystemBrief } from "@wizard/appspec";
import type { ModuleRegistry } from "@wizard/modules";
import type { ToolIssue } from "../core/tool.js";
import { DEFAULT_REGISTRY } from "../planner/catalog.js";
import { capabilityMap, dataModules } from "./capability.js";
import {
  type ExtraRequirement,
  MAX_V3_QUESTIONS,
  V3_TOPIC_LABELS,
  V3_TOPICS,
  type V3Topic,
} from "./schemas.js";

/** A blocking unclarity: the build cannot start without it. */
export interface BlockingGap {
  topic: V3Topic;
  /** Russian, plain: what is missing. */
  reasonRu: string;
}

/**
 * Blocking gaps of a brief in the tree order: no goal; no must scenario; no data while the requirements need modules
 * that keep records; no role. Audience, integrations, content and launch limits never block (asked in the build).
 */
export function blockingGaps(
  brief: SystemBrief,
  extras: readonly ExtraRequirement[] = [],
  registry: ModuleRegistry = DEFAULT_REGISTRY,
): BlockingGap[] {
  const out: BlockingGap[] = [];
  if (brief.goals.length === 0) out.push({ topic: "goals", reasonRu: "Не ясно, зачем бизнесу система" });
  if (!brief.scenarios.some((s) => s.priority === "must"))
    out.push({ topic: "scenarios", reasonRu: "Нет ни одного обязательного сценария «Когда…, система…»" });
  if (brief.data.length === 0) {
    const modules = dataModules(capabilityMap(brief, extras, registry).verdicts, registry);
    if (modules.length > 0)
      out.push({ topic: "data", reasonRu: "Не ясно, какие данные система хранит и сколько" });
  }
  if (brief.roles.length === 0)
    out.push({ topic: "roles", reasonRu: "Не ясно, кто работает в системе и что каждый может" });
  return out;
}

const index = (t: V3Topic) => V3_TOPICS.indexOf(t);

/**
 * Tree order of the next question: it may not skip a topic with an open blocking gap, and it does not go back to a
 * topic before the last one asked unless that topic still has a gap.
 */
export function questionOrderIssues(
  topic: V3Topic,
  o: { gaps: readonly BlockingGap[]; lastTopic: V3Topic | null },
): ToolIssue[] {
  const first = o.gaps[0];
  if (first && index(topic) > index(first.topic))
    return [
      {
        path: "topic",
        code: "TREE_ORDER",
        message: `Сначала тема «${V3_TOPIC_LABELS[first.topic]}»: ${first.reasonRu}. Вопрос о «${V3_TOPIC_LABELS[topic]}» — после неё.`,
      },
    ];
  if (o.lastTopic && index(topic) < index(o.lastTopic) && !o.gaps.some((g) => g.topic === topic))
    return [
      {
        path: "topic",
        code: "TREE_ORDER",
        message: `Тема «${V3_TOPIC_LABELS[topic]}» уже пройдена: иди дальше по дереву (${V3_TOPICS.map((t) => V3_TOPIC_LABELS[t]).join(" → ")}).`,
      },
    ];
  return [];
}

/** Why the interview stops now, or null to go on: no blocking gaps (and the model finished) or the cap. */
export function stopReason(o: {
  gaps: readonly BlockingGap[];
  asked: number;
  modelFinished: boolean;
}): "clear" | "cap" | null {
  if (o.asked >= MAX_V3_QUESTIONS) return "cap";
  if (o.gaps.length === 0 && o.modelFinished) return "clear";
  return null;
}
