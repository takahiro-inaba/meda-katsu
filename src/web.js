/* ---------------------------------------------------------------------------
   メダ活 — URL で開いたときだけ効くもの

   ここにあるのは、公開したページとして配ったときにだけ意味を持つ 3 つ。
     1. オフラインで開けるようにする（Service Worker の登録と更新の知らせ）
     2. ホーム画面に追加する導線
     3. 初めて開いた人への短い説明

   1ファイル版（file:// で開くもの）と Artifact 版には入れない。
   Service Worker は http(s) でしか動かず、入れても黙って失敗するだけだから。
--------------------------------------------------------------------------- */
(function () {
  "use strict";

  var WELCOME_KEY = "meda-katsu/welcome";
  var STORE_KEY = "meda-katsu/v1";
  var onWeb = location.protocol === "http:" || location.protocol === "https:";

  function readFlag(key) {
    try { return localStorage.getItem(key); } catch (err) { return null; }
  }
  function writeFlag(key, value) {
    try { localStorage.setItem(key, value); } catch (err) { /* 保存できない表示では覚えない */ }
  }

  /* --- 更新の知らせ --------------------------------------------------------
     新しい版を控えたことに気づけないと、直したものがいつまでも出ない。
     勝手に読み込み直すと入力中の内容が消えるので、押してもらう。
  ------------------------------------------------------------------------- */
  function showUpdateBar(worker) {
    if (document.querySelector(".update-bar")) return;
    var bar = document.createElement("div");
    bar.className = "update-bar";
    bar.setAttribute("role", "status");

    var text = document.createElement("span");
    text.textContent = "新しい版があります";

    var apply = document.createElement("button");
    apply.className = "btn sm";
    apply.type = "button";
    apply.textContent = "更新する";
    apply.addEventListener("click", function () {
      apply.disabled = true;
      worker.postMessage("skip-waiting");
    });

    var later = document.createElement("button");
    later.className = "btn ghost sm";
    later.type = "button";
    later.textContent = "あとで";
    later.addEventListener("click", function () { bar.remove(); });

    bar.appendChild(text);
    bar.appendChild(apply);
    bar.appendChild(later);
    document.body.appendChild(bar);
  }

  function watchWorker(reg) {
    if (reg.waiting && navigator.serviceWorker.controller) showUpdateBar(reg.waiting);
    reg.addEventListener("updatefound", function () {
      var next = reg.installing;
      if (!next) return;
      next.addEventListener("statechange", function () {
        /* controller があるときだけ＝2回目以降。初回の登録は「更新」ではない */
        if (next.state === "installed" && navigator.serviceWorker.controller) showUpdateBar(next);
      });
    });
  }

  /*
   * 埋め込まれた画面（sandbox の iframe）では navigator.serviceWorker に
   * 触れるだけで SecurityError になる。保存と同じで、駄目でも他は動かす。
   */
  try {
    if (onWeb && "serviceWorker" in navigator) {
      var reloading = false;
      navigator.serviceWorker.addEventListener("controllerchange", function () {
        if (reloading) return;
        reloading = true;
        location.reload();
      });

      window.addEventListener("load", function () {
        /*
         * 登録は最初の描画を待ってから。ビオトープの前で開いて最初に見たいのは
         * 水温であって、控えの取得ではない。
         */
        try {
          navigator.serviceWorker.register("./service-worker.js").then(watchWorker, function () {
            /* 登録できないだけ。オフラインで開けなくなるが、記録は取れる */
          });
        } catch (err) { /* 同期で投げる環境もある */ }
      });
    }
  } catch (err) { /* オフライン対応を諦めるだけで、台帳はそのまま使える */ }

  /* --- ホーム画面に追加 ----------------------------------------------------
     ボタンはサイドバー（index.html）とダッシュボードの末尾に置いてあり、既定では隠してある。
     入れられると分かったときにだけ、この印で出す。
  ------------------------------------------------------------------------- */
  var deferredPrompt = null;

  function installed() {
    return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
      navigator.standalone === true;
  }

  function isIOS() {
    return /iP(hone|ad|od)/.test(navigator.userAgent) ||
      /* iPadOS 13 以降は Mac を名乗る。触れる Mac は iPad だけ */
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }

  function markInstallable(yes) {
    if (yes) document.documentElement.setAttribute("data-installable", "yes");
    else document.documentElement.removeAttribute("data-installable");
  }

  /** iOS には追加を頼む仕組みがないので、場所を教える */
  function iosHowTo() {
    var dialog = document.createElement("dialog");
    dialog.innerHTML =
      '<div class="dialog-body">' +
      '<h2 class="dialog-title">ホーム画面に追加する</h2>' +
      '<ol class="howto">' +
      "<li>画面の下（または上）にある<strong>共有ボタン</strong>（□から↑が出ている印）を押す</li>" +
      "<li>並んだ中から<strong>「ホーム画面に追加」</strong>を選ぶ</li>" +
      "<li>右上の<strong>「追加」</strong>を押す</li>" +
      "</ol>" +
      '<p class="muted" style="font-size:13px; margin:0">' +
      "追加すると、アプリのように開けて、電波が届かない場所でも記録できます。" +
      "記録の場所は変わらないので、これまでの記録はそのまま出ます。</p>" +
      '<div class="form-actions"><button class="btn" type="button" value="close">閉じる</button></div>' +
      "</div>";
    document.body.appendChild(dialog);
    dialog.querySelector("button").addEventListener("click", function () { dialog.close(); });
    dialog.addEventListener("close", function () { dialog.remove(); });
    dialog.showModal();
  }

  window.addEventListener("beforeinstallprompt", function (ev) {
    ev.preventDefault();
    deferredPrompt = ev;
    markInstallable(true);
  });

  window.addEventListener("appinstalled", function () {
    deferredPrompt = null;
    markInstallable(false);
  });

  if (onWeb && isIOS() && !installed()) markInstallable(true);

  /** app.js の「ホーム画面に追加」から呼ばれる */
  window.medaInstall = function () {
    if (deferredPrompt) {
      var prompt = deferredPrompt;
      deferredPrompt = null;
      prompt.prompt();
      prompt.userChoice.then(function (choice) {
        if (choice.outcome === "accepted") markInstallable(false);
        else deferredPrompt = prompt; /* 断られただけ。次も押せるように戻す */
      });
      return;
    }
    iosHowTo();
  };

  /* --- 初めて開いた人へ ----------------------------------------------------
     リンクから来た人は、これが何で、記録がどこへ行くのかを知らない。
     いちばん先に伝えるのは「送信しない」こと。預けたつもりで書いてから
     知るのでは遅いし、逆に消えると思って書かないのも困る。
  ------------------------------------------------------------------------- */
  function showWelcome() {
    var dialog = document.createElement("dialog");
    dialog.id = "welcome-dialog";
    dialog.innerHTML =
      '<div class="dialog-body">' +
      '<div class="welcome-brand">' +
      '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">' +
      '<path d="M12 2.5c3.4 4 5.2 6.8 5.2 9.1A5.2 5.2 0 0 1 12 16.8a5.2 5.2 0 0 1-5.2-5.2c0-2.3 1.8-5.1 5.2-9.1Z" stroke-linejoin="round"/>' +
      '<path d="M2.6 19.4c1.6 0 1.6 1.5 3.1 1.5s1.6-1.5 3.1-1.5 1.6 1.5 3.2 1.5 1.6-1.5 3.1-1.5 1.6 1.5 3.1 1.5 1.6-1.5 3.2-1.5" stroke-linecap="round"/>' +
      "</svg>" +
      '<div><h2 class="dialog-title" style="margin:0">メダ活へようこそ</h2>' +
      '<p class="muted" style="margin:2px 0 0; font-size:12px">ビオトープ台帳</p></div>' +
      "</div>" +

      '<ul class="welcome-list">' +
      "<li><strong>ビオトープの記録をつける台帳です。</strong>" +
      "生き物・水温・作業・写真を残すと、記録から気づき（水換えの間隔、水温の急変など）が出ます。</li>" +
      "<li><strong>記録はこのブラウザの中にだけ残ります。</strong>" +
      "登録も通信もありません。そのぶん端末を変えると引き継げないので、" +
      "移すときは「バックアップ / 復元」から JSON を持ち出してください。</li>" +
      "<li><strong>ホーム画面に追加すると、電波が無くても開けます。</strong>" +
      "水辺で記録するための形です。</li>" +
      "</ul>" +

      '<p class="muted" style="font-size:13px; margin:0">' +
      "まず中身を見たいときは、空の画面にある「サンプルデータで試す」を押してください。" +
      "後から消せます。</p>" +

      '<div class="form-actions">' +
      '<button class="btn ghost install-entry" type="button" data-role="install">ホーム画面に追加</button>' +
      '<button class="btn" type="button" data-role="start">はじめる</button>' +
      "</div></div>";

    document.body.appendChild(dialog);
    dialog.querySelector('[data-role="start"]').addEventListener("click", function () { dialog.close(); });
    dialog.querySelector('[data-role="install"]').addEventListener("click", function () {
      dialog.close();
      window.medaInstall();
    });
    dialog.addEventListener("close", function () {
      writeFlag(WELCOME_KEY, "seen");
      dialog.remove();
    });
    dialog.showModal();
  }

  /*
   * 出すのは「開いたのが初めて」のときだけ。
   * 記録が入っているブラウザに説明を出すと、毎回どかす手間になる。
   */
  if (onWeb && readFlag(WELCOME_KEY) === null && readFlag(STORE_KEY) === null) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", showWelcome);
    } else {
      showWelcome();
    }
  }
})();
