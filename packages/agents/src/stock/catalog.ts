// V4-10 (D79 (6)): niches of the semantic photo library. CI (tools/stock/fill.mjs) fills every niche from Pexels and
// Pixabay with its English queries (stocks index English best) into one shard of the library; a build never looks a
// niche up here — it searches all shards by the meaning of the brief (semantic.ts). Order is priority: the niches of
// the flagship class «сайт + заявки/запись» (services, repair, medicine, beauty, education, food, travel, crafts) first,
// so a run that stops at its budget has filled them; the next run goes on where it stopped.

export interface CatalogNiche {
  /** Shard key: lower-case latin, digits and dashes. */
  slug: string;
  /** Russian name, as an owner would call the business. */
  name: string;
  /** Stock search queries (English): the place, people at work, details, the result for the client. */
  queries: readonly string[];
  /** V4-30: the group of neighbouring niches (a site's photos may mix shards of one group only). */
  group: string;
  /** V4-32: photos the shard holds, when not NICHE_TARGET (catalog rows its first queries did not cover). */
  target?: number;
}

/** Photos one niche shard holds at most (≈ 100 niches → 20–30 thousand photos). */
export const NICHE_TARGET = 260;

const n = (slug: string, name: string, ...queries: string[]): Omit<CatalogNiche, "group"> => ({
  slug,
  name,
  queries,
});
/** V4-32: a niche whose catalog rows needed more queries — room for their photos in a full shard. */
const WIDE_TARGET = 310;
const wide = (c: Omit<CatalogNiche, "group">): Omit<CatalogNiche, "group"> => ({ ...c, target: WIDE_TARGET });
const group = (name: string, list: Omit<CatalogNiche, "group">[]): CatalogNiche[] =>
  list.map((c) => ({ ...c, group: name }));

