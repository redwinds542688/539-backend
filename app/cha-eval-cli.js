#!/usr/bin/env node
/*
 * C式差數 滾動評估 CLI
 *   node app/cha-eval-cli.js --file data/results.json          # 用真實資料比較所有變體
 *   node app/cha-eval-cli.js --file x.json --from 60 --to 300   # 只評估這段目標期（索引）
 *   node app/cha-eval-cli.js --file x.json --top 5              # 每次取前幾顆（預設 5）
 */
"use strict";
var fs = require("fs");
var Cha = require("./cha-backtest.js");
var Ev = require("./cha-eval.js");

var a = { file: null, from: undefined, to: undefined, top: 5, game: "539" };
var argv = process.argv.slice(2);
for (var i = 0; i < argv.length; i++) {
  var k = argv[i], v = argv[i + 1];
  if (k === "--file") { a.file = v; i++; }
  else if (k === "--from") { a.from = parseInt(v, 10); i++; }
  else if (k === "--to") { a.to = parseInt(v, 10); i++; }
  else if (k === "--top") { a.top = parseInt(v, 10); i++; }
  else if (k === "--game") { a.game = v; i++; }
}
if (!a.file || !fs.existsSync(a.file)) { console.error("請用 --file 指定資料檔（[{date, numbers}]）"); process.exit(1); }
var records = JSON.parse(fs.readFileSync(a.file, "utf8"));
if (records && !Array.isArray(records) && Array.isArray(records.results)) records = records.results;
var data = Cha.fromRecords(records, { game: a.game });
var t0 = Date.now();
var ev = Ev.evaluate(data.rows, { from: a.from, to: a.to, topN: a.top, game: a.game });
console.log("滾動評估  資料 " + data.rows.length + " 期（" + data.meta[0].date + " ~ " + data.meta[data.rows.length - 1].date + "）  目標期索引 " + ev.from + "~" + ev.to +
  "  每次取前 " + ev.topN + " 顆  純機率基準 " + (ev.results[0].baseline * 100).toFixed(1) + "%  耗時 " + ((Date.now() - t0) / 1000).toFixed(1) + " 秒");
console.log("");
console.log("變體".padEnd(30, "　") + " 次數  平均顆數  命中/預測    命中率   提升   至少中1顆(實際/隨機期望)");
ev.results.forEach(function (r) {
  console.log(r.name.padEnd(30, "　") + String(r.runs).padStart(4) + "  " + r.avgPredicted.toFixed(1).padStart(6) + "   " +
    (r.hits + "/" + r.predicted).padStart(10) + "   " + (r.hitRate * 100).toFixed(1).padStart(5) + "%  " + r.lift.toFixed(2).padStart(5) + "   " +
    (r.runsWithHit + "/" + r.expectRunsWithHit.toFixed(1)).padStart(12));
});
