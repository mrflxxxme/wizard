// Team patterns (V3-08): nine compositions of the people of the business over one slot schema — a portrait grid, a
// single host, a directory, a lead with the team, cards with bios, a group photo with a caption, credits, a few
// centred portraits and a strip. Only real people from the brief with their own photos (catalog I02, D49): no stock
// faces, no invented names, experience or regalia; without photos the variants fall back to type.
import { z } from "zod";
import { definePattern } from "../define.js";
import { imageSlot, line, linkSlot, para } from "../slots.js";
import type { PatternMeta } from "../types.js";
import type Cards from "./cards.js";
import type Centered from "./centered.js";
import type Credits from "./credits.js";
import type Directory from "./directory.js";
import type GroupPhoto from "./group-photo.js";
import type Lead from "./lead.js";
import type Portraits from "./portraits.js";
import type SingleHost from "./single-host.js";
import type Strip from "./strip.js";

/** A person of the brief: name, role and, when the owner gave one, their own photo with alt. */
export const personSlot = z.object({
  name: line(60),
  role: line(80),
  photo: imageSlot.optional(),
  /** What the person does here, in the owner's words. */
  bio: para(320).optional(),
  /** Short confirmed facts: what they teach, education, specialisation (D49). */
  facts: z.array(line(80)).max(3).optional(),
  /** Booking with this person or their page. */
  link: linkSlot.optional(),
});
const withPhoto = personSlot.extend({ photo: imageSlot });

/** Everything a team section may show; each variant picks what it renders. */
export const teamSlots = z.object({
  title: line(80),
  intro: para(260).optional(),
  people: z.array(personSlot).min(1).max(12),
  action: linkSlot.optional(),
  note: line(140).optional(),
});

const photo = (name: string, alt: string) => ({ src: `/_wizard/photos/example-${name}.webp`, alt });

/** Preview content (tests, previews): an example business, never published as the client's text (D49). */
export const TEAM_EXAMPLE = {
  title: "Кто ведёт занятия",
  intro: "За кругами и столом для лепки работают три мастера. Записаться можно к любому из них.",
  people: [
    {
      name: "Анна Соколова",
      role: "основательница, мастер гончарного круга",
      photo: photo("anna", "Анна Соколова за гончарным кругом"),
      bio: "Ведёт пробные занятия и курс «Круг с нуля». Сама загружает печь и подбирает рецепты глазурей.",
      facts: ["Курс «Круг с нуля»", "Обжиг и глазури"],
      link: { label: "Записаться к Анне", href: "#form" },
    },
    {
      name: "Илья Ветров",
      role: "мастер ручной лепки",
      photo: photo("ilya", "Илья Ветров лепит вазу из пласта глины"),
      bio: "Учит лепить без круга: пласт, жгут и щипковая техника. Любит большие формы — вазы и кашпо.",
      facts: ["Ручная лепка"],
      link: { label: "Записаться к Илье", href: "#form" },
    },
    {
      name: "Мария Лебедева",
      role: "мастер по глазурям",
      photo: photo("maria", "Мария Лебедева наносит глазурь на тарелку"),
      bio: "Проводит занятия по глазурованию и помогает подобрать цвет к посуде, которую вы сделали.",
      facts: ["Глазурование"],
    },
    {
      name: "Дмитрий Орлов",
      role: "администратор мастерской",
      photo: photo("dmitry", "Дмитрий Орлов за стойкой администратора"),
      bio: "Отвечает на звонки и сообщения, переносит записи и выдаёт готовые работы.",
    },
  ],
  action: { label: "Записаться на пробное", href: "#form" },
  note: "Мастера меняются по дням недели, расписание видно при записи",
} satisfies z.input<typeof teamSlots>;

const at = import.meta.url;
const base = teamSlots.pick({ title: true, intro: true, action: true, note: true });

