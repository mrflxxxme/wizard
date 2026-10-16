// Stock photos of the bar sites (grill-11 (3), D61): Pexels License, author credit kept next to each copy.
// The build downloads cdnUrl (w=1600) and fills the Photo slots of the sites; no gradient placeholders.

export type StockPhoto = {
  file: string;
  provider: "pexels";
  id: string;
  author: string;
  pageUrl: string;
  cdnUrl: string;
  alt: string;
};

export const BAR_PHOTOS = {
  "bakery-loaves": {
    file: "bakery-1.jpg",
    provider: "pexels",
    id: "38699007",
    author: "Feyza Daştan",
    pageUrl: "https://www.pexels.com/photo/artisanal-bread-dough-with-score-patterns-38699007/",
    cdnUrl: "https://images.pexels.com/photos/38699007/pexels-photo-38699007.jpeg?auto=compress&cs=tinysrgb",
    alt: "Два круглых хлеба на закваске с рисунком надрезов в виде колоса на листах пергамента, рядом ситечко с мукой на деревянном столе",
  },
  "bakery-hands": {
    file: "bakery-2.jpg",
    provider: "pexels",
    id: "10009357",
    author: "Skyler Ewing",
    pageUrl: "https://www.pexels.com/photo/person-holding-a-dough-10009357/",
    cdnUrl: "https://images.pexels.com/photos/10009357/pexels-photo-10009357.jpeg?auto=compress&cs=tinysrgb",
    alt: "Руки пекаря формуют кусок теста на густо присыпанном мукой столе, рядом лежит вторая заготовка",
  },
  "bakery-oven": {
    file: "bakery-3.jpg",
    provider: "pexels",
    id: "10481790",
    author: "Chris F",
    pageUrl: "https://www.pexels.com/photo/brown-breads-in-the-oven-10481790/",
    cdnUrl: "https://images.pexels.com/photos/10481790/pexels-photo-10481790.jpeg?auto=compress&cs=tinysrgb",
    alt: "Румяные буханки хлеба на полках в многоярусной подовой печи, тёплый свет внутри",
  },
  "bakery-shelves": {
    file: "bakery-4.jpg",
    provider: "pexels",
    id: "30884563",
    author: "Travel with Lenses",
    pageUrl: "https://www.pexels.com/photo/assorted-artisan-bread-display-in-berlin-bakery-30884563/",
    cdnUrl: "https://images.pexels.com/photos/30884563/pexels-photo-30884563.jpeg?auto=compress&cs=tinysrgb",
    alt: "Круглые ремесленные хлебы с надрезами на деревянных полках и ящики с булочками",
  },
  "bakery-buns": {
    file: "bakery-5.jpg",
    provider: "pexels",
    id: "39432439",
    author: "Tanita Lupa",
    pageUrl: "https://www.pexels.com/photo/freshly-baked-cinnamon-rolls-on-tray-39432439/",
    cdnUrl: "https://images.pexels.com/photos/39432439/pexels-photo-39432439.jpeg?auto=compress&cs=tinysrgb",
    alt: "Противень с только что испечёнными булочками с корицей, выложенными ровными рядами на пергаменте, вид сверху",
  },
  "bakery-baskets": {
    file: "bakery-6.jpg",
    provider: "pexels",
    id: "14242070",
    author: "Jonathan Borba",
    pageUrl: "https://www.pexels.com/photo/brown-wooden-round-container-on-brown-wooden-table-14242070/",
    cdnUrl: "https://images.pexels.com/photos/14242070/pexels-photo-14242070.jpeg?auto=compress&cs=tinysrgb",
    alt: "Плетёные корзины для расстойки (баннетоны), присыпанные мукой, на тёмной столешнице пекарни",
  },
  "service-under-car": {
    file: "service-1.jpg",
    provider: "pexels",
    id: "7019602",
    author: "cottonbro studio",
    pageUrl:
      "https://www.pexels.com/photo/a-man-holding-a-light-checking-the-underbody-of-a-vehicle-7019602/",
    cdnUrl: "https://images.pexels.com/photos/7019602/pexels-photo-7019602.jpeg?auto=compress&cs=tinysrgb",
    alt: "Механик с переносной лампой осматривает днище автомобиля на подъёмнике в полутёмной мастерской",
  },
  "service-engine": {
    file: "service-2.jpg",
    provider: "pexels",
    id: "36742923",
    author: "Jan Wright",
    pageUrl: "https://www.pexels.com/photo/close-up-of-car-engine-compartment-36742923/",
    cdnUrl: "https://images.pexels.com/photos/36742923/pexels-photo-36742923.jpeg?auto=compress&cs=tinysrgb",
    alt: "Подкапотное пространство автомобиля с открытым капотом, крупным планом двигатель под пластиковой крышкой",
  },
  "service-brakes": {
    file: "service-3.jpg",
    provider: "pexels",
    id: "34277926",
    author: "Erik Mclean",
    pageUrl: "https://www.pexels.com/photo/close-up-of-car-brake-caliper-and-disc-34277926/",
    cdnUrl: "https://images.pexels.com/photos/34277926/pexels-photo-34277926.jpeg?auto=compress&cs=tinysrgb",
    alt: "Крупный план тормозного диска с перфорацией и суппорта, снятых с автомобиля в мастерской",
  },
  "service-tools": {
    file: "service-4.jpg",
    provider: "pexels",
    id: "7019599",
    author: "cottonbro studio",
    pageUrl: "https://www.pexels.com/photo/photograph-of-wrenches-near-a-yellow-screwdriver-7019599/",
    cdnUrl: "https://images.pexels.com/photos/7019599/pexels-photo-7019599.jpeg?auto=compress&cs=tinysrgb",
    alt: "Набор гаечных ключей и отвёртка с жёлтой ручкой в тёмной мастерской, размытые лампы на фоне",
  },
  "service-lift": {
    file: "service-5.jpg",
    provider: "pexels",
    id: "29198156",
    author: "Mathias Reding",
    pageUrl: "https://www.pexels.com/photo/vintage-car-on-lift-in-auto-repair-shop-29198156/",
    cdnUrl: "https://images.pexels.com/photos/29198156/pexels-photo-29198156.jpeg?auto=compress&cs=tinysrgb",
    alt: "Старый седан, поднятый на двухстоечном подъёмнике в мастерской, снято снизу в приглушённом свете",
  },
} as const satisfies Record<string, StockPhoto>;

export type PhotoSlot = keyof typeof BAR_PHOTOS;
