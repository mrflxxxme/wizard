// Module «Контент и блог» (specs/modules/modules.yaml#catalog content, origin: new, V3-24): articles of the blog with
// rubrics and pages of the site (about the company, delivery and so on). The owner (and the staff) write them in the
// cabinet and publish by the status «Опубликовано»; a visitor reads only published ones (rowFilter of the public role,
// RLS in the database) — the list of articles, an article and a rubric by their addresses, the pages. The runtime
// serves /sitemap.xml with the published entries, /robots.txt and the head of every page for crawlers (V3-24). On the
// v3 front the public screens are composed from the article-* and rubric-* patterns; on v2 they are pages.ts.
import type { ModuleManifest } from "@wizard/appspec";
import type { ModuleDefinition } from "../types.js";
import { compileContent, CONTENT_NAMES as N, CONTENT_ROUTES as R } from "./compile.js";
import {
  articlePage,
  blogPage,
  CONTENT_LIB_FILE,
  contentLibSource,
  pagesPage,
  rubricPage,
  sitePage,
} from "./pages.js";

/** Roles that open the public pages: everyone (the visitor's own cabinet included). */
const PUBLIC = ["$public", "$owner", "$staff", "$visitor"];
const PAGE_COMPONENTS = ["LandingSection", "EmptyState", "Loading"];

