#!/usr/bin/env node
/*
 * C式差數 回測 CLI
 *
 *   node app/cha-backtest-cli.js                       # 讀 data/results.json，回溯 16 期
 *   node app/cha-backtest-cli.js --file path.json      # 指定資料檔（[{date, numbers}] 陣列）
 *   node app/cha-backtest-cli.js --game lotto          # 539 | daily | mark6 | lotto
 *   node app/cha-backtest-cli.js --steps 16 --span 6 --sweep 6
 *   node app/cha-backtest-cli.js --spare 32                   # 備用列數（畫面外可往上讀的期數，預設 32）
 *   node app/cha-backtest-cli.js --offsets -11,-10,-9,-1,0,1,9,10,11   # 只勾這些偏移
 *   node app/cha-backtest-cli.js --ai                  # 加印 差數ai統計 彙總（各九宮差命中次數、沒中 x）
 *   node app/cha-backtest-cli.js --ai-detail           # 加印 差數ai統計 每一筆紀錄 [同列,連線差,列距,九宮差,桿距]
 *   node app/cha-backtest-cli.js --target 49           # 預測目標列（統一列號：備用列 1..32、顯示區 33..48、空白第 1 列 49 = 預設）；回測從目標列上一列往上 16 次
 *   node app/cha-backtest-cli.js --predict [N]         # 用回測統計預測目標列，列前 N 顆（預設 5）；目標列已開出時附命中
 *   node app/cha-backtest-cli.js --predict-mode anchor|top|field|condition|gapvote|app   # 計分規則：anchor=百分比相加（預設）、top=最高值篩選、field=機率相乘、condition=同條件命中率、gapvote=差6統計差6…6份表投票、app=App原邏輯
 *   node app/cha-backtest-cli.js --predict-mode gapvote --vote-top 5   # 每份桿距表只拿前 5 顆投票（不給就全拿）
 *   node app/cha-backtest-cli.js --anchor-detail       # 加印 anchor 模式每顆主角的四個百分比與分數
 *   node app/cha-backtest-cli.js --stats-cond gap      # 桿距分開統計：差6只用回溯裡差6的資料、差5只用差5的（可逗號串多欄，例 gap,rowDist）
 *   node app/cha-backtest-cli.js --json                # 輸出完整 JSON（給後續機率邏輯用）
 *   node app/cha-backtest-cli.js --demo                # 用亂數資料跑一次，確認框架可動
 */
"use strict";

var fs = require("fs");
var path = require("path");
var Cha = require("./cha-backtest.js");

function parseArgs(argv) {
  var a = { file: null, game: "539", steps: 16, span: 6, sweep: 6, offsets: null, json: false, demo: false, seed: 1, spare: 32 };
  for (var i = 0; i < argv.length; i++) {
    var k = argv[i];
    var v = argv[i + 1];
    if (k === "--file") { a.file = v; i++; }
    else if (k === "--game") { a.game = v; i++; }
    else if (k === "--steps") { a.steps = parseInt(v, 10); i++; }
    else if (k === "--span") { a.span = parseInt(v, 10); i++; }
    else if (k === "--sweep") { a.sweep = parseInt(v, 10); i++; }
    else if (k === "--spare") { a.spare = parseInt(v, 10); i++; }
    else if (k === "--offsets") { a.offsets = v; i++; }
    else if (k === "--seed") { a.seed = parseInt(v, 10); i++; }
    else if (k === "--json") a.json = true;
    else if (k === "--ai") a.ai = true;
    else if (k === "--predict") { a.predict = true; if (v && /^\d+$/.test(v)) { a.predictTop = parseInt(v, 10); i++; } }
    else if (k === "--predict-mode") { a.predictMode = v; i++; }
    else if (k === "--target") { a.target = parseInt(v, 10); i++; }
    else if (k === "--anchor-detail") { a.predict = true; a.anchorDetail = true; }
    else if (k === "--stats-cond") { a.statsCond = v; i++; }
    else if (k === "--vote-top") { a.voteTop = parseInt(v, 10); i++; }
    else if (k === "--app-table") a.appTable = true;
    else if (k === "--ai-detail") { a.ai = true; a.aiDetail = true; }
    else if (k === "--demo") a.demo = true;
    else if (k === "--help" || k === "-h") { a.help = true; }
  }
  return a;
}

