// B2-18 acceptance «Брифы mvp-09 и mvp-10 покрываются модулями»: the system plans a planner is expected to write for
// the two briefs (tools/eval/briefs/mvp-09-school-library.json, mvp-10-yoga-subscription.json) — modules of the
// catalog with parameters, no custom code; the card payment of mvp-10 is out of scope with a replacement (D65).
import { type SystemPlan, THEME_FONTS, THEME_PRESETS } from "@wizard/appspec";

const design: SystemPlan["design"] = {
  direction: { mood: ["спокойствие"] },
  theme: THEME_PRESETS[0] as string,
  accent: "#2A7F9E",
  fontPair: { heading: THEME_FONTS[0] as string, body: THEME_FONTS[0] as string },
  photoStyle: "светлые фото",
};

/** mvp-09: a school library — books, who took which book, the due date, a reminder to the student, list import. */
export function libraryPlan(): SystemPlan {
  return {
    version: 1,
    niche: "школьная библиотека",
    goals: [
      { id: "resource_tracking", statement: "Видеть, кто взял какую книгу и когда должен вернуть" },
      { id: "client_history", statement: "История выдач каждого ученика под рукой" },
    ],
    modules: [
      {
        id: "resources",
        params: {
          resource_label: "Книга",
          default_days: 14,
          bulk_import: true,
          extra_fields: [
            { name: "author", label: "Автор", type: "string" },
            { name: "year", label: "Год издания", type: "int" },
          ],
        },
        goals: ["resource_tracking"],
      },
      { id: "client_card", params: { client_label: "Ученик", match_by: "email" }, goals: ["client_history"] },
      { id: "notify", params: { channels: ["email"] } },
      { id: "staff", params: { roles: ["Библиотекарь"], sections_1: ["resources", "client_card"] } },
    ],
    design,
    outOfScope: [],
    custom: [],
  };
}

/** mvp-10: an online yoga school — a subscription to video lessons, the student's cabinet; card payment out of scope. */
export function yogaPlan(): SystemPlan {
  return {
    version: 1,
    niche: "онлайн-школа йоги",
    goals: [
      { id: "retention", statement: "Ученики продлевают подписку на видеоуроки" },
      { id: "self_service", statement: "У ученика свой кабинет с уроками" },
    ],
    modules: [
      {
        id: "packages",
        params: {
          package_label: "Подписка",
          kind: "period",
          validity_days: 30,
          write_off_on_booking: false,
          materials: true,
          material_label: "Видеоурок",
        },
        goals: ["retention"],
      },
      { id: "client_card", params: { client_label: "Ученик", match_by: "email" } },
      { id: "notify", params: { channels: ["email"] } },
      {
        id: "visitor_cabinet",
        params: { show_bookings: false, show_packages: true },
        goals: ["self_service"],
      },
    ],
    design,
    outOfScope: [
      {
        request: "Оплата подписки картой каждый месяц",
        replacement:
          "Владелец принимает оплату сам и открывает подписку в кабинете; ученик входит по коду и смотрит видеоуроки",
        category: "payments",
        module: "packages",
      },
    ],
    custom: [],
  };
}