/** The catalog in fill order. */
export const CATALOG: readonly CatalogNiche[] = [
  // Services with requests and booking: medicine and care.
  ...group("care", [
    n(
      "dental",
      "стоматология",
      "dental clinic",
      "dentist with patient",
      "dental care",
      "smiling woman white teeth",
      "dental office interior",
    ),
    n(
      "medical",
      "медицинская клиника",
      "medical clinic",
      "doctor consultation",
      "medical office",
      "nurse with patient",
      "clinic reception",
    ),
    n(
      "psychologist",
      "психолог",
      "therapy session",
      "psychologist office",
      "calm therapy room",
      "counseling conversation",
      "woman talking therapist",
    ),
    n(
      "massage",
      "массаж",
      "massage therapist",
      "massage spa",
      "back massage",
      "spa stones towels",
      "relaxing spa room",
    ),
    n(
      "cosmetology",
      "косметология",
      "cosmetologist",
      "facial treatment",
      "skincare procedure",
      "skincare cosmetics",
      "beauty clinic",
    ),
    n(
      "lab",
      "медицинские анализы",
      "medical laboratory",
      "blood test",
      "lab technician",
      "test tubes laboratory",
    ),
    // V4-32: «Контактные линзы», «Очки» (the frames display is mostly brand text).
    wide(
      n(
        "optics",
        "оптика",
        "optician",
        "eyeglasses store",
        "eye exam",
        "glasses frames display",
        "contact lenses",
        "putting in contact lens",
        "eyeglasses on table",
        "trying on glasses",
      ),
    ),
    n(
      "physio",
      "реабилитация и ЛФК",
      "physiotherapy",
      "rehabilitation exercise",
      "physical therapist knee",
      "sports medicine",
    ),
    n("pharmacy", "аптека", "pharmacy", "pharmacist", "medicine shelves", "pills close up"),
  ]),
  // Beauty.
  ...group("beauty", [
    // V4-32: «Детская стрижка».
    wide(
      n(
        "barber",
        "барбершоп",
        "barber shop",
        "barber at work",
        "beard trim",
        "barber tools",
        "men haircut",
        "kid haircut barbershop",
      ),
    ),
    n(
      "hair",
      "парикмахерская",
      "hair salon",
      "hairdresser at work",
      "hair coloring",
      "hair styling",
      "salon chair mirror",
    ),
    n(
      "nails",
      "маникюр и педикюр",
      "nail salon",
      "manicure master",
      "manicure close up",
      "pedicure",
      "nail polish colors",
    ),
    n("brows", "брови и ресницы", "eyebrow shaping", "eyelash extension", "lash artist", "makeup artist"),
    n(
      "beauty",
      "салон красоты",
      "beauty salon",
      "beautician at work",
      "beauty salon interior",
      "woman beauty treatment",
    ),
    n("tattoo", "тату-салон", "tattoo artist", "tattoo studio", "tattoo machine close up", "tattooed arm"),
  ]),
  // Sport and wellbeing.
  ...group("sport", [
    n(
      "fitness",
      "фитнес-клуб",
      "fitness gym",
      "personal trainer",
      "gym equipment",
      "workout class",
      "woman lifting weights",
    ),
    n("yoga", "студия йоги", "yoga studio", "yoga class", "yoga mat", "meditation", "pilates class"),
    n(
      "dance",
      "школа танцев",
      "dance studio",
      "dance class",
      // V4-30: the styles a school teaches, not ballet only («Сальса» and «Хип-хоп» cards showed ballet).
      "salsa dancing couple",
      "hip hop dance class",
      "ballroom dancing",
      "contemporary dance",
      "kids dance class",
    ),
    n("pool", "бассейн и плавание", "swimming pool", "swimming lesson", "kids swimming", "pool water"),
    n("martial", "единоборства", "boxing training", "martial arts class", "kids karate", "boxing gloves"),
    n(
      "kids-sport",
      "детский спорт",
      "kids sports",
      "children football",
      "kids gymnastics",
      "coach with kids",
    ),
  ]),
  // Education.
  ...group("education", [
    n(
      "kids-center",
      "детский развивающий центр",
      "kids learning",
      "children playing educational",
      "kindergarten classroom",
      "kids drawing",
      "toddler playing blocks",
    ),
    wide(
      n(
        "languages",
        "курсы иностранных языков",
        "language class",
        "english lesson",
        "students classroom",
        "online tutoring",
        "books and notebook",
        // V4-32: «Английский для взрослых».
        "adult language class",
      ),
    ),
    n("tutor", "репетитор", "tutor with student", "homework help", "math lesson", "student studying"),
    n(
      "music",
      "музыкальная школа",
      "music lesson",
      "piano lesson",
      "guitar lesson",
      "vocal studio",
      "musical instruments",
    ),
    n(
      "art-school",
      "художественная студия",
      "art class",
      "painting class",
      "art studio",
      "paint brushes palette",
    ),
    n(
      "courses",
      "онлайн-курсы и тренинги",
      "online course",
      "workshop training",
      "business seminar",
      "laptop learning",
    ),
    // V4-32: «Теория».
    wide(
      n(
        "driving",
        "автошкола",
        "driving lesson",
        "driving instructor",
        "learner driver car",
        "steering wheel",
        "driving theory class",
      ),
    ),
    n(
      "coding-kids",
      "программирование для детей",
      "kids coding",
      "robotics class",
      "children computer class",
      "lego robot",
    ),
  ]),
  // Repair and home services.
  ...group("home", [
    wide(
      n(
        "cleaning",
        "клининг",
        "house cleaning",
        "cleaning service",
        "cleaner mopping floor",
        "cleaning supplies",
        "clean bright kitchen",
        // V4-32: «Уборка после ремонта».
        "post renovation cleaning",
        "cleaner vacuum dust",
      ),
    ),
    n(
      "renovation",
      "ремонт квартир",
      "apartment renovation",
      "painting walls",
      "renovation worker",
      "tiling bathroom",
      "new renovated apartment",
    ),
    n(
      "aircon",
      "монтаж кондиционеров",
      "air conditioner installation",
      "hvac technician",
      "air conditioner on wall",
      "split system indoor unit",
      "air conditioner repair",
    ),
    // V4-30: a plumber at home (bathroom, kitchen), not industrial pipelines («plumber at work» found gas mains).
    wide(
      n(
        "plumbing",
        "сантехник",
        "plumber fixing kitchen sink",
        "plumber in bathroom",
        "bathroom faucet",
        "toilet installation",
        "shower installation",
        // V4-32: «Прочистка труб».
        "clogged sink plunger",
        "drain cleaning",
      ),
    ),
    n(
      "electric",
      "электрик",
      "electrician at work",
      "electrical wiring",
      "electric panel",
      "light installation",
    ),
    n(
      "windows",
      "окна и двери",
      "window installation",
      "plastic windows",
      "new door installation",
      "bright window interior",
    ),
    n(
      "furniture",
      "мебель на заказ",
      "custom furniture",
      "carpenter workshop",
      "kitchen cabinets",
      "wood furniture making",
      "modern kitchen interior",
    ),
    n(
      "interior",
      "дизайн интерьера",
      "interior design",
      "modern living room",
      "interior designer",
      "cozy bedroom",
      "scandinavian interior",
    ),
    n(
      "construction",
      "строительство домов",
      "house construction",
      "builders on site",
      "wooden frame house",
      "new country house",
      "construction crew",
    ),
    n("roofing", "кровля и фасады", "roof installation", "roofer at work", "house facade", "metal roof"),
    n(
      "landscape",
      "ландшафтный дизайн",
      "landscape design",
      "garden landscaping",
      "lawn care",
      "gardener planting",
      "beautiful backyard garden",
    ),
    n(
      "appliance",
      "ремонт бытовой техники",
      "appliance repair",
      "washing machine repair",
      "technician fixing fridge",
      "repair tools",
    ),
    n(
      "phone-repair",
      "ремонт телефонов",
      "phone repair",
      "smartphone screen replacement",
      "electronics repair",
      "laptop repair",
    ),
    n("pest", "дезинсекция", "pest control", "exterminator spraying", "clean home protection"),
    n(
      "moving",
      "грузоперевозки и переезды",
      "moving company",
      "movers carrying boxes",
      "moving truck",
      "cardboard boxes",
    ),
    n("locksmith", "ремонт и изготовление ключей", "locksmith", "door lock", "keys close up"),
  ]),
  // Auto.
  ...group("auto", [
    n(
      "autoservice",
      "автосервис",
      "car mechanic",
      "auto repair shop",
      "car service garage",
      "mechanic tools",
      "car on lift",
    ),
    n("carwash", "автомойка и детейлинг", "car wash", "car detailing", "polishing car", "clean shiny car"),
    n("tires", "шиномонтаж", "tire change", "tire service", "car wheels", "tire shop"),
    n(
      "car-rental",
      "прокат автомобилей",
      "car rental",
      "car keys handover",
      "car on the road",
      "road trip car",
    ),
  ]),
  // Professional services.
  ...group("professional", [
    n(
      "legal",
      "юридические услуги",
      "lawyer office",
      "legal consultation",
      "signing contract",
      "law books",
      "business meeting handshake",
    ),
    n(
      "accounting",
      "бухгалтерские услуги",
      "accountant at work",
      "financial documents",
      "tax consultation",
      "calculator and documents",
      "small business owner laptop",
    ),
    n(
      "realty",
      "агентство недвижимости",
      "real estate agent",
      "apartment viewing",
      "house keys",
      "modern apartment building",
      "new home couple",
    ),
    n(
      "insurance",
      "страхование",
      "insurance consultation",
      "family protection",
      "car insurance agent",
      "documents signing",
    ),
    n(
      "marketing",
      "маркетинговое агентство",
      "marketing team",
      "creative agency office",
      "brainstorming",
      "digital marketing laptop",
    ),
    n(
      "it-services",
      "IT-услуги и разработка",
      "software developers",
      "programmer at work",
      "it support",
      "server room",
      "team coding",
    ),
    n("translation", "бюро переводов", "translator at work", "documents translation", "dictionary books"),
    n("coworking", "коворкинг", "coworking space", "open office", "meeting room", "people working laptops"),
    n("printing", "типография", "printing house", "printed materials", "business cards", "printing press"),
    n(
      "photographer",
      "фотограф и фотосессии",
      "photographer",
      "photo studio",
      "photoshoot",
      "camera lens",
      "portrait session",
    ),
    n("video", "видеосъёмка и монтаж", "videographer", "video production", "film crew", "video editing"),
  ]),
  // Events.
  ...group("events", [
    n(
      "wedding",
      "свадьбы и праздники",
      "wedding ceremony",
      "wedding decor",
      "bride and groom",
      "wedding table setting",
      "event planner",
    ),
    n(
      "events",
      "организация мероприятий",
      "event venue",
      "corporate party",
      "conference hall",
      "party decorations",
      "festive celebration",
    ),
    n(
      "kids-party",
      "детские праздники",
      "kids birthday party",
      "balloons party",
      "children celebrating",
      "party animator",
    ),
    n("catering", "кейтеринг", "catering service", "buffet table", "waiter serving", "banquet food"),
  ]),
  // Food and drink.
  ...group("food", [
    n("cafe", "кофейня", "coffee shop", "barista", "latte art", "cafe interior", "coffee cup"),
    n("bakery", "пекарня", "bakery", "fresh bread", "baker at work", "pastries display", "croissants"),
    n(
      "restaurant",
      "ресторан",
      "restaurant interior",
      "chef cooking",
      "plated dish",
      "restaurant dinner",
      "wine glasses table",
    ),
    n("pizza", "пиццерия", "pizza", "pizzeria oven", "pizza chef", "pizza slice"),
    // V4-32: «Супы».
    wide(
      n(
        "sushi",
        "суши и роллы",
        "sushi",
        "sushi chef",
        "japanese food",
        "sushi rolls set",
        "miso soup",
        "ramen bowl",
      ),
    ),
    n(
      "confectionery",
      "кондитерская и торты на заказ",
      "cake",
      "pastry chef",
      "birthday cake",
      "desserts",
      "cupcakes",
    ),
    n("delivery", "доставка еды", "food delivery", "courier with bag", "takeaway food boxes", "home dinner"),
    n("bar", "бар", "bar interior", "bartender", "cocktail", "craft beer"),
    n("canteen", "столовая и бизнес-ланчи", "canteen", "lunch tray", "business lunch", "soup bowl"),
    n(
      "coffee-roast",
      "обжарка кофе",
      "coffee roasting",
      "coffee beans",
      "coffee roaster machine",
      "coffee bag",
    ),
    n("tea-honey", "чай и мёд", "tea ceremony", "loose leaf tea", "honey jar", "tea cup"),
    n(
      "farm",
      "фермерские продукты",
      "farm products",
      "fresh vegetables",
      "farmer market",
      "dairy farm",
      "farmer in field",
    ),
  ]),
  // Travel and leisure.
  ...group("travel", [
    n(
      "travel",
      "туры и путешествия",
      "travel",
      "tourists sightseeing",
      "mountain landscape",
      "beach vacation",
      "travel agency",
    ),
    n(
      "active-tours",
      "активные туры и сплавы",
      "rafting",
      "hiking group",
      "kayaking",
      "camping tent",
      "mountain hiking",
    ),
    n(
      "hotel",
      "гостиница и посуточная аренда",
      "hotel room",
      "hotel reception",
      "cozy apartment",
      "guest house",
    ),
    n("glamping", "глэмпинг и базы отдыха", "glamping", "cabin in the woods", "lake house", "campfire"),
    n("excursions", "экскурсии", "city tour guide", "excursion group", "historic architecture", "city walk"),
    n("rental-gear", "прокат снаряжения", "equipment rental", "ski rental", "bike rental", "sup board"),
    n("quest", "квесты и развлечения", "escape room", "friends having fun", "bowling", "game night"),
    n("bath", "баня и сауна", "sauna", "russian bath", "wooden sauna interior", "spa relax"),
  ]),
  // Crafts and creative.
  ...group("crafts", [
    n(
      "ceramics",
      "керамическая мастерская",
      "pottery",
      "ceramic workshop",
      "potter wheel",
      "handmade ceramics",
    ),
    n(
      "handmade",
      "изделия ручной работы",
      "handmade crafts",
      "artisan workshop",
      "handmade jewelry",
      "craft market",
    ),
    n("sewing", "ателье и пошив", "tailor", "sewing machine", "dressmaker", "fabric rolls"),
    n(
      "florist",
      "цветочный магазин",
      "flower shop",
      "florist",
      "bouquet",
      "flowers close up",
      "flower arrangement",
    ),
    n("woodwork", "столярная мастерская", "woodworking", "carpenter", "wood workshop", "wooden products"),
    n("jewelry", "ювелирная мастерская", "jewelry", "jeweler at work", "rings", "jewelry store"),
    n("leather", "изделия из кожи", "leather goods", "leather workshop", "leather bag", "leather wallet"),
    n(
      "candles",
      "свечи и мыло ручной работы",
      "handmade candles",
      "handmade soap",
      "aromatherapy",
      "cozy candles",
    ),
  ]),
  // Pets.
  ...group("pets", [
    n(
      "vet",
      "ветеринарная клиника",
      "veterinary clinic",
      "vet with dog",
      "veterinarian cat",
      "pet grooming",
      "happy dog owner",
    ),
    n("grooming", "груминг", "dog grooming", "pet salon", "groomer with dog", "cute puppy"),
    n("pet-hotel", "зоогостиница и дрессировка", "dog training", "dog trainer", "dog walking", "pet hotel"),
  ]),
  // Other services.
  ...group("other", [
    n("dry-cleaning", "химчистка", "dry cleaning", "laundry", "ironing clothes", "clean clothes"),
    n(
      "security",
      "охрана и видеонаблюдение",
      "security camera",
      "cctv installation",
      "security guard",
      "alarm system",
    ),
    n(
      "solar",
      "солнечные панели и энергосбережение",
      "solar panels",
      "solar installation",
      "home heating",
      "heat pump",
    ),
  ]),
  // Shops.
  ...group("shops", [
    n(
      "clothing",
      "магазин одежды",
      "clothing store",
      "fashion boutique",
      "clothes rack",
      "woman shopping",
      "fashion model",
    ),
    n("kids-store", "детские товары", "kids clothes", "baby products", "toys store", "children toys"),
    n(
      "cosmetics-store",
      "магазин косметики",
      "cosmetics store",
      "makeup products",
      "skincare products",
      "perfume bottles",
    ),
    n("electronics", "магазин электроники", "electronics store", "gadgets", "headphones", "smartphone"),
    n("sport-store", "спорттовары", "sports store", "sports equipment", "running shoes", "bicycle"),
    n("books", "книжный магазин", "bookstore", "books shelves", "reading book", "cozy reading"),
    n("home-goods", "товары для дома", "home decor", "kitchenware", "home textiles", "cozy home"),
    n("garden-store", "товары для сада", "garden tools", "plant nursery", "potted plants", "seedlings"),
    n("pet-store", "зоомагазин", "pet store", "pet food", "dog toys", "cat with owner"),
    n("auto-parts", "автозапчасти", "auto parts", "car parts store", "engine parts", "car battery"),
    n(
      "building-materials",
      "стройматериалы",
      "building materials",
      "hardware store",
      "lumber",
      "construction tools",
    ),
    n(
      "shop",
      "магазин",
      "retail store",
      "shop interior",
      "shopping bags",
      "online shopping",
      "small business owner",
    ),
  ]),
  // Generic: people, teams, the client's result.
  ...group("generic", [
    n(
      "team",
      "команда и офис",
      "business team",
      "office meeting",
      "happy client",
      "customer service",
      "small business owner smiling",
    ),
  ]),
];

