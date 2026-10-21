// Стоматология «Тридцать два» (V5-09): the bar site of the direction «Чистая медицина». A fictional clinic in Nizhny
// Novgorod; the first screen is the booking with the price of the first visit, the signature is the treatment plan.
import {
  MedContacts,
  MedDoctors,
  MedFooter,
  MedHero,
  MedPlan,
  MedPrices,
  MedReviews,
} from "../../../v4/blocks/medicine/blocks.js";
import type { PhotoSlot } from "../photos.js";
import type { Photo } from "../still.js";

type Photos = Record<PhotoSlot, Photo>;

/** Mark of «Тридцать два»: a molar drawn in one line, its two roots set apart like the figures 3 and 2. */
export function ClinicMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" aria-hidden="true" className={className}>
      <path
        d="M8 9c0-4 5-5 8-3.5 2.5 1.2 5.5 1.2 8 0C27 4 32 5 32 9c0 6-2 9-3.5 12-1 2-1.5 6-2.5 12-.4 2.4-3.4 2.4-3.8 0L20.7 24c-.2-1-1.2-1-1.4 0L17.8 33c-.4 2.4-3.4 2.4-3.8 0-1-6-1.5-10-2.5-12C10 18 8 15 8 9Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const logo = (
  <span className="inline-flex items-center gap-2 font-display text-xl leading-none font-semibold">
    <ClinicMark className="size-9 text-accent-text" />
    <span>
      Тридцать два
      <span className="block text-[0.625rem] font-normal tracking-[0.14em] text-muted-foreground uppercase">
        стоматология
      </span>
    </span>
  </span>
);

const PHONE = "+7 831 214-32-32";
const PHONE_HREF = "tel:+78312143232";
const BOOK = "zapis";
const CREDITED: PhotoSlot[] = ["med-hero", "med-dr-1", "med-dr-2", "med-dr-3", "med-kid", "med-room"];

