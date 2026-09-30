// 50 canary rows for import tests (data-boundary.yaml#import.test): unique names (Cyrillic, non-Slavic, Latin),
// phones (RU and not RU), emails and handles, generated deterministically.
import type { Cell } from "../src/import/index.js";

const FIRST = [
  "Всеволод",
  "Агния",
  "Джахонгир",
  "Зульфия",
  "Ростислав",
  "Милена",
  "Ашот",
  "Гульнара",
  "Emily",
  "Oliver",
];
const LAST = [
  "Кривошеин",
  "Белозерова",
  "Рахимов",
  "Абдуллаева",
  "Задонский",
  "Ветрова",
  "Саркисян",
  "Хабибуллина",
  "Pemberton",
  "Whitaker",
];

export interface CanaryRow {
  name: string;
  phone: string;
  email: string;
  city: string;
  amount: number;
  note: string;
}

export function canaryRows(n = 50): CanaryRow[] {
  const rows: CanaryRow[] = [];
  for (let i = 0; i < n; i++) {
    const first = FIRST[i % FIRST.length] as string;
    const last = LAST[(i * 3 + Math.floor(i / 10)) % LAST.length] as string;
    const d = String(1000 + i * 37).padStart(4, "0");
    rows.push({
      name: `${last} ${first}`,
      phone:
        i % 5 === 4
          ? `+375 29 7${d.slice(0, 2)}-${d.slice(2)}-${String(10 + i)}`
          : `+7 916 5${d.slice(0, 2)}-${d.slice(2)}-${String(10 + i)}`,
      email: `canary.${i}.${d}@kanareyka-test.ru`,
      city: ["Казань", "Тверь", "Омск", "Сочи", "Пермь"][i % 5] as string,
      amount: 1000 + i * 131,
      note: `Постоянный клиент, пишет в телеграм @canary_user_${d}`,
    });
  }
  return rows;
}

export const CANARY_HEADER = ["ФИО клиента", "Телефон", "Почта", "Город", "Сумма заказа", "Комментарий"];

export function canaryGrid(rows: readonly CanaryRow[]): Cell[][] {
  return [CANARY_HEADER, ...rows.map((r) => [r.name, r.phone, r.email, r.city, r.amount, r.note])];
}

/** Every distinctive canary string: full values and their distinctive parts. */
export function canaryNeedles(rows: readonly CanaryRow[]): string[] {
  const out = new Set<string>();
  for (const r of rows) {
    out.add(r.name);
    for (const part of r.name.split(" ")) out.add(part);
    out.add(r.phone);
    out.add(r.phone.replace(/\D/g, ""));
    out.add(r.email);
    out.add(r.email.split("@")[0] as string);
    out.add(r.note);
    out.add(r.note.split("@")[1] as string);
  }
  out.add("kanareyka-test");
  return [...out];
}
