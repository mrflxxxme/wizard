// Goal scenarios of the module «Контент и блог» (packages/modules/src/content, modules.yaml#catalog content, V3-24):
// articles `article` {title, status draft | published, published_at, rubric?, slug, excerpt, body, cover, seo_*},
// rubrics `rubric` {name, slug, description}, pages of the site `site_page`. The owner writes in the cabinet form; a
// visitor reads the lists /blog and /pages and the entry pages /blog/<slug>, /blog/rubric/<slug>, /pages/<slug> — the
// same steps on the v2 pages of the module and on the v3 pages of the composer (article-*, rubric-*, blog-*); a
// crawler reads /robots.txt, /sitemap.xml and the head of an entry page from the runtime.
import type { GoalProgram, GoalRun } from "../types.js";
import { formReady, openEntity, ownerRole, pageText, plain, press, setFields, textOf } from "./shared.js";

const ARTICLE = "article";
const RUBRIC = "rubric";
const PAGE = "site_page";
const BLOG = "/blog";
const PAGES = "/pages";

/** A slug of the run: latin, from the marker («Проверка 1a2b3c» → «gs-1a2b3c»). */
const slugOf = (t: GoalRun, prefix = "gs") =>
  `${prefix}-${t.marker.replace(/[^0-9a-f]/gi, "").toLowerCase()}`;
/** The body of an entry of the run: two paragraphs and a subheading of the markdown subset. */
const bodyOf = (t: GoalRun) =>
  `Первый абзац записи ${t.marker}.\n\n## Подробности\n\nВторой абзац с деталями.`;

/**
 * The owner writes an entry of `entity` in the cabinet form (every field filled, `values` on top; the multi-line body
 * is typed into its text area) and saves it; returns its row.
 */
async function ownerWrites(
  t: GoalRun,
  entity: string,
  values: Readonly<Record<string, string | boolean>>,
): Promise<Record<string, unknown>> {
  await t.as("owner");
  const area = await openEntity(t, ownerRole(t.spec), entity);
  const { body, ...rest } = values;
  // The section's table and its «Добавить» come with the data of the section.
  await t.page
    .locator(area)
    .getByRole("button", { name: "Добавить", exact: true })
    .first()
    .waitFor({ state: "visible", timeout: 8_000 })
    .catch(() => {});
  await press(t, "Добавить", area);
  await formReady(t, area);
  await t.fillForm(area);
  await setFields(t, area, rest);
  if (typeof body === "string") {
    const box = t.page.locator(`${area} [data-testid="wz-field-body"] textarea`).first();
    if ((await box.count()) === 0) t.fail("в форме нет поля текста");
    await box.fill(body);
  }
  await t.submit(area);
  const error = await textOf(t, `${area} form [role="alert"]`);
  if (error) t.fail("запись не сохранилась", error);
  const key = entity === RUBRIC ? "name" : "title";
  const mine = (await t.newRows(entity)).filter((r) => r[key] === values[key]);
  if (mine.length !== 1)
    t.fail(`новых записей «${entity}» с этим названием в базе ${mine.length}, ожидалась одна`);
  return mine[0] as Record<string, unknown>;
}

/** An article (or a page) of the run: the marker as the title, the run's slug and body, the status. */
const entry = (t: GoalRun, status: "draft" | "published", extra: Record<string, string> = {}) => ({
  title: t.marker,
  slug: slugOf(t),
  status,
  body: bodyOf(t),
  excerpt: `Анонс записи ${t.marker}`,
  seo_title: t.marker,
  seo_description: `Описание для поисковиков ${t.marker}`,
  ...extra,
});

/** A document of the system as a crawler gets it: status and text, no scripts run. */
async function fetchText(t: GoalRun, path: string): Promise<{ status: number; text: string }> {
  return t.page.evaluate(async (p) => {
    const r = await fetch(p, { credentials: "omit", headers: { accept: "text/html,application/xml,*/*" } });
    return { status: r.status, text: await r.text() };
  }, path);
}

