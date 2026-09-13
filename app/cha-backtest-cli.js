#!/usr/bin/env node
/*
 * C式差數 回測 CLI
 *
 *   node app/cha-backtest-cli.js                       # 讀 data/results.json，回溯 16 期
 *   node app/cha-backtest-cli.js --file path.json      # 指定資料檔（[{date, numbers}] 陣列）
 *   node app/cha-backtest-cli.js --game lotto          # 539 | daily | mark6 | lotto
 *   node app/cha-backtest-cli.js --steps 16 --span 6 --sweep 6
 *   node app/cha-backtest-cli.js --spare 16                   # 備用列數（畫面外可往上讀的期數，預設 16）
 *   node app/cha-backtest-cli.js --offsets -11,-10,-9,-1,0,1,9,10,11   # 只勾這些偏移
 *   node app/cha-backtest-cli.js --json                # 輸出完整 JSON（給後續機率邏輯用）
 *   node app/cha-backtest-cli.js --demo                # 用亂數資料跑一次，確認框架可動
 */
"use strict";

var fs = require("fs");
var path = require("path");
var Cha = require("./cha-backtest.js");

function parseArgs(argv) {
  var a = { file: null, game: "539", steps: 16, span: 6, sweep: 6, offsets: null, json: false, demo: false, seed: 1, spare: 16 };
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
    "  掃描=" + o.sweepCount + "位置  回溯=" + o.steps + "次  備用列=" + o.spareRows + "  偏移=" + offsetsOn.join(","));
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
    game: a.game,
    steps: a.steps,
    span: a.span,
    sweepCount: a.sweep,
    spareRows: a.spare,
    offsetsChecked: offsetsToChecked(a.offsets),
  };
  var data = Cha.fromRecords(records, opts);
  var result = Cha.backtest(data.rows, opts, data.meta);
  if (a.json) {
    // steps 裡有 Set，輸出時轉成陣列
    console.log(JSON.stringify(result, function (k, v) { return v instanceof Set ? Array.from(v) : v; }, 2));
    return;
  }
  printReport(result);
}

main();
