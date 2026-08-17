/**
 * index.html + src/*.{css,js} を 1 枚の HTML にまとめて dist/artifact.html を作る。
 * Artifact として公開するページは <html>/<head>/<body> を持たないため、
 * <title> と <body> の中身だけを取り出し、CSS と JS をインライン化する。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFile(resolve(root, p), "utf8");

const html = await read("index.html");
const css = await read("src/app.css");
const icons = await read("src/icons.js");
const js = await read("src/app.js");

const title = html.match(/<title>([\s\S]*?)<\/title>/)[1].trim();
const body = html
  .match(/<body>([\s\S]*)<\/body>/)[1]
  .replace(/\s*<script src="src\/(icons|app|web)\.js"><\/script>\s*/g, "\n")
  .trim();

const out = `<title>${title}</title>
<style>
${css.trim()}
</style>
${body}
<script>
${icons.trim()}
${js.trim()}
</script>
`;

/*
 * ダブルクリックで開ける 1 ファイル版も出す。
 * 公開したページ向けのもの（manifest・アイコンの参照・src/web.js）は外す。
 * file:// では Service Worker が動かず、参照先のファイルも隣に無いため、
 * 残すと 404 を出すだけになる。
 */
const standalone = html
  .replace(/[ \t]*<link rel="manifest"[^>]*>\n/, "")
  .replace(/[ \t]*<link rel="apple-touch-icon"[^>]*>\n/, "")
  .replace(/[ \t]*<script src="src\/web\.js"><\/script>\n/, "")
  .replace('<link rel="stylesheet" href="src/app.css">', `<style>\n${css.trim()}\n</style>`)
  .replace('<script src="src/icons.js"></script>', `<script>\n${icons.trim()}\n</script>`)
  .replace('<script src="src/app.js"></script>', `<script>\n${js.trim()}\n</script>`);

await mkdir(resolve(root, "dist"), { recursive: true });
await writeFile(resolve(root, "dist/artifact.html"), out, "utf8");
await writeFile(resolve(root, "dist/meda-katsu.html"), standalone, "utf8");
console.log(`dist/artifact.html (${(out.length / 1024).toFixed(1)} KB)`);
console.log(`dist/meda-katsu.html (${(standalone.length / 1024).toFixed(1)} KB)`);
