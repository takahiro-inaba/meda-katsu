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
const js = await read("src/app.js");

const title = html.match(/<title>([\s\S]*?)<\/title>/)[1].trim();
const body = html
  .match(/<body>([\s\S]*)<\/body>/)[1]
  .replace(/\s*<script src="src\/app\.js"><\/script>\s*/, "\n")
  .trim();

const out = `<title>${title}</title>
<style>
${css.trim()}
</style>
${body}
<script>
${js.trim()}
</script>
`;

await mkdir(resolve(root, "dist"), { recursive: true });
await writeFile(resolve(root, "dist/artifact.html"), out, "utf8");
console.log(`dist/artifact.html を書き出しました (${(out.length / 1024).toFixed(1)} KB)`);
