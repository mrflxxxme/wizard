// Long ТЗ → chunks for the model: whole paragraphs packed up to the limit; once a chunk is past half of it, a heading
// starts the next one (sections stay whole where they can); a paragraph longer than the limit is split by lines, then
// cut hard.

const HEADING = /^#{1,6}\s/;

function splitLong(p: string, max: number): string[] {
  if (p.length <= max) return [p];
  const out: string[] = [];
  let cur = "";
  for (const line of p.split("\n")) {
    for (let i = 0; i < line.length; i += max) {
      const part = line.slice(i, i + max);
      if (cur && cur.length + 1 + part.length > max) {
        out.push(cur);
        cur = "";
      }
      cur = cur ? `${cur}\n${part}` : part;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Splits text into chunks of at most `max` characters along paragraph boundaries. */
export function chunkText(text: string, max: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= max) return [trimmed];
  const chunks: string[] = [];
  let cur = "";
  for (const para of trimmed.split(/\n{2,}/).flatMap((p) => splitLong(p, max))) {
    const sep = cur ? "\n\n" : "";
    const breakAtHeading = HEADING.test(para) && cur.length > max * 0.5;
    if (cur && (cur.length + sep.length + para.length > max || breakAtHeading)) {
      chunks.push(cur);
      cur = para;
    } else cur += sep + para;
  }
  if (cur) chunks.push(cur);
  return chunks;
}