export const TEAM_PATTERNS: readonly PatternMeta[] = [
  definePattern<typeof Portraits>()(at, "team", {
    variant: "portraits",
    layout: "grid",
    title: "Сетка портретов 3:4: имя и роль под фото, по две колонки на телефоне",
    archetypes: ["*"],
    slots: base.extend({ people: z.array(personSlot).min(2).max(12) }),
    needs: null,
    license: "own",
    origin: "own",
    example: TEAM_EXAMPLE,
  }),
  definePattern<typeof SingleHost>()(at, "team", {
    variant: "single-host",
    layout: "split",
    title: "Один ведущий: большой портрет, крупно имя, роль, о себе, факты и запись к нему",
    archetypes: ["*"],
    slots: base.extend({ people: z.array(withPhoto).min(1).max(1) }),
    needs: null,
    license: "own",
    origin: "own",
    example: {
      ...TEAM_EXAMPLE,
      intro: "Все занятия ведёт основательница мастерской, от пробного до курса на круге.",
      people: TEAM_EXAMPLE.people.slice(0, 1),
    },
  }),
  definePattern<typeof Directory>()(at, "team", {
    variant: "directory",
    layout: "list",
    title:
      "Справочник: строки с именем крупно, ролью и записью к человеку; фото маленьким кружком, если есть",
    archetypes: ["*"],
    slots: base.extend({ people: z.array(personSlot).min(2).max(12) }),
    needs: null,
    license: "own",
    origin: "own",
    example: TEAM_EXAMPLE,
  }),
  definePattern<typeof Lead>()(at, "team", {
    variant: "lead",
    layout: "asymmetric",
    title: "Руководитель крупно с рассказом о себе, остальные маленькими портретами рядом",
    archetypes: ["*"],
    slots: base.extend({ people: z.array(personSlot).min(3).max(7) }),
    needs: null,
    license: "own",
    origin: "own",
    example: TEAM_EXAMPLE,
  }),
  definePattern<typeof Cards>()(at, "team", {
    variant: "cards",
    layout: "card",
    title: "Горизонтальные карточки в две колонки: фото, имя, роль, о себе, факты и запись",
    archetypes: ["*"],
    slots: base.extend({ people: z.array(personSlot).min(2).max(8) }),
    needs: null,
    license: "own",
    origin: "own",
    example: TEAM_EXAMPLE,
  }),
  definePattern<typeof GroupPhoto>()(at, "team", {
    variant: "group-photo",
    layout: "editorial",
    title: "Журнальный ряд портретов без зазоров с подписью «на фото слева направо», под ним короткие био",
    archetypes: ["*"],
    slots: base.extend({ people: z.array(withPhoto).min(2).max(5) }),
    needs: null,
    license: "own",
    origin: "own",
    example: TEAM_EXAMPLE,
  }),
  definePattern<typeof Credits>()(at, "team", {
    variant: "credits",
    layout: "typographic",
    title: "Титры без фото: роль мелко справа от оси, имя крупно слева, по центру страницы",
    archetypes: ["*"],
    slots: base.extend({ people: z.array(personSlot).min(2).max(12) }),
    needs: null,
    license: "own",
    origin: "own",
    example: TEAM_EXAMPLE,
  }),
  definePattern<typeof Centered>()(at, "team", {
    variant: "centered",
    layout: "centered",
    title: "Маленькая команда по центру: круглые портреты, имя, роль и пара строк о себе",
    archetypes: ["*"],
    slots: base.extend({ people: z.array(personSlot).min(1).max(4) }),
    needs: null,
    license: "own",
    origin: "own",
    example: { ...TEAM_EXAMPLE, people: TEAM_EXAMPLE.people.slice(0, 3) },
  }),
  definePattern<typeof Strip>()(at, "team", {
    variant: "strip",
    layout: "band",
    title: "Тонированная полоса с лентой портретов, которую листают вручную; на десктопе помещается в ряд",
    archetypes: ["*"],
    slots: base.extend({ people: z.array(withPhoto).min(2).max(12) }),
    needs: null,
    license: "own",
    origin: "own",
    example: TEAM_EXAMPLE,
  }),
];
