// Name dictionary (data/names.ru.txt → names.data.ts) with case forms generated at load time.
import { NAMES_DATA } from "./names.data.js";
import { fold } from "./util.js";

export interface NameInfo {
  /** Needs a surname or patronymic next to it (Вера, Роман, Лев…). */
  ambiguous: boolean;
  latin: boolean;
}

export interface NameDict {
  names: Map<string, NameInfo>;
  surnames: Set<string>;
}

const VOWELS = /[аеёиоуыэюя]$/;

/** Russian case forms of a given name (nominative included). Over-generation is harmless: forms are only looked up. */
export function caseForms(lemma: string, gender: string): string[] {
  const l = lemma;
  const stem1 = l.slice(0, -1);
  const add = (stem: string, ends: string[]) => ends.map((e) => stem + e);
  if (/ия$/.test(l)) return add(stem1, ["я", "и", "ю", "ей", "е"]);
  if (/я$/.test(l)) return add(stem1, ["я", "и", "е", "ю", "ей", "ею", "ёй"]);
  if (/а$/.test(l)) return add(stem1, ["а", "ы", "и", "е", "у", "ой", "ей", "ою"]);
  if (/ий$/.test(l)) return add(stem1, ["й", "я", "ю", "ем", "и", "е"]);
  if (/й$/.test(l)) return add(stem1, ["й", "я", "ю", "ем", "е"]);
  if (/ь$/.test(l)) return gender === "f" ? add(stem1, ["ь", "и", "ью"]) : add(stem1, ["ь", "я", "ю", "ем", "е"]);
  if (/о$/.test(l)) return gender === "m" ? add(stem1, ["о", "а", "у", "ом", "е"]) : [l];
  if (VOWELS.test(l) || gender === "f") return [l]; // indeclinable (Нелли, Алсу) or feminine consonant (Жасмин)
  return add(l, ["", "а", "у", "ом", "е", "ем", "ым"]);
}

function build(): NameDict {
  const names = new Map<string, NameInfo>();
  const surnames = new Set<string>();
  const put = (form: string, info: NameInfo) => {
    const key = fold(form);
    const prev = names.get(key);
    // A form is ambiguous only if every lemma producing it is ambiguous (Яна vs genitive of Ян).
    if (prev) prev.ambiguous &&= info.ambiguous;
    else names.set(key, { ...info });
  };
  for (const line of NAMES_DATA.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const [form = "", flags = "", extra = ""] = line.split("\t");
    const gender = flags.includes("m") ? "m" : flags.includes("f") ? "f" : "u";
    if (flags.includes("s")) {
      for (const f of caseForms(form, "m")) surnames.add(fold(f));
      continue;
    }
    if (flags.includes("l")) {
      put(form, { ambiguous: true, latin: true });
      continue;
    }
    const info: NameInfo = { ambiguous: flags.includes("a"), latin: false };
    const forms = extra ? [form, ...extra.split(" ")] : caseForms(form, gender === "u" ? "f" : gender);
    for (const f of forms) put(f, info);
  }
  return { names, surnames };
}

let cached: NameDict | null = null;

export function nameDict(): NameDict {
  cached ??= build();
  return cached;
}