/** Waits until the text shows up (data of the page loads after the document). */
async function shows(t: GoalRun, text: string): Promise<boolean> {
  return t.page
    .getByText(text, { exact: false })
    .first()
    .waitFor({ state: "visible", timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
}

/** The text of the page's h1 (one per page). */
const heading = async (t: GoalRun) =>
  plain(
    (await t.page
      .locator("h1")
      .first()
      .innerText({ timeout: 5_000 })
      .catch(() => "")) || "",
  );

/** The visitor follows the link named `name` and lands on `path`. */
async function follow(t: GoalRun, name: string, path: string): Promise<void> {
  const link = t.page.getByRole("link", { name, exact: false }).first();
  try {
    await link.waitFor({ state: "visible", timeout: 8_000 });
  } catch {
    t.fail(`на странице нет ссылки «${name}»`, plain(await pageText(t)).slice(0, 300));
  }
  await link.click();
  try {
    await t.page.waitForURL((u) => decodeURIComponent(u.pathname) === path, { timeout: 8_000 });
  } catch {
    t.fail(`ссылка «${name}» ведёт не на ${path}`, new URL(t.page.url()).pathname);
  }
  await t.settle();
}

/** GS-content-1: a published article is in the list and opens on its own address with its text. */
const published: GoalProgram = async (t) => {
  t.step("В кабинете пишет статью и ставит статус «Опубликовано»");
  await ownerWrites(t, ARTICLE, entry(t, "published"));

  t.step("Открывает список статей и переходит к новой статье");
  await t.as("visitor");
  await t.open(BLOG);
  if (!(await shows(t, t.marker)))
    t.fail("опубликованной статьи нет в списке", plain(await pageText(t)).slice(0, 300));
  await follow(t, t.marker, `${BLOG}/${slugOf(t)}`);

  t.step("Статья видна в списке и открывается на своей странице с заголовком и текстом");
  if (!(await shows(t, `Первый абзац записи ${t.marker}`))) t.fail("на странице статьи нет её текста");
  if (!(await shows(t, "Подробности"))) t.fail("подзаголовок текста не показан");
  const h1 = await heading(t);
  if (!h1.includes(t.marker)) t.fail("заголовок страницы статьи — не её название", h1);
};

/** GS-content-2: a draft is not in the list, its address is «Страница не найдена», the data API does not give it. */
const draft: GoalProgram = async (t) => {
  t.step("Сохраняет статью черновиком");
  await ownerWrites(t, ARTICLE, entry(t, "draft"));

  t.step("Открывает список статей и адрес черновика");
  await t.as("visitor");
  await t.open(BLOG);
  await t.page.waitForTimeout(500);
  if ((await pageText(t)).includes(t.marker)) t.fail("черновик виден в списке статей");
  await t.open(`${BLOG}/${slugOf(t)}`);

  t.step("Черновика нет в списке, по его адресу — «Страница не найдена», данные его не отдают");
  if (!(await shows(t, "Страница не найдена"))) t.fail("по адресу черновика нет «Страница не найдена»");
  if ((await pageText(t)).includes(`Первый абзац записи ${t.marker}`))
    t.fail("текст черновика виден посетителю");
  const doc = await fetchText(t, `${BLOG}/${slugOf(t)}`);
  if (doc.text.includes(t.marker)) t.fail("заголовок черновика есть в документе для поисковиков");
  if (!doc.text.includes('<meta name="robots" content="noindex">'))
    t.fail("адрес черновика не закрыт от индексации (noindex)");
  const api = await t.api("GET", `/api/data/${ARTICLE}?filter[slug]=${encodeURIComponent(slugOf(t))}`);
  const items = (api.body as { items?: unknown[] } | null)?.items ?? [];
  if (items.length > 0) t.fail("черновик отдаётся посетителю через данные");
};

/** GS-content-3: robots.txt names the rules, the sitemap lists the article, its page gives the crawler its head. */
const sitemap: GoalProgram = async (t) => {
  t.step("Публикует статью");
  await ownerWrites(t, ARTICLE, entry(t, "published"));

  t.step("Поисковый робот читает /robots.txt, /sitemap.xml и страницу статьи");
  await t.as("visitor");
  await t.open(BLOG);
  const robots = await fetchText(t, "/robots.txt");
  const map = await fetchText(t, "/sitemap.xml");
  const page = await fetchText(t, `${BLOG}/${slugOf(t)}`);

  t.step("Адрес статьи есть в карте сайта, а страница статьи отдаёт роботу её заголовок и описание");
  if (robots.status !== 200 || !/User-agent:/i.test(robots.text))
    t.fail("/robots.txt не отвечает правилами для роботов", `HTTP ${robots.status}`);
  if (map.status !== 200 || !map.text.includes("<urlset"))
    t.fail("/sitemap.xml не отвечает картой сайта", `HTTP ${map.status}`);
  if (!map.text.includes(`${BLOG}/${slugOf(t)}</loc>`))
    t.fail("адреса статьи нет в карте сайта", map.text.slice(0, 400));
  if (!map.text.includes(`${BLOG}</loc>`)) t.fail("списка статей нет в карте сайта");
  if (page.status !== 200) t.fail("страница статьи отвечает не 200", `HTTP ${page.status}`);
  const title = /<title>([^<]*)<\/title>/.exec(page.text)?.[1] ?? "";
  if (!title.includes(t.marker)) t.fail("в <title> страницы нет заголовка статьи", title);
  if (!page.text.includes(`content="Описание для поисковиков ${t.marker}"`))
    t.fail("в описании страницы нет описания статьи для поисковиков");
  if (!page.text.includes(`rel="canonical" href="`) || !page.text.includes(`${BLOG}/${slugOf(t)}">`))
    t.fail("у страницы статьи нет канонического адреса");
};

/** GS-content-4: from an article the visitor goes to its rubric; the rubric page has its name and the article. */
const rubric: GoalProgram = async (t) => {
  t.step("Создаёт рубрику и публикует в ней статью");
  const name = `Рубрика ${slugOf(t, "r")}`;
  const rubricSlug = slugOf(t, "r");
  // The rubric through the data API (the cabinet form of an entry is GS-content-1), the article in the cabinet.
  await t.as("owner");
  const created = await t.api("POST", `/api/data/${RUBRIC}`, {
    name,
    slug: rubricSlug,
    description: `Статьи рубрики ${t.marker}`,
  });
  const rubricId = (created.body as { item?: { id?: string } } | null)?.item?.id;
  if (created.status >= 300 || !rubricId)
    return t.fail("рубрика не создалась", JSON.stringify(created.body).slice(0, 200));
  await ownerWrites(t, ARTICLE, entry(t, "published", { rubric: rubricId }));

  t.step("Открывает статью и нажимает на её рубрику");
  await t.as("visitor");
  await t.open(`${BLOG}/${slugOf(t)}`);
  if (!(await shows(t, `Первый абзац записи ${t.marker}`))) t.fail("статья не открылась");
  await follow(t, name, `${BLOG}/rubric/${rubricSlug}`);

  t.step("На странице рубрики — её название и статья");
  if (!(await shows(t, t.marker)))
    t.fail("статьи нет на странице рубрики", plain(await pageText(t)).slice(0, 300));
  const h1 = await heading(t);
  if (!h1.includes(name)) t.fail("заголовок страницы рубрики — не её название", h1);
};

/** GS-content-5: a published page of the site is in the list of pages and opens on its own address. */
const page: GoalProgram = async (t) => {
  t.step("Пишет страницу и ставит статус «Опубликовано»");
  await ownerWrites(t, PAGE, entry(t, "published"));

  t.step("Открывает список страниц и переходит к новой странице");
  await t.as("visitor");
  await t.open(PAGES);
  if (!(await shows(t, t.marker))) t.fail("страницы нет в списке", plain(await pageText(t)).slice(0, 300));
  await follow(t, t.marker, `${PAGES}/${slugOf(t)}`);

  t.step("Страница открывается со своим заголовком и текстом");
  if (!(await shows(t, `Первый абзац записи ${t.marker}`))) t.fail("на странице нет её текста");
  const h1 = await heading(t);
  if (!h1.includes(t.marker)) t.fail("заголовок страницы — не её название", h1);
};

export const CONTENT_PROGRAMS: Readonly<Record<string, GoalProgram>> = {
  "GS-content-1": published,
  "GS-content-2": draft,
  "GS-content-3": sitemap,
  "GS-content-4": rubric,
  "GS-content-5": page,
};
