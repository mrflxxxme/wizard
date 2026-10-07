// Preload (node --import) of the stock-library CLI tests: the stocks answer from here, everything else (the local S3
// stub) goes to the real fetch. Pexels finds three photos of the asked orientation per query; every picture is the
// JPEG at FAKE_STOCK_JPEG. Each stock request is appended to FAKE_STOCK_LOG (one host per line). No network.
import { appendFileSync, readFileSync } from "node:fs";

const real = globalThis.fetch;
const jpeg = new Uint8Array(readFileSync(process.env.FAKE_STOCK_JPEG ?? ""));
const SIZE = { landscape: [1900, 1200], portrait: [1300, 1950], square: [1600, 1600] };
let next = 1000;

globalThis.fetch = async (input, init) => {
  const u = new URL(String(input));
  if (!["api.pexels.com", "images.pexels.com", "pixabay.com"].includes(u.hostname)) return real(input, init);
  if (process.env.FAKE_STOCK_LOG) appendFileSync(process.env.FAKE_STOCK_LOG, `${u.hostname}\n`);
  if (u.hostname === "api.pexels.com") {
    const [width, height] = SIZE[u.searchParams.get("orientation")] ?? SIZE.landscape;
    const photos = [0, 1, 2].map(() => {
      const id = next++;
      return {
        id,
        width,
        height,
        url: `https://www.pexels.com/photo/${id}/`,
        photographer: `Фотограф ${id}`,
        photographer_url: `https://www.pexels.com/@p${id}`,
        src: { large2x: `https://images.pexels.com/photos/${id}/p.jpeg?auto=compress&w=1880` },
      };
    });
    return Response.json({ photos });
  }
  if (u.hostname === "images.pexels.com")
    return new Response(jpeg, { status: 200, headers: { "content-type": "image/jpeg" } });
  return new Response("[ERROR 400] Invalid API key", { status: 400 });
};
