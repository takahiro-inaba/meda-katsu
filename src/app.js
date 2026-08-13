/* ---------------------------------------------------------------------------
   メダ活 — ビオトープ台帳
   保存先はブラウザの localStorage。サーバは使わない。
--------------------------------------------------------------------------- */
(function () {
  "use strict";

  var STORE_KEY = "meda-katsu/v1";
  var THEME_KEY = "meda-katsu/theme";
  var LOG_TYPES = ["餌やり", "水換え", "足し水", "掃除", "観察", "その他"];

  /*
   * 生き物の数は保持せず、出来事の積み上げから計算する。
   * sign 1 = 増える / -1 = 減る / 0 = その時点の数え直し（絶対値で置き換える）
   */
  var EVENT_KINDS = [
    { kind: "導入", sign: 1, verb: "入れた" },
    { kind: "繁殖", sign: 1, verb: "増えた" },
    { kind: "死亡", sign: -1, verb: "減った" },
    { kind: "譲渡", sign: -1, verb: "出した" },
    { kind: "数え直し", sign: 0, verb: "数えたら" }
  ];

  function kindOf(name) {
    return EVENT_KINDS.filter(function (k) { return k.kind === name; })[0] || EVENT_KINDS[0];
  }

  /*
   * 水草・底床・機材。性質は違うが「入れた → 使っている → 撤去した」という
   * 一生は同じなので、種別を持つ一つの表で扱う。
   * 量は「3株」「20L」「1台」と単位がばらばらなので自由入力にする。
   */
  /*
   * 測定時刻。水温は朝と昼で数℃違うため、時刻を持たないと
   * 「水温が変わった」のか「測る時間が違った」のか区別できない。
   * 時刻のない古い記録は「不明」のまま扱い、後から作らない。
   */
  var TIME_BANDS = [
    { key: "朝", from: 4, to: 10, label: "朝（4〜10時）" },
    { key: "昼", from: 10, to: 16, label: "昼（10〜16時）" },
    { key: "夕夜", from: 16, to: 4, label: "夕・夜（16〜4時）" }
  ];

  function bandOf(time) {
    if (!time) return null;
    var hour = Number(String(time).split(":")[0]);
    if (isNaN(hour)) return null;
    if (hour >= 4 && hour < 10) return "朝";
    if (hour >= 10 && hour < 16) return "昼";
    return "夕夜";
  }

  function nowTime() {
    var d = new Date();
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }

  /** 時刻まで含めた並び順・グラフの横位置に使う。時刻不明は正午として置く */
  function stampOf(row) {
    var base = parseDate(row.date).getTime();
    var time = row.time || "12:00";
    var parts = String(time).split(":");
    return base + (Number(parts[0]) || 0) * 3600000 + (Number(parts[1]) || 0) * 60000;
  }

  function fmtTime(row) {
    return row.time ? row.time : "時刻不明";
  }

  var GEAR_CATEGORIES = [
    { key: "水草", note: "植えたもの。増えたり枯れたりする。", placeholder: "アナカリス", amount: "3株" },
    { key: "底床", note: "敷いたもの。何年かで交換する。", placeholder: "赤玉土（中粒）", amount: "20L" },
    { key: "機材", note: "動くもの。止まったら気づきたい。", placeholder: "ソーラーポンプ", amount: "1台" }
  ];
  /*
   * グラフの座標系の幅。SVG は横幅いっぱいに拡大縮小されるので、
   * 実際の表示幅と離れるほど文字だけが小さく（大きく）なる。
   * スマホでは座標系そのものを狭くして、目盛りが読める大きさを保つ。
   */
  var VH = 230;
  var VW = 760;

  /* --- 季節 ----------------------------------------------------------------
     ビオトープは季節そのものなので、水の色を季節で変える。
     ボタンなどの色は動かさない（対比を検証した値を保つため）。
  ------------------------------------------------------------------------- */

  var SEASONS = [
    { key: "spring", label: "春", icon: "sprout", months: [3, 4, 5] },
    { key: "summer", label: "夏", icon: "leaf", months: [6, 7, 8] },
    { key: "autumn", label: "秋", icon: "leaf", months: [9, 10, 11] },
    { key: "winter", label: "冬", icon: "ripple", months: [12, 1, 2] }
  ];

  function season() {
    var m = new Date().getMonth() + 1;
    return SEASONS.filter(function (s2) { return s2.months.indexOf(m) >= 0; })[0];
  }

  /* --- 生きている水面 ------------------------------------------------------
     ダッシュボードの主役。水温で色みが動き、メダカがゆっくり泳ぐ。
     動きを減らす設定のときは 1 枚だけ描いて止める。
  ------------------------------------------------------------------------- */

  var waterAnim = null;

  function startWaterHero(canvas, temp, population) {
    if (waterAnim) { cancelAnimationFrame(waterAnim); waterAnim = null; }
    if (!canvas || !canvas.getContext) return;

    var ctx = canvas.getContext("2d");
    var styles = getComputedStyle(document.documentElement);
    var top = styles.getPropertyValue("--water-1").trim() || "#e6f2ec";
    var bottom = styles.getPropertyValue("--water-2").trim() || "#b9dfd0";
    var inkRgb = styles.getPropertyValue("--water-ink").trim() || "20, 40, 32";

    /* 22℃ を中心に、暖かいほど明るく、冷たいほど沈んだ色に寄せる */
    var warmth = Math.max(-1, Math.min(1, ((Number(temp) || 22) - 22) / 9));

    var still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    /* 飾りではなく記録の反映。いる数が多いほど水面もにぎやかになる */
    var count = Math.max(0, Math.min(8, Math.round((population || 0) / 8)));
    var fish = [];
    for (var i = 0; i < count; i++) {
      fish.push({
        x: Math.random(),
        y: 0.28 + Math.random() * 0.55,
        speed: (0.012 + Math.random() * 0.02) * (Math.random() < 0.5 ? -1 : 1),
        scale: 0.6 + Math.random() * 0.6,
        phase: Math.random() * 6.28
      });
    }

    function draw(t) {
      var ratio = Math.min(window.devicePixelRatio || 1, 2);
      var w = canvas.clientWidth;
      var h = canvas.clientHeight;
      if (!w || !h) return;
      if (canvas.width !== w * ratio) { canvas.width = w * ratio; canvas.height = h * ratio; }
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, w, h);

      var grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, top);
      grad.addColorStop(1, bottom);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      /* 水温の色み */
      ctx.fillStyle = warmth >= 0
        ? "rgba(235, 175, 80, " + (warmth * 0.16).toFixed(3) + ")"
        : "rgba(70, 130, 190, " + (-warmth * 0.16).toFixed(3) + ")";
      ctx.fillRect(0, 0, w, h);

      /* 水面のうねり */
      ctx.lineWidth = 1.4;
      for (var r = 0; r < 4; r++) {
        var y0 = h * (0.2 + r * 0.2);
        ctx.strokeStyle = "rgba(" + inkRgb + ", " + (0.07 + r * 0.012).toFixed(3) + ")";
        ctx.beginPath();
        for (var x = 0; x <= w; x += 6) {
          var y = y0 +
            Math.sin(x / (70 + r * 22) + t / (2600 + r * 700) + r) * (3.5 + r) +
            Math.sin(x / 33 - t / 3400) * 1.2;
          if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      /* メダカ */
      fish.forEach(function (f) {
        var fx = ((f.x + (still ? 0 : (t / 1000) * f.speed)) % 1 + 1) % 1;
        var px = fx * (w + 60) - 30;
        var py = f.y * h + Math.sin(t / 1400 + f.phase) * 5;
        var dir = f.speed >= 0 ? 1 : -1;
        var len = 15 * f.scale;
        var hgt = 5.4 * f.scale;

        ctx.save();
        ctx.translate(px, py);
        ctx.scale(dir, 1);
        ctx.fillStyle = "rgba(" + inkRgb + ", " + (0.26 + f.scale * 0.16).toFixed(3) + ")";
        ctx.beginPath();
        ctx.ellipse(0, 0, len / 2, hgt / 2, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        var tailWag = Math.sin(t / 260 + f.phase) * hgt * 0.35;
        ctx.moveTo(-len / 2 + 1, 0);
        ctx.lineTo(-len / 2 - hgt * 0.9, -hgt * 0.7 + tailWag);
        ctx.lineTo(-len / 2 - hgt * 0.9, hgt * 0.7 + tailWag);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      });

      if (!still && canvas.isConnected) waterAnim = requestAnimationFrame(draw);
    }

    draw(still ? 0 : performance.now());
  }

  /* --- アイコン ------------------------------------------------------------ */

  var VIEW_ICONS = {
    dashboard: "ripple", creatures: "medaka", water: "thermometer",
    logs: "topup", gear: "sprout", photos: "camera"
  };

  var LOG_ICONS = {
    "餌やり": "food", "水換え": "waterchange", "足し水": "topup",
    "掃除": "clean", "観察": "observe", "その他": "dot"
  };

  var GEAR_ICONS = { "水草": "plant", "底床": "substrate", "機材": "pump" };

  /** 種類の名前から絵柄を選ぶ。当てはまらないものはメダカの姿で代用する */
  function speciesIcon(name) {
    var n = String(name || "");
    if (/ドジョウ|どじょう|鰌/.test(n)) return "loach";
    if (/エビ|えび|蝦|海老/.test(n)) return "shrimp";
    if (/タニシ|たにし|貝|カワニナ|巻貝/.test(n)) return "snail";
    if (/藻|草|モス|アナカリス|マツモ/.test(n)) return "plant";
    return "medaka";
  }

  function chartWidth() { return window.innerWidth < 720 ? 340 : 760; }

  /* --- 保存 --------------------------------------------------------------- */

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function emptyState() {
    var id = uid();
    return {
      version: 5,
      activeBiotopeId: id,
      biotopes: [{ id: id, name: "メインのビオトープ", startedAt: today(), note: "" }],
      creatures: [],
      events: [],
      measurements: [],
      logs: [],
      photos: [],
      gear: []
    };
  }

  var didMigrate = false;

  function migrate(data) {
    if (data.version < 5) didMigrate = true;
    /* v1 は数を直接持っていたので、その数を「導入」の出来事に読み替える */
    if (data.version < 2) {
      data.creatures.forEach(function (c) {
        data.events.push({
          id: uid(), biotopeId: c.biotopeId, creatureId: c.id,
          date: c.introducedAt || today(), kind: "導入",
          amount: Number(c.count) || 0, note: "以前の記録から引き継ぎ"
        });
        delete c.count;
      });
    }
    /* v4 までの測定は時刻を持たない。作らずに「不明」のままにする */
    if (data.version < 5) {
      data.measurements.forEach(function (m) { if (m.time === undefined) m.time = null; });
    }
    data.version = 5;
    return data;
  }

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return emptyState();
      var data = JSON.parse(raw);
      if (!data || !Array.isArray(data.biotopes) || data.biotopes.length === 0) return emptyState();
      data.creatures = data.creatures || [];
      data.events = data.events || [];
      data.measurements = data.measurements || [];
      data.logs = data.logs || [];
      data.photos = data.photos || [];
      data.gear = data.gear || [];
      data = migrate(data);
      if (!data.biotopes.some(function (b) { return b.id === data.activeBiotopeId; })) {
        data.activeBiotopeId = data.biotopes[0].id;
      }
      return data;
    } catch (err) {
      console.warn("保存データを読めなかったため、新規に開始します", err);
      return emptyState();
    }
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (err) {
      toast("保存できませんでした。ブラウザの保存容量を確認してください。");
    }
  }

  /* --- 写真の保管庫 --------------------------------------------------------
     写真は localStorage に入らない（全体で 5MB 程度しかない）。
     記録の JSON は localStorage、画像そのものは IndexedDB に置く。
  ------------------------------------------------------------------------- */

  var DB_NAME = "meda-katsu";
  var PHOTO_STORE = "photos";
  var dbPromise = null;
  var photoUrls = {}; // id → objectURL。作り直すと ちらつくので使い回す

  function db() {
    if (!dbPromise) {
      dbPromise = new Promise(function (resolve, reject) {
        var req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = function () { req.result.createObjectStore(PHOTO_STORE); };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    }
    return dbPromise;
  }

  function photoTx(mode, fn) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction(PHOTO_STORE, mode);
        var req = fn(tx.objectStore(PHOTO_STORE));
        tx.oncomplete = function () { resolve(req ? req.result : undefined); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error); };
      });
    });
  }

  function putPhotoBlob(id, blob) { return photoTx("readwrite", function (s) { return s.put(blob, id); }); }
  function getPhotoBlob(id) { return photoTx("readonly", function (s) { return s.get(id); }); }

  function dropPhotoBlobs(ids) {
    if (ids.length === 0) return Promise.resolve();
    ids.forEach(function (id) {
      if (photoUrls[id]) { URL.revokeObjectURL(photoUrls[id]); delete photoUrls[id]; }
    });
    return photoTx("readwrite", function (s) { ids.forEach(function (id) { s.delete(id); }); });
  }

  /** 端末の写真は数MBある。長辺 1600px の JPEG に縮めてから保存する。 */
  function shrink(file) {
    var MAX_EDGE = 1600;
    return createImageBitmap(file, { imageOrientation: "from-image" }).then(function (bmp) {
      var scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
      var w = Math.round(bmp.width * scale);
      var h = Math.round(bmp.height * scale);
      var canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
      bmp.close();
      return new Promise(function (resolve) {
        canvas.toBlob(function (blob) { resolve({ blob: blob, w: w, h: h }); }, "image/jpeg", 0.82);
      });
    });
  }

  var state = load();
  var ui = {
    view: "dashboard", range: 90, logType: "餌やり",
    eventCreatureId: null, eventKind: "繁殖", photoId: null,
    gearCategory: "水草", showRemoved: false, band: "all"
  };
  var undoSnapshot = null;

  if (didMigrate) save();

  /* --- 明るさ --------------------------------------------------------------
     既定はライト。OS や表示側のテーマには追従しない。
     暗くするのはこの画面で選んだときだけ。
  ------------------------------------------------------------------------- */

  function currentTheme() {
    try { return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light"; }
    catch (err) { return "light"; }
  }

  function applyTheme(name) {
    if (name === "dark") document.documentElement.setAttribute("data-app-theme", "dark");
    else document.documentElement.removeAttribute("data-app-theme");
    var btn = document.getElementById("theme-toggle");
    if (btn) btn.textContent = name === "dark" ? "明るくする" : "暗くする";
  }

  applyTheme(currentTheme());

  /* --- 日付・数値 --------------------------------------------------------- */

  function today() {
    var d = new Date();
    return (
      d.getFullYear() +
      "-" + String(d.getMonth() + 1).padStart(2, "0") +
      "-" + String(d.getDate()).padStart(2, "0")
    );
  }

  function parseDate(s) {
    var p = String(s || "").split("-");
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }

  function fmtShort(s) {
    var d = parseDate(s);
    return d.getMonth() + 1 + "/" + d.getDate();
  }

  function fmtLong(s) {
    var d = parseDate(s);
    return d.getFullYear() + "年" + (d.getMonth() + 1) + "月" + d.getDate() + "日";
  }

  function daysSince(s) {
    var ms = parseDate(today()).getTime() - parseDate(s).getTime();
    return Math.round(ms / 86400000);
  }

  function relative(s) {
    var n = daysSince(s);
    if (n === 0) return "今日";
    if (n === 1) return "昨日";
    return n + "日前";
  }

  function num(v, decimals) {
    if (v === null || v === undefined || v === "" || isNaN(v)) return "—";
    return Number(v).toFixed(decimals === undefined ? 1 : decimals);
  }

  function esc(s) {
    return String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* --- 抽出 --------------------------------------------------------------- */

  function activeBiotope() {
    return state.biotopes.filter(function (b) { return b.id === state.activeBiotopeId; })[0] || state.biotopes[0];
  }

  function mine(list) {
    return list.filter(function (r) { return r.biotopeId === state.activeBiotopeId; });
  }

  function byDateDesc(a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; }
  function byDateAsc(a, b) { return a.date > b.date ? 1 : a.date < b.date ? -1 : 0; }

  function measurements() {
    return mine(state.measurements).slice().sort(function (a, b) { return stampOf(a) - stampOf(b); });
  }

  /** 選ばれた時間帯だけに絞る。時刻不明は「すべて」のときだけ含める */
  function inBand(rows) {
    if (ui.band === "all") return rows;
    return rows.filter(function (r) { return bandOf(r.time) === ui.band; });
  }
  function logs() { return mine(state.logs).slice().sort(byDateDesc); }
  function creatures() { return mine(state.creatures); }

  function inRange(rows) {
    if (ui.range === "all") return rows;
    var cutoff = Date.now() - ui.range * 86400000;
    return rows.filter(function (r) { return parseDate(r.date).getTime() >= cutoff; });
  }

  function seriesOf(rows, key) {
    return rows
      .filter(function (r) { return r[key] !== null && r[key] !== undefined && r[key] !== ""; })
      .map(function (r) { return { t: stampOf(r), v: Number(r[key]), date: r.date, time: r.time }; });
  }

  function eventsOf(creatureId) {
    return state.events
      .filter(function (e) { return e.creatureId === creatureId; })
      .sort(byDateAsc);
  }

  function applyEvent(count, e) {
    var sign = kindOf(e.kind).sign;
    var amount = Number(e.amount) || 0;
    return sign === 0 ? amount : Math.max(0, count + sign * amount);
  }

  function countOf(creatureId) {
    return eventsOf(creatureId).reduce(applyEvent, 0);
  }

  function totalCount() {
    return creatures().reduce(function (sum, c) { return sum + countOf(c.id); }, 0);
  }

  /** 合計匹数の推移。数は日をまたいで一定なので階段状に描く。 */
  function countSeries() {
    var all = mine(state.events).slice().sort(byDateAsc);
    if (all.length === 0) return [];
    var per = {};
    var points = [];
    all.forEach(function (e, i) {
      per[e.creatureId] = applyEvent(per[e.creatureId] || 0, e);
      var isLastOfDay = i === all.length - 1 || all[i + 1].date !== e.date;
      if (!isLastOfDay) return;
      var total = 0;
      Object.keys(per).forEach(function (k) { total += per[k]; });
      points.push({ t: parseDate(e.date).getTime(), v: total, date: e.date });
    });
    /* 最後の変化から今日までは同じ数が続いている */
    var last = points[points.length - 1];
    if (last && last.date !== today()) {
      points.push({ t: parseDate(today()).getTime(), v: last.v, date: today() });
    }
    return points;
  }

  function recentEvents(limit) {
    return mine(state.events).slice().sort(byDateDesc).slice(0, limit);
  }

  function changeWithin(days) {
    var cutoff = Date.now() - days * 86400000;
    var plus = 0, minus = 0;
    mine(state.events).forEach(function (e) {
      if (parseDate(e.date).getTime() < cutoff) return;
      var sign = kindOf(e.kind).sign;
      if (sign > 0) plus += Number(e.amount) || 0;
      else if (sign < 0) minus += Number(e.amount) || 0;
    });
    return { plus: plus, minus: minus };
  }

  function photos() { return mine(state.photos).slice().sort(byDateDesc); }

  function photosOfLog(logId) {
    return state.photos.filter(function (p) { return p.logId === logId; });
  }

  /** 端末から選ばれた画像を縮めて保管し、記録に加える */
  function addPhotos(files, meta) {
    var list = Array.prototype.slice.call(files).filter(function (f) { return /^image\//.test(f.type); });
    if (list.length === 0) return Promise.resolve(0);
    toast(list.length + " 枚を取り込んでいます…");

    return Promise.all(list.map(function (file) {
      return shrink(file).then(function (out) {
        var id = uid();
        return putPhotoBlob(id, out.blob).then(function () {
          return {
            id: id, biotopeId: state.activeBiotopeId,
            date: meta.date || today(), caption: meta.caption || "",
            logId: meta.logId || null, w: out.w, h: out.h, bytes: out.blob.size
          };
        });
      });
    })).then(function (records) {
      state.photos = state.photos.concat(records);
      save();
      render();
      toast(records.length + " 枚を取り込みました");
      return records.length;
    }).catch(function (err) {
      console.warn("写真の取り込みに失敗", err);
      toast("写真を取り込めませんでした。保存容量が足りないかもしれません。");
      return 0;
    });
  }

  function creatureById(id) {
    return state.creatures.filter(function (c) { return c.id === id; })[0] || null;
  }

  function lastLogOf(type) {
    var hit = logs().filter(function (l) { return l.type === type; })[0];
    return hit || null;
  }

  /* --- 変更 --------------------------------------------------------------- */

  function commit(fn) {
    fn();
    save();
    render();
  }

  function removeWithUndo(message, fn) {
    undoSnapshot = JSON.stringify(state);
    commit(fn);
    toast(message, "元に戻す", function () {
      if (!undoSnapshot) return;
      state = JSON.parse(undoSnapshot);
      undoSnapshot = null;
      save();
      render();
      toast("元に戻しました");
    });
  }

  /* --- グラフ ------------------------------------------------------------- */

  function niceScale(min, max) {
    if (min === max) { min -= 0.5; max += 0.5; }
    var span = max - min;
    var raw = span / 4;
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / mag;
    var step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
    var lo = Math.floor(min / step) * step;
    var hi = Math.ceil(max / step) * step;
    var ticks = [];
    for (var v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v / step) * step);
    return { min: lo, max: hi, ticks: ticks };
  }

  /**
   * 単系列の折れ線グラフ。系列がひとつなので凡例は置かず、
   * 見出しと末尾の直接ラベルで何の値かを示す。
   */
  function lineChartHTML(points, color, unit, decimals, stepped) {
    if (points.length === 0) {
      return '<div class="empty"><span class="empty-title">記録がありません</span><p>この期間の測定はまだありません。</p></div>';
    }

    var narrow = VW < 500;
    var pad = narrow
      ? { top: 14, right: 58, bottom: 24, left: 34 }
      : { top: 16, right: 66, bottom: 26, left: 46 };
    var iw = VW - pad.left - pad.right;
    var ih = VH - pad.top - pad.bottom;

    var vals = points.map(function (p) { return p.v; });
    var scale = niceScale(Math.min.apply(null, vals), Math.max.apply(null, vals));
    var tMin = points[0].t;
    var tMax = points[points.length - 1].t;

    function px(p) {
      if (points.length === 1 || tMax === tMin) return pad.left + iw / 2;
      return pad.left + ((p.t - tMin) / (tMax - tMin)) * iw;
    }
    function py(p) {
      return pad.top + (1 - (p.v - scale.min) / (scale.max - scale.min)) * ih;
    }

    var svg = [];
    svg.push('<svg viewBox="0 0 ' + VW + " " + VH + '" role="img" aria-label="' + esc(unit) + 'の推移">');

    scale.ticks.forEach(function (t) {
      var y = pad.top + (1 - (t - scale.min) / (scale.max - scale.min)) * ih;
      svg.push('<line class="chart-grid" x1="' + pad.left + '" y1="' + y + '" x2="' + (pad.left + iw) + '" y2="' + y + '"/>');
      svg.push('<text class="chart-tick" x="' + (pad.left - 8) + '" y="' + (y + 4) + '" text-anchor="end">' + num(t, decimals) + "</text>");
    });
    svg.push('<line class="chart-axis" x1="' + pad.left + '" y1="' + (pad.top + ih) + '" x2="' + (pad.left + iw) + '" y2="' + (pad.top + ih) + '"/>');

    var ticksX = points.length <= (narrow ? 3 : 6)
      ? points
      : narrow
        ? [points[0], points[points.length - 1]]
        : [points[0], points[Math.floor(points.length / 2)], points[points.length - 1]];
    ticksX.forEach(function (p) {
      svg.push('<text class="chart-tick" x="' + px(p) + '" y="' + (pad.top + ih + 17) + '" text-anchor="middle">' + fmtShort(p.date) + "</text>");
    });

    var d = points.map(function (p, i) {
      if (i === 0) return "M" + px(p).toFixed(1) + " " + py(p).toFixed(1);
      /* 階段状のときは、次の値に変わるまで前の高さを保つ */
      var lead = stepped ? "L" + px(p).toFixed(1) + " " + py(points[i - 1]).toFixed(1) + " " : "";
      return lead + "L" + px(p).toFixed(1) + " " + py(p).toFixed(1);
    }).join(" ");
    svg.push('<path d="' + d + " L" + px(points[points.length - 1]).toFixed(1) + " " + (pad.top + ih) + " L" + px(points[0]).toFixed(1) + " " + (pad.top + ih) + ' Z" fill="' + color + '" fill-opacity="0.1"/>');
    svg.push('<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>');

    if (points.length <= (narrow ? 20 : 40)) {
      points.forEach(function (p) {
        svg.push('<circle class="chart-dot-ring" cx="' + px(p).toFixed(1) + '" cy="' + py(p).toFixed(1) + '" r="4" fill="' + color + '"/>');
      });
    }

    var last = points[points.length - 1];
    svg.push('<circle class="chart-dot-ring" cx="' + px(last).toFixed(1) + '" cy="' + py(last).toFixed(1) + '" r="5" fill="' + color + '"/>');
    svg.push('<text class="chart-endlabel" x="' + (px(last) + 12) + '" y="' + (py(last) + 4) + '">' + num(last.v, decimals) + esc(unit) + "</text>");

    svg.push('<line class="chart-crosshair" x1="0" y1="' + pad.top + '" x2="0" y2="' + (pad.top + ih) + '" style="display:none"/>');
    svg.push("</svg>");

    var payload = points.map(function (p) {
      return { x: px(p), y: py(p), v: p.v, date: p.date, time: p.time || null };
    });

    return (
      '<div class="chart" data-chart="' + esc(JSON.stringify({ points: payload, unit: unit, decimals: decimals })).replace(/"/g, "&quot;") + '">' +
      svg.join("") +
      "</div>"
    );
  }

  function wireCharts(root) {
    root.querySelectorAll(".chart[data-chart]").forEach(function (host) {
      var cfg = JSON.parse(host.getAttribute("data-chart"));
      var svg = host.querySelector("svg");
      var crosshair = host.querySelector(".chart-crosshair");
      var tip = document.createElement("div");
      tip.className = "tooltip";
      tip.style.display = "none";
      host.appendChild(tip);

      function hide() {
        crosshair.style.display = "none";
        tip.style.display = "none";
      }

      host.addEventListener("pointermove", function (ev) {
        var rect = svg.getBoundingClientRect();
        if (!rect.width) return;
        var x = ((ev.clientX - rect.left) / rect.width) * VW;
        var best = null;
        cfg.points.forEach(function (p) {
          if (!best || Math.abs(p.x - x) < Math.abs(best.x - x)) best = p;
        });
        if (!best) return;
        crosshair.setAttribute("x1", best.x);
        crosshair.setAttribute("x2", best.x);
        crosshair.style.display = "";
        tip.innerHTML =
          '<div class="tooltip-date">' + esc(fmtLong(best.date)) +
          (best.time ? " " + esc(best.time) : "") + "</div>" +
          "<strong>" + num(best.v, cfg.decimals) + esc(cfg.unit) + "</strong>";
        tip.style.display = "";
        tip.style.left = (best.x / VW) * rect.width + "px";
        tip.style.top = (best.y / VH) * rect.height - 10 + "px";
      });
      host.addEventListener("pointerleave", hide);
    });
  }

  /* --- 画面: ダッシュボード ----------------------------------------------- */

  function statusPill(days) {
    if (days === null) return '<span class="pill">記録なし</span>';
    var cls = days >= 30 ? "is-crit" : days >= 14 ? "is-warn" : "is-good";
    var word = days >= 30 ? "そろそろ交換" : days >= 14 ? "確認どき" : "良好";
    return '<span class="pill ' + cls + '">' + icon(cls) + esc(word) + "</span>";
  }

  function icon(kind) {
    if (kind === "is-good") return mediaIcon("check", 13);
    if (kind === "is-warn") return mediaIcon("alert", 13);
    return mediaIcon("info", 13);
  }

  function bandChips() {
    var options = [["all", "すべての時間"]].concat(TIME_BANDS.map(function (b) { return [b.key, b.key]; }));
    return (
      '<div class="chips" role="group" aria-label="測定した時間帯">' +
      options.map(function (o) {
        return '<button class="chip" data-action="band" data-band="' + o[0] + '" aria-pressed="' + (ui.band === o[0]) + '">' + esc(o[1]) + "</button>";
      }).join("") +
      "</div>"
    );
  }

  /** 時間帯ごとの平均。朝と昼で何℃違うのかを直接見せる */
  function bandStatsHTML(rows) {
    var groups = TIME_BANDS.map(function (b) {
      var hit = rows.filter(function (r) { return bandOf(r.time) === b.key; });
      return { label: b.label, rows: hit };
    });
    var unknown = rows.filter(function (r) { return !bandOf(r.time); });
    if (unknown.length) groups.push({ label: "時刻の記録なし", rows: unknown });

    var shown = groups.filter(function (g) { return g.rows.length > 0; });
    if (shown.length === 0) return "";

    return (
      '<div class="tiles">' +
      shown.map(function (g) {
        var stats = statsOf(g.rows, "temp");
        return (
          '<div class="card tile">' +
          '<div class="tile-label">' + esc(g.label) + "</div>" +
          '<div class="tile-value">' + (stats ? num(stats.avg) + '<small>℃</small>' : '<span class="muted">—</span>') + "</div>" +
          '<div class="tile-meta">' + g.rows.length + "回" +
          (stats ? " ・ " + num(stats.min) + "〜" + num(stats.max) + "℃" : "") + "</div>" +
          "</div>"
        );
      }).join("") +
      "</div>"
    );
  }

  function rangeChips() {
    return (
      '<div class="chips" role="group" aria-label="表示期間">' +
      [[30, "30日"], [90, "90日"], ["all", "全期間"]]
        .map(function (r) {
          return '<button class="chip" data-action="range" data-range="' + r[0] + '" aria-pressed="' + (String(ui.range) === String(r[0])) + '">' + r[1] + "</button>";
        })
        .join("") +
      "</div>"
    );
  }

  function dashboardView() {
    var rows = measurements();
    var latest = rows[rows.length - 1];
    var temps = inBand(inRange(rows));
    var waterChange = lastLogOf("水換え");
    var species = {};
    creatures().forEach(function (c) { species[c.species] = true; });
    var change30 = changeWithin(30);

    var hasTemp = latest && latest.temp !== "" && latest.temp !== null && latest.temp !== undefined;
    var hero = hasTemp
      ? '<div><div class="hero-label">いまの水温</div><div class="hero-value">' + num(latest.temp) + '<span class="hero-unit">℃</span></div></div>' +
        '<div class="hero-meta">' + esc(fmtLong(latest.date)) +
        (latest.time ? " " + esc(latest.time) + (bandOf(latest.time) ? "（" + esc(bandOf(latest.time)) + "）" : "") : "") +
        " ・ " + esc(relative(latest.date)) + "に測定" +
        (latest.ph ? " ・ pH " + num(latest.ph, 1) : "") + "</div>"
      : '<div><div class="hero-label">いまの水温</div><div class="hero-value muted">—</div></div>' +
        '<div class="hero-meta">まだ測定がありません。「水質」から記録できます。</div>';

    return (
      '<div class="page-head"><div>' +
      '<h1 class="page-title">' + esc(activeBiotope().name) + "</h1>" +
      '<p class="page-note"><span class="season-chip">' + mediaIcon(season().icon, 15) + esc(season().label) + "のビオトープ</span>" +
      (activeBiotope().startedAt ? "立ち上げ " + esc(fmtLong(activeBiotope().startedAt)) + " ・ " + daysSince(activeBiotope().startedAt) + "日目" : "") + "</p>" +
      "</div>" +
      '<div class="row" style="gap:8px">' + bandChips() + rangeChips() + "</div></div>" +

      '<div class="card water-card">' +
      '<canvas class="water-canvas" id="water-canvas" aria-hidden="true"></canvas>' +
      '<div class="hero">' + hero + "</div></div>" +

      insightsHTML() +

      '<div class="tiles">' +
      tile("生き物", totalCount() + '<small>匹</small>',
        Object.keys(species).length + "種類 ・ 30日で " +
        (change30.plus || change30.minus ? "＋" + change30.plus + " / −" + change30.minus : "動きなし"), "medaka") +
      tile("最新の pH", latest && latest.ph ? num(latest.ph, 1) : '<span class="muted">—</span>', latest && latest.ph ? esc(relative(latest.date)) + "に測定" : "未測定", "thermometer") +
      tile("最後の水換え", waterChange ? esc(relative(waterChange.date)) : '<span class="muted">—</span>', statusPill(waterChange ? daysSince(waterChange.date) : null), "waterchange") +
      tile("水草・設備", activeGearCount() + '<small>点</small>',
        GEAR_CATEGORIES.map(function (c) { return c.key + " " + gearOf(c.key, false).length; }).join(" ・ "), "sprout") +
      "</div>" +

      '<div class="card">' +
      '<div class="card-head"><span class="card-title">水温の推移（℃）</span><span class="muted">' +
      (ui.band === "all" ? "すべての時間" : ui.band + "だけ") + " ・ " +
      (ui.range === "all" ? "全期間" : "直近" + ui.range + "日") + "</span></div>" +
      '<div class="card-body">' + lineChartHTML(seriesOf(temps, "temp"), "var(--series-1)", "℃", 1) + "</div>" +
      "</div>" +

      (photos().length
        ? '<div class="card"><div class="card-head"><span class="card-title">最近の写真</span>' +
          '<button class="btn quiet" data-action="view" data-view="photos">すべて見る</button></div>' +
          '<div class="card-body">' + thumbsHTML(photos().slice(0, 5)) + "</div></div>"
        : "") +

      '<div class="card">' +
      '<div class="card-head"><span class="card-title">最近の作業</span><button class="btn quiet" data-action="view" data-view="logs">すべて見る</button></div>' +
      '<div class="card-body">' + timelineHTML(logs().slice(0, 6), false) + "</div>" +
      "</div>" +

      /* 狭い画面では固定ヘッダーに置ききれないので、ここに出す */
      '<div class="only-mobile">' +
      '<div class="row" style="gap:8px">' +
      '<button class="btn ghost grow" data-action="theme">' + (currentTheme() === "dark" ? "明るくする" : "暗くする") + "</button>" +
      '<button class="btn ghost grow" data-action="backup">バックアップ / 復元</button></div>' +
      '<p class="muted" style="font-size:11px; text-align:center; margin:8px 0 0">' +
      "記録はこのブラウザの中にだけ保存されます。別の端末とは共有されません。</p></div>"
    );
  }

  function tile(label, value, meta, iconName) {
    return (
      '<div class="card tile">' +
      '<div class="tile-label">' + (iconName ? mediaIcon(iconName, 15) : "") + esc(label) + "</div>" +
      '<div class="tile-value">' + value + "</div>" +
      '<div class="tile-meta">' + meta + "</div>" +
      "</div>"
    );
  }

  /* --- 画面: 生き物 -------------------------------------------------------- */

  function creatureLabel(c) {
    return c.species + (c.name ? "（" + c.name + "）" : "");
  }

  function eventLine(e) {
    var k = kindOf(e.kind);
    if (k.sign === 0) return "数え直し " + (Number(e.amount) || 0) + " 匹";
    return e.kind + " " + (k.sign > 0 ? "+" : "−") + (Number(e.amount) || 0) + " 匹";
  }

  function creaturesView() {
    var rows = creatures();
    var change = changeWithin(30);
    var counts = countSeries();

    var body = rows.length === 0
      ? emptyHTML("生き物がまだ登録されていません", "上のフォームから、メダカやドジョウなどを登録してください。", "medaka")
      : '<div class="table-wrap"><table>' +
        '<thead><tr><th>種類</th><th>呼び名・系統</th><th class="num">いまの数</th><th>最後の動き</th><th>メモ</th><th></th></tr></thead><tbody>' +
        rows.map(function (c) {
          var evs = eventsOf(c.id);
          var last = evs[evs.length - 1];
          return (
            "<tr>" +
            '<td data-label="種類"><span class="named">' + mediaIcon(speciesIcon(c.species), 22, "creature-icon") +
            "<strong>" + esc(c.species) + "</strong></span></td>" +
            '<td data-label="呼び名">' + (c.name ? esc(c.name) : '<span class="muted">—</span>') + "</td>" +
            '<td class="num" data-label="いまの数">' + countOf(c.id) + '<small class="muted"> 匹</small></td>' +
            '<td data-label="最後の動き">' + (last ? esc(eventLine(last)) + '<span class="muted"> ・ ' + esc(relative(last.date)) + "</span>" : '<span class="muted">—</span>') + "</td>" +
            '<td class="memo">' + (c.note ? esc(c.note) : "") + "</td>" +
            '<td class="actions-cell nowrap">' +
            '<button class="btn ghost sm" data-action="history" data-id="' + c.id + '">増減を記録</button> ' +
            '<button class="btn quiet sm danger" data-action="del-creature" data-id="' + c.id + '">削除</button>' +
            "</td></tr>"
          );
        }).join("") +
        "</tbody></table></div>";

    return (
      '<div class="page-head"><div><h1 class="page-title">生き物</h1>' +
      '<p class="page-note">合計 ' + totalCount() + " 匹。直近30日で " +
      (change.plus || change.minus
        ? "＋" + change.plus + " / −" + change.minus + " 匹の動きがありました。"
        : "数の動きはありません。") +
      "</p></div></div>" +

      (counts.length > 1
        ? '<div class="card"><div class="card-head"><span class="card-title">合計匹数の推移</span>' +
          '<span class="muted">出来事の記録から計算</span></div>' +
          '<div class="card-body">' + lineChartHTML(counts, "var(--series-3)", "匹", 0, true) + "</div></div>"
        : "") +

      '<div class="card"><div class="card-head"><span class="card-title">生き物を追加</span></div><div class="card-body">' +
      '<form id="creature-form" class="stack">' +
      '<div class="form-grid">' +
      field("種類", '<input class="input" name="species" list="species-list" placeholder="ミナミヌマエビ" required>') +
      field("呼び名・系統", '<input class="input" name="name" placeholder="楊貴妃">') +
      field("入れた数", '<input class="input" name="count" type="number" min="0" step="1" value="1" required>') +
      field("導入日", '<input class="input" name="introducedAt" type="date" value="' + today() + '" required>') +
      '<div class="wide">' + field("メモ", '<input class="input" name="note" placeholder="ホームセンターで購入。稚魚10匹。">') + "</div>" +
      "</div>" +
      '<datalist id="species-list"><option value="メダカ"><option value="ドジョウ"><option value="ミナミヌマエビ"><option value="タニシ"><option value="ヤマトヌマエビ"><option value="カワニナ"></datalist>' +
      '<div class="form-actions"><button class="btn" type="submit">追加する</button></div>' +
      "</form></div></div>" +

      '<div class="card"><div class="card-head"><span class="card-title">登録されている生き物</span><span class="muted">' + rows.length + " 件</span></div>" +
      (rows.length === 0 ? '<div class="card-body">' + body + "</div>" : body) +
      "</div>" +

      (rows.length === 0 ? "" :
        '<div class="card"><div class="card-head"><span class="card-title">最近の増減</span>' +
        '<span class="muted">' + mine(state.events).length + " 件の記録</span></div>" +
        '<div class="card-body">' + eventTimelineHTML(recentEvents(8), false, true) + "</div></div>")
    );
  }

  function eventTimelineHTML(rows, allowDelete, showCreature) {
    if (rows.length === 0) {
      return '<div class="empty"><span class="empty-title">まだ動きがありません</span><p>繁殖や死亡を記録すると、匹数の推移がたどれるようになります。</p></div>';
    }
    return (
      '<div class="timeline">' +
      rows.map(function (e) {
        var c = creatureById(e.creatureId);
        return (
          '<div class="timeline-item">' +
          '<div class="timeline-date">' + esc(fmtShort(e.date)) + "<br>" + esc(relative(e.date)) + "</div>" +
          '<div class="timeline-body"><div class="row">' +
          '<span class="tag" data-kind="' + esc(e.kind) + '">' + esc(eventLine(e)) + "</span>" +
          (showCreature ? '<span class="muted">' + esc(c ? creatureLabel(c) : "削除された生き物") + "</span>" : "") +
          (allowDelete ? '<button class="btn quiet sm danger" style="margin-left:auto" data-action="del-event" data-id="' + e.id + '">削除</button>' : "") +
          "</div>" +
          (e.note ? '<div class="timeline-memo">' + esc(e.note) + "</div>" : "") +
          "</div></div>"
        );
      }).join("") +
      "</div>"
    );
  }

  /** 生き物ごとの履歴ダイアログの中身 */
  function renderEventDialog() {
    var c = creatureById(ui.eventCreatureId);
    var host = document.getElementById("event-dialog-body");
    if (!c) { host.innerHTML = ""; return; }
    var k = kindOf(ui.eventKind);

    host.innerHTML =
      '<div class="row" style="justify-content:space-between">' +
      '<h2 class="dialog-title">' + esc(creatureLabel(c)) + "</h2>" +
      '<span class="pill">いま ' + countOf(c.id) + " 匹</span></div>" +

      '<form id="event-form" class="stack">' +
      "<div><span class=\"label\">何があったか</span>" +
      '<div class="chips" role="group" aria-label="出来事の種別">' +
      EVENT_KINDS.map(function (e) {
        return '<button type="button" class="chip" data-action="event-kind" data-kind="' + esc(e.kind) + '" aria-pressed="' + (ui.eventKind === e.kind) + '">' + esc(e.kind) + "</button>";
      }).join("") +
      "</div></div>" +
      '<div class="form-grid">' +
      field("日付", '<input class="input" name="date" type="date" value="' + today() + '" required>') +
      field(k.sign === 0 ? "数えた匹数" : "匹数", '<input class="input" name="amount" type="number" min="0" step="1" value="1" required>', "amount-label") +
      '<div class="wide">' + field("メモ", '<input class="input" name="note" placeholder="水草に卵。稚魚を確認。">') + "</div>" +
      "</div>" +
      '<div class="form-actions"><button class="btn ghost" type="button" data-action="close-dialog">閉じる</button>' +
      '<button class="btn" type="submit">記録する</button></div>' +
      "</form>" +

      '<div><span class="label">この生き物の履歴</span>' +
      eventTimelineHTML(eventsOf(c.id).slice().reverse(), true, false) + "</div>";
  }

  /* --- 気づき --------------------------------------------------------------
     記録から機械的に導ける指摘だけを出す。
     どれも「根拠になった数字」を必ず添える。数字を見せずに助言だけ出すと、
     合っているのか判断できず、そのうち読まれなくなる。
  ------------------------------------------------------------------------- */

  var LEVEL_ORDER = { crit: 0, warn: 1, info: 2, good: 3 };

  function median(values) {
    if (values.length === 0) return null;
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function insights() {
    var out = [];
    var add = function (level, title, evidence, suggestion) {
      out.push({ level: level, title: title, evidence: evidence, suggestion: suggestion });
    };

    var ms = measurements();
    var temps = ms.filter(function (m) { return m.temp !== null && m.temp !== undefined && m.temp !== ""; });
    var phs = ms.filter(function (m) { return m.ph !== null && m.ph !== undefined && m.ph !== ""; });
    var lastTemp = temps[temps.length - 1];
    /*
     * 直前の測定ではなく「同じ時間帯の直前の測定」と比べる。
     * 朝6時の22℃と昼2時の29℃を並べると、時間帯の差を水温の急変と誤って読む。
     */
    var prevTemp = null;
    if (lastTemp) {
      for (var pi = temps.length - 2; pi >= 0; pi--) {
        if (bandOf(temps[pi].time) === bandOf(lastTemp.time)) { prevTemp = temps[pi]; break; }
      }
    }
    var lastPh = phs[phs.length - 1];
    var allLogs = logs();
    var waterChanges = allLogs.filter(function (l) { return l.type === "水換え"; });

    /* 水温 */
    if (lastTemp) {
      var t = Number(lastTemp.temp);
      if (t >= 30) {
        add("crit", "水温が高い状態です",
          fmtLong(lastTemp.date) + " " + fmtTime(lastTemp) + " の測定で " + num(t) + "℃",
          "メダカは 30℃ を超えると弱りやすくなります。日よけ、足し水、水量を増やすなどで下げられます。");
      } else if (t >= 28) {
        add("warn", "水温が上がってきています",
          fmtLong(lastTemp.date) + " " + fmtTime(lastTemp) + " の測定で " + num(t) + "℃",
          "このまま上がると 30℃ に届きます。直射日光が当たる時間を確かめてみてください。");
      } else if (t <= 5) {
        add("info", "水温が下がっています",
          fmtLong(lastTemp.date) + "の測定で " + num(t) + "℃",
          "メダカは低水温では餌を食べなくなります。餌やりを控えめにする時期です。");
      }

      if (prevTemp) {
        var gap = daysBetween(prevTemp.date, lastTemp.date);
        var diff = Number(lastTemp.temp) - Number(prevTemp.temp);
        if (gap <= 7 && Math.abs(diff) >= 5) {
          var bandName = bandOf(lastTemp.time);
          add("warn", "水温が短い間に大きく動きました",
            fmtShort(prevTemp.date) + " " + fmtTime(prevTemp) + " " + num(prevTemp.temp) + "℃ → " +
            fmtShort(lastTemp.date) + " " + fmtTime(lastTemp) + " " + num(t) + "℃" +
            "（" + gap + "日で " + (diff > 0 ? "+" : "−") + num(Math.abs(diff)) + "℃" +
            (bandName ? "・どちらも" + bandName : "") + "）",
            "同じ時間帯どうしの比較なので、時刻の違いによる差ではありません。急な変化は生き物の負担になります。");
        }
      }

      if (daysSince(lastTemp.date) >= 21) {
        add("info", "水温の測定が空いています",
          "最後の測定は " + relative(lastTemp.date) + "（" + fmtLong(lastTemp.date) + "）",
          "季節の変わり目は動きが大きい時期です。数日おきでも記録が残ると推移が見えます。");
      }
    }

    /* 測る時間帯 */
    var temps30 = temps.filter(function (m) { return daysSince(m.date) <= 30; });
    var bandAvg = {};
    TIME_BANDS.forEach(function (b) {
      var hit = temps30.filter(function (m) { return bandOf(m.time) === b.key; });
      if (hit.length >= 2) bandAvg[b.key] = statsOf(hit, "temp").avg;
    });
    var bandKeys = Object.keys(bandAvg);
    if (bandKeys.length >= 2) {
      var values = bandKeys.map(function (k) { return bandAvg[k]; });
      var spread = Math.max.apply(null, values) - Math.min.apply(null, values);
      if (spread >= 2) {
        add("info", "測る時間帯で水温が変わっています",
          "直近30日の平均 — " + bandKeys.map(function (k) { return k + " " + num(bandAvg[k]) + "℃"; }).join(" / ") +
          "（差 " + num(spread) + "℃）",
          "推移を読むときは時間帯を揃えてください。水質の画面で時間帯を選べます。");
      }
    }
    var noTime = temps30.filter(function (m) { return !bandOf(m.time); });
    if (temps30.length >= 5 && noTime.length >= temps30.length * 0.5) {
      add("info", "測定時刻の記録がない回が多めです",
        "直近30日 " + temps30.length + "回のうち " + noTime.length + "回は時刻なし",
        "同じ時間に測って時刻も残すと、季節の変化と時間帯の差を切り分けられます。");
    }

    /* pH */
    if (lastPh) {
      var ph = Number(lastPh.ph);
      if (ph < 6.0 || ph > 8.5) {
        add("warn", "pH が普段の範囲から外れています",
          fmtLong(lastPh.date) + "の測定で pH " + num(ph, 1),
          "メダカが落ち着くのは 6.5〜8.0 あたりとされます。底床や水草、足し水の水を見直す手がかりになります。");
      }
      var phIn30 = phs.filter(function (m) { return daysSince(m.date) <= 30; });
      if (phIn30.length >= 3) {
        var lo = Math.min.apply(null, phIn30.map(function (m) { return Number(m.ph); }));
        var hi = Math.max.apply(null, phIn30.map(function (m) { return Number(m.ph); }));
        if (hi - lo >= 1.0) {
          add("info", "pH の振れ幅が大きめです",
            "直近30日で " + num(lo, 1) + " 〜 " + num(hi, 1) + "（" + phIn30.length + "回の測定）",
            "測る時間帯でも変わります。同じ時間に測ると、本当の変化かどうか切り分けられます。");
        }
      }
    }

    /* 水換え */
    if (waterChanges.length >= 1) {
      var sinceChange = daysSince(waterChanges[0].date);
      var intervals = [];
      for (var i = 0; i < waterChanges.length - 1 && i < 8; i++) {
        intervals.push(daysBetween(waterChanges[i + 1].date, waterChanges[i].date));
      }
      var usual = median(intervals);
      if (sinceChange >= 30) {
        add("warn", "水換えから間があいています",
          "最後の水換えは " + sinceChange + "日前" + (usual ? "（普段はおよそ " + Math.round(usual) + "日おき）" : ""),
          "足し水だけでは蒸発ぶんしか戻りません。少量でも換えると水質が落ち着きます。");
      } else if (usual && sinceChange >= usual * 2 && sinceChange >= 14) {
        add("info", "水換えの間隔が普段より延びています",
          "最後の水換えは " + sinceChange + "日前。これまではおよそ " + Math.round(usual) + "日おき",
          "忙しい時期なら無理はいりません。間隔が変わったこと自体を覚えておくと後で効きます。");
      }
    }

    /* 生き物 */
    var deaths30 = 0;
    var births30 = 0;
    mine(state.events).forEach(function (e) {
      if (daysSince(e.date) > 30) return;
      if (e.kind === "死亡") deaths30 += Number(e.amount) || 0;
      if (e.kind === "繁殖") births30 += Number(e.amount) || 0;
    });
    var total = totalCount();
    if (deaths30 >= 3 && total > 0 && deaths30 >= total * 0.1) {
      add("crit", "この1か月で減りかたが大きいです",
        "直近30日の死亡 " + deaths30 + " 匹（いまの合計 " + total + " 匹）",
        "水温・pH の記録と、同じ時期の作業ログを並べて見てみてください。原因の見当がつくことがあります。");
    } else if (deaths30 >= 3) {
      add("warn", "死亡の記録が続いています",
        "直近30日で " + deaths30 + " 匹",
        "同じ時期の水温と作業ログを見返すと、きっかけが見つかることがあります。");
    }
    if (births30 > 0) {
      add("good", "繁殖しています",
        "直近30日で " + births30 + " 匹増えました",
        "稚魚は親に食べられることがあります。産卵床ごと分けると生き残りやすくなります。");
    }

    creatures().forEach(function (c) {
      var evs = eventsOf(c.id);
      var last = evs[evs.length - 1];
      if (last && daysSince(last.date) >= 120) {
        add("info", creatureLabel(c) + " の数を確かめる時期です",
          "最後に数が動いたのは " + relative(last.date) + "（" + eventLine(last) + "）",
          "エビやタニシは知らないうちに増減します。「数え直し」で今の数に合わせられます。");
      }
    });

    /* 底床 */
    gearOf("底床", false).forEach(function (g) {
      var age = daysSince(g.installedAt);
      if (age >= 730) {
        add("info", g.name + " を敷いてから " + Math.floor(age / 365) + "年たちました",
          fmtLong(g.installedAt) + "から " + age + "日",
          "赤玉土は何年かかけて崩れて泥になります。水の濁りが取れにくくなったら交換の合図です。");
      }
    });

    /* 記録そのもの */
    var lastAnything = [
      ms.length ? ms[ms.length - 1].date : null,
      allLogs.length ? allLogs[0].date : null
    ].filter(Boolean).sort().pop();
    if (lastAnything && daysSince(lastAnything) >= 21) {
      add("info", "記録が途切れています",
        "最後の記録は " + relative(lastAnything) + "（" + fmtLong(lastAnything) + "）",
        "毎日でなくてかまいません。水温だけでも続けると、翌年の同じ時期と比べられます。");
    }

    var ps = photos();
    if (ps.length >= 2 && daysSince(ps[0].date) >= 60) {
      add("info", "写真の間隔があいています",
        "最後の写真は " + relative(ps[0].date) + "。全部で " + ps.length + " 枚",
        "同じ場所から撮った写真が並ぶと、水草の茂りかたの変化がはっきり見えます。");
    }

    return out.sort(function (a, b) { return LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]; });
  }

  function daysBetween(from, to) {
    return Math.round((parseDate(to).getTime() - parseDate(from).getTime()) / 86400000);
  }

  function insightsHTML() {
    var list = insights();
    if (list.length === 0) {
      return (
        '<div class="card"><div class="card-head"><span class="card-title">気づき</span>' +
        '<button class="btn ghost sm" data-action="summary">まとめて相談する</button></div>' +
        '<div class="card-body"><div class="empty"><span class="empty-title">いまのところ気になる動きはありません</span>' +
        "<p>水温・水換え・生き物の増減から、記録の中で目立つ変化を探しています。</p></div></div></div>"
      );
    }
    return (
      '<div class="card">' +
      '<div class="card-head"><span class="card-title">気づき</span>' +
      '<button class="btn ghost sm" data-action="summary">まとめて相談する</button></div>' +
      '<div class="card-body insights">' +
      list.map(function (n) {
        return (
          '<div class="insight">' +
          '<span class="pill is-' + n.level + '">' +
          insightIcon(n.level) + esc(insightWord(n.level)) + "</span>" +
          '<div class="insight-body">' +
          '<div class="insight-title">' + esc(n.title) + "</div>" +
          '<div class="insight-evidence">' + esc(n.evidence) + "</div>" +
          '<div class="insight-suggestion">' + esc(n.suggestion) + "</div>" +
          "</div></div>"
        );
      }).join("") +
      "</div></div>"
    );
  }

  function insightWord(level) {
    return level === "crit" ? "気になる" : level === "warn" ? "注意" : level === "good" ? "順調" : "参考";
  }

  function insightIcon(level) {
    if (level === "good") return mediaIcon("check", 13);
    if (level === "crit" || level === "warn") return mediaIcon("alert", 13);
    return mediaIcon("info", 13);
  }

  /* --- 相談用の要約 --------------------------------------------------------
     アプリからはどこへも送らない。貼り付けられる文章を作るだけ。
     送り先は使う人が選ぶ。
  ------------------------------------------------------------------------- */

  function statsOf(rows, key) {
    var values = rows
      .filter(function (r) { return r[key] !== null && r[key] !== undefined && r[key] !== ""; })
      .map(function (r) { return Number(r[key]); });
    if (values.length === 0) return null;
    var sum = values.reduce(function (a, b) { return a + b; }, 0);
    return {
      count: values.length,
      min: Math.min.apply(null, values),
      max: Math.max.apply(null, values),
      avg: sum / values.length
    };
  }

  /** 推移がわかる程度に間引いた列 */
  function thinned(rows, key, wanted) {
    var withValue = rows.filter(function (r) { return r[key] !== null && r[key] !== undefined && r[key] !== ""; });
    if (withValue.length <= wanted) return withValue;
    var step = (withValue.length - 1) / (wanted - 1);
    var picked = [];
    for (var i = 0; i < wanted; i++) picked.push(withValue[Math.round(i * step)]);
    return picked;
  }

  function buildSummary(question) {
    var b = activeBiotope();
    var ms = measurements();
    var recent = ms.filter(function (m) { return daysSince(m.date) <= 90; });
    var allLogs = logs();
    var lines = [];
    var decimals1 = function (v) { return num(v, 1); };

    lines.push("# ビオトープの記録");
    lines.push("");
    lines.push("- 名前: " + b.name);
    if (b.startedAt) lines.push("- 立ち上げ: " + fmtLong(b.startedAt) + "（" + daysSince(b.startedAt) + "日目）");
    lines.push("- 今日: " + fmtLong(today()));
    lines.push("");

    /* 生き物 */
    var cs = creatures();
    lines.push("## 生き物（合計 " + totalCount() + "匹 / " + cs.length + "種類）");
    if (cs.length === 0) {
      lines.push("- 記録なし");
    } else {
      cs.forEach(function (c) {
        var sums = {};
        var evs = eventsOf(c.id);
        evs.forEach(function (e) {
          sums[e.kind] = (sums[e.kind] || 0) + (Number(e.amount) || 0);
        });
        var parts = EVENT_KINDS.map(function (k) {
          if (!sums[k.kind]) return null;
          return k.kind + (k.sign > 0 ? "+" : k.sign < 0 ? "−" : " ") + sums[k.kind];
        }).filter(Boolean);
        var last = evs[evs.length - 1];
        lines.push(
          "- " + creatureLabel(c) + ": " + countOf(c.id) + "匹" +
          (parts.length ? "（" + parts.join(" / ") + "）" : "") +
          (last ? " 最後の動き " + fmtShort(last.date) + " " + eventLine(last) : "")
        );
      });
      var ch = changeWithin(30);
      lines.push("- 直近30日の増減: ＋" + ch.plus + " / −" + ch.minus);
    }
    lines.push("");

    /* 水温・pH */
    var temp = statsOf(recent, "temp");
    lines.push("## 水温");
    if (!temp) {
      lines.push("- 測定なし");
    } else {
      var lastTemp = thinned(recent, "temp", 1000).slice(-1)[0];
      lines.push("- 最新: " + fmtShort(lastTemp.date) + " " + fmtTime(lastTemp) + " " +
        decimals1(lastTemp.temp) + "℃（" + relative(lastTemp.date) + "）");
      lines.push("- 直近90日: " + temp.count + "回測定、" + decimals1(temp.min) + "〜" + decimals1(temp.max) + "℃（平均 " + decimals1(temp.avg) + "℃）");
      var byBand = [];
      TIME_BANDS.forEach(function (band) {
        var hit = recent.filter(function (m) { return bandOf(m.time) === band.key; });
        var st = statsOf(hit, "temp");
        if (st) byBand.push(band.label + " 平均 " + decimals1(st.avg) + "℃（" + st.count + "回）");
      });
      if (byBand.length) lines.push("- 時間帯ごと: " + byBand.join(" / "));
      lines.push("- 推移: " + thinned(recent, "temp", 6).map(function (m) {
        return fmtShort(m.date) + (m.time ? " " + m.time : "") + " " + decimals1(m.temp);
      }).join(" → "));
    }
    lines.push("");

    var ph = statsOf(recent, "ph");
    lines.push("## pH");
    if (!ph) {
      lines.push("- 測定なし");
    } else {
      lines.push("- 直近90日: " + ph.count + "回測定、" + decimals1(ph.min) + "〜" + decimals1(ph.max) + "（平均 " + decimals1(ph.avg) + "）");
      lines.push("- 推移: " + thinned(recent, "ph", 6).map(function (m) {
        return fmtShort(m.date) + " " + decimals1(m.ph);
      }).join(" → "));
    }
    lines.push("");

    /* 世話 */
    lines.push("## 世話");
    var changes = allLogs.filter(function (l) { return l.type === "水換え"; });
    if (changes.length) {
      var gaps = [];
      for (var i = 0; i < changes.length - 1 && i < 8; i++) {
        gaps.push(daysBetween(changes[i + 1].date, changes[i].date));
      }
      var usual = median(gaps);
      lines.push("- 最後の水換え: " + relative(changes[0].date) + "（" + fmtShort(changes[0].date) + "）" +
        (usual ? " / 普段はおよそ " + Math.round(usual) + "日おき" : ""));
    } else {
      lines.push("- 水換えの記録なし");
    }
    if (allLogs.length) {
      lines.push("- 直近の作業:");
      allLogs.slice(0, 10).forEach(function (l) {
        lines.push("  - " + fmtShort(l.date) + " " + l.type + (l.note ? "：" + l.note : ""));
      });
    }
    lines.push("");

    /* 水草・設備 */
    lines.push("## 水草・底床・機材");
    var anyGear = false;
    GEAR_CATEGORIES.forEach(function (cat) {
      var rows = gearOf(cat.key, false);
      if (rows.length === 0) return;
      anyGear = true;
      lines.push("- " + cat.key + ": " + rows.map(function (g) {
        return g.name + (g.amount ? "（" + g.amount + "）" : "") + " " + gearAge(g);
      }).join("、"));
    });
    var removed = mine(state.gear).filter(function (g) { return g.removedAt; });
    if (removed.length) {
      anyGear = true;
      lines.push("- 撤去済み: " + removed.map(function (g) {
        return g.name + "（" + fmtShort(g.installedAt) + "〜" + fmtShort(g.removedAt) + "）";
      }).join("、"));
    }
    if (!anyGear) lines.push("- 記録なし");
    lines.push("");

    /* 気づき */
    var found = insights();
    if (found.length) {
      lines.push("## アプリが記録から見つけた点");
      found.forEach(function (n) {
        lines.push("- [" + insightWord(n.level) + "] " + n.title + " — " + n.evidence);
      });
      lines.push("");
    }

    lines.push("## 相談したいこと");
    lines.push(question && question.trim() ? question.trim() : "（ここに知りたいことを書いてください）");
    lines.push("");
    lines.push("上の記録をふまえて、気をつける点と次にやるとよいことを教えてください。");

    return lines.join("\n");
  }

  function renderSummaryDialog() {
    var host = document.getElementById("summary-dialog-body");
    host.innerHTML =
      '<h2 class="dialog-title">記録をまとめて相談する</h2>' +
      '<p class="muted" style="margin:0; font-size:13px">' +
      "下の文章をコピーして、Claude や ChatGPT に貼り付けてください。" +
      "アプリからはどこへも送信しません。貼り付け先には、ここに写っている記録が渡ります。</p>" +
      '<label><span class="label">相談したいこと（任意）</span>' +
      '<input class="input" id="summary-question" placeholder="夏場に水温が上がるのを抑えたい。"></label>' +
      '<textarea class="textarea" id="summary-text" rows="12" readonly spellcheck="false" ' +
      'style="font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px"></textarea>' +
      '<div class="form-actions">' +
      '<button class="btn ghost" type="button" data-action="close-dialog">閉じる</button>' +
      '<button class="btn" type="button" data-action="copy-summary">コピーする</button></div>';

    var question = document.getElementById("summary-question");
    var text = document.getElementById("summary-text");
    text.value = buildSummary("");
    question.addEventListener("input", function () { text.value = buildSummary(question.value); });
  }

  /* --- 画面: 水草・設備 ---------------------------------------------------- */

  function gearOf(category, includeRemoved) {
    return mine(state.gear)
      .filter(function (g) { return g.category === category && (includeRemoved || !g.removedAt); })
      .sort(function (a, b) { return a.installedAt < b.installedAt ? 1 : -1; });
  }

  function activeGearCount() {
    return mine(state.gear).filter(function (g) { return !g.removedAt; }).length;
  }

  function gearAge(g) {
    if (g.removedAt) {
      var days = Math.round((parseDate(g.removedAt) - parseDate(g.installedAt)) / 86400000);
      return days + "日間 使用";
    }
    return daysSince(g.installedAt) + "日目";
  }

  function gearTableHTML(category) {
    var rows = gearOf(category, ui.showRemoved);
    var meta = GEAR_CATEGORIES.filter(function (c) { return c.key === category; })[0];

    if (rows.length === 0) {
      return (
        '<div class="empty"><span class="empty-title">' + esc(category) + "の記録がありません</span>" +
        "<p>" + esc(meta.note) + "</p></div>"
      );
    }

    return (
      '<div class="table-wrap"><table>' +
      '<thead><tr><th>名前</th><th>量</th><th>設置日</th><th>経過</th><th>メモ</th><th></th></tr></thead><tbody>' +
      rows.map(function (g) {
        return (
          '<tr' + (g.removedAt ? ' class="is-removed"' : "") + ">" +
          '<td data-label="名前"><span class="named">' + mediaIcon(GEAR_ICONS[category] || "dot", 21, "creature-icon") +
          "<strong>" + esc(g.name) + "</strong></span>" +
          (g.removedAt ? ' <span class="pill">撤去済み</span>' : "") + "</td>" +
          '<td data-label="量">' + (g.amount ? esc(g.amount) : '<span class="muted">—</span>') + "</td>" +
          '<td data-label="設置日">' + esc(fmtLong(g.installedAt)) + "</td>" +
          '<td data-label="経過">' + esc(gearAge(g)) + "</td>" +
          '<td class="memo">' + (g.note ? esc(g.note) : "") + "</td>" +
          '<td class="actions-cell nowrap">' +
          (g.removedAt
            ? '<button class="btn ghost sm" data-action="restore-gear" data-id="' + g.id + '">使用中に戻す</button> '
            : '<button class="btn ghost sm" data-action="remove-gear" data-id="' + g.id + '">撤去した</button> ') +
          '<button class="btn quiet sm danger" data-action="del-gear" data-id="' + g.id + '">削除</button>' +
          "</td></tr>"
        );
      }).join("") +
      "</tbody></table></div>"
    );
  }

  function gearView() {
    var cat = GEAR_CATEGORIES.filter(function (c) { return c.key === ui.gearCategory; })[0];
    var removedCount = mine(state.gear).filter(function (g) { return g.removedAt; }).length;

    return (
      '<div class="page-head"><div><h1 class="page-title">水草・設備</h1>' +
      '<p class="page-note">使用中 ' + activeGearCount() + " 点。撤去したものは記録として残ります。</p></div>" +
      (removedCount
        ? '<div class="chips"><button class="chip" data-action="toggle-removed" aria-pressed="' + !!ui.showRemoved + '">撤去したものも表示（' + removedCount + "）</button></div>"
        : "") +
      "</div>" +

      '<div class="card"><div class="card-head"><span class="card-title">追加する</span></div><div class="card-body">' +
      '<form id="gear-form" class="stack">' +
      "<div><span class=\"label\">種別</span>" +
      '<div class="chips" role="group" aria-label="種別">' +
      GEAR_CATEGORIES.map(function (c) {
        return '<button type="button" class="chip" data-action="gear-category" data-category="' + esc(c.key) + '" aria-pressed="' + (ui.gearCategory === c.key) + '">' +
          mediaIcon(GEAR_ICONS[c.key], 17) + esc(c.key) + "</button>";
      }).join("") +
      "</div></div>" +
      '<div class="form-grid">' +
      field("名前", '<input class="input" id="gear-name" name="name" placeholder="' + esc(cat.placeholder) + '" required>') +
      field("量", '<input class="input" id="gear-amount" name="amount" placeholder="' + esc(cat.amount) + '">') +
      field("設置日", '<input class="input" name="installedAt" type="date" value="' + today() + '" required>') +
      '<div class="wide">' + field("メモ", '<input class="input" name="note" placeholder="' + esc(cat.note) + '">') + "</div>" +
      "</div>" +
      '<div class="form-actions"><button class="btn" type="submit">追加する</button></div>' +
      "</form></div></div>" +

      GEAR_CATEGORIES.map(function (c) {
        var count = gearOf(c.key, false).length;
        return (
          '<div class="card"><div class="card-head"><span class="card-title with-icon">' +
          mediaIcon(GEAR_ICONS[c.key], 18) + esc(c.key) + "</span>" +
          '<span class="muted">使用中 ' + count + " 点</span></div>" +
          (gearOf(c.key, ui.showRemoved).length === 0 ? '<div class="card-body">' : "") +
          gearTableHTML(c.key) +
          (gearOf(c.key, ui.showRemoved).length === 0 ? "</div>" : "") +
          "</div>"
        );
      }).join("")
    );
  }

  /* --- 画面: 水質 ---------------------------------------------------------- */

  function waterView() {
    var rows = measurements();
    var shown = inBand(inRange(rows));
    var table = rows.length === 0
      ? '<div class="card-body">' + emptyHTML("測定の記録がありません", "水温だけでも記録しておくと、季節ごとの変化が見えるようになります。", "thermometer") + "</div>"
      : '<div class="table-wrap"><table>' +
        '<thead><tr><th>日時</th><th class="num">水温（℃）</th><th class="num">pH</th><th>メモ</th><th></th></tr></thead><tbody>' +
        rows.slice().sort(function (a, b) { return stampOf(b) - stampOf(a); }).map(function (m) {
          return (
            "<tr>" +
            '<td data-label="名前">' + esc(fmtLong(m.date)) + " " +
            (m.time ? esc(m.time) : '<span class="muted">時刻不明</span>') +
            '<span class="muted"> ・ ' + esc(relative(m.date)) + (bandOf(m.time) ? " ・ " + esc(bandOf(m.time)) : "") + "</span></td>" +
            '<td class="num" data-label="水温">' + (m.temp === "" || m.temp === null || m.temp === undefined ? '<span class="muted">—</span>' : num(m.temp) + " ℃") + "</td>" +
            '<td class="num" data-label="pH">' + (m.ph === "" || m.ph === null || m.ph === undefined ? '<span class="muted">—</span>' : num(m.ph, 1)) + "</td>" +
            '<td class="memo">' + (m.note ? esc(m.note) : "") + "</td>" +
            '<td class="actions-cell"><button class="btn quiet sm danger" data-action="del-measurement" data-id="' + m.id + '">削除</button></td>' +
            "</tr>"
          );
        }).join("") +
        "</tbody></table></div>";

    return (
      '<div class="page-head"><div><h1 class="page-title">水質</h1>' +
      '<p class="page-note">水温は測る時間帯で数℃変わります。時間帯を揃えて見ると、本当の変化が分かります。</p></div>' +
      '<div class="row" style="gap:8px">' + bandChips() + rangeChips() + "</div></div>" +

      '<div class="card"><div class="card-head"><span class="card-title">時間帯ごとの平均水温</span>' +
      '<span class="muted">' + (ui.range === "all" ? "全期間" : "直近" + ui.range + "日") + "</span></div>" +
      '<div class="card-body">' +
      (bandStatsHTML(inRange(rows)) || '<div class="empty"><span class="empty-title">まだ比べられません</span><p>時刻つきの測定が増えると、朝と昼の差が見えるようになります。</p></div>') +
      "</div></div>" +

      '<div class="card"><div class="card-head"><span class="card-title">測定を記録</span></div><div class="card-body">' +
      '<form id="measurement-form" class="stack">' +
      '<div class="form-grid">' +
      field("日付", '<input class="input" name="date" type="date" value="' + today() + '" required>') +
      field("時刻", '<input class="input" name="time" type="time" value="' + nowTime() + '">') +
      field("水温（℃）", '<input class="input" name="temp" type="number" step="0.1" placeholder="24.5">') +
      field("pH", '<input class="input" name="ph" type="number" step="0.1" min="0" max="14" placeholder="7.2">') +
      '<div class="wide">' + field("メモ", '<input class="input" name="note" placeholder="朝いちばん。少し緑水ぎみ。">') + "</div>" +
      "</div>" +
      '<div class="form-actions"><button class="btn" type="submit">記録する</button></div>' +
      "</form></div></div>" +

      /* 2枚を横に並べると軸ラベルが縮んで読めなくなるため、縦に積む */
      '<div class="card"><div class="card-head"><span class="card-title">水温の推移（℃）</span>' +
      '<span class="muted">' + (ui.band === "all" ? "すべての時間" : ui.band + "だけ") + " ・ " +
      (ui.range === "all" ? "全期間" : "直近" + ui.range + "日") + "</span></div>" +
      '<div class="card-body">' + lineChartHTML(seriesOf(shown, "temp"), "var(--series-1)", "℃", 1) + "</div></div>" +
      '<div class="card"><div class="card-head"><span class="card-title">pH の推移</span>' +
      '<span class="muted">' + (ui.band === "all" ? "すべての時間" : ui.band + "だけ") + " ・ " +
      (ui.range === "all" ? "全期間" : "直近" + ui.range + "日") + "</span></div>" +
      '<div class="card-body">' + lineChartHTML(seriesOf(shown, "ph"), "var(--series-2)", "", 1) + "</div></div>" +

      '<div class="card"><div class="card-head"><span class="card-title">測定の記録</span><span class="muted">' + rows.length + " 件</span></div>" +
      table + "</div>"
    );
  }

  /* --- 写真 ---------------------------------------------------------------- */

  /** 画像は IndexedDB にあるので src は後から差し込む */
  function wirePhotos(root) {
    root.querySelectorAll("img[data-photo]").forEach(function (img) {
      var id = img.getAttribute("data-photo");
      if (photoUrls[id]) { img.src = photoUrls[id]; return; }
      getPhotoBlob(id).then(function (blob) {
        if (!blob) return;
        photoUrls[id] = URL.createObjectURL(blob);
        img.src = photoUrls[id];
      });
    });
  }

  function thumbsHTML(list) {
    if (list.length === 0) return "";
    return (
      '<div class="thumbs">' +
      list.map(function (p) {
        return (
          '<button type="button" class="thumb" data-action="photo" data-id="' + p.id + '">' +
          '<img data-photo="' + p.id + '" alt="' + esc(p.caption || fmtLong(p.date) + "の写真") + '" loading="lazy">' +
          "</button>"
        );
      }).join("") +
      "</div>"
    );
  }

  function photosView() {
    var rows = photos();
    var months = [];
    var byMonth = {};
    rows.forEach(function (p) {
      var key = p.date.slice(0, 7);
      if (!byMonth[key]) { byMonth[key] = []; months.push(key); }
      byMonth[key].push(p);
    });

    var gallery = rows.length === 0
      ? '<div class="empty"><span class="empty-title">写真がありません</span>' +
        "<p>同じ場所を撮りためると、水草の茂りかたや水の色の変化が後から見返せます。</p></div>"
      : months.map(function (key) {
          var parts = key.split("-");
          return (
            '<section class="month">' +
            '<h3 class="month-head">' + Number(parts[0]) + "年" + Number(parts[1]) + "月" +
            '<span class="muted"> ・ ' + byMonth[key].length + " 枚</span></h3>" +
            thumbsHTML(byMonth[key]) +
            "</section>"
          );
        }).join("");

    return (
      '<div class="page-head"><div><h1 class="page-title">写真</h1>' +
      '<p class="page-note">' + rows.length + " 枚。長辺 1600px の JPEG に縮めて、この端末の中に保存しています。</p></div></div>" +

      '<div class="card"><div class="card-head"><span class="card-title">写真を追加</span></div><div class="card-body">' +
      '<form id="photo-form" class="stack">' +
      '<div class="form-grid">' +
      field("撮影日", '<input class="input" name="date" type="date" value="' + today() + '" required>') +
      field("説明", '<input class="input" name="caption" placeholder="睡蓮が咲いた。">') +
      '<div class="wide">' + field("画像ファイル", '<input class="input" name="files" type="file" accept="image/*" multiple required>') + "</div>" +
      "</div>" +
      '<div class="form-actions"><button class="btn" type="submit">取り込む</button></div>' +
      "</form></div></div>" +

      '<div class="card"><div class="card-head"><span class="card-title">これまでの写真</span>' +
      '<span class="muted">新しい順</span></div>' +
      '<div class="card-body gallery">' + gallery + "</div></div>"
    );
  }

  function renderPhotoDialog() {
    var p = state.photos.filter(function (x) { return x.id === ui.photoId; })[0];
    var host = document.getElementById("photo-dialog-body");
    if (!p) { host.innerHTML = ""; return; }
    var log = p.logId ? state.logs.filter(function (l) { return l.id === p.logId; })[0] : null;

    host.innerHTML =
      '<img class="lightbox-img" data-photo="' + p.id + '" alt="' + esc(p.caption || fmtLong(p.date) + "の写真") + '">' +
      '<div class="row" style="justify-content:space-between">' +
      "<div><strong>" + esc(fmtLong(p.date)) + "</strong>" +
      '<span class="muted"> ・ ' + esc(relative(p.date)) + (log ? " ・ " + esc(log.type) : "") + "</span>" +
      (p.caption ? '<div class="muted">' + esc(p.caption) + "</div>" : "") +
      '<div class="muted" style="font-size:11px">' + p.w + " × " + p.h + " ・ " + Math.round((p.bytes || 0) / 1024) + " KB</div>" +
      "</div></div>" +
      '<div class="form-actions">' +
      '<button class="btn quiet danger" type="button" data-action="del-photo" data-id="' + p.id + '">この写真を削除</button>' +
      '<button class="btn ghost" type="button" data-action="close-dialog">閉じる</button></div>';
    wirePhotos(host);
  }

  /* --- 画面: 作業ログ ------------------------------------------------------ */

  function timelineHTML(rows, allowDelete) {
    if (rows.length === 0) {
      return emptyHTML("作業の記録がありません", "餌やりや水換えを記録しておくと、間隔が空いたときに気づけます。", "topup");
    }
    return (
      '<div class="timeline">' +
      rows.map(function (l) {
        return (
          '<div class="timeline-item">' +
          '<div class="timeline-date">' + esc(fmtShort(l.date)) + "<br>" + esc(relative(l.date)) + "</div>" +
          '<div class="timeline-body">' +
          '<div class="row"><span class="tag" data-type="' + esc(l.type) + '">' +
          mediaIcon(LOG_ICONS[l.type] || "dot", 17) + esc(l.type) + "</span>" +
          (allowDelete ? '<button class="btn quiet sm danger" style="margin-left:auto" data-action="del-log" data-id="' + l.id + '">削除</button>' : "") +
          "</div>" +
          (l.note ? '<div class="timeline-memo">' + esc(l.note) + "</div>" : "") +
          thumbsHTML(photosOfLog(l.id)) +
          "</div></div>"
        );
      }).join("") +
      "</div>"
    );
  }

  function logsView() {
    var rows = logs();
    return (
      '<div class="page-head"><div><h1 class="page-title">作業ログ</h1>' +
      '<p class="page-note">やったことを日付つきで残します。' + rows.length + " 件の記録があります。</p></div></div>" +

      '<div class="card"><div class="card-head"><span class="card-title">作業を記録</span></div><div class="card-body">' +
      '<form id="log-form" class="stack">' +
      "<div>" +
      '<span class="label">種別</span>' +
      '<div class="chips" role="group" aria-label="作業の種別">' +
      LOG_TYPES.map(function (t) {
        return '<button type="button" class="chip" data-action="log-type" data-type="' + esc(t) + '" aria-pressed="' + (ui.logType === t) + '">' +
          mediaIcon(LOG_ICONS[t] || "dot", 17) + esc(t) + "</button>";
      }).join("") +
      "</div></div>" +
      '<div class="form-grid">' +
      field("日付", '<input class="input" name="date" type="date" value="' + today() + '" required>') +
      '<div class="wide">' + field("メモ", '<input class="input" name="note" placeholder="1/3 換水。カルキ抜き済み。">') + "</div>" +
      '<div class="wide">' + field("写真（任意・複数可）", '<input class="input" name="files" type="file" accept="image/*" multiple>') + "</div>" +
      "</div>" +
      '<div class="form-actions"><button class="btn" type="submit">記録する</button></div>' +
      "</form></div></div>" +

      '<div class="card"><div class="card-head"><span class="card-title">これまでの作業</span></div>' +
      '<div class="card-body">' + timelineHTML(rows, true) + "</div></div>"
    );
  }

  /* --- 共通の部品 ---------------------------------------------------------- */

  function field(label, control, labelId) {
    return '<label><span class="label"' + (labelId ? ' id="' + labelId + '"' : "") + ">" +
      esc(label) + "</span>" + control + "</label>";
  }

  /** チップ群の選択状態だけを更新する（描き直すと入力が消えるため） */
  function setPressed(action, attr, value) {
    document.querySelectorAll('[data-action="' + action + '"]').forEach(function (btn) {
      btn.setAttribute("aria-pressed", String(btn.getAttribute(attr) === value));
    });
  }

  function emptyHTML(title, note, iconName) {
    return (
      '<div class="empty">' + mediaIcon(iconName || "ripple", 44, "empty-icon") +
      '<span class="empty-title">' + esc(title) + "</span><p>" + esc(note) + "</p>" +
      '<button class="btn ghost" data-action="sample">サンプルデータで試す</button></div>'
    );
  }

  function toast(message, actionLabel, onAction) {
    var old = document.querySelector(".toast");
    if (old) old.remove();
    var el = document.createElement("div");
    el.className = "toast";
    el.textContent = message;
    if (actionLabel) {
      var btn = document.createElement("button");
      btn.className = "btn quiet sm";
      btn.style.color = "inherit";
      btn.style.textDecoration = "underline";
      btn.textContent = actionLabel;
      btn.addEventListener("click", function () { el.remove(); onAction(); });
      el.appendChild(btn);
    }
    document.body.appendChild(el);
    setTimeout(function () { if (el.isConnected) el.remove(); }, actionLabel ? 8000 : 3000);
  }

  /* --- 描画 ---------------------------------------------------------------- */

  function render() {
    VW = chartWidth();
    document.documentElement.setAttribute("data-season", season().key);
    var select = document.getElementById("biotope-select");
    select.innerHTML = state.biotopes.map(function (b) {
      return '<option value="' + b.id + '"' + (b.id === state.activeBiotopeId ? " selected" : "") + ">" + esc(b.name) + "</option>";
    }).join("");

    document.querySelectorAll(".nav-icon").forEach(function (span) {
      if (span.firstChild) return;
      span.innerHTML = mediaIcon(VIEW_ICONS[span.getAttribute("data-icon")], 19);
    });
    document.querySelectorAll(".nav-item").forEach(function (btn) {
      var v = btn.getAttribute("data-view");
      if (v === ui.view) {
        btn.setAttribute("aria-current", "page");
        /* 狭い画面ではタブが横に流れるので、選んだものを見える位置へ寄せる */
        if (btn.scrollIntoView) btn.scrollIntoView({ block: "nearest", inline: "nearest" });
      } else {
        btn.removeAttribute("aria-current");
      }
    });
    document.querySelector('[data-count="creatures"]').textContent = creatures().length || "";
    document.querySelector('[data-count="water"]').textContent = mine(state.measurements).length || "";
    document.querySelector('[data-count="logs"]').textContent = mine(state.logs).length || "";
    document.querySelector('[data-count="photos"]').textContent = mine(state.photos).length || "";
    document.querySelector('[data-count="gear"]').textContent = activeGearCount() || "";

    var main = document.getElementById("main");
    main.innerHTML =
      ui.view === "creatures" ? creaturesView() :
      ui.view === "water" ? waterView() :
      ui.view === "logs" ? logsView() :
      ui.view === "photos" ? photosView() :
      ui.view === "gear" ? gearView() :
      dashboardView();
    wireCharts(main);
    wirePhotos(main);

    var canvas = document.getElementById("water-canvas");
    if (canvas) {
      var latestTemp = measurements().filter(function (m) {
        return m.temp !== null && m.temp !== undefined && m.temp !== "";
      }).slice(-1)[0];
      startWaterHero(canvas, latestTemp ? latestTemp.temp : 22, totalCount());
    } else if (waterAnim) {
      cancelAnimationFrame(waterAnim);
      waterAnim = null;
    }

    /* 履歴ダイアログを開いたまま記録したときは、その中身も描き直す */
    if (ui.eventCreatureId && document.getElementById("event-dialog").open) renderEventDialog();
  }

  /* --- サンプルデータ ------------------------------------------------------ */

  function loadSample() {
    var bid = state.activeBiotopeId;
    var start = new Date();
    start.setDate(start.getDate() - 89);

    function dateAt(offset) {
      var d = new Date(start);
      d.setDate(d.getDate() + offset);
      return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    }

    /*
     * 測定の多くは朝。ときどき昼に測る。
     * 昼は日射で数℃高くなるので、時間帯の差がそのまま出る。
     */
    var ms = [];
    var slot = 0;
    for (var i = 89; i >= 0; i -= 3) {
      var seasonal = 22 + 6 * Math.sin((i / 89) * Math.PI);
      var atNoon = slot % 3 === 1;
      var time = atNoon
        ? "1" + (3 + (slot % 2)) + ":" + (slot % 2 ? "10" : "40")
        : "0" + (7 + (slot % 2)) + ":" + (slot % 2 ? "05" : "35");
      ms.push({
        id: uid(), biotopeId: bid, date: dateAt(i),
        /* i は「立ち上げからの経過日数」。始めたころは時刻を残していなかった、という状態にする */
        time: i <= 8 ? null : time,
        temp: Math.round((seasonal + (atNoon ? 2.6 : -1.4) + (Math.random() - 0.5) * 1.6) * 10) / 10,
        ph: Math.round((7.1 + (atNoon ? 0.15 : -0.05) + (Math.random() - 0.5) * 0.5) * 10) / 10,
        note: ""
      });
      slot++;
    }

    /* d は「何日前か」 */
    var sampleLogs = [
      { d: 0, t: "餌やり", n: "朝1回。食べ残しなし。" },
      { d: 2, t: "観察", n: "稚魚が5匹ほど泳いでいるのを確認。" },
      { d: 5, t: "水換え", n: "1/3 換水。カルキ抜き済み。" },
      { d: 8, t: "足し水", n: "蒸発ぶんを補充。" },
      { d: 13, t: "掃除", n: "アオミドロを取り除いた。" },
      { d: 21, t: "餌やり", n: "" },
      { d: 34, t: "水換え", n: "夏場なので多めに換水。" }
    ];

    commit(function () {
      state.measurements = state.measurements.concat(ms);
      var sampleCreatures = [
        { species: "メダカ", name: "楊貴妃", note: "立ち上げ時に導入。", events: [
          { at: 0, kind: "導入", amount: 12 },
          { at: 46, kind: "死亡", amount: 1, note: "1匹だけ弱っていた。" },
          { at: 61, kind: "繁殖", amount: 8, note: "産卵床から稚魚を確認。" },
          { at: 87, kind: "繁殖", amount: 5, note: "二回目の稚魚。" }
        ] },
        { species: "ドジョウ", name: "マドジョウ", note: "底床の掃除役。", events: [
          { at: 14, kind: "導入", amount: 2 }
        ] },
        { species: "ミナミヌマエビ", name: "", note: "コケ取り。数は概算。", events: [
          { at: 30, kind: "導入", amount: 20 },
          { at: 75, kind: "数え直し", amount: 34, note: "増えているが正確には数えられない。" }
        ] },
        { species: "タニシ", name: "ヒメタニシ", note: "", events: [
          { at: 30, kind: "導入", amount: 6 },
          { at: 68, kind: "譲渡", amount: 2, note: "知人のビオトープへ。" }
        ] }
      ];

      sampleCreatures.forEach(function (s) {
        var cid = uid();
        state.creatures.push({
          id: cid, biotopeId: bid, species: s.species, name: s.name,
          introducedAt: dateAt(s.events[0].at), note: s.note
        });
        s.events.forEach(function (e) {
          state.events.push({
            id: uid(), biotopeId: bid, creatureId: cid,
            date: dateAt(e.at), kind: e.kind, amount: e.amount, note: e.note || ""
          });
        });
      });
      state.gear = state.gear.concat([
        { category: "底床", name: "赤玉土（中粒）", amount: "20L", at: 0, note: "立ち上げ時に敷いた。" },
        { category: "水草", name: "アナカリス", amount: "5株", at: 0, note: "よく伸びる。時々間引く。" },
        { category: "水草", name: "ホテイアオイ", amount: "2株", at: 21, note: "産卵床を兼ねる。" },
        { category: "水草", name: "スイレン", amount: "1鉢", at: 35, note: "" },
        { category: "機材", name: "ソーラーポンプ", amount: "1台", at: 7, note: "曇りの日は止まる。" },
        { category: "機材", name: "投げ込みフィルター", amount: "1台", at: 0, removedAt: 42, note: "エアポンプの音が気になり撤去。" }
      ].map(function (g) {
        return {
          id: uid(), biotopeId: bid, category: g.category, name: g.name, amount: g.amount,
          installedAt: dateAt(g.at), removedAt: g.removedAt ? dateAt(g.removedAt) : null, note: g.note
        };
      }));

      state.logs = state.logs.concat(sampleLogs.map(function (l) {
        return { id: uid(), biotopeId: bid, date: dateAt(89 - l.d), type: l.t, note: l.n };
      }));
      state.biotopes.forEach(function (b) { if (b.id === bid) b.startedAt = dateAt(0); });
    });
    addSamplePhotos(dateAt);
  }

  /**
   * サンプル用の画像。手元に写真がなくてもギャラリーの動きが見えるように、
   * 水面を模した絵をその場で描く（実際の写真ではないことは説明文に出す）。
   */
  function drawSamplePhoto(hue, leaves) {
    var c = document.createElement("canvas");
    c.width = 800;
    c.height = 600;
    var g = c.getContext("2d");

    var grad = g.createLinearGradient(0, 0, 0, 600);
    grad.addColorStop(0, "hsl(" + hue + ", 32%, 26%)");
    grad.addColorStop(1, "hsl(" + (hue + 18) + ", 38%, 14%)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 800, 600);

    g.strokeStyle = "rgba(255,255,255,0.10)";
    g.lineWidth = 2;
    for (var i = 0; i < 26; i++) {
      g.beginPath();
      g.ellipse(400, 120 + i * 26, 240 + i * 14, 26 + i * 3, 0, 0, Math.PI * 2);
      g.stroke();
    }
    for (var j = 0; j < leaves; j++) {
      var x = 90 + ((j * 173) % 620);
      var y = 110 + ((j * 251) % 400);
      g.fillStyle = "hsl(" + (hue - 8 + (j % 3) * 6) + ", 40%, " + (30 + (j % 4) * 5) + "%)";
      g.beginPath();
      g.ellipse(x, y, 58 + (j % 3) * 12, 40 + (j % 3) * 8, (j % 5) * 0.4, 0, Math.PI * 2);
      g.fill();
    }
    return new Promise(function (resolve) { c.toBlob(resolve, "image/jpeg", 0.8); });
  }

  function addSamplePhotos(dateAt) {
    var bid = state.activeBiotopeId;
    var specs = [
      { at: 8, hue: 152, leaves: 3, caption: "立ち上げて2週間。まだ底床が見える。（サンプル画像）" },
      { at: 48, hue: 140, leaves: 9, caption: "水草が茂ってきた。（サンプル画像）" },
      { at: 86, hue: 128, leaves: 15, caption: "水面がほとんど葉で覆われた。（サンプル画像）" }
    ];

    Promise.all(specs.map(function (s) {
      return drawSamplePhoto(s.hue, s.leaves).then(function (blob) {
        var id = uid();
        return putPhotoBlob(id, blob).then(function () {
          return {
            id: id, biotopeId: bid, date: dateAt(s.at), caption: s.caption,
            logId: null, w: 800, h: 600, bytes: blob.size
          };
        });
      });
    })).then(function (records) {
      state.photos = state.photos.concat(records);
      save();
      render();
      toast("サンプルデータを入れました");
    }).catch(function () {
      toast("サンプルデータを入れました（写真は作れませんでした）");
    });
  }

  /* --- 操作 ---------------------------------------------------------------- */

  document.addEventListener("click", function (ev) {
    var el = ev.target.closest("[data-action]");
    if (!el) return;
    var action = el.getAttribute("data-action");

    if (action === "close-dialog") {
      el.closest("dialog").close();
    } else if (action === "view") {
      ui.view = el.getAttribute("data-view");
      render();
    } else if (action === "range") {
      var r = el.getAttribute("data-range");
      ui.range = r === "all" ? "all" : Number(r);
      render();
    } else if (action === "band") {
      ui.band = el.getAttribute("data-band");
      render();
    } else if (action === "log-type") {
      /* 描き直すと、入力途中のメモや選んだファイルが消えてしまう */
      ui.logType = el.getAttribute("data-type");
      setPressed("log-type", "data-type", ui.logType);
    } else if (action === "sample") {
      loadSample();
    } else if (action === "history") {
      ui.eventCreatureId = el.getAttribute("data-id");
      renderEventDialog();
      document.getElementById("event-dialog").showModal();
    } else if (action === "event-kind") {
      ui.eventKind = el.getAttribute("data-kind");
      setPressed("event-kind", "data-kind", ui.eventKind);
      /* 「数え直し」だけは意味が違うので、入力欄の見出しだけ差し替える */
      var amountLabel = document.getElementById("amount-label");
      if (amountLabel) amountLabel.textContent = kindOf(ui.eventKind).sign === 0 ? "数えた匹数" : "匹数";
    } else if (action === "del-event") {
      var eid = el.getAttribute("data-id");
      removeWithUndo("増減の記録を削除しました", function () {
        state.events = state.events.filter(function (e) { return e.id !== eid; });
      });
    } else if (action === "del-creature") {
      var did = el.getAttribute("data-id");
      removeWithUndo("生き物と、その増減の記録を削除しました", function () {
        state.creatures = state.creatures.filter(function (c) { return c.id !== did; });
        state.events = state.events.filter(function (e) { return e.creatureId !== did; });
      });
    } else if (action === "del-measurement") {
      var mid = el.getAttribute("data-id");
      removeWithUndo("測定を削除しました", function () {
        state.measurements = state.measurements.filter(function (m) { return m.id !== mid; });
      });
    } else if (action === "del-log") {
      var lid = el.getAttribute("data-id");
      var attached = photosOfLog(lid).length;
      removeWithUndo(
        attached ? "作業ログを削除しました（写真は「写真」に残ります）" : "作業ログを削除しました",
        function () {
          state.logs = state.logs.filter(function (l) { return l.id !== lid; });
          /* 写真そのものは消さない。取り消しても画像は戻せないため */
          state.photos.forEach(function (p) { if (p.logId === lid) p.logId = null; });
        }
      );
    } else if (action === "summary") {
      renderSummaryDialog();
      document.getElementById("summary-dialog").showModal();
    } else if (action === "copy-summary") {
      var area = document.getElementById("summary-text");
      area.readOnly = false;
      area.select();
      area.readOnly = true;
      navigator.clipboard.writeText(area.value).then(
        function () { toast("コピーしました。Claude や ChatGPT に貼り付けてください"); },
        function () { toast("コピーできませんでした。選択されているので手動でコピーしてください"); }
      );
    } else if (action === "gear-category") {
      /* 描き直さずに、選択状態と入力例だけ差し替える */
      ui.gearCategory = el.getAttribute("data-category");
      setPressed("gear-category", "data-category", ui.gearCategory);
      var cat = GEAR_CATEGORIES.filter(function (c) { return c.key === ui.gearCategory; })[0];
      document.getElementById("gear-name").placeholder = cat.placeholder;
      document.getElementById("gear-amount").placeholder = cat.amount;
    } else if (action === "toggle-removed") {
      ui.showRemoved = !ui.showRemoved;
      render();
    } else if (action === "remove-gear") {
      var rgid = el.getAttribute("data-id");
      commit(function () {
        state.gear.forEach(function (g) { if (g.id === rgid) g.removedAt = today(); });
      });
      toast("撤去として記録しました");
    } else if (action === "restore-gear") {
      var bgid = el.getAttribute("data-id");
      commit(function () {
        state.gear.forEach(function (g) { if (g.id === bgid) g.removedAt = null; });
      });
    } else if (action === "del-gear") {
      var dgid = el.getAttribute("data-id");
      removeWithUndo("記録を削除しました", function () {
        state.gear = state.gear.filter(function (g) { return g.id !== dgid; });
      });
    } else if (action === "photo") {
      ui.photoId = el.getAttribute("data-id");
      renderPhotoDialog();
      document.getElementById("photo-dialog").showModal();
    } else if (action === "del-photo") {
      var pid = el.getAttribute("data-id");
      /* 画像は取り消せないので、ここだけは元に戻せない削除 */
      dropPhotoBlobs([pid]).then(function () {
        commit(function () {
          state.photos = state.photos.filter(function (p) { return p.id !== pid; });
        });
        document.getElementById("photo-dialog").close();
        toast("写真を削除しました");
      });
    } else if (action === "add-biotope") {
      document.getElementById("biotope-dialog").showModal();
    } else if (action === "theme") {
      var next = currentTheme() === "dark" ? "light" : "dark";
      try { localStorage.setItem(THEME_KEY, next); } catch (err) { /* 保存できなくても切り替えは効く */ }
      applyTheme(next);
      render(); /* 水面の色はトークンから読むので描き直す */
    } else if (action === "backup") {
      var dlg = document.getElementById("backup-dialog");
      document.getElementById("backup-text").value = JSON.stringify(state, null, 2);
      dlg.showModal();
    }
  });

  document.addEventListener("submit", function (ev) {
    var form = ev.target;
    var data = new FormData(form);
    var get = function (k) { return String(data.get(k) || "").trim(); };

    if (form.id === "creature-form") {
      ev.preventDefault();
      var newId = uid();
      commit(function () {
        state.creatures.push({
          id: newId, biotopeId: state.activeBiotopeId,
          species: get("species"), name: get("name"),
          introducedAt: get("introducedAt"), note: get("note")
        });
        /* 最初の数も「導入」という出来事として持つ */
        state.events.push({
          id: uid(), biotopeId: state.activeBiotopeId, creatureId: newId,
          date: get("introducedAt"), kind: "導入",
          amount: Number(get("count")) || 0, note: ""
        });
      });
      toast("生き物を追加しました");
    } else if (form.id === "event-form") {
      ev.preventDefault();
      var creatureId = ui.eventCreatureId;
      commit(function () {
        state.events.push({
          id: uid(), biotopeId: state.activeBiotopeId, creatureId: creatureId,
          date: get("date"), kind: ui.eventKind,
          amount: Number(get("amount")) || 0, note: get("note")
        });
      });
      toast(ui.eventKind + "を記録しました");
    } else if (form.id === "measurement-form") {
      ev.preventDefault();
      var temp = get("temp");
      var ph = get("ph");
      if (temp === "" && ph === "") { toast("水温か pH のどちらかを入力してください"); return; }
      commit(function () {
        state.measurements.push({
          id: uid(), biotopeId: state.activeBiotopeId,
          date: get("date"),
          time: get("time") || null,
          temp: temp === "" ? null : Number(temp),
          ph: ph === "" ? null : Number(ph),
          note: get("note")
        });
      });
      toast("測定を記録しました");
    } else if (form.id === "log-form") {
      ev.preventDefault();
      var logId = uid();
      var logDate = get("date");
      var picked = form.elements.files.files;
      commit(function () {
        state.logs.push({
          id: logId, biotopeId: state.activeBiotopeId,
          date: logDate, type: ui.logType, note: get("note")
        });
      });
      if (picked.length) addPhotos(picked, { date: logDate, logId: logId });
      else toast(ui.logType + "を記録しました");
    } else if (form.id === "gear-form") {
      ev.preventDefault();
      commit(function () {
        state.gear.push({
          id: uid(), biotopeId: state.activeBiotopeId,
          category: ui.gearCategory, name: get("name"), amount: get("amount"),
          installedAt: get("installedAt"), removedAt: null, note: get("note")
        });
      });
      toast(ui.gearCategory + "を追加しました");
    } else if (form.id === "photo-form") {
      ev.preventDefault();
      addPhotos(form.elements.files.files, { date: get("date"), caption: get("caption") });
    } else if (form.id === "biotope-form") {
      ev.preventDefault();
      var name = get("name") || "名前のないビオトープ";
      var nid = uid();
      commit(function () {
        state.biotopes.push({ id: nid, name: name, startedAt: get("startedAt"), note: "" });
        state.activeBiotopeId = nid;
        ui.view = "dashboard";
      });
      document.getElementById("biotope-dialog").close();
      form.reset();
      toast("「" + name + "」を追加しました");
    } else if (form.id === "restore-form") {
      ev.preventDefault();
      var text = document.getElementById("backup-text").value;
      try {
        var next = JSON.parse(text);
        if (!next || !Array.isArray(next.biotopes) || next.biotopes.length === 0) throw new Error("形式が違います");
        state = next;
        save();
        state = load();
        render();
        document.getElementById("backup-dialog").close();
        toast("データを読み込みました");
      } catch (err) {
        toast("読み込めませんでした。書き出したJSONをそのまま貼り付けてください。");
      }
    }
  });

  document.addEventListener("change", function (ev) {
    if (ev.target.id === "biotope-select") {
      state.activeBiotopeId = ev.target.value;
      save();
      render();
    }
  });

  document.getElementById("copy-backup").addEventListener("click", function () {
    var ta = document.getElementById("backup-text");
    ta.select();
    navigator.clipboard.writeText(ta.value).then(
      function () { toast("JSONをコピーしました"); },
      function () { toast("コピーできませんでした。手動で選択してください。"); }
    );
  });

  var resizeTimer = null;
  window.addEventListener("resize", function () {
    if (VW === chartWidth()) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 150);
  });

  render();
})();
