// The page of blocks as one TSX file (V5-03): the catalog's BlockById renders each block, the signature section sits
// where the director put it. The record blocks.json is the source of truth; this file is generated from it with the content inlined.
import { posix } from "node:path";
import type { BlocksPage } from "./types.js";

export const V5_DIR = "ui/v5";
export const V5_SIGNATURE_FILE = "ui/sections/v5-signature.tsx";

/** `ui/v5/<artifact>.json` of a record. */
export const recordPath = (name: string): string => `${V5_DIR}/${name}.json`;

/** TSX of the home page; `signatureAfter` — block id the signature section follows (null — no signature). */
export function homeSource(
  page: BlocksPage,
  signatureAfter: string | null,
  homeFile = "ui/pages/site/Home.tsx",
): string {
  const sig = posix.relative(posix.dirname(homeFile), V5_SIGNATURE_FILE.replace(/\.tsx$/, ""));
  const lines = page.blocks.flatMap((b, i) => {
    const el = `<BlockById key={${i}} id=${JSON.stringify(b.id)} content={${JSON.stringify(b.content)}}${
      b.variant ? ` variant=${JSON.stringify(b.variant)}` : ""
    } />`;
    return b.id === signatureAfter ? [el, "<Signature />"] : [el];
  });
  return [
    `import { BlockById, directionCss } from "@wizard/ui-kit";`,
    ...(signatureAfter
      ? [`import Signature from ${JSON.stringify(sig.startsWith(".") ? sig : `./${sig}`)};`]
      : []),
    "",
    "export default function Home() {",
    "  return (",
    "    <>",
    `      <style>{directionCss(${JSON.stringify(page.direction)}, ":root")}</style>`,
    ...lines.map((l) => `      ${l}`),
    "    </>",
    "  );",
    "}",
    "",
  ].join("\n");
}
