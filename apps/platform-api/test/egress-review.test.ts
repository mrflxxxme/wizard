// M2-52 (D71): the founder sees the outgoing-request hosts of a revision on review; a new host is a review reason.
import type { AppSpec } from "@wizard/appspec";
import { describe, expect, test } from "vitest";
import {
  egressHostsNote,
  FOUNDER_REVIEW_CHECKS,
  FOUNDER_REVIEW_REASON_RU,
} from "../src/publish/moderation.js";

const withHosts = (...hosts: string[]) =>
  ({
    functions: [{ name: "sync", kind: "action", file: "functions/sync.ts", egress: hosts }],
  }) as unknown as AppSpec;

describe("egress hosts on founder review", () => {
  test("the alert lists every host and marks the new ones", () => {
    expect(egressHostsNote(withHosts(), null)).toBe("");
    expect(egressHostsNote(withHosts("api.crm.ru", "api.sms.ru"), withHosts("api.crm.ru"))).toBe(
      " Внешние запросы функций: api.crm.ru, api.sms.ru (новые: api.sms.ru).",
    );
    expect(egressHostsNote(withHosts("api.crm.ru"), withHosts("api.crm.ru"))).toBe(
      " Внешние запросы функций: api.crm.ru.",
    );
  });

  test("G2-EGRESS-02 puts the revision on review; the reason has a Russian label", () => {
    expect(FOUNDER_REVIEW_CHECKS).toContain("G2-EGRESS-02");
    expect(FOUNDER_REVIEW_REASON_RU.new_egress_hosts).toBe("новые адреса внешних запросов");
  });
});
