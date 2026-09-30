// Checksums for card numbers (Luhn), SNILS and INN (data-boundary.yaml#detectors.kinds).

function digitsOf(s: string): number[] | null {
  if (!/^\d+$/.test(s)) return null;
  return [...s].map((c) => c.charCodeAt(0) - 48);
}

export function luhnValid(num: string): boolean {
  const d = digitsOf(num);
  if (!d || d.length < 2) return false;
  let sum = 0;
  for (let i = d.length - 1, alt = false; i >= 0; i--, alt = !alt) {
    let v = d[i] ?? 0;
    if (alt) {
      v *= 2;
      if (v > 9) v -= 9;
    }
    sum += v;
  }
  return sum % 10 === 0;
}

/** Card IIN ranges from data-boundary.yaml: Mir 2200–2204, Visa 4, MC 51–55 and 2221–2720, UnionPay 62, JCB 35. */
export function cardIinAllowed(num: string): boolean {
  if (/^(?:220[0-4]|4|5[1-5]|62|35)/.test(num)) return true;
  const p4 = Number(num.slice(0, 4));
  return p4 >= 2221 && p4 <= 2720;
}

export function isCardNumber(num: string): boolean {
  return num.length >= 13 && num.length <= 19 && cardIinAllowed(num) && luhnValid(num);
}

/** SNILS control number for the first 9 digits (as a 2-digit string). */
export function snilsControl(first9: string): string | null {
  const d = digitsOf(first9);
  if (!d || d.length !== 9) return null;
  let s = 0;
  for (let i = 0; i < 9; i++) s += (d[i] ?? 0) * (9 - i);
  let c: number;
  if (s < 100) c = s;
  else if (s === 100 || s === 101) c = 0;
  else {
    c = s % 101;
    if (c === 100) c = 0;
  }
  return String(c).padStart(2, "0");
}

/** 11 digits. Numbers ≤ 001-001-998 are not checksummed (data-boundary.yaml#detectors.kinds.snils). */
export function snilsValid(num: string): boolean {
  if (!/^\d{11}$/.test(num)) return false;
  const body = num.slice(0, 9);
  if (Number(body) <= 1001998) return true;
  return snilsControl(body) === num.slice(9);
}

const W10 = [2, 4, 10, 3, 5, 9, 4, 6, 8];
const W11 = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
const W12 = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8];

function innDigit(d: number[], w: number[]): number {
  let s = 0;
  for (let i = 0; i < w.length; i++) s += (d[i] ?? 0) * (w[i] ?? 0);
  return (s % 11) % 10;
}

/** INN of a legal entity: 10 digits. */
export function innOrgValid(num: string): boolean {
  const d = digitsOf(num);
  if (!d || d.length !== 10 || num.startsWith("00")) return false;
  return innDigit(d, W10) === d[9];
}

/** INN of a person (or sole proprietor): 12 digits. */
export function innPersonValid(num: string): boolean {
  const d = digitsOf(num);
  if (!d || d.length !== 12 || num.startsWith("00")) return false;
  return innDigit(d, W11) === d[10] && innDigit(d, W12) === d[11];
}

export function innValid(num: string): boolean {
  return num.length === 10 ? innOrgValid(num) : innPersonValid(num);
}
