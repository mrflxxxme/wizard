// V3-40: the static page of the blind comparison (one HTML file next to its img/ folder; no network, no dependencies).
// The rater sees pairs «Сайт A / Сайт B» with the phone and desktop screenshots and the task of each site, picks the
// better one or «Одинаково», marks «A и B — как один шаблон» and downloads the answers as a JSON file; aggregate.mjs
// sums the files. The page carries no source and no brief id: only the neutral pair ids, the tasks and the images.

/** Version of the votes file (aggregate.mjs reads this kind and version); neutral — the page names no product. */
export const VOTES_KIND = "blind-votes";
export const VOTES_VERSION = 1;

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** JSON inside <script>: no «</script>», no «<!--». */
const safeJson = (v) => JSON.stringify(v).replace(/</g, "\\u003c");

const CSS = `
:root {
  --bg: #f6f5f2; --surface: #ffffff; --text: #1d1d1b; --muted: #5f5d58; --line: #dcd9d2;
  --accent: #2f5bd3; --accent-text: #ffffff; --chosen: #e7edfb; --warn: #9a5b00;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #161615; --surface: #20201e; --text: #ecebe7; --muted: #a9a69f; --line: #3a3935;
    --accent: #8fa9f2; --accent-text: #10131c; --chosen: #26304a; --warn: #f0b45c;
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --bg: #161615; --surface: #20201e; --text: #ecebe7; --muted: #a9a69f; --line: #3a3935;
  --accent: #8fa9f2; --accent-text: #10131c; --chosen: #26304a; --warn: #f0b45c;
  color-scheme: dark;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 1280px; margin: 0 auto; padding: 24px 16px 96px; }
h1 { font-size: 1.6rem; margin: 0 0 8px; }
p { margin: 0 0 12px; }
.muted { color: var(--muted); }
.intro, .pair { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 20px; margin: 0 0 20px; }
.intro ul { margin: 0 0 12px; padding-left: 20px; }
label.name { display: block; font-weight: 600; margin: 12px 0 4px; }
input[type="text"], textarea { width: 100%; max-width: 420px; font: inherit; color: var(--text); background: var(--bg);
  border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; }
textarea { max-width: none; min-height: 56px; resize: vertical; }
.pair h2 { font-size: 1.15rem; margin: 0 0 12px; }
.sites { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.site { border: 1px solid var(--line); border-radius: 10px; padding: 12px; min-width: 0; }
.site h3 { margin: 0 0 4px; font-size: 1rem; }
.site .task { font-size: .9rem; color: var(--muted); margin: 0 0 10px; }
.shots { display: grid; grid-template-columns: 1fr 3fr; gap: 10px; align-items: start; }
.shots figure { margin: 0; min-width: 0; }
.shots figcaption { font-size: .8rem; color: var(--muted); margin-top: 4px; }
.shots a { display: block; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; background: var(--bg); }
.shots img { display: block; width: 100%; height: auto; }
.phone a { aspect-ratio: 390 / 844; }
.desk a { aspect-ratio: 16 / 10; }
.phone img, .desk img { height: 100%; object-fit: cover; object-position: top; }
fieldset { border: 0; padding: 0; margin: 16px 0 0; }
legend { font-weight: 600; margin-bottom: 8px; }
.choices { display: flex; flex-wrap: wrap; gap: 8px; }
.choices label, .check { display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--line);
  border-radius: 999px; padding: 8px 14px; cursor: pointer; }
.choices input:checked + span { font-weight: 600; }
.choices label:has(input:checked) { background: var(--chosen); border-color: var(--accent); }
.check { margin-top: 12px; border-radius: 8px; }
.bar { position: fixed; left: 0; right: 0; bottom: 0; background: var(--surface); border-top: 1px solid var(--line);
  padding: 12px 16px; display: flex; gap: 12px; align-items: center; justify-content: center; flex-wrap: wrap; }
button { font: inherit; font-weight: 600; background: var(--accent); color: var(--accent-text); border: 0;
  border-radius: 8px; padding: 10px 18px; cursor: pointer; }
.warn { color: var(--warn); }
@media (max-width: 860px) {
  .sites { grid-template-columns: 1fr; }
}
`;

