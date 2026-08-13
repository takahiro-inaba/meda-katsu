/**
 * ソース一式を 1 枚の HTML にまとめて dist/source.html を作る。
 * リポジトリへ push できない環境でも、コードを読める形で残しておくため。
 *
 * ファイルの中身は <pre> に HTML エスケープして埋める。
 * <script> の中に文字列として入れると、index.html に含まれる </script> で壊れる。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const FILES = [
  ["index.html", "画面の骨組み"],
  ["src/app.css", "デザイントークンとスタイル"],
  ["src/icons.js", "線画アイコン 20 個"],
  ["src/app.js", "状態・保存・描画・グラフ・水面"],
  ["scripts/build-artifact.mjs", "1 枚の HTML にまとめる"],
  ["scripts/build-source-artifact.mjs", "このページを作る"],
  ["README.md", "使いかたと設計の理由"],
  ["docs/loop-log.md", "要求と決定の履歴"],
  [".gitignore", ""]
];

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const files = [];
for (const [path, note] of FILES) {
  const body = await readFile(resolve(root, path), "utf8");
  files.push({ path, note, body, lines: body.split("\n").length, bytes: Buffer.byteLength(body) });
}

let commits = "";
try {
  commits = execSync("git log --pretty='format:%h %s'", { cwd: root }).toString().trim();
} catch {
  commits = "(コミット履歴を読めませんでした)";
}

const totalBytes = files.reduce((n, f) => n + f.bytes, 0);
const totalLines = files.reduce((n, f) => n + f.lines, 0);

const page = `<title>メダ活 ソース一式</title>
<style>
:root {
  color-scheme: light;
  --plane: #f4f6f2; --surface: #fdfdfb; --surface-2: #eef1ec;
  --ink: #131a16; --ink-2: #4f5a53; --muted: #8b938c;
  --hairline: #e2e5dd; --line: #c9cfc6;
  --accent: #2c6b53; --accent-soft: #e3efe8;
  --sans: system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", "Yu Gothic UI", Meiryo, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--plane); color: var(--ink);
  font-family: var(--sans); font-size: 14px; line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}
button { font: inherit; color: inherit; cursor: pointer; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 3px; }

header { padding: 26px 28px 20px; border-bottom: 1px solid var(--hairline); background: var(--surface); }
h1 { margin: 0 0 4px; font-size: 20px; letter-spacing: 0.01em; }
.sub { margin: 0; color: var(--ink-2); font-size: 13px; }
.meta-row { display: flex; gap: 18px; flex-wrap: wrap; margin-top: 14px; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }

.layout { display: grid; grid-template-columns: 268px minmax(0, 1fr); align-items: start; }
.files {
  border-right: 1px solid var(--hairline); background: var(--surface);
  padding: 14px; display: flex; flex-direction: column; gap: 2px;
  position: sticky; top: 0; max-height: 100vh; overflow-y: auto;
}
.file-btn {
  display: flex; flex-direction: column; gap: 1px; text-align: left;
  padding: 9px 10px; border: 0; border-radius: 7px; background: transparent;
}
.file-btn:hover { background: var(--surface-2); }
.file-btn[aria-current="true"] { background: var(--accent-soft); }
.file-btn[aria-current="true"] .fname { color: var(--accent); font-weight: 700; }
.fname { font-family: var(--mono); font-size: 12.5px; }
.fnote { color: var(--muted); font-size: 11px; }

main { padding: 20px 24px 60px; min-width: 0; }
.file-head {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  padding: 12px 16px; background: var(--surface);
  border: 1px solid var(--hairline); border-bottom: 0;
  border-radius: 12px 12px 0 0;
}
.file-head .path { font-family: var(--mono); font-weight: 700; font-size: 13px; }
.file-head .size { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.spacer { flex: 1; }
.btn {
  padding: 6px 13px; border-radius: 6px; border: 1px solid var(--line);
  background: transparent; color: var(--ink-2); font-size: 13px;
}
.btn:hover { background: var(--surface-2); color: var(--ink); }
.btn.primary { background: var(--accent); border-color: transparent; color: #fff; font-weight: 700; }
.btn.primary:hover { filter: brightness(1.08); background: var(--accent); color: #fff; }
.btn[disabled] { opacity: 0.45; cursor: default; }

pre.view {
  margin: 0; padding: 16px 18px;
  background: var(--surface); border: 1px solid var(--hairline); border-radius: 0 0 12px 12px;
  font-family: var(--mono); font-size: 12.5px; line-height: 1.65;
  overflow-x: auto; white-space: pre; tab-size: 2;
}
#store { display: none; }

.note {
  margin: 20px 0 0; padding: 14px 16px;
  background: var(--surface); border: 1px solid var(--hairline); border-radius: 12px;
  font-size: 13px; color: var(--ink-2);
}
.note h2 { margin: 0 0 8px; font-size: 13px; color: var(--ink); letter-spacing: 0.02em; }
.note code { font-family: var(--mono); font-size: 12px; background: var(--surface-2); padding: 1px 5px; border-radius: 4px; }
.note pre { margin: 8px 0 0; padding: 12px; background: var(--surface-2); border-radius: 8px; font-family: var(--mono); font-size: 12px; overflow-x: auto; }
.commits { font-family: var(--mono); font-size: 12px; color: var(--ink-2); white-space: pre-wrap; margin: 0; }

.toast {
  position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%);
  background: var(--ink); color: var(--plane); padding: 9px 18px;
  border-radius: 999px; font-size: 13px; box-shadow: 0 12px 28px -18px rgba(0,0,0,.6);
}

@media (max-width: 820px) {
  .layout { grid-template-columns: minmax(0, 1fr); }
  .files { position: static; max-height: none; border-right: 0; border-bottom: 1px solid var(--hairline); }
  main { padding: 16px 14px 48px; }
  header { padding: 20px 16px 16px; }
}
</style>

<header>
  <h1>メダ活 — ソース一式</h1>
  <p class="sub">ビオトープ台帳のコード全部。依存ライブラリはありません。</p>
  <div class="meta-row">
    <span>${files.length} ファイル</span>
    <span>${totalLines.toLocaleString("ja-JP")} 行</span>
    <span>${(totalBytes / 1024).toFixed(1)} KB</span>
    <span>${new Date().toLocaleDateString("ja-JP")} 時点</span>
  </div>
</header>

<div class="layout">
  <nav class="files" id="file-list" aria-label="ファイル"></nav>
  <main>
    <div class="file-head">
      <span class="path" id="cur-path"></span>
      <span class="size" id="cur-size"></span>
      <span class="spacer"></span>
      <button class="btn" id="copy-btn">このファイルをコピー</button>
      <button class="btn primary" id="save-btn">全ファイルを保存</button>
    </div>
    <pre class="view" id="view"></pre>

    <div class="note">
      <h2>手元に戻すには</h2>
      <p style="margin:0">
        「全ファイルを保存」で <code>meda-katsu-source.json</code>（<code>{ パス: 中身 }</code> の形）が保存できます。
        同じ場所で次を実行すると、フォルダ構成ごと復元できます。
      </p>
      <pre>node -e "const f=require('./meda-katsu-source.json'),{writeFileSync,mkdirSync}=require('fs'),{dirname}=require('path');for(const p in f){mkdirSync(dirname(p),{recursive:true});writeFileSync(p,f[p])}"</pre>
      <p style="margin:10px 0 0">
        復元後は <code>index.html</code> をブラウザで開けばそのまま動きます。ビルドもインストールも不要です。
        <code>node scripts/build-artifact.mjs</code> で 1 ファイル版も作れます。
      </p>
    </div>

    <div class="note">
      <h2>コミット</h2>
      <p class="commits">${esc(commits)}</p>
    </div>
  </main>
</div>

<div id="store">
${files.map((f) => `<pre data-path="${esc(f.path)}">${esc(f.body)}</pre>`).join("\n")}
</div>

<script>
(function () {
  "use strict";
  var meta = ${JSON.stringify(files.map((f) => ({ path: f.path, note: f.note, lines: f.lines, bytes: f.bytes })))};
  var store = document.getElementById("store");
  var list = document.getElementById("file-list");
  var view = document.getElementById("view");
  var curPath = document.getElementById("cur-path");
  var curSize = document.getElementById("cur-size");
  var current = meta[0].path;

  function bodyOf(path) {
    var el = store.querySelector('[data-path="' + path + '"]');
    return el ? el.textContent : "";
  }

  function toast(message) {
    var old = document.querySelector(".toast");
    if (old) old.remove();
    var el = document.createElement("div");
    el.className = "toast";
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(function () { if (el.isConnected) el.remove(); }, 3000);
  }

  function show(path) {
    current = path;
    var m = meta.filter(function (x) { return x.path === path; })[0];
    view.textContent = bodyOf(path);
    curPath.textContent = path;
    curSize.textContent = m.lines.toLocaleString("ja-JP") + " 行 ・ " + (m.bytes / 1024).toFixed(1) + " KB";
    list.querySelectorAll(".file-btn").forEach(function (b) {
      b.setAttribute("aria-current", String(b.dataset.path === path));
    });
    view.scrollTop = 0;
  }

  meta.forEach(function (m) {
    var b = document.createElement("button");
    b.className = "file-btn";
    b.dataset.path = m.path;
    b.innerHTML = '<span class="fname"></span><span class="fnote"></span>';
    b.querySelector(".fname").textContent = m.path;
    b.querySelector(".fnote").textContent = m.note || (m.bytes / 1024).toFixed(1) + " KB";
    b.addEventListener("click", function () { show(m.path); });
    list.appendChild(b);
  });

  document.getElementById("copy-btn").addEventListener("click", function () {
    navigator.clipboard.writeText(bodyOf(current)).then(
      function () { toast(current + " をコピーしました"); },
      function () { toast("コピーできませんでした。本文を選択してコピーしてください"); }
    );
  });

  var saveBtn = document.getElementById("save-btn");
  if (!window.claude || !window.claude.downloads) {
    saveBtn.disabled = true;
    saveBtn.textContent = "保存は使えません";
  } else {
    saveBtn.addEventListener("click", function () {
      var bundle = {};
      meta.forEach(function (m) { bundle[m.path] = bodyOf(m.path); });
      saveBtn.disabled = true;
      window.claude.downloads
        .save({ filename: "meda-katsu-source.json", data: JSON.stringify(bundle, null, 2) })
        .then(function () { toast("保存しました"); })
        .catch(function (err) {
          var code = err && err.code;
          if (code === "declined") toast("保存を取り消しました");
          else if (code === "rate_limited") toast("少し待ってからもう一度お試しください");
          else if (code === "too_large") toast("大きすぎて保存できません");
          else { toast("この画面では保存できません。コピーをお使いください"); saveBtn.textContent = "保存は使えません"; return; }
        })
        .then(function () { if (saveBtn.textContent !== "保存は使えません") saveBtn.disabled = false; });
    });
  }

  show(current);
})();
</script>
`;

await mkdir(resolve(root, "dist"), { recursive: true });
await writeFile(resolve(root, "dist/source.html"), page, "utf8");
console.log(`dist/source.html (${(page.length / 1024).toFixed(1)} KB / ${files.length} ファイル)`);
