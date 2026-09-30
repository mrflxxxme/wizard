// social_handle and car_plate_ru (data-boundary.yaml#detectors.kinds).
import type { Finding } from "../types.js";
import { finding } from "../util.js";

// @handle (5–32 chars), not inside an email, npm scope (@scope/pkg), decorator (@Component(…)) or CSS at-rule.
const HANDLE_RE = /(?<![\p{L}\p{N}_.@-])@([A-Za-z0-9_]{5,32})(?![A-Za-z0-9_@(/-]|\.[A-Za-z0-9])/gu;
const PROFILE_RE =
  /(?<![\p{L}\p{N}.-])(?:https?:\/\/)?(?:www\.|m\.)?(?:vk\.com|t\.me|telegram\.me|ok\.ru|instagram\.com)\/(@?\w+(?:\.\w+)*)/giu;
// Code and markup at-words that look like handles.
const NOT_HANDLES = new Set(
  (
    "media import keyframes supports charset layer container property namespace tailwind apply screen variant " +
    "font-face page counter-style document param returns return deprecated example typedef type throws private " +
    "public internal author version since see link override todo fixme callback template property readonly " +
    "everyone channel here admin types angular vitejs babel vitest testing storybook sveltejs remix-run tanstack " +
    "emotion reduxjs mui chakra-ui radix-ui heroicons wizard anthropic openai google ts-ignore ts-expect-error"
  ).split(" "),
);
// Profile paths that are not people.
const NOT_PROFILES = /^(?:share|joinchat|addstickers|addemoji|proxy|login|feed|search|im|settings|help|about|legal|terms)$/i;

// Letters used on Russian plates (Cyrillic) and their Latin look-alikes.
const PLATE_RE =
  /(?<![\p{L}\d#-])([АВЕКМНОРСТУХABEKMHOPCTYX])[ \xa0]?(\d{3})[ \xa0]?([АВЕКМНОРСТУХABEKMHOPCTYX]{2})[ \xa0]?(\d{2,3})(?![\p{L}\d-])/giu;

export interface HandleOptions {
  /** The system's own service accounts (e.g. its Telegram bot username) — not findings. */
  ignoreHandles?: readonly string[];
}

export function detectHandles(text: string, options: HandleOptions = {}): Finding[] {
  const ignore = new Set((options.ignoreHandles ?? []).map((h) => h.replace(/^@/, "").toLowerCase()));
  const out: Finding[] = [];
  if (text.includes("@")) {
    for (const m of text.matchAll(HANDLE_RE)) {
      const h = (m[1] ?? "").toLowerCase();
      if (NOT_HANDLES.has(h) || ignore.has(h) || /^\d+$/.test(h)) continue;
      out.push(finding("social_handle", m.index, m.index + m[0].length, "medium"));
    }
  }
  if (/vk\.com|t\.me|telegram\.me|ok\.ru|instagram\.com/i.test(text)) {
    for (const m of text.matchAll(PROFILE_RE)) {
      const path = (m[1] ?? "").replace(/^@/, "");
      if (!path || NOT_PROFILES.test(path) || ignore.has(path.toLowerCase())) continue;
      out.push(finding("social_handle", m.index, m.index + m[0].length, "high"));
    }
  }
  return out;
}

export function detectCarPlates(text: string): Finding[] {
  const out: Finding[] = [];
  for (const m of text.matchAll(PLATE_RE)) {
    const letters = `${m[1] ?? ""}${m[3] ?? ""}`;
    // Lowercase Latin is hex/identifiers, not a plate; all-hex Latin letters likewise.
    if (/[a-z]/.test(letters) || /^[A-F]+$/.test(letters)) continue;
    // Lowercase Cyrillic only when written together ("а123вс77"): "в 100 км 20 минут" is not a plate.
    if (/[а-яё]/.test(letters) && /^\p{L}[ \xa0]|\d[ \xa0]\p{L}/u.test(m[0])) continue;
    const region = m[4] ?? "";
    if (region === "00" || (region.length === 3 && region.startsWith("0"))) continue;
    out.push(finding("car_plate_ru", m.index, m.index + m[0].length, "high"));
  }
  return out;
}