export const contentManifest: ModuleManifest = {
  id: "content",
  version: 1,
  name: "Контент и блог",
  summary:
    "Статьи с рубриками и страницы сайта: владелец пишет и публикует в кабинете, посетитель читает; карта сайта для поисковиков",
  status: "ready",
  order: 25,
  origin: { kind: "new" },
  goals: ["attract"],
  params: [
    {
      name: "blog_title",
      label: "Как называть раздел статей",
      type: "string",
      maxLength: 40,
      default: "Блог",
    },
    { name: "with_rubrics", label: "Рубрики статей", type: "bool", default: true },
    {
      name: "with_pages",
      label: "Страницы сайта (о компании, доставка и другие)",
      type: "bool",
      default: true,
    },
  ],
  links: [
    { module: "staff", effect: "сотрудники пишут и правят статьи и страницы в кабинете" },
    { module: "visitor_cabinet", effect: "вошедший клиент читает опубликованные статьи и страницы" },
  ],
  provides: {
    entities: [N.article, N.rubric, N.page],
    routes: [R.blog, R.article, R.rubric, R.pages, R.page],
  },
  hook: true,
  fragments: {
    acceptance: [
      {
        value: {
          text: "Посетитель без входа читает статьи",
          check: { type: "permission", role: "$public", entity: N.article, op: "read", expect: "allow" },
        },
      },
      {
        value: {
          text: "Посетитель без входа не меняет статьи",
          check: { type: "permission", role: "$public", entity: N.article, op: "update", expect: "deny" },
        },
      },
      {
        value: {
          text: "Владелец пишет статьи",
          check: { type: "permission", role: "$owner", entity: N.article, op: "create", expect: "allow" },
        },
      },
    ],
  },
  screens: [
    {
      id: "blog",
      audience: "public",
      route: R.blog,
      title: "Блог",
      roles: PUBLIC,
      components: PAGE_COMPONENTS,
      nav: true,
    },
    {
      id: "article",
      audience: "public",
      route: R.article,
      title: "Статья",
      roles: PUBLIC,
      components: PAGE_COMPONENTS,
    },
    {
      id: "rubric",
      audience: "public",
      route: R.rubric,
      title: "Рубрика",
      roles: PUBLIC,
      components: PAGE_COMPONENTS,
      when: { param: "with_rubrics" },
    },
    {
      id: "pages",
      audience: "public",
      route: R.pages,
      title: "Информация",
      roles: PUBLIC,
      components: PAGE_COMPONENTS,
      when: { param: "with_pages" },
      nav: true,
    },
    {
      id: "site_page",
      audience: "public",
      route: R.page,
      title: "Страница",
      roles: PUBLIC,
      components: PAGE_COMPONENTS,
      when: { param: "with_pages" },
    },
    {
      id: "content",
      audience: "cabinet",
      route: "/cabinet",
      title: "Блог и страницы",
      roles: ["$owner", "$staff"],
      components: ["CabinetLayout", "DataTable", "RecordCard", "RecordForm"],
    },
  ],
  metrics: [
    {
      id: "articles_published",
      label: "Опубликовано статей",
      goal: "attract",
      unit: "count",
      better: "up",
      period: "month",
      compute: { kind: "count", entity: N.article, dateField: N.date, where: { [N.status]: "published" } },
    },
  ],
  goalScenarios: [
    {
      id: "GS-content-1",
      goal: "attract",
      title: "Владелец публикует статью — она в списке и открывается по своему адресу",
      steps: [
        { actor: "owner", text: "В кабинете пишет статью и ставит статус «Опубликовано»" },
        { actor: "visitor", text: "Открывает список статей и переходит к новой статье" },
      ],
      expect: [
        {
          kind: "page_text",
          text: "Статья видна в списке и открывается на своей странице с заголовком и текстом",
        },
      ],
    },
    {
      id: "GS-content-2",
      goal: "attract",
      title: "Черновик не виден посетителю",
      steps: [
        { actor: "owner", text: "Сохраняет статью черновиком" },
        { actor: "visitor", text: "Открывает список статей и адрес черновика" },
      ],
      expect: [
        {
          kind: "denied",
          text: "Черновика нет в списке, по его адресу — «Страница не найдена», данные его не отдают",
        },
      ],
    },
    {
      id: "GS-content-3",
      goal: "attract",
      title: "Опубликованная статья попадает в карту сайта",
      steps: [
        { actor: "owner", text: "Публикует статью" },
        { actor: "system", text: "Поисковый робот читает /robots.txt, /sitemap.xml и страницу статьи" },
      ],
      expect: [
        {
          kind: "page_text",
          text: "Адрес статьи есть в карте сайта, а страница статьи отдаёт роботу её заголовок и описание",
        },
      ],
    },
    {
      id: "GS-content-4",
      goal: "attract",
      title: "Посетитель переходит от статьи к её рубрике",
      when: { param: "with_rubrics" },
      steps: [
        { actor: "owner", text: "Создаёт рубрику и публикует в ней статью" },
        { actor: "visitor", text: "Открывает статью и нажимает на её рубрику" },
      ],
      expect: [{ kind: "page_text", text: "На странице рубрики — её название и статья" }],
    },
    {
      id: "GS-content-5",
      goal: "attract",
      title: "Владелец публикует страницу сайта — она открывается по своему адресу",
      when: { param: "with_pages" },
      steps: [
        { actor: "owner", text: "Пишет страницу и ставит статус «Опубликовано»" },
        { actor: "visitor", text: "Открывает список страниц и переходит к новой странице" },
      ],
      expect: [{ kind: "page_text", text: "Страница открывается со своим заголовком и текстом" }],
    },
  ],
  tests: {
    matrix: [
      { name: "по умолчанию: блог с рубриками и страницы сайта", params: {} },
      {
        name: "новости без рубрик и страниц",
        params: { blog_title: "Новости", with_rubrics: false, with_pages: false },
      },
      { name: "блог рядом с лендингом и заявками", params: {}, withModules: ["landing", "leads", "notify"] },
      { name: "сотрудники пишут статьи", params: { with_pages: false }, withModules: ["staff"] },
    ],
    gates: ["G0", "G1"],
  },
};

export const contentModule: ModuleDefinition = {
  manifest: contentManifest,
  compile: compileContent,
  screens: {
    blog: blogPage,
    article: articlePage,
    rubric: rubricPage,
    pages: pagesPage,
    site_page: sitePage,
  },
  files: { [CONTENT_LIB_FILE]: contentLibSource },
};
