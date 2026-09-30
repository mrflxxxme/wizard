// email (data-boundary.yaml#detectors.kinds.email): RFC 5322 lite incl. Cyrillic domains, plus common obfuscations.
import type { Finding } from "../types.js";
import { finding } from "../util.js";

const EMAIL_RE =
  /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}][\p{L}\p{N}._%+-]{0,63}@(?:[\p{L}\p{N}][\p{L}\p{N}-]{0,62}\.)+(\p{L}{2,24})(?![\p{L}\p{N}-])/gu;
// Asset names like icon@2x.png are not addresses.
const FILE_EXT = /^(?:png|jpe?g|gif|svg|webp|avif|bmp|ico|css|scss|less|js|mjs|cjs|ts|tsx|jsx|json|map|woff2?|ttf|otf|mp[34]|webm|pdf|txt|md|html?|xml|ya?ml|zip)$/i;

const AT = String.raw`(?:[ \xa0]*[([{<]at[)\]}>][ \xa0]*|[ \xa0]+at[ \xa0]+|[ \xa0]*\(?собак[аи]\)?[ \xa0]*|[ \xa0]*\(?собачк[аи]\)?[ \xa0]*)`;
const DOT = String.raw`(?:[ \xa0]*\.[ \xa0]*|[ \xa0]*[([{<]dot[)\]}>][ \xa0]*|[ \xa0]+dot[ \xa0]+|[ \xa0]+точка[ \xa0]+|[ \xa0]*\(точка\)[ \xa0]*)`;
const OBFUSCATED_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}._-])[A-Za-z0-9][A-Za-z0-9._-]{0,63}${AT}[A-Za-z0-9][A-Za-z0-9-]{0,62}(?:${DOT}[A-Za-z0-9-]{1,63})*${DOT}([A-Za-z]{2,10})(?![\p{L}\p{N}])`,
  "giu",
);
const OBFUSCATION_HINT = /собак|собачк|(?<![A-Za-z])at(?![A-Za-z])/iu;
const COMMON_TLD = new Set(
  "ru su com net org info biz pro io me co dev app online site tech xyz ua by kz uz am ge de uk eu us cloud mail email".split(" "),
);

export function detectEmails(text: string): Finding[] {
  const out: Finding[] = [];
  for (const m of text.matchAll(EMAIL_RE)) {
    if (FILE_EXT.test(m[1] ?? "")) continue;
    out.push(finding("email", m.index, m.index + m[0].length, "high"));
  }
  if (!OBFUSCATION_HINT.test(text)) return out;
  for (const m of text.matchAll(OBFUSCATED_RE)) {
    if (m[0].includes("@")) continue;
    if (!COMMON_TLD.has((m[1] ?? "").toLowerCase())) continue;
    out.push(finding("email", m.index, m.index + m[0].length, "medium"));
  }
  return out;
}