const SCRIPT = `
(function () {
  var DATA = JSON.parse(document.getElementById("blind-data").textContent);
  var STORE = "blind-compare-" + DATA.layoutId;
  var state = { rater: "", votes: {} };
  try { var saved = JSON.parse(localStorage.getItem(STORE) || "null"); if (saved && saved.votes) state = saved; } catch (e) {}
  function save() { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) {} progress(); }
  function vote(id) { return state.votes[id] || (state.votes[id] = { better: null, sameTemplate: false, comment: "" }); }
  function done() { return DATA.pairs.filter(function (p) { var v = state.votes[p.id]; return v && v.better; }).length; }
  function progress() {
    document.getElementById("progress").textContent = "Оценено пар: " + done() + " из " + DATA.pairs.length;
  }
  var name = document.getElementById("rater");
  name.value = state.rater || "";
  name.addEventListener("input", function () { state.rater = name.value.trim(); save(); });
  document.querySelectorAll("[data-pair]").forEach(function (box) {
    var id = box.getAttribute("data-pair");
    var v = state.votes[id];
    box.querySelectorAll("input[type=radio]").forEach(function (r) {
      if (v && v.better === r.value) r.checked = true;
      r.addEventListener("change", function () { vote(id).better = r.value; save(); });
    });
    var same = box.querySelector("input[type=checkbox]");
    if (v && v.sameTemplate) same.checked = true;
    same.addEventListener("change", function () { vote(id).sameTemplate = same.checked; save(); });
    var note = box.querySelector("textarea");
    if (v && v.comment) note.value = v.comment;
    note.addEventListener("input", function () { vote(id).comment = note.value.slice(0, 500); save(); });
  });
  document.getElementById("download").addEventListener("click", function () {
    if (!state.rater) { alert("Укажите имя или псевдоним вверху страницы — так ваши ответы не смешаются с чужими."); name.focus(); return; }
    var left = DATA.pairs.length - done();
    if (left > 0 && !confirm("Не оценено пар: " + left + ". Скачать то, что есть?")) return;
    var out = {
      kind: DATA.votesKind, version: DATA.votesVersion, layoutId: DATA.layoutId, seed: DATA.seed,
      rater: state.rater, savedAt: new Date().toISOString(),
      votes: DATA.pairs.map(function (p) {
        var x = state.votes[p.id] || {};
        return { pair: p.id, better: x.better || null, sameTemplate: !!x.sameTemplate, comment: (x.comment || "").trim() };
      })
    };
    var blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    var slug = state.rater.toLowerCase().replace(/[^a-zа-яё0-9]+/gi, "-").replace(/^-+|-+$/g, "") || "rater";
    a.href = URL.createObjectURL(blob);
    a.download = "blind-" + slug + "-" + DATA.layoutId + ".json";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  });
  progress();
})();
`;

function siteHtml(side, letter) {
  const shot = (vp, cls, label) =>
    `<figure class="${cls}"><a href="${esc(side.images[vp])}" target="_blank" rel="noopener"><img src="${esc(side.images[vp])}" alt="Сайт ${letter}: ${esc(label.toLowerCase())}" loading="lazy"></a><figcaption>${esc(label)}</figcaption></figure>`;
  return `<div class="site"><h3>Сайт ${letter}</h3><p class="task">Задача: ${esc(side.title)}</p><div class="shots">${shot("390", "phone", "Телефон")}${shot("1440", "desk", "Компьютер")}</div></div>`;
}

function pairHtml(p, i, n) {
  return `<section class="pair" data-pair="${esc(p.id)}" id="${esc(p.id)}">
<h2>Пара ${i + 1} из ${n}</h2>
<div class="sites">${siteHtml(p.A, "A")}${siteHtml(p.B, "B")}</div>
<fieldset><legend>Какой сайт лучше справляется со своей задачей?</legend><div class="choices">
<label><input type="radio" name="b-${esc(p.id)}" value="A"><span>Лучше A</span></label>
<label><input type="radio" name="b-${esc(p.id)}" value="B"><span>Лучше B</span></label>
<label><input type="radio" name="b-${esc(p.id)}" value="same"><span>Одинаково</span></label>
</div></fieldset>
<label class="check"><input type="checkbox"><span>A и B выглядят как один шаблон</span></label>
<p style="margin-top:12px"><textarea placeholder="Комментарий (необязательно): что понравилось, что мешает"></textarea></p>
</section>`;
}

/** The page of a layout (layout.mjs blindLayout): pairs with the images under their neutral names, no sources. */
export function renderBlindPage(layout) {
  const data = {
    layoutId: layout.layoutId,
    seed: layout.seed,
    votesKind: VOTES_KIND,
    votesVersion: VOTES_VERSION,
    pairs: layout.pairs.map((p) => ({ id: p.id })),
  };
  const n = layout.pairs.length;
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Слепое сравнение сайтов</title>
<style>${CSS}</style>
</head>
<body>
<main>
<section class="intro">
<h1>Слепое сравнение сайтов</h1>
<p>Перед вами ${n} пар сайтов малого бизнеса. У каждого сайта указана задача — каким бизнесом он должен быть и что должен уметь. Чей это сайт и как он сделан, неважно: оценивайте только то, что видите.</p>
<ul>
<li>Выберите, какой сайт из пары лучше справляется со своей задачей: понятно ли, что предлагают, удобно ли сделать главное действие, приятно ли смотреть. Если разницы нет — «Одинаково».</li>
<li>Отметьте «как один шаблон», если два сайта кажутся сделанными по одному шаблону: то же устройство страницы, те же блоки в том же порядке, отличаются только тексты и цвета.</li>
<li>Снимки открываются целиком по щелчку. Ответы сохраняются в этом браузере, можно прерваться и вернуться.</li>
<li>В конце нажмите «Скачать результаты» и пришлите файл тому, кто дал вам эту страницу.</li>
</ul>
<label class="name" for="rater">Ваше имя или псевдоним</label>
<input type="text" id="rater" autocomplete="nickname" placeholder="Например, Оценщик 3">
</section>
${layout.pairs.map((p, i) => pairHtml(p, i, n)).join("\n")}
</main>
<div class="bar"><span id="progress" class="muted"></span><button type="button" id="download">Скачать результаты</button></div>
<script type="application/json" id="blind-data">${safeJson(data)}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
