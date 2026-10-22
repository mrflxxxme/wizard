// Бюро Лаптевой (V5-09): the bar site of the direction «Редакция». A fictional translation bureau in Yekaterinburg
// with a notary one floor down; the first screen is the offer with a price and the price list as a table of contents,
// the signature is the editor's second reading.
import { BlockById } from "../../../v4/blocks/index.js";
import type { PhotoSlot } from "../photos.js";
import type { Photo } from "../still.js";
import type { PageBlock } from "./service.js";

type Photos = Record<PhotoSlot, Photo>;

/** Mark of Бюро Лаптевой: the proofreader's insertion caret in red pencil over the letter Л. */
export function BureauMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" aria-hidden="true" className={className}>
      <path
        d="M6 36 18 8h4l12 28"
        fill="none"
        stroke="currentColor"
        strokeWidth="3.4"
        strokeLinejoin="miter"
      />
      <path
        d="M11 22c4-5 6-9 9-13 3 4 5 8 9 13"
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

const logo = (
  <span className="inline-flex items-end gap-3 font-display text-[calc(var(--ds-text-display)*1.1)] leading-[0.9] font-semibold tracking-[-0.01em] lg:text-7xl">
    <BureauMark className="size-11 shrink-0 lg:size-16" />
    Бюро Лаптевой
  </span>
);
const smallLogo = (
  <span className="inline-flex items-end gap-2 font-display text-3xl leading-none font-semibold">
    <BureauMark className="size-8" />
    Бюро Лаптевой
  </span>
);

const PHONE = "+7 343 288-40-12";
const EMAIL = "doc@lapteva-bureau.ru";
const CREDITED: PhotoSlot[] = ["ed-desk", "ed-portrait", "ed-city"];