function offsetsToChecked(spec) {
  if (!spec) return null;
  var want = spec.split(",").map(function (s) { return parseInt(s, 10); });
  return Cha.NINE_GRID_DRAG_OFFSETS.map(function (o) { return want.indexOf(o) !== -1; });
}

/** 亂數資料（固定種子），只用來確認框架能跑；不是真實開獎。 */
function demoRecords(count, game, seed) {
  var profile = Cha.GAME_PROFILES[game] || Cha.GAME_PROFILES["539"];
  var s = seed >>> 0 || 1;
  function rnd() { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }
  var out = [];
  var day = new Date(2026, 0, 1);
  for (var i = 0; i < count; i++) {
    var picked = {};
    var nums = [];
    while (nums.length < profile.colCount) {
      var n = 1 + Math.floor(rnd() * profile.maxBall);
      if (!picked[n]) { picked[n] = true; nums.push(n); }
    }
    nums.sort(function (a, b) { return a - b; });
    var d = new Date(day.getTime() + i * 86400000);
    out.push({ date: d.toISOString().slice(0, 10), numbers: nums });
  }
  return out;
}

function pad2(n) { return String(n).padStart(2, "0"); }

function fmtOff(o) { return o === "x" || o === null ? String(o) : (o > 0 ? "+" + o : String(o)); }

/** 全形/半形混排的固定寬度：中文算 2 格 */
function padW(str, width) {
  var s = String(str), w = 0;
  for (var i = 0; i < s.length; i++) w += s.charCodeAt(i) > 255 ? 2 : 1;
  return w >= width ? s : s + new Array(width - w + 1).join(" ");
}

/**
 * 回溯統計表：
 *   下桿在預測期 N（= 錨定期），回溯 N-1 … N-16。每一次回測下桿那一列只當「真實的果」對答案，不進計算；
 *   標定與統計只讀它上面的列（搜尋範圍欄）。
 */
