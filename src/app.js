/* ---------------------------------------------------------------------------
   メダ活 — ビオトープ台帳
   保存先はブラウザの localStorage。サーバは使わない。
--------------------------------------------------------------------------- */
(function () {
  "use strict";

  var STORE_KEY = "meda-katsu/v1";
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
  var VW = 760;
  var VH = 230;

  /* --- 保存 --------------------------------------------------------------- */

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function emptyState() {
    var id = uid();
    return {
      version: 3,
      activeBiotopeId: id,
      biotopes: [{ id: id, name: "メインのビオトープ", startedAt: today(), note: "" }],
      creatures: [],
      events: [],
      measurements: [],
      logs: [],
      photos: []
    };
  }

  function migrate(data) {
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
    data.version = 3;
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
    eventCreatureId: null, eventKind: "繁殖", photoId: null
  };
  var undoSnapshot = null;

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

  function measurements() { return mine(state.measurements).slice().sort(byDateAsc); }
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
      .map(function (r) { return { t: parseDate(r.date).getTime(), v: Number(r[key]), date: r.date }; });
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

    var pad = { top: 16, right: 66, bottom: 26, left: 46 };
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

    var ticksX = points.length <= 6 ? points : [points[0], points[Math.floor(points.length / 2)], points[points.length - 1]];
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

    if (points.length <= 40) {
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
      return { x: px(p), y: py(p), v: p.v, date: p.date };
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
          '<div class="tooltip-date">' + esc(fmtLong(best.date)) + "</div>" +
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
    if (kind === "is-good") return '<svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor"><path d="M4.6 9.4 1.5 6.3l1-1 2.1 2.1 5-5 1 1z"/></svg>';
    if (kind === "is-warn") return '<svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor"><path d="M6 1 11.5 11h-11z"/></svg>';
    return '<svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor"><circle cx="6" cy="6" r="5.5"/></svg>';
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
    var temps = inRange(rows);
    var waterChange = lastLogOf("水換え");
    var species = {};
    creatures().forEach(function (c) { species[c.species] = true; });
    var change30 = changeWithin(30);

    var hero = latest && latest.temp !== "" && latest.temp !== null && latest.temp !== undefined
      ? '<div><div class="hero-label">最新の水温</div><div class="hero-value">' + num(latest.temp) + '<span class="hero-unit">℃</span></div></div>' +
        '<div class="hero-meta">' + esc(fmtLong(latest.date)) + "（" + esc(relative(latest.date)) + "）に測定" +
        (latest.ph ? " ・ pH " + num(latest.ph, 1) : "") + "</div>"
      : '<div><div class="hero-label">最新の水温</div><div class="hero-value muted">—</div></div>' +
        '<div class="hero-meta">まだ測定がありません。「水質」から記録できます。</div>';

    return (
      '<div class="page-head"><div>' +
      '<h1 class="page-title">' + esc(activeBiotope().name) + "</h1>" +
      '<p class="page-note">' + (activeBiotope().startedAt ? "立ち上げ " + esc(fmtLong(activeBiotope().startedAt)) + "・" + daysSince(activeBiotope().startedAt) + "日目" : "ビオトープの様子") + "</p>" +
      "</div>" + rangeChips() + "</div>" +

      '<div class="card"><div class="hero">' + hero + "</div></div>" +

      '<div class="tiles">' +
      tile("生き物", totalCount() + '<small>匹</small>',
        Object.keys(species).length + "種類 ・ 30日で " +
        (change30.plus || change30.minus ? "＋" + change30.plus + " / −" + change30.minus : "動きなし")) +
      tile("最新の pH", latest && latest.ph ? num(latest.ph, 1) : '<span class="muted">—</span>', latest && latest.ph ? esc(relative(latest.date)) + "に測定" : "未測定") +
      tile("最後の水換え", waterChange ? esc(relative(waterChange.date)) : '<span class="muted">—</span>', statusPill(waterChange ? daysSince(waterChange.date) : null)) +
      tile("記録の数", (rows.length + mine(state.logs).length) + '<small>件</small>', "測定 " + rows.length + " ・ 作業 " + mine(state.logs).length) +
      "</div>" +

      '<div class="card">' +
      '<div class="card-head"><span class="card-title">水温の推移（℃）</span><span class="muted">' + (ui.range === "all" ? "全期間" : "直近" + ui.range + "日") + "</span></div>" +
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
      "</div>"
    );
  }

  function tile(label, value, meta) {
    return (
      '<div class="card tile">' +
      '<div class="tile-label">' + esc(label) + "</div>" +
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
      ? emptyHTML("生き物がまだ登録されていません", "上のフォームから、メダカやドジョウなどを登録してください。")
      : '<div class="table-wrap"><table>' +
        '<thead><tr><th>種類</th><th>呼び名・系統</th><th class="num">いまの数</th><th>最後の動き</th><th>メモ</th><th></th></tr></thead><tbody>' +
        rows.map(function (c) {
          var evs = eventsOf(c.id);
          var last = evs[evs.length - 1];
          return (
            "<tr>" +
            "<td><strong>" + esc(c.species) + "</strong></td>" +
            "<td>" + (c.name ? esc(c.name) : '<span class="muted">—</span>') + "</td>" +
            '<td class="num">' + countOf(c.id) + '<small class="muted"> 匹</small></td>' +
            "<td>" + (last ? esc(eventLine(last)) + '<span class="muted"> ・ ' + esc(relative(last.date)) + "</span>" : '<span class="muted">—</span>') + "</td>" +
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

  /* --- 画面: 水質 ---------------------------------------------------------- */

  function waterView() {
    var rows = measurements();
    var shown = inRange(rows);
    var table = rows.length === 0
      ? '<div class="card-body">' + emptyHTML("測定の記録がありません", "水温だけでも記録しておくと、季節ごとの変化が見えるようになります。") + "</div>"
      : '<div class="table-wrap"><table>' +
        '<thead><tr><th>日付</th><th class="num">水温（℃）</th><th class="num">pH</th><th>メモ</th><th></th></tr></thead><tbody>' +
        rows.slice().sort(byDateDesc).map(function (m) {
          return (
            "<tr>" +
            "<td>" + esc(fmtLong(m.date)) + '<span class="muted"> ・ ' + esc(relative(m.date)) + "</span></td>" +
            '<td class="num">' + (m.temp === "" || m.temp === null || m.temp === undefined ? '<span class="muted">—</span>' : num(m.temp)) + "</td>" +
            '<td class="num">' + (m.ph === "" || m.ph === null || m.ph === undefined ? '<span class="muted">—</span>' : num(m.ph, 1)) + "</td>" +
            '<td class="memo">' + (m.note ? esc(m.note) : "") + "</td>" +
            '<td class="actions-cell"><button class="btn quiet sm danger" data-action="del-measurement" data-id="' + m.id + '">削除</button></td>' +
            "</tr>"
          );
        }).join("") +
        "</tbody></table></div>";

    return (
      '<div class="page-head"><div><h1 class="page-title">水質</h1>' +
      '<p class="page-note">水温と pH は別々のグラフで見ます（ひとつの縦軸にまとめると値の大小を読み違えるため）。</p></div>' +
      rangeChips() + "</div>" +

      '<div class="card"><div class="card-head"><span class="card-title">測定を記録</span></div><div class="card-body">' +
      '<form id="measurement-form" class="stack">' +
      '<div class="form-grid">' +
      field("日付", '<input class="input" name="date" type="date" value="' + today() + '" required>') +
      field("水温（℃）", '<input class="input" name="temp" type="number" step="0.1" placeholder="24.5">') +
      field("pH", '<input class="input" name="ph" type="number" step="0.1" min="0" max="14" placeholder="7.2">') +
      '<div class="wide">' + field("メモ", '<input class="input" name="note" placeholder="朝いちばん。少し緑水ぎみ。">') + "</div>" +
      "</div>" +
      '<div class="form-actions"><button class="btn" type="submit">記録する</button></div>' +
      "</form></div></div>" +

      /* 2枚を横に並べると軸ラベルが縮んで読めなくなるため、縦に積む */
      '<div class="card"><div class="card-head"><span class="card-title">水温の推移（℃）</span>' +
      '<span class="muted">' + (ui.range === "all" ? "全期間" : "直近" + ui.range + "日") + "</span></div>" +
      '<div class="card-body">' + lineChartHTML(seriesOf(shown, "temp"), "var(--series-1)", "℃", 1) + "</div></div>" +
      '<div class="card"><div class="card-head"><span class="card-title">pH の推移</span>' +
      '<span class="muted">' + (ui.range === "all" ? "全期間" : "直近" + ui.range + "日") + "</span></div>" +
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
      return emptyHTML("作業の記録がありません", "餌やりや水換えを記録しておくと、間隔が空いたときに気づけます。");
    }
    return (
      '<div class="timeline">' +
      rows.map(function (l) {
        return (
          '<div class="timeline-item">' +
          '<div class="timeline-date">' + esc(fmtShort(l.date)) + "<br>" + esc(relative(l.date)) + "</div>" +
          '<div class="timeline-body">' +
          '<div class="row"><span class="tag" data-type="' + esc(l.type) + '">' + esc(l.type) + "</span>" +
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
        return '<button type="button" class="chip" data-action="log-type" data-type="' + esc(t) + '" aria-pressed="' + (ui.logType === t) + '">' + esc(t) + "</button>";
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

  function emptyHTML(title, note) {
    return (
      '<div class="empty"><span class="empty-title">' + esc(title) + "</span><p>" + esc(note) + "</p>" +
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
    var select = document.getElementById("biotope-select");
    select.innerHTML = state.biotopes.map(function (b) {
      return '<option value="' + b.id + '"' + (b.id === state.activeBiotopeId ? " selected" : "") + ">" + esc(b.name) + "</option>";
    }).join("");

    document.querySelectorAll(".nav-item").forEach(function (btn) {
      var v = btn.getAttribute("data-view");
      if (v === ui.view) btn.setAttribute("aria-current", "page");
      else btn.removeAttribute("aria-current");
    });
    document.querySelector('[data-count="creatures"]').textContent = creatures().length || "";
    document.querySelector('[data-count="water"]').textContent = mine(state.measurements).length || "";
    document.querySelector('[data-count="logs"]').textContent = mine(state.logs).length || "";
    document.querySelector('[data-count="photos"]').textContent = mine(state.photos).length || "";

    var main = document.getElementById("main");
    main.innerHTML =
      ui.view === "creatures" ? creaturesView() :
      ui.view === "water" ? waterView() :
      ui.view === "logs" ? logsView() :
      ui.view === "photos" ? photosView() :
      dashboardView();
    wireCharts(main);
    wirePhotos(main);

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

    var ms = [];
    for (var i = 89; i >= 0; i -= 3) {
      var seasonal = 22 + 6 * Math.sin((i / 89) * Math.PI);
      ms.push({
        id: uid(), biotopeId: bid, date: dateAt(i),
        temp: Math.round((seasonal + (Math.random() - 0.5) * 2.4) * 10) / 10,
        ph: Math.round((7.1 + (Math.random() - 0.5) * 0.7) * 10) / 10,
        note: ""
      });
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

  render();
})();
