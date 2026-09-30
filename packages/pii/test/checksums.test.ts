import { describe, expect, test } from "vitest";
import {
  cardIinAllowed,
  innOrgValid,
  innPersonValid,
  isCardNumber,
  luhnValid,
  ogrnipValid,
  snilsControl,
  snilsValid,
} from "../src/index.js";
import { mutateDigit } from "./helpers.js";

describe("Luhn / card", () => {
  const valid = [
    "4111111111111111", // Visa 16
    "4222222222222", // Visa 13
    "5555555555554444", // MC 55
    "2221000000000009", // MC 2221–2720
    "2200000000000004", // Mir
    "6200000000000005", // UnionPay
    "3530111333300000", // JCB
    "4000000000000000006", // Visa 19
  ];
  test.each(valid)("%s is a card", (n) => {
    expect(luhnValid(n)).toBe(true);
    expect(isCardNumber(n)).toBe(true);
  });
  test.each(valid)("%s with any single changed digit fails Luhn", (n) => {
    for (let i = 0; i < n.length; i++) expect(luhnValid(mutateDigit(n, i))).toBe(false);
  });
  test("IIN outside the spec list is not a card (Amex, Maestro 50, 2721)", () => {
    expect(luhnValid("378282246310005")).toBe(true);
    expect(isCardNumber("378282246310005")).toBe(false);
    expect(cardIinAllowed("5018000000000000")).toBe(false);
    expect(cardIinAllowed("2721000000000000")).toBe(false);
    expect(cardIinAllowed("2720990000000000")).toBe(true);
    expect(cardIinAllowed("2205000000000000")).toBe(false);
  });
  test("length bounds 13–19 and non-digits", () => {
    expect(isCardNumber("411111111111")).toBe(false);
    expect(isCardNumber("41111111111111111111")).toBe(false);
    expect(luhnValid("4111 1111 1111 1111")).toBe(false);
    expect(luhnValid("")).toBe(false);
  });
});

/** Test-local SNILS sum, to hit every branch of the control-number rule. */
function snilsSum(body: string): number {
  let s = 0;
  for (let i = 0; i < 9; i++) s += Number(body[i]) * (9 - i);
  return s;
}
function findBody(pred: (s: number) => boolean): string {
  for (let n = 1_002_000; n < 999_999_999; n += 7919) {
    const body = String(n).padStart(9, "0");
    if (pred(snilsSum(body))) return body;
  }
  throw new Error("no body");
}

describe("SNILS", () => {
  test("canonical example 112-233-445 95", () => {
    expect(snilsValid("11223344595")).toBe(true);
    expect(snilsValid("11223344596")).toBe(false);
    expect(snilsValid(mutateDigit("11223344595", 0))).toBe(false);
  });
  test("s < 100 → s", () => {
    const b = findBody((s) => s < 100);
    expect(snilsControl(b)).toBe(String(snilsSum(b)).padStart(2, "0"));
  });
  test("s ∈ {100, 101} → 00", () => {
    for (const target of [100, 101]) {
      const b = findBody((s) => s === target);
      expect(snilsControl(b)).toBe("00");
      expect(snilsValid(`${b}00`)).toBe(true);
    }
  });
  test("s > 101 → s mod 101, and 100 after mod → 00", () => {
    const b = findBody((s) => s > 101 && s % 101 < 100);
    expect(snilsControl(b)).toBe(String(snilsSum(b) % 101).padStart(2, "0"));
    const c = findBody((s) => s > 101 && s % 101 === 100);
    expect(snilsControl(c)).toBe("00");
  });
  test("numbers ≤ 001-001-998 are not checksummed", () => {
    expect(snilsValid("00100199812")).toBe(true);
    expect(snilsValid("00100199899")).toBe(true);
    // 001-001-999: checksummed (sum 65)
    expect(snilsValid("00100199965")).toBe(true);
    expect(snilsValid("00100199966")).toBe(false);
  });
  test("shape", () => {
    expect(snilsValid("1122334459")).toBe(false);
    expect(snilsValid("112-233-445 95")).toBe(false);
  });
});

describe("INN", () => {
  test("person (12 digits)", () => {
    expect(innPersonValid("500100732259")).toBe(true);
    expect(innPersonValid(mutateDigit("500100732259", 10))).toBe(false);
    expect(innPersonValid(mutateDigit("500100732259", 11))).toBe(false);
    expect(innPersonValid(mutateDigit("500100732259", 3))).toBe(false);
    expect(innPersonValid("7707083893")).toBe(false);
  });
  test("organization (10 digits)", () => {
    expect(innOrgValid("7707083893")).toBe(true);
    expect(innOrgValid("7830002293")).toBe(true);
    expect(innOrgValid(mutateDigit("7707083893", 9))).toBe(false);
    expect(innOrgValid(mutateDigit("7707083893", 0))).toBe(false);
  });
  test("region 00 and non-digits are invalid", () => {
    expect(innOrgValid("0000000000")).toBe(false);
    expect(innPersonValid("000000000000")).toBe(false);
    expect(innOrgValid("77070838a3")).toBe(false);
  });
});

describe("OGRNIP", () => {
  test("valid, changed check digit, wrong first digit, wrong length", () => {
    expect(ogrnipValid("304500116000157")).toBe(true);
    expect(ogrnipValid(mutateDigit("304500116000157", 14))).toBe(false);
    expect(ogrnipValid("504500116000157")).toBe(false);
    expect(ogrnipValid("30450011600015")).toBe(false);
  });
});