function printReport(result) {
  var o = result.opts;
  var f = result.frame;
  var offsetsOn = Cha.NINE_GRID_DRAG_OFFSETS.filter(function (_, i) { return o.offsetsChecked[i]; });
  var rowOf = function (idx) { return Cha.rowNo(result.rows, idx, o); };
  console.log("C式差數 回溯統計表  彩券=" + o.game + "  球數=" + o.maxBall + "  搜期=" + o.span + "  上桿掃描=" + o.sweepCount + "位置（差1~差" + o.sweepCount + "）  偏移=" + offsetsOn.join(","));
  console.log("列號：備用列 " + f.spareRowNo[0] + "~" + f.spareRowNo[1] + "、顯示區 " + f.visibleRowNo[0] + "~" + f.visibleRowNo[1] + "、空白第 1 列 " + (f.visibleRowNo[1] + 1) +
    "   預測期(錨定期)=第 " + f.targetRowNo + " 列   回溯 " + f.stepsRun + " 次：第 " + f.firstLowerRowNo + " 列 → 第 " + f.lastLowerRowNo + " 列");
  console.log("規則：下桿在哪一列，那一列就不進計算，只當真實的果對答案；標定與統計只讀搜尋範圍內的列。");
  console.log("");
  console.log(padW("回溯", 5) + padW("下桿列", 7) + padW("日期", 7) + padW("上桿位置(桿距)", 25) + padW("搜尋範圍 下桿側/上桿側", 24) + padW("標定", 5) + padW("主角", 5) + padW("有中", 5) + padW("紀錄", 5) + padW("真實的果", 16) + "命中號碼(幾顆主角推到)");
  result.records.forEach(function (r) {
    var date = r.meta && r.meta.date ? r.meta.date.slice(5) : "-";
    var ups = r.upperPositions.length ? r.upperPositions.map(function (u) { return "差" + (r.lowerIdx - u); }).join(" ") : "(上桿往上搜不滿" + o.span + "期)";
    var range = "-";
    if (r.upperPositions.length) {
      var lowestUpper = Math.max.apply(null, r.upperPositions);
      var highestUpper = Math.min.apply(null, r.upperPositions);
      // 下桿側：lowerIdx-1 … lowerIdx-span；上桿側：最低上桿-1 … 最高上桿-span
      range = rowOf(r.lowerIdx - 1) + "~" + rowOf(r.lowerIdx - o.span) + " / " + rowOf(lowestUpper - 1) + "~" + rowOf(highestUpper - o.span);
    }
    var pairs = {};
    r.aiEntries.forEach(function (e) { pairs[e.upperIdx + ":" + e.upperPair.join("-") + ":" + [e.self, e.partner].sort().join("-")] = true; });
    var hitSubjects = r.aiEntries.filter(function (e) { return e.hits && e.hits.length; });
    var recs = 0; hitSubjects.forEach(function (e) { recs += e.hits.length; });
    var byNum = {};
    hitSubjects.forEach(function (e) {
      var drag = Cha.nineGridDrag(e.self, o.maxBall);
      e.hits.forEach(function (h) { var n = drag[Cha.NINE_GRID_DRAG_OFFSETS.indexOf(h)]; byNum[n] = (byNum[n] || 0) + 1; });
    });
    var hitNums = Object.keys(byNum).map(function (k) { return { n: +k, c: byNum[k] }; }).sort(function (a, b) { return b.c - a.c || a.n - b.n; })
      .map(function (x) { return pad2(x.n) + "(" + x.c + ")"; }).join(" ") || "-";
    console.log(padW(String(r.t), 5) + padW(String(r.lowerRowNo), 7) + padW(date, 7) + padW(ups, 25) + padW(range, 24) +
      padW(String(Object.keys(pairs).length), 5) + padW(String(r.aiEntries.length), 5) + padW(String(hitSubjects.length), 5) + padW(String(recs), 5) +
      padW(r.actual.map(pad2).join(" "), 16) + hitNums);
  });
  console.log("");
  console.log("各桿距分開統計（差 6 只算差 6 的）  最高值(佔有中紀錄的 %)");
  console.log(padW("桿距", 6) + padW("有資料", 7) + padW("主角", 6) + padW("有中", 6) + padW("紀錄", 6) + padW("同列", 14) + padW("連線差", 14) + padW("列距", 14) + padW("九宮差前三", 26) + "桿距");
  function topStr(fs, key, n) {
    var list = fs[key].list.slice(0, n || 1);
    return list.map(function (x) { return fmtOff(x.value) + " " + (x.prob * 100).toFixed(0) + "%"; }).join(" ") || "-";
  }
  result.byGap.forEach(function (g) {
    console.log(padW("差" + (-g.gap), 6) + padW(g.steps + "次", 7) + padW(String(g.subjects), 6) + padW(String(g.hitSubjects), 6) + padW(String(g.hitRecords), 6) +
      padW(topStr(g.fields, "sameRow"), 14) + padW(topStr(g.fields, "linkDiff"), 14) + padW(topStr(g.fields, "rowDist"), 14) + padW(topStr(g.fields, "offset", 3), 26) + topStr(g.fields, "gap"));
  });
  var all = result.aiFields;
  var steps = {}; result.aiEntries.forEach(function (e) { steps[e.lowerIdx] = true; });
  console.log(padW("全部", 6) + padW(Object.keys(steps).length + "次", 7) + padW(String(result.aiEntries.length), 6) + padW(String(all.hitSubjects), 6) + padW(String(all.hitRecords), 6) +
    padW(topStr(all.fields, "sameRow"), 14) + padW(topStr(all.fields, "linkDiff"), 14) + padW(topStr(all.fields, "rowDist"), 14) + padW(topStr(all.fields, "offset", 3), 26) + topStr(all.fields, "gap", 3));
}

