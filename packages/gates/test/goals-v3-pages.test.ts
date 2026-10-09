// V3-18: the goal programs find the module data of a v3 page — the composer writes the props of a section as JSON
// ("entity":"booking"), not as a ui-kit attribute (entity="booking"): the client cabinet /me of a v3 site is the
// visitor's page with «Мои записи» and «Мои заявки» (GS-visitor_cabinet-*), as the v2 page /me is.
import type { AppSpec } from "@wizard/appspec";
import { describe, expect, test } from "vitest";
import { entityPage } from "../src/goals/programs/shared.js";
import type { GoalRun } from "../src/goals/types.js";

const spec = {
  pages: [
    { route: "/booking", title: "Запись", file: "ui/pages/site/Booking.tsx", roles: ["guest", "visitor"] },
    { route: "/me", title: "Личный кабинет", file: "ui/pages/site/Me.tsx", roles: ["visitor"] },
    { route: "/cabinet", title: "Кабинет", file: "ui/pages/Cabinet.tsx", roles: ["owner"] },
  ],
} as unknown as AppSpec;

const files = new Map([
  [
    "ui/pages/site/Booking.tsx",
    '<FormBookingCompact {...{"entity":"booking","booking":{"serviceEntity":"service"}}} />',
  ],
  [
    "ui/pages/site/Me.tsx",
    '<AccountTabs {...{"title":"Личный кабинет","sections":[{"id":"booking","entity":"booking"},{"id":"lead","entity":"lead"}]}} />',
  ],
  ["ui/pages/Cabinet.tsx", '<DataTable entity="booking" />'],
]);

const run = { spec, files } as unknown as GoalRun;

describe("entityPage on v3 pages", () => {
  test("the visitor's /me names its entities in the section props; the v2 cabinet keeps its attribute", () => {
    expect(entityPage(run, "visitor", "booking", "/me")).toEqual({
      route: "/me",
      file: "ui/pages/site/Me.tsx",
    });
    expect(entityPage(run, "visitor", "lead", "/me")).toEqual({ route: "/me", file: "ui/pages/site/Me.tsx" });
    expect(entityPage(run, "owner", "booking")).toEqual({ route: "/cabinet", file: "ui/pages/Cabinet.tsx" });
    expect(entityPage(run, "visitor", "client_package", "/me")).toBeNull();
  });
});
