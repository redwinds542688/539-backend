/*
 * C式差數 滾動評估：在真實開獎資料上逐期預測、逐期對答案，比較各種預測變體的命中率。
 *
 * 對每個目標期 T（由舊到新）：只用 T 以前的資料跑 predict(targetIdx = T)，取前 topN 顆，
 * 跟 rows[T] 真實開出對照。所有變體用同一批目標期，結果才能直接比較。
 *
 * 純機率基準：539 每期 5 顆佔 39 顆，任一顆隨機命中 5/39 = 12.8%；
 * 隨機挑 k 顆至少中 1 顆的機率 = 1 − C(34,k)/C(39,k)。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./cha-backtest.js"));
  else root.ChaEval = factory(root.ChaBacktest);
})(typeof self !== "undefined" ? self : this, function (Cha) {
  "use strict";

  function choose(n, k) { var r = 1; for (var i = 1; i <= k; i++) r = r * (n - k + i) / i; return r; }
  function pAtLeastOne(maxBall, colCount, k) {
    if (k <= 0) return 0;
    if (k > maxBall - colCount) return 1;
    return 1 - choose(maxBall - colCount, k) / choose(maxBall, k);
  }

  /** 內建變體（都在現有九宮邏輯範圍內，只改統計/計分方式） */
  var VARIANTS = [
    { name: "app原邏輯(6期掃描前二名)", opts: { predictMode: "app" }, variableCount: true },
    { name: "anchor 預設(相加,九宮差前3)", opts: { predictMode: "anchor" } },
    { name: "anchor 九宮差前1", opts: { predictMode: "anchor", predictOffsetTop: 1 } },
    { name: "anchor 九宮差前2", opts: { predictMode: "anchor", predictOffsetTop: 2 } },
    { name: "anchor 九宮差前5", opts: { predictMode: "anchor", predictOffsetTop: 5 } },
    { name: "anchor 九宮差全部9", opts: { predictMode: "anchor", predictOffsetTop: 9 } },
    { name: "anchor 主角分數相乘", opts: { predictMode: "anchor", anchorSubjectScore: "product" } },
    { name: "anchor 不看主角分數(只看九宮差)", opts: { predictMode: "anchor", anchorSubjectScore: "none" } },
    { name: "anchor 九宮差百分比相乘", opts: { predictMode: "anchor", anchorOffsetWeight: "mul" } },
    { name: "anchor 不加九宮差百分比", opts: { predictMode: "anchor", anchorOffsetWeight: "none" } },
    { name: "anchor 九宮差依桿距分開排行", opts: { predictMode: "anchor", anchorOffsetCond: "gap" } },
    { name: "anchor 九宮差依列距分開排行", opts: { predictMode: "anchor", anchorOffsetCond: "rowDist" } },
    { name: "anchor 九宮差依同列分開排行", opts: { predictMode: "anchor", anchorOffsetCond: "sameRow" } },
    { name: "anchor 九宮差依連線差分開排行", opts: { predictMode: "anchor", anchorOffsetCond: "linkDiff" } },
    { name: "巧合:桿距分開統計(差6只算差6)", opts: { predictMode: "anchor", anchorStatsCond: "gap" } },
    { name: "巧合:桿距+列距分開統計", opts: { predictMode: "anchor", anchorStatsCond: ["gap", "rowDist"] } },
    { name: "巧合:桿距+同列分開統計", opts: { predictMode: "anchor", anchorStatsCond: ["gap", "sameRow"] } },
    { name: "巧合:桿距+連線差分開統計", opts: { predictMode: "anchor", anchorStatsCond: ["gap", "linkDiff"] } },
    { name: "巧合:四記錄全同才算(完全巧合)", opts: { predictMode: "anchor", anchorStatsCond: ["gap", "rowDist", "sameRow", "linkDiff"] } },
    { name: "巧合:桿距分開+九宮差前1", opts: { predictMode: "anchor", anchorStatsCond: "gap", predictOffsetTop: 1 } },
    { name: "巧合:桿距分開+只看九宮差", opts: { predictMode: "anchor", anchorStatsCond: "gap", anchorSubjectScore: "none" } },
    { name: "巧合:桿距分開+回溯32次", opts: { predictMode: "anchor", anchorStatsCond: "gap", steps: 32, spareRows: 48 } },
    { name: "比對:九宮差依連線九宮差(pairDiff)排行", opts: { predictMode: "anchor", anchorOffsetCond: "pairDiff" } },
    { name: "比對:pairDiff排行+不看主角分數", opts: { predictMode: "anchor", anchorOffsetCond: "pairDiff", anchorSubjectScore: "none" } },
    { name: "比對:pairDiff排行前1+不看主角分數", opts: { predictMode: "anchor", anchorOffsetCond: "pairDiff", anchorSubjectScore: "none", predictOffsetTop: 1 } },
    { name: "比對:pairDiff整套分開統計", opts: { predictMode: "anchor", anchorStatsCond: "pairDiff" } },
    { name: "比對:pairDiff+桿距分開統計", opts: { predictMode: "anchor", anchorStatsCond: ["pairDiff", "gap"] } },
    { name: "比對:pairDiff排行+回溯32次", opts: { predictMode: "anchor", anchorOffsetCond: "pairDiff", anchorSubjectScore: "none", steps: 32, spareRows: 48 } },
    { name: "投票:6份桿距表全部號碼投票", opts: { predictMode: "gapvote" } },
    { name: "投票:每份表前3顆投票", opts: { predictMode: "gapvote", gapVoteTop: 3 } },
    { name: "投票:每份表前5顆投票", opts: { predictMode: "gapvote", gapVoteTop: 5 } },
    { name: "投票:每份表前10顆投票", opts: { predictMode: "gapvote", gapVoteTop: 10 } },
    { name: "投票:每份表前5顆+不看主角分數", opts: { predictMode: "gapvote", gapVoteTop: 5, anchorSubjectScore: "none" } },
    { name: "投票:每份表前5顆+九宮差前1", opts: { predictMode: "gapvote", gapVoteTop: 5, predictOffsetTop: 1 } },
    { name: "投票:每份表前5顆+九宮差全部9", opts: { predictMode: "gapvote", gapVoteTop: 5, predictOffsetTop: 9 } },
    { name: "投票:每份表前5顆+回溯32次", opts: { predictMode: "gapvote", gapVoteTop: 5, steps: 32, spareRows: 48 } },
    { name: "anchor 記錄1/2/3/5以主角計", opts: { predictMode: "anchor", fieldCountMode: "subjects" } },
    { name: "anchor 回溯32次", opts: { predictMode: "anchor", steps: 32, spareRows: 48 } },
    { name: "anchor 舊定義(跳過N-1,回溯N-2起)", opts: { predictMode: "anchor", anchorRows: 1 } },
    { name: "field 機率相乘", opts: { predictMode: "field" } },
    { name: "condition 同條件命中率", opts: { predictMode: "condition" } },
    { name: "top 最高值篩選", opts: { predictMode: "top" } },
  ];

  /**
   * evaluate(rows, { variants, from, to, topN, game })
   * 回傳每個變體的 { name, runs, predicted, hits, hitRate, baseline, lift, runsWithHit, expectRunsWithHit, avgPredicted }
   */
  function evaluate(rows, options) {
    var opt = options || {};
    var variants = opt.variants || VARIANTS;
    var topN = opt.topN || 5;
    var base = Cha.resolveOpts({ game: opt.game || "539" });
    var from = opt.from !== undefined ? opt.from : Math.min(rows.length - 1, base.windowSize + base.spareRows);
    var to = opt.to !== undefined ? opt.to : rows.length - 1;
    var baseline = base.colCount / base.maxBall;
    var results = variants.map(function (v) {
      var r = { name: v.name, runs: 0, predicted: 0, hits: 0, runsWithHit: 0, expectRunsWithHit: 0, perRun: [] };
      for (var T = from; T <= to; T++) {
        var o = {};
        for (var k in v.opts) o[k] = v.opts[k];
        o.game = opt.game || "539";
        // 只餵目標期以前的資料：框架（顯示區/備用列）跟著目標期走，目標期本身就是「空白第 1 列」
        var hist = rows.slice(0, T);
        o.targetIdx = T;
        o.predictTop = v.variableCount ? 39 : topN;
        var pr = Cha.predict(hist, o);
        var nums = v.variableCount ? pr.ranked.map(function (x) { return x.n; }) : pr.topNums;
        var actual = rows[T];
        var hit = nums.filter(function (n) { return actual.indexOf(n) !== -1; });
        r.runs++;
        r.predicted += nums.length;
        r.hits += hit.length;
        if (hit.length) r.runsWithHit++;
        r.expectRunsWithHit += pAtLeastOne(base.maxBall, base.colCount, nums.length);
        if (opt.keepRuns) r.perRun.push({ T: T, nums: nums, hits: hit });
      }
      r.hitRate = r.predicted ? r.hits / r.predicted : 0;
      r.baseline = baseline;
      r.lift = baseline ? r.hitRate / baseline : 0;
      r.avgPredicted = r.runs ? r.predicted / r.runs : 0;
      r.expectHits = r.predicted * baseline;
      if (!opt.keepRuns) delete r.perRun;
      return r;
    });
    return { from: from, to: to, topN: topN, results: results };
  }

  return { VARIANTS: VARIANTS, evaluate: evaluate, pAtLeastOne: pAtLeastOne };
});