/** App 原本的 6 期掃描統計（預期的果 = 前二名補第三名） */
function printAppTable(result) {
  console.log("");
  console.log("App 原邏輯（6 期掃描累計，取前二名不足補第三名）");
  console.log("回溯  列號 日期        上桿位置        備用  預期的果(號碼×次數)                          真實的果             命中");
  result.records.forEach(function (r) {
    var date = r.meta && r.meta.date ? r.meta.date : "-";
    var ups = r.upperPositions.map(function (u) { return r.lowerIdx - u; }).join(",");
    var pred = r.predicted.map(function (p) { return pad2(p.n) + "×" + p.c; }).join(" ") || "(無)";
    var act = r.actual.map(pad2).join(" ");
    var hits = r.hits.length ? r.hits.map(pad2).join(" ") : "-";
    console.log(
      String(r.t).padStart(3) + "   " + String(r.lowerRowNo).padStart(2) + "  " + date.padEnd(11) + " 下桿-" + ups.padEnd(12) + " " +
      String(r.spareRowsUsed).padStart(2) + "列  " + pred.padEnd(44) + " " + act.padEnd(20) + " " + hits
    );
  });
  var s = result.summary;
  console.log("合計：跑 " + s.runs + " 次，" + s.runsWithPrediction + " 次有預期號碼，" + s.runsWithHit + " 次至少命中 1 顆；預期號碼 " + s.totalPredicted + " 顆，命中 " + s.totalHits + " 顆，命中率 " +
    (s.hitRate * 100).toFixed(1) + "%（純機率 " + (s.randomRate * 100).toFixed(1) + "%，提升 " + s.lift.toFixed(2) + "）");
}


function printAi(result, detail) {
  var agg = result.ai;
  console.log("");
  console.log("差數ai統計  有中的主角 " + agg.total + " 顆、有中的紀錄 " + result.aiFields.hitRecords + " 筆（沒中 x 不列入計算與排行）");
  console.log("九宮差  " + Cha.NINE_GRID_DRAG_OFFSETS.map(function (o) { return fmtOff(o).padStart(4); }).join(""));
  console.log("命中數  " + Cha.NINE_GRID_DRAG_OFFSETS.map(function (o) { return String(agg.byOffset[o]).padStart(4); }).join(""));
  var fs = result.aiFields;
  console.log("");
  console.log("五個記錄的排行（分母 = 有中的紀錄 " + fs.hitRecords + " 筆）");
  Cha.AI_FIELDS.forEach(function (f) {
    var st = fs.fields[f.key];
    var top = st.top.map(fmtOff).join(" / ") || "-";
    console.log("第" + f.no + "個記錄 " + f.label.padEnd(4, "　") + " 最高：" + top);
    st.list.forEach(function (x) {
      console.log("    " + fmtOff(x.value).padStart(4) + "  " + String(x.count).padStart(3) + " 筆  " +
        (x.prob * 100).toFixed(1).padStart(5) + "%");
    });
  });
  printCrossTable(result.offsetByPairDiff, "九宮差比對表：標定連線的九宮差（例 +11 的兩個標定號碼）→ 主角加哪個九宮差會中（命中主角數 / 該組主角數）");
  if (!detail) return;
  console.log("");
  console.log("每一筆紀錄  [同列, 連線差, 列距, 九宮差, 桿距]  主角(連線對手)");
  result.records.forEach(function (r) {
    var flat = Cha.flattenAiRecords(r.aiEntries);
    if (!flat.length) return;
    var date = r.meta && r.meta.date ? r.meta.date : "-";
    console.log("回測" + String(r.t).padStart(2) + "  " + date + "  真實的果 " + r.actual.map(pad2).join(" ") + "  共 " + flat.length + " 筆");
    flat.forEach(function (x) {
      console.log("    [" + [x.sameRow, fmtOff(x.linkDiff), x.rowDist, fmtOff(x.offset), x.gap].join(", ") + "]  " +
        pad2(x.self) + "(" + pad2(x.partner) + ")");
    });
  });
}

