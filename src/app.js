/* ---------------------------------------------------------------------------
   メダ活 — ビオトープ台帳
   保存先はブラウザの localStorage。サーバは使わない。
--------------------------------------------------------------------------- */
(function () {
  "use strict";

  var STORE_KEY = "meda-katsu/v1";
  var LOG_TYPES = ["餌やり", "水換え", "足し水", "掃除", "観察", "その他"];
  var VW = 760;
  var VH = 230;

  /* --- 保存 --------------------------------------------------------------- */

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function emptyState() {
    var id = uid();
    return {
      version: 1,
      activeBiotopeId: id,
      biotopes: [{ id: id, name: "メインのビオトープ", startedAt: today(), note: "" }],
      creatures: [],
      measurements: [],
      logs: []
    };
  }

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return emptyState();
      var data = JSON.parse(raw);
      if (!data || !Array.isArray(data.biotopes) || data.biotopes.length === 0) return emptyState();
      data.creatures = data.creatures || [];
      data.measurements = data.measurements || [];
      data.logs = data.logs || [];
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

  var state = load();
  var ui = { view: "dashboard", range: 90, logType: "餌やり" };
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

  function totalCount() {
    return creatures().reduce(function (sum, c) { return sum + (Number(c.count) || 0); }, 0);
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
  function lineChartHTML(points, color, unit, decimals) {
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

    var d = points.map(function (p, i) { return (i ? "L" : "M") + px(p).toFixed(1) + " " + py(p).toFixed(1); }).join(" ");
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
      tile("生き物", totalCount() + '<small>匹</small>', Object.keys(species).length + "種類") +
      tile("最新の pH", latest && latest.ph ? num(latest.ph, 1) : '<span class="muted">—</span>', latest && latest.ph ? esc(relative(latest.date)) + "に測定" : "未測定") +
      tile("最後の水換え", waterChange ? esc(relative(waterChange.date)) : '<span class="muted">—</span>', statusPill(waterChange ? daysSince(waterChange.date) : null)) +
      tile("記録の数", (rows.length + mine(state.logs).length) + '<small>件</small>', "測定 " + rows.length + " ・ 作業 " + mine(state.logs).length) +
      "</div>" +

      '<div class="card">' +
      '<div class="card-head"><span class="card-title">水温の推移（℃）</span><span class="muted">' + (ui.range === "all" ? "全期間" : "直近" + ui.range + "日") + "</span></div>" +
      '<div class="card-body">' + lineChartHTML(seriesOf(temps, "temp"), "var(--series-1)", "℃", 1) + "</div>" +
      "</div>" +

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

  function creaturesView() {
    var rows = creatures();
    var body = rows.length === 0
      ? emptyHTML("生き物がまだ登録されていません", "上のフォームから、メダカやドジョウなどを登録してください。")
      : '<div class="table-wrap"><table>' +
        "<thead><tr><th>種類</th><th>呼び名・系統</th><th class=\"num\">数</th><th>導入日</th><th>メモ</th><th></th></tr></thead><tbody>" +
        rows.map(function (c) {
          return (
            "<tr>" +
            "<td><strong>" + esc(c.species) + "</strong></td>" +
            "<td>" + (c.name ? esc(c.name) : '<span class="muted">—</span>') + "</td>" +
            '<td class="num nowrap">' +
            '<button class="btn quiet sm" data-action="count" data-id="' + c.id + '" data-delta="-1" aria-label="' + esc(c.species) + 'を1減らす">−</button>' +
            " " + (Number(c.count) || 0) + " " +
            '<button class="btn quiet sm" data-action="count" data-id="' + c.id + '" data-delta="1" aria-label="' + esc(c.species) + 'を1増やす">＋</button>' +
            "</td>" +
            "<td>" + (c.introducedAt ? esc(fmtLong(c.introducedAt)) : '<span class="muted">—</span>') + "</td>" +
            '<td class="memo">' + (c.note ? esc(c.note) : "") + "</td>" +
            '<td class="actions-cell"><button class="btn quiet sm danger" data-action="del-creature" data-id="' + c.id + '">削除</button></td>' +
            "</tr>"
          );
        }).join("") +
        "</tbody></table></div>";

    return (
      '<div class="page-head"><div><h1 class="page-title">生き物</h1>' +
      '<p class="page-note">合計 ' + totalCount() + " 匹を管理しています。</p></div></div>" +

      '<div class="card"><div class="card-head"><span class="card-title">生き物を追加</span></div><div class="card-body">' +
      '<form id="creature-form" class="stack">' +
      '<div class="form-grid">' +
      field("種類", '<input class="input" name="species" list="species-list" placeholder="ミナミヌマエビ" required>') +
      field("呼び名・系統", '<input class="input" name="name" placeholder="楊貴妃">') +
      field("数", '<input class="input" name="count" type="number" min="0" step="1" value="1" required>') +
      field("導入日", '<input class="input" name="introducedAt" type="date" value="' + today() + '">') +
      '<div class="wide">' + field("メモ", '<input class="input" name="note" placeholder="ホームセンターで購入。稚魚10匹。">') + "</div>" +
      "</div>" +
      '<datalist id="species-list"><option value="メダカ"><option value="ドジョウ"><option value="ミナミヌマエビ"><option value="タニシ"><option value="ヤマトヌマエビ"><option value="カワニナ"></datalist>' +
      '<div class="form-actions"><button class="btn" type="submit">追加する</button></div>' +
      "</form></div></div>" +

      '<div class="card"><div class="card-head"><span class="card-title">登録されている生き物</span><span class="muted">' + rows.length + " 件</span></div>" +
      (rows.length === 0 ? '<div class="card-body">' + body + "</div>" : body) +
      "</div>"
    );
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
      "</div>" +
      '<div class="form-actions"><button class="btn" type="submit">記録する</button></div>' +
      "</form></div></div>" +

      '<div class="card"><div class="card-head"><span class="card-title">これまでの作業</span></div>' +
      '<div class="card-body">' + timelineHTML(rows, true) + "</div></div>"
    );
  }

  /* --- 共通の部品 ---------------------------------------------------------- */

  function field(label, control) {
    return '<label><span class="label">' + esc(label) + "</span>" + control + "</label>";
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

    var main = document.getElementById("main");
    main.innerHTML =
      ui.view === "creatures" ? creaturesView() :
      ui.view === "water" ? waterView() :
      ui.view === "logs" ? logsView() :
      dashboardView();
    wireCharts(main);
    main.scrollTop = 0;
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
      state.creatures = state.creatures.concat([
        { id: uid(), biotopeId: bid, species: "メダカ", name: "楊貴妃", count: 12, introducedAt: dateAt(0), note: "立ち上げ時に導入。" },
        { id: uid(), biotopeId: bid, species: "ドジョウ", name: "マドジョウ", count: 2, introducedAt: dateAt(14), note: "底床の掃除役。" },
        { id: uid(), biotopeId: bid, species: "ミナミヌマエビ", name: "", count: 20, introducedAt: dateAt(30), note: "コケ取り。かなり増えた。" },
        { id: uid(), biotopeId: bid, species: "タニシ", name: "ヒメタニシ", count: 6, introducedAt: dateAt(30), note: "" }
      ]);
      state.logs = state.logs.concat(sampleLogs.map(function (l) {
        return { id: uid(), biotopeId: bid, date: dateAt(89 - l.d), type: l.t, note: l.n };
      }));
      state.biotopes.forEach(function (b) { if (b.id === bid) b.startedAt = dateAt(0); });
    });
    toast("サンプルデータを入れました");
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
      ui.logType = el.getAttribute("data-type");
      render();
    } else if (action === "sample") {
      loadSample();
    } else if (action === "count") {
      var delta = Number(el.getAttribute("data-delta"));
      var cid = el.getAttribute("data-id");
      commit(function () {
        state.creatures.forEach(function (c) {
          if (c.id === cid) c.count = Math.max(0, (Number(c.count) || 0) + delta);
        });
      });
    } else if (action === "del-creature") {
      var did = el.getAttribute("data-id");
      removeWithUndo("生き物の記録を削除しました", function () {
        state.creatures = state.creatures.filter(function (c) { return c.id !== did; });
      });
    } else if (action === "del-measurement") {
      var mid = el.getAttribute("data-id");
      removeWithUndo("測定を削除しました", function () {
        state.measurements = state.measurements.filter(function (m) { return m.id !== mid; });
      });
    } else if (action === "del-log") {
      var lid = el.getAttribute("data-id");
      removeWithUndo("作業ログを削除しました", function () {
        state.logs = state.logs.filter(function (l) { return l.id !== lid; });
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
      commit(function () {
        state.creatures.push({
          id: uid(), biotopeId: state.activeBiotopeId,
          species: get("species"), name: get("name"),
          count: Number(get("count")) || 0,
          introducedAt: get("introducedAt"), note: get("note")
        });
      });
      toast("生き物を追加しました");
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
      commit(function () {
        state.logs.push({
          id: uid(), biotopeId: state.activeBiotopeId,
          date: get("date"), type: ui.logType, note: get("note")
        });
      });
      toast(ui.logType + "を記録しました");
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