/** Site «Тридцать два»: booking first, prices without «от», the treatment plan, doctors, reviews, address. */
export function ClinicSite({ photos }: { photos: Photos }) {
  return (
    <div className="overflow-x-clip bg-background text-foreground">
      <MedHero
        content={{
          anchor: BOOK,
          header: {
            name: "Тридцать два",
            logo,
            nav: [
              { id: "ceny", label: "Цены" },
              { id: "plan", label: "План лечения" },
              { id: "vrachi", label: "Врачи" },
              { id: "otzyvy", label: "Отзывы" },
              { id: "adres", label: "Адрес" },
            ],
            phone: PHONE,
            phoneHref: PHONE_HREF,
            hours: "Пн–пт 8:00–22:00, сб–вс 9:00–21:00",
          },
          photo: photos["med-hero"],
          photoNote: "Кабинет 3. Каналы лечим под микроскопом Zeiss",
          place: "Нижний Новгород, Ванеева, 34",
          title: "Осмотр, снимок и план лечения за\u00a0900 ₽",
          days: [
            {
              id: "d0",
              label: "Сегодня",
              slots: [
                { time: "16:40", doctor: "Анна Ветрова, терапевт · кабинет 3" },
                { time: "17:20", doctor: "", taken: true },
                { time: "18:00", doctor: "Тимур Гайнуллин, хирург · кабинет 1" },
                { time: "19:20", doctor: "", taken: true },
                { time: "20:00", doctor: "Анна Ветрова, терапевт · кабинет 3" },
                { time: "21:00", doctor: "Денис Сомов, детский врач · кабинет 2" },
              ],
            },
            {
              id: "d1",
              label: "Завтра, чт",
              slots: [
                { time: "08:00", doctor: "", taken: true },
                { time: "09:40", doctor: "Анна Ветрова, терапевт · кабинет 3" },
                { time: "10:20", doctor: "Тимур Гайнуллин, хирург · кабинет 1" },
                { time: "12:00", doctor: "", taken: true },
                { time: "15:30", doctor: "Ольга Кулешова, ортодонт · кабинет 4" },
                { time: "18:40", doctor: "Денис Сомов, детский врач · кабинет 2" },
              ],
            },
            {
              id: "d2",
              label: "Пт, 23 окт",
              slots: [
                { time: "09:00", doctor: "Денис Сомов, детский врач · кабинет 2" },
                { time: "11:20", doctor: "", taken: true },
                { time: "12:00", doctor: "Ольга Кулешова, ортодонт · кабинет 4" },
                { time: "14:40", doctor: "Анна Ветрова, терапевт · кабинет 3" },
                { time: "17:00", doctor: "", taken: true },
                { time: "19:30", doctor: "Тимур Гайнуллин, хирург · кабинет 1" },
              ],
            },
          ],
          phoneLabel: "Телефон для подтверждения",
          cta: "Записаться на {time}",
          note: "Администратор перезвонит в течение 10 минут. С острой болью примем в день звонка, даже если окон нет.",
          facts: [
            { value: "4,9", label: "1 312 отзывов на ПроДокторов" },
            { value: "17 лет", label: "на Ванеева, с 2009 года" },
            { value: "2 года", label: "гарантия на пломбы и коронки" },
          ],
          footnote:
            "900 ₽ вычитаем из счёта, если лечение начато в течение 30 дней. Снимок прицельный или 3D-срез одного участка челюсти.",
        }}
      />
      <MedPrices
        content={{
          anchor: "ceny",
          title: "Цены без «от»",
          lead: "В каждой строке уже есть анестезия и контрольные снимки. Сумму лечения врач пишет в плане до начала работы.",
          cta: "Выбрать время",
          ctaHref: `#${BOOK}`,
          groups: [
            {
              title: "Диагностика",
              rows: [
                {
                  name: "Осмотр, снимок, план лечения",
                  what: "Терапевт, прицельный снимок, план с ценами",
                  price: 900,
                },
                {
                  name: "КТ одной челюсти",
                  what: "3D-снимок и описание рентгенолога за 1 день",
                  price: 2900,
                },
              ],
            },
            {
              title: "Лечение",
              rows: [
                {
                  name: "Кариес и пломба",
                  what: "Коффердам, светоотверждаемая пломба Estelite",
                  price: 5400,
                },
                {
                  name: "Пульпит, один канал",
                  what: "Под микроскопом, временная пломба, снимок после",
                  price: 7200,
                },
                {
                  name: "Коронка из циркония",
                  what: "Сканирование вместо слепков, примерка, гарантия 2 года",
                  price: 24500,
                },
              ],
            },
            {
              title: "Гигиена",
              rows: [
                {
                  name: "Чистка Air Flow и ультразвук",
                  what: "Камень, налёт, полировка и фтор, 60 минут",
                  price: 5900,
                },
              ],
            },
            {
              title: "Хирургия",
              rows: [
                { name: "Удаление зуба", what: "Осмотр через 3 дня входит в цену", price: 3200 },
                {
                  name: "Удаление зуба мудрости",
                  what: "С разрезом и швами, снятие швов через неделю",
                  price: 8500,
                },
                {
                  name: "Имплант Osstem под ключ",
                  what: "Имплант, абатмент, коронка из циркония, 2 КТ",
                  price: 62000,
                },
              ],
            },
            {
              title: "Дети",
              rows: [
                {
                  name: "Первый приём ребёнка",
                  what: "Знакомство с креслом, осмотр, советы родителям, 40 минут",
                  price: 1100,
                },
              ],
            },
          ],
        }}
      />
      <MedPlan
        content={{
          anchor: "plan",
          title: "Цена в плане до первого сверла",
          lead: "После осмотра врач печатает план: каждый зуб, каждая работа, итог. Вы подписываете его, и сумма больше не меняется.",
          points: [
            "Цена плана закреплена в договоре на 90 дней, пункт 4.2",
            "Если в кресле работы оказалось больше, разницу оплачивает клиника",
            "План отдаём на руки: его можно показать в другой клинике",
          ],
          sheet: {
            head: "План лечения № 2417",
            patient: "Е. М., 34 года · врач А. С. Ветрова",
            lines: [
              { tooth: "все", item: "Чистка Air Flow перед лечением", price: 5900 },
              { tooth: "36", item: "Кариес, пломба Estelite", price: 5400 },
              { tooth: "46", item: "Пульпит, 3 канала под микроскопом", price: 21600 },
              { tooth: "46", item: "Коронка из циркония", price: 24500 },
            ],
            totalLabel: "Итого по плану",
            stamp: "Цена зафиксирована",
          },
        }}
      />
      <MedDoctors
        content={{
          anchor: "vrachi",
          title: "Врачи и их окна",
          lead: "Запись к конкретному врачу стоит столько же, сколько к дежурному.",
          cta: "Записаться",
          ctaHref: `#${BOOK}`,
          doctors: [
            {
              name: "Анна Ветрова",
              role: "Терапевт, каналы",
              years: "14 лет",
              fact: "лечит каналы под микроскопом",
              next: "Сегодня, 16:40",
              photo: photos["med-dr-1"],
            },
            {
              name: "Тимур Гайнуллин",
              role: "Хирург-имплантолог",
              years: "11 лет",
              fact: "1 900 имплантов",
              next: "Сегодня, 18:00",
              photo: photos["med-dr-2"],
            },
            {
              name: "Ольга Кулешова",
              role: "Ортодонт",
              years: "9 лет",
              fact: "410 законченных случаев с элайнерами",
              next: "Завтра, 15:30",
              photo: photos["med-dr-3"],
            },
            {
              name: "Денис Сомов",
              role: "Детский стоматолог",
              years: "7 лет",
              fact: "лечит детей с 2 лет",
              next: "Сегодня, 21:00",
              photo: photos["med-kid"],
            },
          ],
        }}
      />
      <MedReviews
        content={{
          anchor: "otzyvy",
          title: "Отзывы",
          ratings: [
            { value: "4,9", source: "ПроДокторов, 1 312 отзывов" },
            { value: "4,9", source: "Яндекс Карты, 640 оценок" },
          ],
          items: [
            {
              name: "Екатерина М.",
              date: "Сентябрь 2026",
              doctor: "Анна Ветрова, каналы зуба 46",
              text: "Позвонила с болью в 19:30, в 20:00 уже сидела в кресле. Каналы лечили за два визита. В плане было 21 600 ₽, столько и заплатила.",
            },
            {
              name: "Игорь Т.",
              date: "Август 2026",
              doctor: "Тимур Гайнуллин, имплант 36",
              text: "Тимур Рашидович показал на КТ, где проходит нерв, и поставил имплант за 40 минут. Через четыре месяца коронка, жую на эту сторону.",
            },
            {
              name: "Марина С.",
              date: "Июль 2026",
              doctor: "Денис Сомов, кариес у сына 5 лет",
              text: "Сын впервые не плакал у врача. В первый визит 20 минут разглядывали инструменты и считали зубы, лечили уже во второй.",
            },
          ],
        }}
      />
      <MedContacts
        content={{
          anchor: "adres",
          title: "Как добраться",
          address: "Нижний Новгород, ул. Ванеева, 34",
          way: [
            "Остановка «Улица Ванеева», 2 минуты пешком",
            "Во дворе парковка на 12 машин, для пациентов бесплатно",
            "Вход с улицы по пандусу, все кабинеты на первом этаже",
          ],
          hours: [
            { days: "Понедельник – пятница", time: "8:00–22:00" },
            { days: "Суббота и воскресенье", time: "9:00–21:00" },
            { days: "Острая боль", time: "в день звонка" },
          ],
          phone: PHONE,
          phoneHref: PHONE_HREF,
          cta: "Записаться онлайн",
          ctaHref: `#${BOOK}`,
          photo: photos["med-room"],
        }}
      />
      <MedFooter
        content={{
          name: "Тридцать два",
          logo,
          warning: "Имеются противопоказания. Необходима консультация специалиста",
          legal: [
            "ООО «Тридцать два», ИНН 5262318840, ОГРН 1095262004417",
            "Лицензия на медицинскую деятельность № Л041-01126-52/00581934 от 14.04.2022, выдана Министерством здравоохранения Нижегородской области",
            `Нижний Новгород, ул. Ванеева, 34 · ${PHONE}`,
          ],
          credits: CREDITED.map((s) => photos[s].credit),
        }}
      />
    </div>
  );
}
