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
 *   node app/cha-backtest-cli.js --target 17           # 預測目標列（顯示列號 1..16，17 = 空白第 1 列，預設）；回測從目標列上一列往上 16 次
 *   node app/cha-backtest-cli.js --predict [N]         # 用回測統計預測目標列，列前 N 顆（預設 5）；目標列已開出時附命中
 *   node app/cha-backtest-cli.js --predict-mode top|field|condition   # 計分規則：top=最高值篩選（預設）、field=機率相乘、condition=同條件命中率
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

function printReport(result) {
  var o = result.opts;
  var offsetsOn = Cha.NINE_GRID_DRAG_OFFSETS.filter(function (_, i) { return o.offsetsChecked[i]; });
  console.log("C式差數 回測  彩券=" + o.game + "  球數=" + o.maxBall + "  搜期=" + o.span +
    "  掃描=" + o.sweepCount + "位置  顯示區=" + o.windowSize + "期  備用列=" + o.spareRows + "期  偏移=" + offsetsOn.join(","));
  console.log("預測目標=第 " + result.frame.targetRowNo + " 列  回測=" + result.frame.stepsRun + "次（下桿從第 " +
    (result.frame.targetRowNo - 1) + " 列往上到第 " + (result.frame.targetRowNo - result.frame.stepsRun) + " 列）");
  console.log("");
  console.log("回溯  日期        上桿位置        備用  預期的果(號碼×次數)                          真實的果             命中");
  result.records.forEach(function (r) {
    var date = r.meta && r.meta.date ? r.meta.date : "-";
    var ups = r.upperPositions.map(function (u) { return r.lowerIdx - u; }).join(",");
    var pred = r.predicted.map(function (p) { return pad2(p.n) + "×" + p.c; }).join(" ") || "(無)";
    var act = r.actual.map(pad2).join(" ");
    var hits = r.hits.length ? r.hits.map(pad2).join(" ") : "-";
    console.log(
      String(r.t).padStart(3) + "   " + date.padEnd(11) + " 下桿-" + ups.padEnd(12) + " " +
      String(r.spareRowsUsed).padStart(2) + "列  " + pred.padEnd(44) + " " + act.padEnd(20) + " " + hits
    );
  });
  var s = result.summary;
  console.log("");
  console.log("合計：跑 " + s.runs + " 次，" + s.runsWithPrediction + " 次有預期號碼，" + s.runsWithHit + " 次至少命中 1 顆");
  console.log("預期號碼總數 " + s.totalPredicted + "，命中 " + s.totalHits + " 顆，命中率 " + (s.hitRate * 100).toFixed(1) + "%");
  console.log("純機率基準：同樣顆數隨機挑平均會中 " + s.totalExpectedRandomHits.toFixed(2) + " 顆（" +
    (s.randomRate * 100).toFixed(1) + "%），提升倍數 " + s.lift.toFixed(2));
}

function fmtOff(o) { return o === "x" || o === null ? String(o) : (o > 0 ? "+" + o : String(o)); }

function printAi(result, detail) {
  var agg = result.ai;
  console.log("");
  console.log("差數ai統計  主角總數 " + agg.total + "  沒中(x) " + agg.x + "  有中 " + (agg.total - agg.x));
  console.log("九宮差  " + Cha.NINE_GRID_DRAG_OFFSETS.map(function (o) { return fmtOff(o).padStart(4); }).join(""));
  console.log("命中數  " + Cha.NINE_GRID_DRAG_OFFSETS.map(function (o) { return String(agg.byOffset[o]).padStart(4); }).join(""));
  var fs = result.aiFields;
  console.log("");
  console.log("五個記錄的機率分布（分母 = 有中的紀錄 " + fs.hitRecords + " 筆；命中率 = 該值的主角有中 / 主角總數）");
  Cha.AI_FIELDS.forEach(function (f) {
    var st = fs.fields[f.key];
    var top = st.top.map(fmtOff).join(" / ") || "-";
    console.log("第" + f.no + "個記錄 " + f.label.padEnd(4, "　") + " 最高：" + top);
    st.list.forEach(function (x) {
      console.log("    " + fmtOff(x.value).padStart(4) + "  " + String(x.count).padStart(3) + " 筆  " +
        (x.prob * 100).toFixed(1).padStart(5) + "%   命中率 " + x.hitSubjects + "/" + x.subjects + " = " + (x.hitRate * 100).toFixed(0) + "%");
    });
  });
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

function printPredict(pr) {
  console.log("");
  console.log("預測第 " + pr.targetRowNo + " 列（上桿掃上方 " + pr.live.positions.length + " 個位置）  計分規則=" + pr.mode + "  主角 " + pr.subjects + " 顆");
  if (pr.top_) {
    var tv = pr.top_.topValues;
    console.log("  最高值：同列 " + tv.sameRow.map(fmtOff).join("/") + "  連線差 " + tv.linkDiff.map(fmtOff).join("/") +
      "  列距 " + tv.rowDist.join("/") + "  桿距 " + tv.gap.join("/") +
      "  → 主角四個條件符合 " + pr.top_.matchLevel + " 個的有 " + pr.top_.keptSubjects + " 顆");
    console.log("  九宮差依機率：" + pr.top_.offsetRounds.slice(0, 4).map(function (r) { return r.offsets.map(fmtOff).join("/") + "(" + r.count + ")"; }).join("  →  "));
  }
  if (!pr.ranked.length) { console.log("  沒有任何標定連線，無法預測"); return; }
  console.log("名次  號碼   分數      來源（主角+九宮差 → 這顆）");
  pr.top.forEach(function (x, i) {
    var src = x.reasons.slice().sort(function (a, b) { return b.weight - a.weight; }).slice(0, 4)
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
  };
  var data = Cha.fromRecords(records, opts);
  if (a.target) opts.targetIdx = data.rows.length - 16 + (a.target - 1); // 顯示列號 → 索引（17 = rows.length）
  var result = Cha.backtest(data.rows, opts, data.meta);
  if (a.json) {
    // steps 裡有 Set，輸出時轉成陣列
    console.log(JSON.stringify(result, function (k, v) { return v instanceof Set ? Array.from(v) : v; }, 2));
    return;
  }
  printReport(result);
  if (a.ai) printAi(result, a.aiDetail);
  if (a.predict) printPredict(Cha.predict(data.rows, opts, result));
}

main();
