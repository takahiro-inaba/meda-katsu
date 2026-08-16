/* ---------------------------------------------------------------------------
   メダ活 — オフラインで開くための控え

   ビオトープの前に立って記録する道具なので、電波が届かない場所で開けないと
   意味がない。ここで持つのは「アプリの一式」だけで、記録そのものは扱わない
   （記録は localStorage / IndexedDB にあり、通信もしないため控える先がない）。

   VERSION は公開のたびに scripts/build-site.mjs が差し替える。中身が変わると
   ブラウザがこのファイルの差分に気づき、新しい版を入れ直す。
--------------------------------------------------------------------------- */
var VERSION = "__BUILD__";
var CACHE = "meda-katsu-" + VERSION;

/* 開くのに要るもの。ここに無いものは、その場で取りに行って控える */
var SHELL = [
  "./",
  "./index.html",
  "./src/app.css",
  "./src/icons.js",
  "./src/app.js",
  "./src/web.js",
  "./manifest.webmanifest",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
  "./assets/apple-touch-icon.png"
];

self.addEventListener("install", function (ev) {
  ev.waitUntil(
    caches.open(CACHE).then(function (cache) {
      /*
       * addAll は 1 つ落ちると全部落ちる。1 ファイル取れなかっただけで
       * オフラインで何も開けなくなるより、取れた分を控えるほうがいい
       * （足りないものは fetch のときに取りに行く）。
       */
      return Promise.all(
        SHELL.map(function (url) {
          return cache.add(new Request(url, { cache: "reload" })).catch(function () {});
        })
      );
    })
  );
});

self.addEventListener("activate", function (ev) {
  ev.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.map(function (key) {
          if (key !== CACHE && key.indexOf("meda-katsu-") === 0) return caches.delete(key);
        })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

/* 待っている新しい版に、すぐ交代してよいと伝える（画面の「更新する」から来る） */
self.addEventListener("message", function (ev) {
  if (ev.data === "skip-waiting") self.skipWaiting();
});

self.addEventListener("fetch", function (ev) {
  var req = ev.request;
  if (req.method !== "GET") return;

  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  /*
   * ページそのものは新しいほうを先に試す。控えを先に返す作りだと、
   * 直したはずのものが何度読み込んでも古いまま出る。
   * 通信できなければ控えたページを返す（これがオフラインで開ける道）。
   */
  if (req.mode === "navigate") {
    ev.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put("./index.html", copy); });
        return res;
      }).catch(function () {
        return caches.match("./index.html").then(function (hit) {
          return hit || caches.match("./");
        });
      })
    );
    return;
  }

  /*
   * それ以外（CSS・JS・アイコン）は控えを即返し、裏で取り直す。
   * 表示を待たせずに、次に開くときは新しくなっている。
   */
  ev.respondWith(
    caches.match(req).then(function (hit) {
      var fresh = fetch(req).then(function (res) {
        if (res && res.status === 200 && res.type === "basic") {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        return hit;
      });
      return hit || fresh;
    })
  );
});