/** Sections of the page in order: a catalog block id and its content. */
export function bureauBlocks(photos: Photos): PageBlock[] {
  return [
    {
      id: "redaktsiya.hero",
      content: {
        header: {
          name: "Бюро Лаптевой",
          logo,
          dateline: ["Екатеринбург, Радищева, 6А, офис 312", "Пн–пт 9:00–20:00, сб 10:00–16:00"],
          motto: "Переводы документов с нотариальным заверением. Работаем с 2004 года.",
          nav: [
            { id: "chitka", label: "Вторая читка" },
            { id: "ceny", label: "Цены по языкам" },
            { id: "kak", label: "Как сдать документ" },
            { id: "byuro", label: "Переводчики" },
            { id: "pisma", label: "Отзывы" },
            { id: "adres", label: "Адрес" },
          ],
          phone: PHONE,
          phoneHref: "tel:+73432884012",
        },
        kicker: "Нотариус этажом ниже",
        title: "Перевод паспорта с\u00a0нотариусом за\u00a01\u00a0400 ₽",
        lead: "Пришлите фото разворота в Telegram до 18:00. На следующий день к 11:00 перевод будет подшит и заверен у нотариуса Ковалёвой: её кабинет на втором этаже, ехать никуда не нужно.",
        cta: "Прислать фото в Telegram",
        ctaHref: "#kak",
        alt: `или на почту ${EMAIL}`,
        altHref: `mailto:${EMAIL}`,
        tocTitle: "Документы, цена с нотариусом",
        toc: [
          { name: "Паспорт, свидетельство, права, справка", price: 1400, term: "на следующий день" },
          { name: "Диплом с приложением", price: 4900, term: "2 рабочих дня" },
          { name: "Трудовая книжка до 10 разворотов", price: 6200, term: "3 рабочих дня" },
          {
            name: "Апостиль на документ ЗАГС",
            price: 3500,
            plus: "госпошлина 2 500 ₽",
            term: "5 рабочих дней",
          },
          { name: "Договор, страница без нотариуса", price: 690, term: "до 10 страниц в день" },
        ],
        tocNote: "Цены для английского и немецкого. Другие языки ниже, перевод в день обращения +50 %.",
        photo: photos["ed-desk"],
        caption: "Вторая читка: редактор сверяет перевод с оригиналом строку за строкой.",
        facts: [
          { value: "38 412", label: "страниц за 2025 год" },
          { value: "11", label: "языков в штате" },
          { value: "4,9", label: "Яндекс Карты, 862 отзыва" },
          { value: "22", label: "года на Радищева" },
        ],
      },
    },
    {
      id: "redaktsiya.proof",
      content: {
        anchor: "chitka",
        kicker: "Вторая читка",
        title: "Каждую страницу читает редактор",
        lead: "Переводчик сдаёт текст, редактор сверяет его с оригиналом и с загранпаспортом клиента. Консульство или вуз возвращает документ из-за одной буквы, поэтому ищем ошибки именно такого размера.",
        figure: { value: "1 186", label: "страниц редакторы исправили в 2025 году до выдачи" },
        sheet: {
          head: "Перевод паспорта РФ на английский · стр. 1",
          lines: [
            { label: "Фамилия", text: "ZHURAVLEVA" },
            {
              label: "Имя",
              fix: {
                wrong: "YULIYA",
                right: "IULIIA",
                note: "Как в загранпаспорте: консульство сверяет имя по буквам",
              },
            },
            {
              label: "Дата рождения",
              fix: {
                wrong: "04/03/1987",
                right: "4 March 1987",
                note: "Запись 04/03 в США прочтут как 3 апреля",
              },
            },
            {
              label: "Место рождения",
              before: "City of ",
              fix: {
                wrong: "Yekaterinburg",
                right: "Sverdlovsk",
                note: "В паспорте город назван так, как в 1987 году",
              },
            },
            {
              label: "Кем выдан",
              text: "Department of the Federal Migration Service for Sverdlovsk Region",
            },
          ],
          sign: "Редактор М. Ю. Лаптева",
        },
      },
    },
    {
      id: "redaktsiya.prices",
      content: {
        anchor: "ceny",
        title: "Цены по языкам",
        lead: "Документ: паспорт, свидетельство или справка на одну страницу. Страница текста: 1 800 знаков с пробелами, считаем по готовому переводу.",
        heads: { lang: "Язык", doc: "Документ", page: "Страница текста", term: "Срок" },
        langs: [
          { name: "Английский", doc: 690, page: 690, term: "1 день" },
          { name: "Немецкий", doc: 690, page: 790, term: "1 день" },
          { name: "Французский", doc: 790, page: 850, term: "1 день" },
          { name: "Испанский", doc: 790, page: 850, term: "1 день" },
          { name: "Итальянский", doc: 850, page: 890, term: "2 дня" },
          { name: "Турецкий", doc: 990, page: 1100, term: "2 дня" },
          { name: "Китайский", doc: 1450, page: 1600, term: "3 дня" },
        ],
        notes: [
          "Нотариальное заверение: 710 ₽ за документ по тарифу нотариуса.",
          "Перевод в день обращения: +50 % к цене перевода, если фото пришло до 12:00.",
          "Курьер по Екатеринбургу 450 ₽, по России СДЭК по тарифу перевозчика.",
        ],
      },
    },
    {
      id: "redaktsiya.steps",
      content: {
        anchor: "kak",
        title: "Как сдать документ",
        items: [
          { title: "Сфотографируйте", text: "Разворот целиком, без бликов. Хватит камеры телефона." },
          {
            title: "Получите цену и срок",
            text: "Ответим в Telegram за 15 минут в рабочее время: сколько стоит, когда готово, нужен ли нотариус.",
          },
          {
            title: "Оплатите по ссылке",
            text: "Картой или через СБП. Оригинал понадобится нотариусу, принесёте его в день выдачи.",
          },
          {
            title: "Заберите перевод",
            text: "В офисе на Радищева или курьером. Перевод подшит к копии, пронумерован и заверен.",
          },
        ],
      },
    },
    {
      id: "redaktsiya.people",
      content: {
        anchor: "byuro",
        quote:
          "Я читаю каждый диплом перед выдачей. За 22 года консульства вернули нам три документа, все три из-за опечаток в датах.",
        author: "Марина Лаптева",
        role: "основатель бюро, переводчик английского и немецкого",
        photo: photos["ed-portrait"],
        bio: "Переводит с 2004 года, в Союзе переводчиков России с 2011-го. До бюро шесть лет работала на Уралмаше, поэтому в прайсе есть паспорта оборудования и чертежи.",
        staffTitle: "Переводчики и редакторы",
        staff: [
          { lang: "Английский", names: "М. Лаптева, И. Шестаков, А. Мурзина" },
          { lang: "Немецкий", names: "М. Лаптева, Е. Гросс" },
          { lang: "Французский", names: "О. Белоусова" },
          { lang: "Испанский, итальянский", names: "Д. Корнилова" },
          { lang: "Турецкий", names: "Э. Ахметова" },
          { lang: "Китайский", names: "Ван Лэй, Т. Сафина" },
          { lang: "Чешский, польский", names: "Я. Новак" },
          { lang: "Казахский, узбекский", names: "Р. Бектурганов" },
        ],
      },
    },
    {
      id: "redaktsiya.reviews",
      content: {
        anchor: "pisma",
        title: "Письма в бюро",
        rating: { value: "4,9", source: "Яндекс Карты, 862 отзыва" },
        items: [
          {
            name: "Ольга Шумкова",
            doc: "Диплом УрФУ · Мюнхен",
            text: "Переводили диплом и приложение для TU München, приняли с первой подачи. Редактор нашла в приложении ошибку в часах одного курса, её сделал ещё деканат.",
          },
          {
            name: "Артём Лысенко",
            doc: "Справка о несудимости · Белград",
            text: "Прислал фото в 17:40, на следующий день в 11:00 забрал перевод с печатью нотариуса. Заплатил 1 400 ₽, как в прайсе.",
          },
          {
            name: "Гульнара Р.",
            doc: "Свидетельства о рождении · Стамбул",
            text: "Три свидетельства на турецкий для ВНЖ, готово за два дня. Имена детей записали как в их загранпаспортах, я даже не успела об этом попросить.",
          },
        ],
      },
    },
    {
      id: "redaktsiya.contacts",
      content: {
        anchor: "adres",
        title: "Адрес",
        address: "Радищева, 6А, офис 312",
        way: [
          "Остановка «Площадь Коммунаров», 3 минуты пешком",
          "Третий этаж, лифт справа от поста охраны",
          "Нотариус Е. В. Ковалёва: тот же подъезд, офис 214",
        ],
        hours: [
          { who: "Бюро, пн–пт", time: "9:00–20:00" },
          { who: "Бюро, суббота", time: "10:00–16:00" },
          { who: "Нотариус, пн–пт", time: "10:00–18:00" },
        ],
        cta: "Прислать фото документа",
        ctaHref: "#kak",
        email: EMAIL,
        emailHref: `mailto:${EMAIL}`,
        photo: photos["ed-city"],
        caption: "Екатеринбург, Исеть. От бюро до Плотинки 10 минут пешком.",
      },
    },
    {
      id: "redaktsiya.footer",
      content: {
        name: "Бюро Лаптевой",
        logo: smallLogo,
        legal: [
          "ИП Лаптева Марина Юрьевна, ОГРНИП 304667021500931, ИНН 667010338214",
          `Екатеринбург, ул. Радищева, 6А, офис 312 · ${PHONE} · ${EMAIL}`,
          "Нотариальное заверение выполняет нотариус Е. В. Ковалёва, бюро нотариальной конторой не является.",
        ],
        credits: CREDITED.map((s) => photos[s].credit),
      },
    },
  ];
}

/** Site Бюро Лаптевой: front page with the price list, second reading, prices by language, steps, people, address. */
export function BureauSite({ photos }: { photos: Photos }) {
  return (
    <div className="overflow-x-clip bg-background text-foreground">
      {bureauBlocks(photos).map((b) => (
        <BlockById key={b.id} {...b} />
      ))}
    </div>
  );
}