/** A niche by slug. */
export const catalogNiche = (slug: string): CatalogNiche | undefined => CATALOG.find((c) => c.slug === slug);

/** V4-30: the group of generic shards (people, teams): the photos of a niche the library lacks. */
export const GENERIC_GROUP = "generic";

/** Word stems of a text (words of 5+ letters, their first 5): «Маникюр и педикюр» → маник, педик. */
export const nicheStems = (text: string): Set<string> =>
  new Set(
    (
      text
        .toLowerCase()
        .replace(/ё/g, "е")
        .match(/[а-я]{5,}/g) ?? []
    ).map((w) => w.slice(0, 5)),
  );

/** Words of a niche text (4+ letters, lower case, «ё» as «е»). */
const nicheWords = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/ё/g, "е")
    .match(/[а-я]{4,}/g) ?? [];

/**
 * Two forms of one word: equal, or the same up to the last letter of the shorter one («оптика» — «оптики», «массаж» —
 * «массажный»), never two words that only start alike («клининг» — «клиника»).
 */
const sameWord = (a: string, b: string): boolean => {
  const k = Math.min(a.length, b.length) - 1;
  return a === b || (k >= 4 && a.slice(0, k) === b.slice(0, k));
};

/**
 * V4-30: the catalog niches a site's niche names — every word of the niche's name is in the text («ветеринарная
 * клиника» → vet, «клининг квартир» → cleaning, «клиника» → none); the most specific names win. SigLIP ranks a Russian
 * query near a neighbour's photos (a vet clinic's near a human clinic), so a niche the catalog names takes its own shard.
 */
export function ownNiches(text: string): CatalogNiche[] {
  const own = nicheWords(text);
  const hits = CATALOG.map((c) => ({ c, words: nicheWords(c.name) })).filter(
    (x) => x.words.length > 0 && x.words.every((w) => own.some((o) => sameWord(w, o))),
  );
  const most = Math.max(0, ...hits.map((x) => x.words.length));
  return hits.filter((x) => x.words.length === most).map((x) => x.c);
}

/**
 * Slug of a requested niche (backfill, tools/stock): `req-` and a hash of its normalized text, so the same request maps
 * to the same shard and never collides with a catalog slug.
 */
export function requestSlug(text: string): string {
  let h = 2166136261;
  for (const ch of normalizeNicheText(text)) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `req-${h.toString(36)}`;
}

/** A niche text as a request key: lower case, «ё» as «е», single spaces, at most 80 characters. */
export const normalizeNicheText = (text: string): string =>
  text.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim().slice(0, 80);