function printCrossTable(ct, title) {
  if (!ct || !ct.groups.length) return;
  console.log("");
  console.log(title);
  console.log("連線差  主角數 有中  " + Cha.NINE_GRID_DRAG_OFFSETS.map(function (o) { return fmtOff(o).padStart(6); }).join("") + "   最常中");
  ct.groups.forEach(function (g) {
    console.log(fmtOff(g.value).padStart(5) + "  " + String(g.subjects).padStart(5) + " " + String(g.hitSubjects).padStart(4) + "  " +
      Cha.NINE_GRID_DRAG_OFFSETS.map(function (o) { return (String(g.byOffset[o]) + "(" + Math.round(g.rate[o] * 100) + "%)").padStart(6); }).join("") +
      "   " + (g.top.map(fmtOff).join("/") || "-"));
  });
}

function printPredict(pr, anchorDetail) {
  console.log("");
  if (pr.anchor_) {
    console.log("錨定式：九宮差前 " + pr.anchor_.offsetTop.length + " 名 " + pr.anchor_.offsetTop.map(function (x) { return fmtOff(x.value) + "(" + (x.prob * 100).toFixed(1) + "%)"; }).join(" ") +
      "  主角 " + pr.anchor_.subjects.length + " 顆");
    if (pr.anchor_.statsCond && pr.anchor_.statsCond.length) console.log("  分開統計：依 " + pr.anchor_.statsCond.join("+") + " 分桶，每顆主角只用同桶的回溯資料（桶內沒命中紀錄才退回全體）");
    if (anchorDetail) {
      console.log("  主角(對手) 上桿列  [同列, 連線差, 列距, 桿距] → 百分比相加 = 主角分數 → 套九宮差得到的號碼");
      pr.anchor_.subjects.forEach(function (sj) {
        var pct = [sj.parts.sameRow, sj.parts.linkDiff, sj.parts.rowDist, sj.parts.gap].map(function (p) { return (p * 100).toFixed(1) + "%"; }).join(" + ");
        var bk = sj.bucket ? "  [桶 " + sj.bucket.key + "：主角 " + sj.bucket.hitSubjects + "/" + sj.bucket.subjects + " 有中" + (sj.bucket.fallback ? "，退回全體" : "") + "]" : "";
        console.log("  " + pad2(sj.self) + "(" + pad2(sj.partner) + ")  [" + [sj.sameRow, fmtOff(sj.linkDiff), sj.rowDist, sj.gap].join(", ") + "]  " + pct +
          " = " + (sj.subjectScore * 100).toFixed(1) + "%  → " + sj.outputs.map(function (x) { return pad2(sj.self) + fmtOff(x.offset) + "=" + pad2(x.num); }).join(" ") + bk);
      });
    }
  }
  if (pr.gapvote_) {
    console.log("桿距投票：差 6 統計差 6 … 差 1 統計差 1，共 " + pr.gapvote_.tableCount + " 份預測表，比哪一號出現的份數最多");
    pr.gapvote_.tables.forEach(function (t) {
      var head = "  差" + (-t.gap) + "  即時主角 " + t.subjects + " 顆  回溯主角 " + t.hitSubjects + "/" + t.btSubjects + " 有中";
      if (t.empty) { console.log(head + "  → 沒有命中紀錄，這份表空白"); return; }
      console.log(head + "  九宮差前 " + t.offsetTop.length + " 名 " + t.offsetTop.map(function (x) { return fmtOff(x.value); }).join("/") +
        "  → 表內 " + t.nums.length + " 顆：" + t.ranked.map(function (x) { return pad2(x.n) + "(" + x.score.toFixed(2) + ")"; }).join(" "));
    });
  }
  console.log("預測第 " + pr.targetRowNo + " 列（上桿掃上方 " + pr.live.positions.length + " 個位置）  計分規則=" + pr.mode + "  主角 " + pr.subjects + " 顆");
  if (pr.top_) {
    var tv = pr.top_.topValues;
    console.log("  最高值：同列 " + tv.sameRow.map(fmtOff).join("/") + "  連線差 " + tv.linkDiff.map(fmtOff).join("/") +
      "  列距 " + tv.rowDist.join("/") + "  桿距 " + tv.gap.join("/") +
      "  → 主角四個條件符合 " + pr.top_.matchLevel + " 個的有 " + pr.top_.keptSubjects + " 顆");
    console.log("  九宮差依機率：" + pr.top_.offsetRounds.slice(0, 4).map(function (r) { return r.offsets.map(fmtOff).join("/") + "(" + r.count + ")"; }).join("  →  "));
  }
  if (!pr.ranked.length) { console.log("  沒有任何標定連線，無法預測"); return; }
  console.log("名次  號碼   分數      來源（" + (pr.gapvote_ ? "份數 / 出現在哪幾份桿距表" : "主角+九宮差 → 這顆") + "）");
  pr.top.forEach(function (x, i) {
    var src = pr.gapvote_
      ? pr.gapvote_.votes[x.n] + " 份：" + x.reasons.map(function (r) { return "差" + (-r.gap); }).join(" ")
      : x.reasons.slice().sort(function (a, b) { return b.weight - a.weight; }).slice(0, 4)
        .map(function (r) { return pad2(r.self) + (r.offset >= 0 ? "+" : "") + r.offset; }).join(" ");
    console.log(String(i + 1).padStart(3) + "    " + pad2(x.n) + "   " + x.score.toFixed(4) + "   " + src + (x.reasons.length > 4 ? " …" : ""));
  });
  console.log("預測號碼：" + pr.topNums.map(pad2).join(" "));
  if (pr.actual) console.log("真實的果：" + pr.actual.map(pad2).join(" ") + "   命中：" + (pr.hits.length ? pr.hits.map(pad2).join(" ") : "-"));
}

