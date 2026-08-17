/**
 * ホーム画面に置くアイコンと、リンクを貼ったときに出る画像を作る。
 *
 * 元は 1 つ（雫と水面のマーク）だけで、大きさと余白を変えて書き出す。
 * PNG は Chromium で描いて `assets/` に置き、そのままコミットする。
 * 公開のたびに描き直すと、生成環境のフォントやレンダラの差でアイコンが
 * 静かに変わってしまうため、成果物を持つほうを取る。
 *
 *   node scripts/build-icons.mjs
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "assets");

/* アプリのトークンと同じ値。ここだけ別の緑にすると別のアプリに見える */
const ACCENT = "#2c6b53";
const PLANE = "#f4f6f2";
const WATER = "#cde3d7";

/**
 * 雫と水面のマーク。index.html のブランドと同じ path を使う。
 * scale は「512 の中でマークが占める割合」。
 * マスクされるアイコン（Android の丸や角丸に切られるもの）は、
 * 四隅が消えても意味が残るように小さく置く。
 */
function markSvg(scale) {
  const span = 512 * scale;
  const offset = (512 - span) / 2;
  const unit = span / 24;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${PLANE}"/>
      <stop offset="1" stop-color="${WATER}"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" fill="url(#bg)"/>
  <g transform="translate(${offset} ${offset}) scale(${unit})">
    <path d="M12 2.5c3.4 4 5.2 6.8 5.2 9.1A5.2 5.2 0 0 1 12 16.8a5.2 5.2 0 0 1-5.2-5.2c0-2.3 1.8-5.1 5.2-9.1Z" fill="${ACCENT}"/>
    <path d="M2.6 19.4c1.6 0 1.6 1.5 3.1 1.5s1.6-1.5 3.1-1.5 1.6 1.5 3.2 1.5 1.6-1.5 3.1-1.5 1.6 1.5 3.1 1.5 1.6-1.5 3.2-1.5"
      fill="none" stroke="${ACCENT}" stroke-width="1.8" stroke-linecap="round" opacity="0.85"/>
  </g>
</svg>`;
}

/** リンクを貼ったときに出る画像（1200×630）。文字は IPAGothic 等の実在するもので描く */
function ogHtml() {
  return `<!doctype html><meta charset="utf-8">
<style>
  * { margin: 0; box-sizing: border-box; }
  body {
    width: 1200px; height: 630px; display: flex; flex-direction: column; justify-content: center;
    gap: 26px; padding: 0 84px;
    background: linear-gradient(160deg, ${PLANE} 0%, ${PLANE} 46%, ${WATER} 100%);
    color: #131a16;
    font-family: "IPAGothic", "Noto Sans CJK JP", system-ui, sans-serif;
  }
  .mark { display: flex; align-items: center; gap: 22px; }
  .mark svg { color: ${ACCENT}; }
  .name { font-size: 64px; font-weight: 700; letter-spacing: 0.04em; }
  .sub { font-size: 26px; letter-spacing: 0.22em; color: #4f5a53; margin-top: 8px; }
  .lead { font-size: 34px; line-height: 1.65; color: #131a16; }
  .foot { font-size: 22px; color: #4f5a53; letter-spacing: 0.02em; }
  .foot b { color: ${ACCENT}; font-weight: 700; }
</style>
<div class="mark">
  <svg width="96" height="96" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <path d="M12 2.5c3.4 4 5.2 6.8 5.2 9.1A5.2 5.2 0 0 1 12 16.8a5.2 5.2 0 0 1-5.2-5.2c0-2.3 1.8-5.1 5.2-9.1Z" stroke-linejoin="round"/>
    <path d="M2.6 19.4c1.6 0 1.6 1.5 3.1 1.5s1.6-1.5 3.1-1.5 1.6 1.5 3.2 1.5 1.6-1.5 3.1-1.5 1.6 1.5 3.1 1.5 1.6-1.5 3.2-1.5" stroke-linecap="round"/>
  </svg>
  <div>
    <div class="name">メダ活</div>
    <div class="sub">BIOTOPE LEDGER</div>
  </div>
</div>
<div class="lead">メダカとビオトープの記録を、<br>生き物・水温・作業・写真でまとめて残す台帳。</div>
<div class="foot"><b>記録はこのブラウザの中だけ。</b>アカウントも通信もいりません。</div>
`;
}

const png = [
  { file: "icon-192.png", size: 192, scale: 0.72 },
  { file: "icon-512.png", size: 512, scale: 0.72 },
  /* マスクされる版。丸く切られても雫が欠けない大きさに落とす */
  { file: "icon-maskable-512.png", size: 512, scale: 0.52 },
  /* iOS のホーム画面。角丸は OS が付けるので、こちらは四角のまま渡す */
  { file: "apple-touch-icon.png", size: 180, scale: 0.72 }
];

await mkdir(out, { recursive: true });
await writeFile(resolve(out, "icon.svg"), markSvg(0.72) + "\n", "utf8");

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });

for (const spec of png) {
  await page.setViewportSize({ width: spec.size, height: spec.size });
  await page.setContent(
    `<!doctype html><meta charset="utf-8"><style>*{margin:0}svg{display:block;width:${spec.size}px;height:${spec.size}px}</style>` +
      markSvg(spec.scale)
  );
  await page.screenshot({ path: resolve(out, spec.file), omitBackground: false });
  console.log(`assets/${spec.file} (${spec.size}×${spec.size})`);
}

await page.setViewportSize({ width: 1200, height: 630 });
await page.setContent(ogHtml());
await page.screenshot({ path: resolve(out, "ogp.png") });
console.log("assets/ogp.png (1200×630)");

await browser.close();
