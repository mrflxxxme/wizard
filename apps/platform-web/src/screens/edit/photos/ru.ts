// Texts of the photos of a system (V4-16): plain Russian (D48).

export const photosRu = {
  network: "Нет связи с платформой. Проверьте интернет и попробуйте ещё раз.",
  title: "Другое фото",
  search: "Найти фото",
  searchPlaceholder: "Например: улыбка врача, уютный кабинет",
  searchButton: "Найти",
  loading: "Подбираю фото по смыслу этого места…",
  none: "Ничего не нашлось — попробуйте другие слова.",
  own: "Ваше фото",
  current: "Сейчас на сайте",
  upload: "Загрузить своё",
  uploading: "Загружаю…",
  uploadHint: "JPEG, PNG или HEIC до 15 МБ. Фото останется только в вашей системе.",
  tooLarge: "Фото больше 15 МБ — уменьшите его и загрузите снова.",
  heic: "Этот браузер не открывает HEIC — сохраните фото как JPEG и загрузите снова.",
  applied: (sec: string) => `Фото заменено за ${sec} с`,
  alt: (n: number, author?: string) => (author ? `Фото ${n}, автор ${author}` : `Фото ${n}`),
} as const;
