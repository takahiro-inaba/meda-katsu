/**
 * 公開するページ一式を dist/site に組む。
 *
 * やっているのは 3 つだけ。
 *   1. 配るファイルを集める（作りかえない。ソースがそのまま動くものを配る）
 *   2. Service Worker の VERSION を版に差し替える
 *      — 中身が変わらないとブラウザは新しい版に気づかず、直したものが出ない
 *   3. 1ファイル版（meda-katsu.html）を同じ場所に置く
 *      — ブラウザの外へ持ち出したい人が、URL から落として使えるように
 *
 *   node scripts/build-site.mjs
 */
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const site = resolve(root, "dist/site");

/** 版。GitHub Actions では commit の SHA が入る。手元では日時で代用する */
function version() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 12);
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: root }).toString().trim();
  } catch {
    return new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  }
}

const COPY = [
  "index.html",
  "src/app.css",
  "src/icons.js",
  "src/app.js",
  "src/web.js",
  "manifest.webmanifest",
  "assets"
];

await rm(site, { recursive: true, force: true });
await mkdir(resolve(site, "src"), { recursive: true });

for (const path of COPY) {
  await cp(resolve(root, path), resolve(site, path), { recursive: true });
}

const build = version();
const sw = await readFile(resolve(root, "service-worker.js"), "utf8");
await writeFile(resolve(site, "service-worker.js"), sw.replace("__BUILD__", build), "utf8");

/* 1ファイル版も同じ URL の下に置く。ブラウザを乗り換える人の持ち出し先になる */
await import("./build-artifact.mjs");
await cp(resolve(root, "dist/meda-katsu.html"), resolve(site, "meda-katsu.html"));

console.log(`dist/site (version ${build})`);