function main() {
  var a = parseArgs(process.argv.slice(2));
  if (a.help) {
    console.log(fs.readFileSync(__filename, "utf8").split("*/")[0].split("\n").slice(1).join("\n"));
    return;
  }
  var records;
  if (a.demo) {
    records = demoRecords(60, a.game, a.seed);
  } else {
    var file = a.file || path.join(__dirname, "..", "data", "results.json");
    if (!fs.existsSync(file)) {
      console.error("找不到資料檔：" + file + "（可用 --file 指定，或 --demo 用亂數資料試跑）");
      process.exit(1);
    }
    records = JSON.parse(fs.readFileSync(file, "utf8"));
    if (records && !Array.isArray(records) && Array.isArray(records.results)) records = records.results;
  }
  var opts = {
    predictTop: a.predictTop,
    predictMode: a.predictMode,
    game: a.game,
    steps: a.steps,
    span: a.span,
    sweepCount: a.sweep,
    spareRows: a.spare,
    offsetsChecked: offsetsToChecked(a.offsets),
    anchorStatsCond: a.statsCond ? (a.statsCond === "global" ? "global" : a.statsCond.split(",")) : "global",
    gapVoteTop: a.voteTop || null,
  };
  var data = Cha.fromRecords(records, opts);
  if (a.target) opts.targetIdx = Cha.idxOfRowNo(data.rows, a.target, Cha.resolveOpts(opts)); // 統一列號 → 索引（49 = rows.length）
  var result = Cha.backtest(data.rows, opts, data.meta);
  if (a.json) {
    // steps 裡有 Set，輸出時轉成陣列
    console.log(JSON.stringify(result, function (k, v) { return v instanceof Set ? Array.from(v) : v; }, 2));
    return;
  }
  result.rows = data.rows;
  printReport(result);
  if (a.appTable) printAppTable(result);
  if (a.ai) printAi(result, a.aiDetail);
  if (a.predict) printPredict(Cha.predict(data.rows, opts, result), a.anchorDetail);
}

main();
