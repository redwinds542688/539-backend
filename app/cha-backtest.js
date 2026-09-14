/*
 * C式差數 回測框架（純邏輯，不依賴 DOM）
 *
 * 這個模組把「名揚四海彩卷系統」裡 C式差數的三段核心邏輯
 *   1. 標定   runCModeChaSearch()        → markCha()
 *   2. 統計   computeCModeChaStatCounts() → countCha()
 *   3. 前幾名 computeCModeTopRankList()   → topRankList()
 * 逐行對照移植成只吃「號碼陣列」的純函式，再往上架：
 *   4. 6期掃描 runCModeChaStatSweepThenShow() → sweep()
 *   5. 16次回測                               → backtest()
 *
 * 名詞（沿用 App 的定義）：
 *   rows      ：開獎列陣列，由舊到新，每列是「由小到大排序」的號碼陣列（不含特別號）。
 *   upperIdx  ：上桿所在列的 0-based 索引（App 的 cModeAPeriod-1）。
 *   lowerIdx  ：下桿所在列的 0-based 索引（App 的 cModeBPeriod-1）。
 *   span      ：搜期（往上比對幾列），App 預設 6。
 *   offsets   ：九宮拖牌 9 個偏移，固定 [-11,-10,-9,-1,0,+1,+9,+10,+11]。
 *
 * 因 / 果：
 *   上桿 + 上桿上方的標定號碼 + 上桿那一列真正開出的號碼  = 因（驗證偏移用）
 *   下桿上方的標定號碼 + 同一偏移                         = 預期的果（統計表 / 填空白格）
 *   下桿那一列真正開出的號碼                              = 真實的果（回測時才拿得到）
 *
 * 之後要接「新的計算機率邏輯」時，從 backtest() 回傳的 records 取資料即可：
 *   每一筆 record 都保留 accCounts（累計次數）、contribs（每一次加分的來源：k/欄/偏移）、
 *   predicted / actual / hits，機率模型可以在 opts.scorer 這個掛勾裡接進來。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ChaBacktest = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /** 九宮拖牌 9 個偏移（與 App 的 NINE_GRID_DRAG_OFFSETS 完全相同，順序不可動） */
  var NINE_GRID_DRAG_OFFSETS = [-11, -10, -9, -1, 0, 1, 9, 10, 11];

  /** 各彩券的球數與欄數（App：isWideGame() ? 49/6 : 39/5） */
  var GAME_PROFILES = {
    "539": { maxBall: 39, colCount: 5 },
    daily: { maxBall: 39, colCount: 5 },
    mark6: { maxBall: 49, colCount: 6 },
    lotto: { maxBall: 49, colCount: 6 },
  };

  var DEFAULTS = {
    game: "539",
    span: 6, // 搜期（App 預設 6，可 3~6）
    sweepCount: 6, // 長按 6期掃描：上桿放在下桿上方 6..1 列
    windowSize: 16, // 顯示區：App 畫面 16 期有開（16+4 視窗），固定框在最新 16 期
    spareRows: 32, // 備用列：顯示區上方另外備好的 32 期（捲動回溯用），不顯示、只供內部搜尋/統計
    frameEnd: null, // 顯示區最後一列的下一個索引；null = rows.length（顯示區 = 最新 16 期）
    topRanks: 2, // 前二名（App 的 CMODE_DING_TOP_RANKS）
    maxFill: 15, // 填空白格最多顆數（App 的 slice(0,15)）
    steps: 16, // 回測次數（回溯 16 期）
    offsetsChecked: null, // 9 個 boolean；null = 全部打勾
    intervals: null, // k2-k1 間隔打勾（App 的 cModeChaIntervals）；null = 全部打勾
    scorer: null, // 之後接「新計算機率邏輯」的掛勾：function(record, ctx) → 額外欄位
    targetIdx: null, // 預測期 N（下桿真正的位置）的索引；null = rows.length（空白第 1 列，列號 49）
    anchorRows: 0, // 錨定期 = 預測期 N（下桿真正的位置）；回溯從 N-1 開始到 N-16。設 1 時多跳過 N-1（舊定義 N-2 … N-17）
    predictOffsetTop: 3, // anchor 模式：第 4 個記錄排行取前幾名九宮差
    anchorSubjectScore: "sum", // anchor 模式主角分數："sum"（四個百分比相加）、"product"（相乘）、"none"（不計，只看九宮差）
    anchorOffsetWeight: "add", // anchor 模式九宮差如何併入號碼分數："add"（主角分數 + 九宮差百分比）、"mul"（相乘）、"none"（只用主角分數）
    anchorOffsetCond: "global", // anchor 模式九宮差排行的取樣範圍："global"（全部主角）或 "gap"/"rowDist"/"sameRow"/"linkDiff"/"pairDiff"（只取該記錄值相同的歷史主角；pairDiff = 標定連線的九宮差，例 +11 的兩個標定號碼）
    anchorStatsCond: "global", // anchor 模式「整套統計」的取樣範圍："global"，或記錄欄位名/陣列（例 "gap"、["gap","rowDist"]）：
                               // 差6只用回溯裡差6的資料、差5只用差5的（五個記錄的百分比與九宮差排行都只從同桿距的歷史主角算）
    fieldCountMode: "records", // 第 1/2/3/5 個記錄的分布以什麼計數："records"（一筆紀錄一次，中 3 個九宮差算 3 次）或 "subjects"（一顆主角一次）
    predictTop: 5, // predict() 取前幾顆
    predictMode: "anchor", // predict() 計分規則："anchor"（百分比相加，預設）、"top"（最高值篩選）、"field"（機率相乘）、"condition"（同條件命中率）、
                           // "gapvote"（差6統計差6…差1統計差1，6 份預測表各自做，再比哪一號出現的份數最多）、"app"（App 原 6 期掃描前二名）、
                           // "records"（紀錄法：上桿標定號碼的紀錄 1/2/3 到回溯紀錄找相同的，取紀錄 4 最多的九宮差套到對應下桿號碼）
    gapVoteTop: null, // gapvote 模式每份表取前幾顆來投票；null = 表內有分數的號碼全部算
    upperIdx: null, // records 模式：真正的上桿位置（索引）；null = 用 6 期掃描的全部位置
  };

  function resolveOpts(opts) {
    var o = {};
    var k;
    for (k in DEFAULTS) o[k] = DEFAULTS[k];
    if (opts) for (k in opts) if (opts[k] !== undefined) o[k] = opts[k];
    var profile = GAME_PROFILES[o.game] || GAME_PROFILES["539"];
    if (o.maxBall === undefined) o.maxBall = profile.maxBall;
    if (o.colCount === undefined) o.colCount = profile.colCount;
    o.offsetsChecked = normalizeChecked(o.offsetsChecked, NINE_GRID_DRAG_OFFSETS.length);
    o.intervals = normalizeChecked(o.intervals, o.span + 1);
    return o;
  }

  function normalizeChecked(v, len) {
    var out = [];
    for (var i = 0; i < len; i++) {
      if (v === null || v === undefined) out.push(true);
      else out.push(!!v[i]);
    }
    return out;
  }

  /** 九宮拖牌：calcNineGridDrag() 的整數版。超過球數就減球數、小於等於 0 就加球數。 */
  function nineGridDrag(x, maxBall) {
    return NINE_GRID_DRAG_OFFSETS.map(function (offset) {
      var z = x + offset;
      if (offset < 0) {
        if (z <= 0) z = maxBall + z;
      } else if (offset > 0) {
        if (z > maxBall) z = z - maxBall;
      }
      return z;
    });
  }

  function cellKey(rowIdx, col) {
    return rowIdx + ":" + col;
  }

  /**
   * 固定框架（跟 App 畫面一致，不隨下桿移動）：
   *   顯示區 = [frameEnd - windowSize, frameEnd)   最新 16 期
   *   備用列 = [frameEnd - windowSize - spareRows, 顯示區第 1 期)   再往上 32 期
   * 回測時下桿只在顯示區裡上移（第 16 期 → 第 1 期），上桿與搜尋列不夠時往備用列讀。
   */
  function frameEnd(rows, o) {
    return o.frameEnd === null || o.frameEnd === undefined ? rows.length : o.frameEnd;
  }
  function visibleStart(rows, o) {
    return Math.max(0, frameEnd(rows, o) - o.windowSize);
  }
  /** 搜尋可以往上讀到的最早列：顯示區 16 期 + 備用列 32 期 */
  function searchFloor(rows, o) {
    return Math.max(0, frameEnd(rows, o) - o.windowSize - o.spareRows);
  }

  /**
   * 取得某一列可用的號碼；超出「顯示區 + 備用列」範圍或資料不存在時回傳 null。
   * 上桿上方不足搜期時，會自然讀到備用列（畫面上看不到，只做內部統計）。
   * App 對應：getRowCells()（cells.length>=colCount 才算有效）。
   */
  function rowCells(rows, idx, lowerIdx, o) {
    if (idx < 0 || idx >= rows.length) return null;
    if (idx >= lowerIdx) return null; // 下桿列與其下方是「未來」，不可讀
    if (idx < searchFloor(rows, o)) return null;
    var r = rows[idx];
    if (!r || r.length < o.colCount) return null;
    return r.slice(0, o.colCount);
  }

  /**
   * 第一段：標定（runCModeChaSearch 的純函式版）。
   * 在下桿上方 k1、k2 列與上桿上方同樣的 k1、k2 列、同樣欄位，找差值相等且落在九宮拖牌偏移內的組合。
   * 回傳 { marked: Set<"row:col">, pairs: [...], echoes: [...] }
   */
  function markCha(rows, upperIdx, lowerIdx, opts) {
    var o = resolveOpts(opts);
    var marked = new Set();
    var pairs = [];
    var echoes = [];
    for (var k1 = 1; k1 <= o.span; k1++) {
      var bIdx1 = lowerIdx - k1;
      var aIdx1 = upperIdx - k1;
      var bCells1 = rowCells(rows, bIdx1, lowerIdx, o);
      var aCells1 = rowCells(rows, aIdx1, lowerIdx, o);
      if (!bCells1 || !aCells1) continue;
      for (var k2 = k1; k2 <= o.span; k2++) {
        if (!o.intervals[k2 - k1]) continue;
        var bIdx2 = lowerIdx - k2;
        var aIdx2 = upperIdx - k2;
        var bCells2 = rowCells(rows, bIdx2, lowerIdx, o);
        var aCells2 = rowCells(rows, aIdx2, lowerIdx, o);
        if (!bCells2 || !aCells2) continue;
        for (var col1 = 0; col1 < o.colCount; col1++) {
          for (var col2 = 0; col2 < o.colCount; col2++) {
            if (k1 === k2 && col2 <= col1) continue;
            var bNum1 = bCells1[col1], bNum2 = bCells2[col2];
            var aNum1 = aCells1[col1], aNum2 = aCells2[col2];
            var s = bNum2 - bNum1; // 下桿側差值（直接相減，不繞圈）
            var p = aNum2 - aNum1; // 上桿側差值
            if (p !== s) continue;
            var pIdx = NINE_GRID_DRAG_OFFSETS.indexOf(p);
            if (pIdx === -1) continue; // 差值必須是九宮差之一
            if (!o.offsetsChecked[pIdx]) continue; // 而且該偏移有打勾
            marked.add(cellKey(aIdx1, col1));
            marked.add(cellKey(aIdx2, col2));
            marked.add(cellKey(bIdx1, col1));
            marked.add(cellKey(bIdx2, col2));
            var pair = {
              k1: k1, k2: k2, col1: col1, col2: col2, diff: p,
              upper: [aNum1, aNum2], lower: [bNum1, bNum2],
              upperRows: [aIdx1, aIdx2], lowerRows: [bIdx1, bIdx2],
              sameRow: k1 === k2,
            };
            pairs.push(pair);
            if (aNum1 === bNum1 && aNum2 === bNum2) echoes.push(pair);
          }
        }
      }
    }
    return { marked: marked, pairs: pairs, echoes: echoes };
  }

  /**
   * 第二段：統計（computeCModeChaStatCounts 的純函式版）。
   * 只看已標定的上下對應格：上方號碼做九宮拖牌，命中「上桿那一列」的偏移，
   * 套到下方號碼得到的結果號碼 +1。
   * 回傳 { counts: {n: c}, contribs: [{k,col,offset,upper,lower,result}] }
   */
  function countCha(rows, upperIdx, lowerIdx, marked, opts) {
    var o = resolveOpts(opts);
    var counts = emptyCounts(o.maxBall);
    var contribs = [];
    var anchor = rowCells(rows, upperIdx, lowerIdx, o); // 上桿那一列 = 驗證用的答案
    if (!anchor) return { counts: counts, contribs: contribs };
    for (var k = 1; k <= o.span; k++) {
      var bIdx = lowerIdx - k;
      var aIdx = upperIdx - k;
      var bCells = rowCells(rows, bIdx, lowerIdx, o);
      var aCells = rowCells(rows, aIdx, lowerIdx, o);
      if (!bCells || !aCells) continue;
      for (var col = 0; col < o.colCount; col++) {
        if (!marked.has(cellKey(aIdx, col)) || !marked.has(cellKey(bIdx, col))) continue;
        var upperVal = aCells[col];
        var lowerVal = bCells[col];
        if (upperVal === lowerVal) continue;
        var dragUpper = nineGridDrag(upperVal, o.maxBall);
        var dragLower = nineGridDrag(lowerVal, o.maxBall);
        for (var pos = 0; pos < NINE_GRID_DRAG_OFFSETS.length; pos++) {
          if (!o.offsetsChecked[pos]) continue;
          if (anchor.indexOf(dragUpper[pos]) === -1) continue; // 偏移在上桿驗證成功
          var result = dragLower[pos];
          if (counts[result] === undefined) continue;
          counts[result]++;
          contribs.push({
            k: k, col: col, offset: NINE_GRID_DRAG_OFFSETS[pos],
            upper: upperVal, lower: lowerVal, result: result,
          });
        }
      }
    }
    return { counts: counts, contribs: contribs };
  }

  function emptyCounts(maxBall) {
    var c = {};
    for (var n = 1; n <= maxBall; n++) c[n] = 0;
    return c;
  }

  function addCounts(acc, add) {
    for (var n in add) acc[n] = (acc[n] || 0) + add[n];
    return acc;
  }

  /** 單一上桿位置：標定 + 統計（App 的雙擊差數鍵 = 只算目前上桿這一個位置） */
  function runSingle(rows, upperIdx, lowerIdx, opts) {
    var m = markCha(rows, upperIdx, lowerIdx, opts);
    var c = countCha(rows, upperIdx, lowerIdx, m.marked, opts);
    return {
      upperIdx: upperIdx,
      lowerIdx: lowerIdx,
      marked: m.marked,
      pairs: m.pairs,
      echoes: m.echoes,
      counts: c.counts,
      contribs: c.contribs,
    };
  }

  /**
   * 6期掃描要跑的上桿位置：下桿上方 sweepCount..1 列。
   * 上桿上方不足搜期時先往備用列讀（不顯示、只統計）；
   * 連備用列都補不滿整整 span 列（資料真的不存在）才略過，避免殘缺結果計入。
   */
  function sweepPositions(rows, lowerIdx, opts) {
    var o = resolveOpts(opts);
    var floor = searchFloor(rows, o);
    var out = [];
    for (var u = lowerIdx - o.sweepCount; u <= lowerIdx - 1; u++) {
      if (u < 0) continue;
      if (u - o.span < floor) continue;
      out.push(u);
    }
    return out;
  }

  /** 這次掃描最早讀到哪一列，以及其中有幾列落在顯示區第 1 期之上的備用列 */
  function spareUsage(rows, positions, o) {
    if (!positions.length) return { earliestIdx: null, spareRowsUsed: 0 };
    var earliest = positions[0] - o.span;
    return { earliestIdx: earliest, spareRowsUsed: Math.max(0, visibleStart(rows, o) - earliest) };
  }

  /**
   * 差數ai統計：紀錄產生器。
   * 以每一組標定連線「下桿側」的兩顆號碼各當一次主角，一顆主角一筆 entry：
   *   sameRow  同列   ：連線對手所在列 − 主角所在列（往下為正，同一列 0）
   *   linkDiff 連線差 ：連線對手號碼 − 主角號碼
   *   rowDist  列距   ：主角所在列 − 下桿列（往上為負，等於 −k）
   *   hits     九宮差 ：主角 + 哪些九宮差 = 真實的果（陣列；空陣列 = 沒中 x；actual 未知時為 null）
   *   gap      桿距   ：上桿列 − 下桿列（上桿在下桿上方幾期，負數）
   * actual = 下桿列真正開出的號碼；回測時有，實際預測（下桿在空白期）時傳 null。
   */
  function aiRecords(rows, upperIdx, lowerIdx, actual, opts) {
    var o = resolveOpts(opts);
    var m = markCha(rows, upperIdx, lowerIdx, o);
    var entries = [];
    m.pairs.forEach(function (pair) {
      for (var side = 0; side < 2; side++) {
        var other = 1 - side;
        var selfNum = pair.lower[side];
        var partnerNum = pair.lower[other];
        var selfRow = pair.lowerRows[side];
        var partnerRow = pair.lowerRows[other];
        var hits = null;
        if (actual) {
          hits = [];
          var drag = nineGridDrag(selfNum, o.maxBall);
          for (var pos = 0; pos < NINE_GRID_DRAG_OFFSETS.length; pos++) {
            if (!o.offsetsChecked[pos]) continue;
            if (actual.indexOf(drag[pos]) !== -1) hits.push(NINE_GRID_DRAG_OFFSETS[pos]);
          }
        }
        entries.push({
          upperIdx: upperIdx,
          lowerIdx: lowerIdx,
          gap: upperIdx - lowerIdx,
          self: selfNum,
          selfRow: selfRow,
          partner: partnerNum,
          partnerRow: partnerRow,
          sameRow: partnerRow - selfRow,
          linkDiff: partnerNum - selfNum,
          rowDist: selfRow - lowerIdx,
          pairDiff: pair.diff,
          upperPair: pair.upper,
          hits: hits,
        });
      }
    });
    return entries;
  }

  /**
   * 把 entry 攤平成使用者定義的「一筆紀錄」：[同列, 連線差, 列距, 九宮差, 桿距]。
   * 命中幾個九宮差就幾筆；沒中一筆、九宮差欄記 "x"；actual 未知時九宮差欄記 null。
   */
  function flattenAiRecords(entries) {
    var out = [];
    entries.forEach(function (e) {
      var offsets = e.hits === null ? [null] : e.hits.length ? e.hits : ["x"];
      offsets.forEach(function (off) {
        out.push({
          sameRow: e.sameRow, linkDiff: e.linkDiff, rowDist: e.rowDist, offset: off, gap: e.gap,
          self: e.self, partner: e.partner, lowerIdx: e.lowerIdx, upperIdx: e.upperIdx,
        });
      });
    });
    return out;
  }

  /** 條件鍵：預設用全部四個條件（桿距、同列、連線差、列距）分組 */
  function aiConditionKey(e) {
    return "gap" + e.gap + "|same" + e.sameRow + "|link" + e.linkDiff + "|dist" + e.rowDist;
  }

  /**
   * 差數ai統計：把 entries 依條件分組，算每個九宮差的命中次數。
   * 沒中（x）的主角不列入計算與排行；答案未知的也不列入。
   * 回傳 { byCondition: {key: {n, byOffset:{offset: count}}}, byOffset: {offset: count}, total }
   * n = 這個條件下有中的主角數，byOffset = 各九宮差的命中筆數。
   */
  function aggregateAi(entries, keyFn) {
    var key = keyFn || aiConditionKey;
    var byCondition = {};
    var byOffset = {};
    var total = 0;
    NINE_GRID_DRAG_OFFSETS.forEach(function (off) { byOffset[off] = 0; });
    entries.forEach(function (e) {
      if (e.hits === null || e.hits.length === 0) return; // 未知答案、沒中(x) 都不列入
      var k = key(e);
      var c = byCondition[k];
      if (!c) {
        c = byCondition[k] = { n: 0, byOffset: {} };
        NINE_GRID_DRAG_OFFSETS.forEach(function (off) { c.byOffset[off] = 0; });
      }
      c.n++; total++;
      e.hits.forEach(function (off) { c.byOffset[off]++; byOffset[off]++; });
    });
    return { byCondition: byCondition, byOffset: byOffset, total: total };
  }

  /** 五個記錄的欄位名稱與順序 */
  var AI_FIELDS = [
    { key: "sameRow", label: "同列", no: 1 },
    { key: "linkDiff", label: "連線差", no: 2 },
    { key: "rowDist", label: "列距", no: 3 },
    { key: "offset", label: "九宮差", no: 4 },
    { key: "gap", label: "桿距", no: 5 },
  ];

  /**
   * 差數ai統計：統計層。
   * 把回測累積的 entries 攤成一筆一筆紀錄，只取「有中」的紀錄（九宮差 = x 的不列入計算與排行），
   * 對五個記錄各自算「每個值出現幾筆、佔比多少」，找出最高的。
   * 回傳 { hitRecords, hitSubjects, fields: { sameRow: {label, no, list:[{value,count,prob}], top:[values]} , ... } }
   */
  function aiFieldStats(entries, opts) {
    var o = opts && opts.fieldCountMode ? opts : { fieldCountMode: "records" };
    var known = entries.filter(function (e) { return e.hits !== null && e.hits.length > 0; });
    var hitFlat = flattenAiRecords(known);
    var out = { hitRecords: hitFlat.length, hitSubjects: known.length, fields: {} };
    AI_FIELDS.forEach(function (f) {
      var counts = {};
      // 第 4 個記錄（九宮差）一定以紀錄計；其餘四個依 fieldCountMode
      var perSubject = o.fieldCountMode === "subjects" && f.key !== "offset";
      var source = perSubject ? known : hitFlat;
      source.forEach(function (r) {
        var v = r[f.key];
        counts[v] = (counts[v] || 0) + 1;
      });
      var denom = perSubject ? known.length : hitFlat.length;
      var list = Object.keys(counts).map(function (k) {
        return {
          value: parseInt(k, 10),
          count: counts[k],
          prob: denom ? counts[k] / denom : 0,
        };
      }).sort(function (a, b) { return b.count - a.count || a.value - b.value; });
      var best = list.length ? list[0].count : 0;
      out.fields[f.key] = {
        label: f.label,
        no: f.no,
        list: list,
        top: list.filter(function (x) { return x.count === best && best > 0; }).map(function (x) { return x.value; }),
      };
    });
    return out;
  }

  /**
   * 各桿距分開的回溯統計：差 1 只算差 1 的、差 6 只算差 6 的。
   * 回傳 [{ gap, steps（幾次回測有這個桿距）, subjects, hitSubjects, hitRecords, fields }]，桿距由 -1 到 -sweepCount。
   */
  function gapFieldStats(entries, opts) {
    var o = resolveOpts(opts);
    var out = [];
    for (var g = -1; g >= -o.sweepCount; g--) {
      var sub = entries.filter(function (e) { return e.gap === g; });
      var lowers = {};
      sub.forEach(function (e) { lowers[e.lowerIdx] = true; });
      var st = aiFieldStats(sub, o);
      out.push({ gap: g, steps: Object.keys(lowers).length, subjects: sub.length, hitSubjects: st.hitSubjects, hitRecords: st.hitRecords, fields: st.fields });
    }
    return out;
  }

  /**
   * 回溯紀錄（使用者 2026-09-14 定義）：以每一顆「上桿側標定號碼」為主，四個紀錄：
   *   紀錄1 桿距   = 上桿在下桿的上幾期（upperIdx − lowerIdx，例 −6）
   *   紀錄2 位置   = 這顆標定號碼在上桿的上幾期（−k）
   *   紀錄3 上桿命中 = 這顆標定號碼加哪個九宮差會落在「上桿那一列」
   *   紀錄4 下桿命中 = 下桿側同 k 同欄的對應號碼加哪個九宮差會落在「下桿那一列」（真實的果）
   * 規則：紀錄3 命中 m 個、紀錄4 命中 n 個 → 拆成 m×n 筆；任一邊沒命中 → 整筆不記；
   *       上下桿同號（回音）照記；同一顆標定號碼在幾條連線裡都只以那一格算一次。
   * 下桿列（actualLower）未知時回傳空陣列（預測期不算）。
   */
  function upperRecords(rows, upperIdx, lowerIdx, actualLower, opts) {
    var o = resolveOpts(opts);
    if (!actualLower) return [];
    var m = markCha(rows, upperIdx, lowerIdx, o);
    var upperRow = rowCells(rows, upperIdx, lowerIdx, o);
    if (!upperRow) return [];
    function hits(num, targetRow) {
      var drag = nineGridDrag(num, o.maxBall), out = [];
      for (var pos = 0; pos < NINE_GRID_DRAG_OFFSETS.length; pos++) {
        if (!o.offsetsChecked[pos]) continue;
        if (targetRow.indexOf(drag[pos]) !== -1) out.push({ offset: NINE_GRID_DRAG_OFFSETS[pos], num: drag[pos] });
      }
      return out;
    }
    var cells = {}, order = [];
    m.pairs.forEach(function (pair) {
      for (var side = 0; side < 2; side++) {
        var k = side === 0 ? pair.k1 : pair.k2, col = side === 0 ? pair.col1 : pair.col2;
        var key = pair.upperRows[side] + ":" + col;
        var link = { upper: pair.upper, lower: pair.lower, diff: pair.diff };
        if (cells[key]) { cells[key].links.push(link); continue; }
        cells[key] = { k: k, col: col, upperNum: pair.upper[side], upperRow: pair.upperRows[side], lowerNum: pair.lower[side], lowerRow: pair.lowerRows[side], links: [link] };
        order.push(key);
      }
    });
    var out = [];
    order.forEach(function (key) {
      var c = cells[key];
      var h3 = hits(c.upperNum, upperRow), h4 = hits(c.lowerNum, actualLower);
      if (!h3.length || !h4.length) return; // 沒命中整筆不記
      h3.forEach(function (a) {
        h4.forEach(function (b) {
          out.push({
            upperIdx: upperIdx, lowerIdx: lowerIdx, gap: upperIdx - lowerIdx, k: c.k, col: c.col,
            upperNum: c.upperNum, upperRow: c.upperRow, lowerNum: c.lowerNum, lowerRow: c.lowerRow,
            r1: upperIdx - lowerIdx, r2: -c.k, r3: a.offset, r3Num: a.num, r4: b.offset, r4Num: b.num,
            same: a.offset === b.offset, echo: c.upperNum === c.lowerNum, links: c.links,
          });
        });
      });
    });
    return out;
  }

  /**
   * 即時（預測期）的上桿標定號碼：跟 upperRecords 一樣的主角，但下桿列未開，只有紀錄 1、2、3；
   * 紀錄 3 可能有多個上桿命中（r3s），沒有命中的標定號碼 r3s 為空（不預測）。
   */
  function upperLive(rows, upperIdx, lowerIdx, opts) {
    var o = resolveOpts(opts);
    var m = markCha(rows, upperIdx, lowerIdx, o);
    var upperRow = rowCells(rows, upperIdx, lowerIdx, o);
    if (!upperRow) return [];
    var cells = {}, order = [];
    m.pairs.forEach(function (pair) {
      for (var side = 0; side < 2; side++) {
        var k = side === 0 ? pair.k1 : pair.k2, col = side === 0 ? pair.col1 : pair.col2;
        var key = pair.upperRows[side] + ":" + col;
        var link = { upper: pair.upper, lower: pair.lower, diff: pair.diff };
        if (cells[key]) { cells[key].links.push(link); continue; }
        cells[key] = { k: k, col: col, upperNum: pair.upper[side], upperRow: pair.upperRows[side], lowerNum: pair.lower[side], lowerRow: pair.lowerRows[side], links: [link] };
        order.push(key);
      }
    });
    return order.map(function (key) {
      var c = cells[key];
      var drag = nineGridDrag(c.upperNum, o.maxBall), r3s = [];
      for (var pos = 0; pos < NINE_GRID_DRAG_OFFSETS.length; pos++) {
        if (!o.offsetsChecked[pos]) continue;
        if (upperRow.indexOf(drag[pos]) !== -1) r3s.push({ offset: NINE_GRID_DRAG_OFFSETS[pos], num: drag[pos] });
      }
      return { upperIdx: upperIdx, lowerIdx: lowerIdx, gap: upperIdx - lowerIdx, k: c.k, col: c.col, upperNum: c.upperNum, upperRow: c.upperRow,
        lowerNum: c.lowerNum, lowerRow: c.lowerRow, r1: upperIdx - lowerIdx, r2: -c.k, r3s: r3s, echo: c.upperNum === c.lowerNum, links: c.links };
    });
  }

  /**
   * 紀錄法預測（predictMode = "records"，使用者 2026-09-14 定義）：
   *   每顆即時上桿標定號碼的 (紀錄1 桿距, 紀錄2 位置, 紀錄3 上桿命中) 到回溯紀錄裡找三個都相同的，
   *   取紀錄4 出現最多的九宮差（同樣最多的全部都取），套到對應下桿號碼 = 預測號碼，存進 39 格統計表（次數 +1）。
   *   上桿沒命中（紀錄3 空）的不預測；回溯裡找不到相同的也不預測。
   * live 可以是一個或多個上桿位置的 upperLive 結果串起來。
   */
  function predictByRecords(liveEntries, hist, o) {
    var score = {}, reasons = {};
    for (var n = 1; n <= o.maxBall; n++) { score[n] = 0; reasons[n] = []; }
    var subjects = [];
    liveEntries.forEach(function (e) {
      if (!e.r3s.length) { subjects.push({ entry: e, r3: null, matched: 0, top: [], outputs: [], skipped: "no-upper-hit" }); return; }
      e.r3s.forEach(function (h) {
        var same = hist.filter(function (r) { return r.r1 === e.r1 && r.r2 === e.r2 && r.r3 === h.offset; });
        var cnt = {};
        same.forEach(function (r) { cnt[r.r4] = (cnt[r.r4] || 0) + 1; });
        var list = Object.keys(cnt).map(function (x) { return { offset: parseInt(x, 10), count: cnt[x] }; })
          .sort(function (a, b) { return b.count - a.count || a.offset - b.offset; });
        var sj = { entry: e, r3: h.offset, r3Num: h.num, matched: same.length, dist: list, top: [], outputs: [] };
        if (!list.length) { sj.skipped = "no-history"; subjects.push(sj); return; }
        var best = list[0].count;
        sj.top = list.filter(function (x) { return x.count === best; }).map(function (x) { return x.offset; });
        var drag = nineGridDrag(e.lowerNum, o.maxBall);
        sj.top.forEach(function (offv) {
          var num = drag[NINE_GRID_DRAG_OFFSETS.indexOf(offv)];
          score[num] += 1;
          reasons[num].push({ self: e.lowerNum, partner: null, offset: offv, weight: 1, upperNum: e.upperNum, r1: e.r1, r2: e.r2, r3: h.offset, matched: same.length, count: best, upperIdx: e.upperIdx, gap: e.gap });
          sj.outputs.push({ offset: offv, num: num, count: best });
        });
        subjects.push(sj);
      });
    });
    return { score: score, reasons: reasons, subjects: subjects };
  }

  /** 6期掃描（App 長按差數鍵）：逐位置跑 runSingle，次數加總；同時產生差數ai統計的 entries。 */
  function sweep(rows, lowerIdx, opts) {
    var o = resolveOpts(opts);
    var positions = sweepPositions(rows, lowerIdx, o);
    var acc = emptyCounts(o.maxBall);
    var steps = [];
    var aiEntries = [];
    var upperEntries = [];
    // 下桿列真正開出的號碼：回測時存在；實際預測（下桿在空白期、lowerIdx 超出 rows）時為 null
    var actual = lowerIdx < rows.length && rows[lowerIdx] ? rows[lowerIdx].slice(0, o.colCount) : null;
    positions.forEach(function (u) {
      var r = runSingle(rows, u, lowerIdx, o);
      addCounts(acc, r.counts);
      r.aiEntries = aiRecords(rows, u, lowerIdx, actual, o);
      aiEntries = aiEntries.concat(r.aiEntries);
      r.upperRecords = upperRecords(rows, u, lowerIdx, actual, o);
      upperEntries = upperEntries.concat(r.upperRecords);
      steps.push(r);
    });
    var usage = spareUsage(rows, positions, o);
    return {
      lowerIdx: lowerIdx, positions: positions, accCounts: acc, steps: steps,
      earliestIdx: usage.earliestIdx, spareRowsUsed: usage.spareRowsUsed,
      aiEntries: aiEntries,
      upperRecords: upperEntries, // 回溯紀錄（上桿標定號碼為主的四個紀錄）
    };
  }

  /**
   * 前幾名（computeCModeTopRankList）：取次數最高的前 topRanks 個「次數值」對應的所有號碼；
   * 若這樣只有 2 顆以下且還有更低的次數值，再放寬一名。最多 maxFill 顆。
   */
  function topRankList(counts, opts) {
    var o = resolveOpts(opts);
    var list = Object.keys(counts)
      .map(function (k) { return { n: parseInt(k, 10), c: counts[k] }; })
      .filter(function (x) { return x.c > 0; })
      .sort(function (a, b) { return b.c - a.c || a.n - b.n; });
    var distinct = [];
    list.forEach(function (x) { if (distinct.indexOf(x.c) < 0) distinct.push(x.c); });
    var ranks = o.topRanks;
    var topVals = distinct.slice(0, ranks);
    var filtered = list.filter(function (x) { return topVals.indexOf(x.c) >= 0; });
    if (filtered.length <= 2 && distinct.length > ranks) {
      ranks += 1;
      topVals = distinct.slice(0, ranks);
      filtered = list.filter(function (x) { return topVals.indexOf(x.c) >= 0; });
    }
    return filtered.slice(0, o.maxFill);
  }

  /** 預測目標列（下桿位置）的索引：預設 rows.length = 空白第 1 列（列號 49） */
  function targetIndex(rows, o) {
    return o.targetIdx === null || o.targetIdx === undefined ? rows.length : o.targetIdx;
  }

  /**
   * 統一列號：備用列第一期 = 1，備用列 1..spareRows，顯示區接著到 spareRows+windowSize，空白第 1 列再 +1。
   * 預設 32 + 16：備用列 1..32、顯示區 33..48、空白第 1 列 49。
   * 列號固定以顯示區最後一期為 48，資料不足時前面的列號只是不存在，不會位移。
   */
  function rowNo(rows, idx, o) {
    return idx - (frameEnd(rows, o) - o.windowSize - o.spareRows) + 1;
  }
  function idxOfRowNo(rows, no, o) {
    return no - 1 + (frameEnd(rows, o) - o.windowSize - o.spareRows);
  }

  /**
   * 回測：下桿在預測期 N，N 同時就是錨定期；下桿從 N-1-anchorRows 開始往上移 steps 次（列號見 rowNo，anchorRows 預設 0）。
   *   下桿第 48 列（N）→ 錨定期第 48 列 → 回溯第 47、46 … 32 列（N-1 … N-16）
   *   下桿第 49 列（空白第 1 列）→ 錨定期第 49 列 → 回溯第 48、47 … 33 列
   * 第 t 次下桿放在 targetIdx − t，那一期的號碼就是真實的果，計算時視為未開；
   * 上桿在它上方 sweepCount..1 列各跑一次（App 的 6期掃描），不夠的列往備用列讀，
   * 累計後取前幾名當預期的果，再跟真實的果比對。
   * 顯示區 16 期 + 備用列 32 期固定不動（frameEnd = rows.length）；最深一步讀到 targetIdx − 16 − 12，
   * 目標在第 16 或 17 列時都在備用列範圍內，不會略過任何位置。
   *
   * rows  ：由舊到新的號碼列。
   * meta  ：可選，與 rows 等長的附加資訊（例如日期），會原樣掛到 record.meta。
   */
  function backtest(rows, opts, meta) {
    var o = resolveOpts(opts);
    var records = [];
    var end = frameEnd(rows, o);
    var target = targetIndex(rows, o);
    var anchor = o.anchorRows || 0;
    for (var t = 1; t <= o.steps; t++) {
      var lowerIdx = target - anchor - t;
      if (lowerIdx < 0) break;
      var sw = sweep(rows, lowerIdx, o);
      var predicted = topRankList(sw.accCounts, o);
      var actual = (rows[lowerIdx] || []).slice(0, o.colCount);
      var hits = predicted.filter(function (p) { return actual.indexOf(p.n) !== -1; });
      var record = {
        t: t,
        lowerIdx: lowerIdx,
        lowerRowNo: rowNo(rows, lowerIdx, o), // 統一列號（備用列第一期 = 1）
        meta: meta ? meta[lowerIdx] : undefined,
        upperPositions: sw.positions,
        earliestIdx: sw.earliestIdx, // 這次最早讀到的列
        spareRowsUsed: sw.spareRowsUsed, // 其中有幾列是畫面外的備用列（內部統計用）
        accCounts: sw.accCounts,
        steps: sw.steps,
        aiEntries: sw.aiEntries, // 差數ai統計：這次回測所有連線主角的紀錄（含命中的九宮差）
        upperRecords: sw.upperRecords, // 回溯紀錄：這次回測所有上桿標定號碼的 [桿距, 位置, 上桿命中, 下桿命中]
        predicted: predicted,
        predictedNums: predicted.map(function (p) { return p.n; }),
        actual: actual,
        hits: hits.map(function (p) { return p.n; }),
        hitCount: hits.length,
        predictedCount: predicted.length,
        // 純機率基準：隨機挑 predictedCount 顆，平均會中幾顆
        expectedRandomHits: predicted.length * (o.colCount / o.maxBall),
      };
      if (typeof o.scorer === "function") {
        var extra = o.scorer(record, { rows: rows, opts: o });
        if (extra && typeof extra === "object") for (var key in extra) record[key] = extra[key];
      }
      records.push(record);
    }
    var allAi = [], allUpper = [];
    records.forEach(function (r) { allAi = allAi.concat(r.aiEntries); allUpper = allUpper.concat(r.upperRecords); });
    return {
      records: records,
      summary: summarize(records),
      ai: aggregateAi(allAi),
      aiFields: aiFieldStats(allAi, o), // 五個記錄各自的機率分布與最高值
      byGap: gapFieldStats(allAi, o), // 差 1 … 差 6 各自的統計（差 6 只算差 6 的）
      offsetByPairDiff: offsetCrossTable(allAi, "pairDiff"), // 九宮差比對表：+11 的標定往往加哪個九宮差會中
      aiEntries: allAi,
      upperRecords: allUpper, // 全部回溯的回溯紀錄
      opts: o,
      targetIdx: target,
      frame: {
        visibleStart: visibleStart(rows, o), visibleEnd: end - 1,
        spareStart: searchFloor(rows, o), spareEnd: visibleStart(rows, o) - 1,
        targetIdx: target, targetRowNo: rowNo(rows, target, o), // 統一列號：備用列 1..32、顯示區 33..48、空白第 1 列 49
        anchorIdx: target, anchorRowNo: rowNo(rows, target, o), anchorRows: anchor, // 錨定期 = 預測期 N
        firstLowerIdx: target - anchor - 1, lastLowerIdx: Math.max(0, target - anchor - o.steps),
        firstLowerRowNo: rowNo(rows, target - anchor - 1, o), lastLowerRowNo: rowNo(rows, Math.max(0, target - anchor - o.steps), o),
        spareRowNo: [1, o.spareRows], visibleRowNo: [o.spareRows + 1, o.spareRows + o.windowSize],
        stepsRequested: o.steps, stepsRun: records.length,
      },
    };
  }

  /**
   * 預測目標列（預設下一期 = 空白第 1 列，也就是 App 的第 17 列；opts.targetIdx 可改成任一列）。
   * 回測一律從目標列的上一列往上跑 steps 次，統計只用目標列以前的資料。
   * 若目標列已經開出（targetIdx < rows.length），結果會附上 actual / hits 方便驗證。
   *
   * 流程：
   *   1. 先跑 16 次回測，得到五個記錄的機率分布（bt.aiFields）。
   *   2. 下桿放在 rows.length（空白第 1 列），上桿掃上方 6..1 列，標定連線，
   *      產生「主角」entries（答案未知，hits = null，只有記錄 1/2/3/5 四個條件）。
   *   3. 每一顆主角依它的四個條件值，從回測統計查機率，再套九個九宮差，
   *      把「主角 + 九宮差」得到的號碼加分。
   *   4. 依分數排序，取前 topN 顆當預測號碼。
   *
   * 預設計分規則（mode = "field"，是假設，可換）：
   *   score(號碼) += P1(同列) × P2(連線差) × P3(列距) × P5(桿距) × P4(九宮差)
   *   Pn = 該值在回測「有中的紀錄」裡的機率（aiFieldStats 的 prob）；沒出現過的值機率 0。
   * mode = "condition"：改用四個條件完全相同的歷史紀錄裡各九宮差的命中率（aggregateAi.byCondition），
   *   歷史沒有這組條件時退回 field 規則。
   */
  /**
   * 篩選式計分（predictMode = "top"）：
   *   1. 第 1/2/3/5 個記錄各取機率最高的值（同分並列都算）。
   *   2. 每顆主角數四個條件有幾個落在最高值上（0..4），只留符合最多的那一群（全中優先，沒有就退到 3、2、1）。
   *   3. 留下的主角先套第 4 個記錄機率最高的九宮差，得到候選；候選不足 topN 顆時依機率順序再套下一個九宮差補滿。
   *   4. 候選分數 = 推到它的主角數（同一輪內），輪次越早分數越高。
   */
  function predictByTop(live, st, o, topN) {
    function topValues(field) { return st.fields[field].top; }
    var tops = { sameRow: topValues("sameRow"), linkDiff: topValues("linkDiff"), rowDist: topValues("rowDist"), gap: topValues("gap") };
    var scored = live.aiEntries.map(function (e) {
      var m = 0;
      ["sameRow", "linkDiff", "rowDist", "gap"].forEach(function (f) { if (tops[f].indexOf(e[f]) !== -1) m++; });
      return { e: e, match: m };
    });
    var best = scored.reduce(function (a, x) { return Math.max(a, x.match); }, 0);
    var kept = scored.filter(function (x) { return x.match === best && best > 0; }).map(function (x) { return x.e; });
    // 九宮差依機率排序，同分一起用（一輪）
    var offList = st.fields.offset.list.slice();
    var rounds = [];
    offList.forEach(function (x) {
      var last = rounds[rounds.length - 1];
      if (last && last.count === x.count) last.offsets.push(x.value);
      else rounds.push({ count: x.count, offsets: [x.value] });
    });
    var score = {}, reasons = {};
    for (var n = 1; n <= o.maxBall; n++) { score[n] = 0; reasons[n] = []; }
    var found = 0;
    rounds.forEach(function (round, ri) {
      if (found >= topN) return;
      var roundWeight = rounds.length - ri; // 越早的輪次分數越高
      kept.forEach(function (e) {
        var drag = nineGridDrag(e.self, o.maxBall);
        round.offsets.forEach(function (off) {
          var pos = NINE_GRID_DRAG_OFFSETS.indexOf(off);
          if (pos === -1 || !o.offsetsChecked[pos]) return; // 這個九宮差沒打勾，跳過
          var num = drag[pos];
          if (score[num] === 0) found++;
          score[num] += roundWeight;
          reasons[num].push({ self: e.self, partner: e.partner, offset: off, weight: roundWeight, round: ri + 1,
            sameRow: e.sameRow, linkDiff: e.linkDiff, rowDist: e.rowDist, gap: e.gap, upperIdx: e.upperIdx });
        });
      });
    });
    return { score: score, reasons: reasons, topValues: tops, matchLevel: best, keptSubjects: kept.length, offsetRounds: rounds };
  }

  /**
   * 錨定式計分（predictMode = "anchor"，預設）：
   *   1. 每顆主角把第 1/2/3/5 個記錄的值到回溯排行查百分比，四個相加 = 主角分數。
   *   2. 回溯第 4 個記錄排行取前 predictOffsetTop 名九宮差。
   *   3. 每顆主角各套這幾個九宮差，得到的號碼加分：主角分數 + 該九宮差的百分比，記到預測統計表。
   */
  /**
   * 九宮差比對表：依標定連線的九宮差（pairDiff，例 +11 的兩個標定號碼）分組，
   * 看每一組的主角「加哪個九宮差」最常中。
   * 每組：subjects（主角數）、hitSubjects（有中的主角數）、byOffset[off] = 命中主角數、
   * rate[off] = 命中主角數 / 主角數（套這個九宮差會中的機率；純機率約 colCount/maxBall）、top（命中最多的九宮差）。
   * groupField 可換成其他記錄欄位（gap / rowDist / sameRow / linkDiff）。
   */
  function offsetCrossTable(btEntries, groupField) {
    var field = groupField || "pairDiff";
    var groups = {};
    btEntries.forEach(function (e) {
      if (e.hits === null) return;
      var key = e[field];
      var g = groups[key];
      if (!g) {
        g = groups[key] = { value: key, subjects: 0, hitSubjects: 0, byOffset: {}, rate: {}, top: [] };
        NINE_GRID_DRAG_OFFSETS.forEach(function (off) { g.byOffset[off] = 0; });
      }
      g.subjects++;
      if (e.hits.length) g.hitSubjects++;
      e.hits.forEach(function (off) { g.byOffset[off]++; });
    });
    var list = Object.keys(groups).map(function (k) { return groups[k]; });
    list.forEach(function (g) {
      var best = 0;
      NINE_GRID_DRAG_OFFSETS.forEach(function (off) {
        g.rate[off] = g.subjects ? g.byOffset[off] / g.subjects : 0;
        if (g.byOffset[off] > best) best = g.byOffset[off];
      });
      g.top = best > 0 ? NINE_GRID_DRAG_OFFSETS.filter(function (off) { return g.byOffset[off] === best; }) : [];
    });
    list.sort(function (a, b) { return a.value - b.value; });
    return { field: field, groups: list };
  }

  /** 九宮差排行：全部主角，或只取某個記錄值與 live 主角相同的歷史主角 */
  function offsetRanking(btEntries, condField, condValue) {
    var counts = {}, total = 0;
    NINE_GRID_DRAG_OFFSETS.forEach(function (off) { counts[off] = 0; });
    btEntries.forEach(function (e) {
      if (e.hits === null || e.hits.length === 0) return;
      if (condField && e[condField] !== condValue) return;
      e.hits.forEach(function (off) { counts[off]++; total++; });
    });
    return NINE_GRID_DRAG_OFFSETS.map(function (off) { return { value: off, count: counts[off], prob: total ? counts[off] / total : 0 }; })
      .filter(function (x) { return x.count > 0; })
      .sort(function (a, b) { return b.count - a.count || a.value - b.value; });
  }

  /** anchorStatsCond 正規化成欄位名陣列；"global"/空 → [] */
  function statsCondFields(cond) {
    if (!cond || cond === "global") return [];
    return Array.isArray(cond) ? cond.slice() : [cond];
  }

  /**
   * 桿距分開統計（巧合法）：依 anchorStatsCond 指定的記錄欄位，把回溯主角分桶，
   * 每個 live 主角只用「同桶」的歷史主角算五個記錄的百分比與九宮差排行。
   * 例：anchorStatsCond = "gap" → 差6只計算差6的，差5只計算差5的。
   * 同桶沒有任何命中紀錄 → 退回全體統計（bucket.fallback = true）。
   */
  function bucketStats(btEntries, condFields, liveEntry, o, cache) {
    if (!condFields.length) return null;
    var key = condFields.map(function (f) { return f + "=" + liveEntry[f]; }).join("|");
    if (cache[key]) return cache[key];
    var subset = btEntries.filter(function (e) {
      for (var i = 0; i < condFields.length; i++) if (e[condFields[i]] !== liveEntry[condFields[i]]) return false;
      return true;
    });
    var st = aiFieldStats(subset, o);
    var b = { key: key, subjects: subset.length, hitSubjects: st.hitSubjects, hitRecords: st.hitRecords, stats: st, fallback: st.hitRecords === 0 };
    cache[key] = b;
    return b;
  }

  function predictByAnchor(live, st, o, btEntries) {
    var condFields = statsCondFields(o.anchorStatsCond);
    var bucketCache = {};
    function Pfrom(stats, field, value) {
      var item = stats.fields[field].list.find(function (x) { return x.value === value; });
      return item ? item.prob : 0;
    }
    var globalTop = st.fields.offset.list.slice(0, o.predictOffsetTop || 3);
    var score = {}, reasons = {};
    for (var n = 1; n <= o.maxBall; n++) { score[n] = 0; reasons[n] = []; }
    var subjects = live.aiEntries.map(function (e) {
      // 依桶（例：同桿距）取統計；沒有桶或桶內沒資料 → 全體統計
      var bucket = btEntries ? bucketStats(btEntries, condFields, e, o, bucketCache) : null;
      var stUse = bucket && !bucket.fallback ? bucket.stats : st;
      function P(field, value) { return Pfrom(stUse, field, value); }
      var parts = { sameRow: P("sameRow", e.sameRow), linkDiff: P("linkDiff", e.linkDiff), rowDist: P("rowDist", e.rowDist), gap: P("gap", e.gap) };
      var subjectScore;
      if (o.anchorSubjectScore === "product") subjectScore = parts.sameRow * parts.linkDiff * parts.rowDist * parts.gap;
      else if (o.anchorSubjectScore === "none") subjectScore = 1;
      else subjectScore = parts.sameRow + parts.linkDiff + parts.rowDist + parts.gap;
      var offTop = bucket && !bucket.fallback ? stUse.fields.offset.list.slice(0, o.predictOffsetTop || 3) : globalTop;
      if (o.anchorOffsetCond && o.anchorOffsetCond !== "global" && btEntries) {
        var cond = offsetRanking(btEntries, o.anchorOffsetCond, e[o.anchorOffsetCond]).slice(0, o.predictOffsetTop || 3);
        if (cond.length) offTop = cond; // 同條件歷史沒有資料就退回全體排行
      }
      var drag = nineGridDrag(e.self, o.maxBall);
      var outputs = [];
      offTop.forEach(function (x) {
        var pos = NINE_GRID_DRAG_OFFSETS.indexOf(x.value);
        if (pos === -1 || !o.offsetsChecked[pos]) return;
        var num = drag[pos];
        var w;
        if (o.anchorOffsetWeight === "mul") w = subjectScore * x.prob;
        else if (o.anchorOffsetWeight === "none") w = subjectScore;
        else w = subjectScore + x.prob;
        score[num] += w;
        reasons[num].push({ self: e.self, partner: e.partner, offset: x.value, weight: w, subjectScore: subjectScore, offsetProb: x.prob,
          sameRow: e.sameRow, linkDiff: e.linkDiff, rowDist: e.rowDist, gap: e.gap, upperIdx: e.upperIdx });
        outputs.push({ offset: x.value, num: num, weight: w });
      });
      return { self: e.self, partner: e.partner, upperIdx: e.upperIdx, sameRow: e.sameRow, linkDiff: e.linkDiff, rowDist: e.rowDist, gap: e.gap,
        parts: parts, subjectScore: subjectScore, outputs: outputs, offsetTop: offTop,
        bucket: bucket ? { key: bucket.key, subjects: bucket.subjects, hitSubjects: bucket.hitSubjects, hitRecords: bucket.hitRecords, fallback: bucket.fallback } : null };
    });
    return { score: score, reasons: reasons, subjects: subjects, offsetTop: globalTop, statsCond: condFields };
  }

  /**
   * 桿距投票（gapvote）：差 6 統計差 6 的、差 5 統計差 5 的 … 差 1 統計差 1 的，
   * 每個桿距各自用「同桿距的回溯主角」做統計、套到「同桿距的即時主角」，得到一份預測表；
   * 最多 6 份表再比：哪一號出現的份數最多就取哪一號。份數相同時，用各表內分數的總和排先後。
   * gapVoteTop 限制每份表只拿前幾顆來投票（null = 有分數的全拿）。
   */
  function predictByGapVote(live, o, btEntries) {
    var gaps = [];
    live.aiEntries.forEach(function (e) { if (gaps.indexOf(e.gap) === -1) gaps.push(e.gap); });
    gaps.sort(function (a, b) { return b - a; }); // -1, -2, ... -6
    var sub = {};
    for (var key in o) sub[key] = o[key];
    sub.anchorStatsCond = "global"; // 已依桿距切好，不再分桶
    var tables = gaps.map(function (g) {
      var subj = live.aiEntries.filter(function (e) { return e.gap === g; });
      var hist = btEntries.filter(function (e) { return e.gap === g; });
      var st = aiFieldStats(hist, o);
      var t = { gap: g, subjects: subj.length, btSubjects: hist.length, hitSubjects: st.hitSubjects, hitRecords: st.hitRecords, empty: st.hitRecords === 0, ranked: [], nums: [], offsetTop: [] };
      if (t.empty) return t; // 這個桿距的回溯沒有任何命中紀錄 → 這份表空白，不投票
      var r = predictByAnchor({ aiEntries: subj }, st, sub, hist);
      t.offsetTop = r.offsetTop;
      t.anchorSubjects = r.subjects;
      t.ranked = Object.keys(r.score).map(function (k) { return { n: parseInt(k, 10), score: r.score[k] }; })
        .filter(function (x) { return x.score > 0; })
        .sort(function (a, b) { return b.score - a.score || a.n - b.n; });
      if (o.gapVoteTop) t.ranked = t.ranked.slice(0, o.gapVoteTop);
      t.nums = t.ranked.map(function (x) { return x.n; });
      return t;
    });
    var votes = {}, sumScore = {}, reasons = {}, total = 0;
    for (var n = 1; n <= o.maxBall; n++) { votes[n] = 0; sumScore[n] = 0; reasons[n] = []; }
    tables.forEach(function (t) {
      t.ranked.forEach(function (x) {
        votes[x.n]++;
        sumScore[x.n] += x.score;
        total += x.score;
        reasons[x.n].push({ self: null, partner: null, offset: null, gap: t.gap, weight: x.score, note: "gap-vote" });
      });
    });
    var score = {};
    for (n = 1; n <= o.maxBall; n++) score[n] = votes[n] > 0 ? votes[n] + sumScore[n] / (1 + total) : 0; // 整數部分 = 份數，小數部分只排同份數的先後
    return { score: score, reasons: reasons, votes: votes, tables: tables, tableCount: tables.filter(function (t) { return !t.empty; }).length };
  }

  function predict(rows, opts, backtestResult) {
    var o = resolveOpts(opts);
    var topN = o.predictTop || 5;
    var mode = o.predictMode || "anchor";
    var bt = backtestResult || backtest(rows, o);
    var st = bt.aiFields;
    var byCond = bt.ai.byCondition;
    function P(field, value) {
      var item = st.fields[field].list.find(function (x) { return x.value === value; });
      return item ? item.prob : 0;
    }
    var lowerIdx = targetIndex(rows, o);
    var known = lowerIdx < rows.length && rows[lowerIdx] ? rows[lowerIdx].slice(0, o.colCount) : null;
    // 標定/主角只用目標列以前的資料（切掉目標列與其下方，答案藏起來）；框架列號仍固定在原本的 rows.length
    var liveOpts = {};
    for (var key in o) liveOpts[key] = o[key];
    liveOpts.frameEnd = frameEnd(rows, o);
    var live = sweep(rows.slice(0, lowerIdx), lowerIdx, liveOpts);
    var score = {};
    var reasons = {};
    var topInfo = null;
    for (var n = 1; n <= o.maxBall; n++) { score[n] = 0; reasons[n] = []; }
    var effectiveMode = mode;
    var anchorInfo = null;
    if (mode === "app") {
      // App 現有邏輯：6 期掃描累計統計表，取前二名（不足補第三名）填空白格
      var appList = topRankList(live.accCounts, o);
      appList.forEach(function (x) { score[x.n] = x.c; reasons[x.n].push({ self: null, partner: null, offset: null, weight: x.c, note: "app-count" }); });
    }
    if (mode === "anchor") {
      anchorInfo = predictByAnchor(live, st, o, bt.aiEntries);
      score = anchorInfo.score;
      reasons = anchorInfo.reasons;
    }
    var recordsInfo = null;
    if (mode === "records") {
      // 上桿位置：指定 upperIdx（真正的上桿）就只用那一個；否則用 6 期掃描的全部位置
      var positionsUsed = o.upperIdx !== null && o.upperIdx !== undefined ? [o.upperIdx] : live.positions;
      var liveEntries = [];
      positionsUsed.forEach(function (u) { liveEntries = liveEntries.concat(upperLive(rows.slice(0, lowerIdx), u, lowerIdx, liveOpts)); });
      recordsInfo = predictByRecords(liveEntries, bt.upperRecords, o);
      recordsInfo.positions = positionsUsed;
      score = recordsInfo.score;
      reasons = recordsInfo.reasons;
    }
    var voteInfo = null;
    if (mode === "gapvote") {
      voteInfo = predictByGapVote(live, o, bt.aiEntries);
      score = voteInfo.score;
      reasons = voteInfo.reasons;
    }
    if (mode === "top") {
      topInfo = predictByTop(live, st, o, topN);
      if (topInfo.keptSubjects > 0) {
        score = topInfo.score;
        reasons = topInfo.reasons;
      } else {
        effectiveMode = "field"; // 沒有任何主角符合最高值 → 退回機率相乘
        topInfo.fallback = "field";
      }
    }
    if (effectiveMode !== "top" && effectiveMode !== "anchor" && effectiveMode !== "app" && effectiveMode !== "gapvote" && effectiveMode !== "records") live.aiEntries.forEach(function (e) {
      var condW = P("sameRow", e.sameRow) * P("linkDiff", e.linkDiff) * P("rowDist", e.rowDist) * P("gap", e.gap);
      var cond = mode === "condition" ? byCond[aiConditionKey(e)] : null;
      var drag = nineGridDrag(e.self, o.maxBall);
      for (var pos = 0; pos < NINE_GRID_DRAG_OFFSETS.length; pos++) {
        if (!o.offsetsChecked[pos]) continue;
        var off = NINE_GRID_DRAG_OFFSETS[pos];
        var w;
        if (cond && cond.n > 0) w = cond.byOffset[off] / cond.n; // 同條件歷史命中率
        else w = condW * P("offset", off);
        if (w <= 0) continue;
        var num = drag[pos];
        score[num] += w;
        reasons[num].push({ self: e.self, partner: e.partner, offset: off, weight: w, sameRow: e.sameRow, linkDiff: e.linkDiff, rowDist: e.rowDist, gap: e.gap, upperIdx: e.upperIdx });
      }
    });
    var ranked = Object.keys(score)
      .map(function (k) { return { n: parseInt(k, 10), score: score[k], reasons: reasons[k] }; })
      .filter(function (x) { return x.score > 0; })
      .sort(function (a, b) { return b.score - a.score || a.n - b.n; });
    var topNums = ranked.slice(0, topN).map(function (x) { return x.n; });
    return {
      lowerIdx: lowerIdx,
      targetRowNo: rowNo(rows, lowerIdx, o),
      mode: mode,
      live: live,
      subjects: live.aiEntries.length,
      ranked: ranked,
      top: ranked.slice(0, topN),
      topNums: topNums,
      actual: known,
      hits: known ? topNums.filter(function (n) { return known.indexOf(n) !== -1; }) : null,
      effectiveMode: effectiveMode,
      anchor_: anchorInfo ? { subjects: anchorInfo.subjects, offsetTop: anchorInfo.offsetTop, statsCond: anchorInfo.statsCond, table: score } : null, // 預測統計表 = table
      gapvote_: voteInfo ? { votes: voteInfo.votes, tables: voteInfo.tables, tableCount: voteInfo.tableCount } : null, // 每個桿距一份預測表 + 份數
      records_: recordsInfo ? { subjects: recordsInfo.subjects, positions: recordsInfo.positions, table: score, histCount: bt.upperRecords.length } : null, // 紀錄法：每顆上桿標定號碼的查找結果 + 39 格統計表
      top_: topInfo ? { topValues: topInfo.topValues, matchLevel: topInfo.matchLevel, keptSubjects: topInfo.keptSubjects, offsetRounds: topInfo.offsetRounds, fallback: topInfo.fallback || null } : null,
      backtest: bt,
    };
  }

  function summarize(records) {
    var s = {
      runs: records.length,
      totalPredicted: 0,
      totalHits: 0,
      totalExpectedRandomHits: 0,
      runsWithHit: 0,
      runsWithPrediction: 0,
    };
    records.forEach(function (r) {
      s.totalPredicted += r.predictedCount;
      s.totalHits += r.hitCount;
      s.totalExpectedRandomHits += r.expectedRandomHits;
      if (r.predictedCount > 0) s.runsWithPrediction++;
      if (r.hitCount > 0) s.runsWithHit++;
    });
    s.hitRate = s.totalPredicted ? s.totalHits / s.totalPredicted : 0;
    s.randomRate = s.totalPredicted ? s.totalExpectedRandomHits / s.totalPredicted : 0;
    s.lift = s.randomRate ? s.hitRate / s.randomRate : 0;
    return s;
  }

  /**
   * 把 results.json / EMBEDDED_DATA 那種 [{date, numbers, special?}] 整理成 rows + meta。
   * 依日期由舊到新排序、每列號碼由小到大排序（跟 App 建表時 sortedNumbers 一致）。
   */
  function fromRecords(records, opts) {
    var o = resolveOpts(opts);
    var list = records
      .filter(function (r) { return r && Array.isArray(r.numbers) && r.numbers.length >= o.colCount; })
      .slice()
      .sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); });
    var rows = list.map(function (r) {
      return r.numbers
        .map(function (n) { return parseInt(n, 10); })
        .filter(function (n) { return !isNaN(n); })
        .sort(function (a, b) { return a - b; })
        .slice(0, o.colCount);
    });
    var meta = list.map(function (r) { return { date: r.date, special: r.special }; });
    return { rows: rows, meta: meta };
  }

  /**
   * 給 App 用的入口（長按 Ai 鍵）：把 App 目前的資料與上下桿位置換成 predict() 的參數，跑紀錄法。
   * params：
   *   records     App 的 currentAllData（[{date, numbers}]，空白期 numbers 為 null 會被濾掉）
   *   upperDate   上桿 A 那一列的日期（tr.dataset.date）
   *   lowerDate   下桿 B 那一列的日期；B 在空白列時給 blanksBelow = B 在最後一期下面第幾列（1 = 空白第 1 列）
   *   steps       回溯幾次（不給用預設 16；App 長按 Ai 給 100）
   *   spareRows   備用列期數（不給用預設 32；App 長按 Ai 給 96）
   *   sweepAll    true = 上桿差 1 到差 6 全部各跑一次紀錄法、累進同一張統計表（使用者 2026-09-14 指示）；false = 只用 upperDate 那個位置
   *   game / span / offsetsChecked / intervals   App 目前的設定（物件或陣列都可）
   * 回傳 { error } 或 { pr（predict 結果）, table（39 格次數）, upperIdx, lowerIdx, upperDate, lowerDate, gap, histCount }
   */
  function appPredict(params) {
    var p = params || {};
    var o = { game: p.game || "539" };
    if (p.steps) o.steps = p.steps; // 回溯幾次（App 目前給 100：回溯 N-1 … N-100）
    if (p.spareRows) o.spareRows = p.spareRows; // 備用列期數（App 目前給 96：16+96=112 列，剛好撐 100 次回溯差 6 搜滿）
    if (p.span) o.span = p.span;
    if (p.offsetsChecked) o.offsetsChecked = p.offsetsChecked;
    if (p.intervals) o.intervals = p.intervals;
    var data = fromRecords(p.records || [], o);
    if (!data.rows.length) return { error: "沒有開獎資料" };
    var dateIdx = {};
    data.meta.forEach(function (m, i) { dateIdx[String(m.date)] = i; });
    var upperIdx = dateIdx[String(p.upperDate)];
    if (upperIdx === undefined && !p.sweepAll) return { error: "上桿要放在已開出的期" };
    var lowerIdx = dateIdx[String(p.lowerDate)];
    if (lowerIdx === undefined) {
      var below = parseInt(p.blanksBelow, 10);
      if (!(below >= 1)) return { error: "下桿位置無法對應到資料" };
      lowerIdx = data.rows.length - 1 + below;
    }
    var ro = resolveOpts(o);
    if (!p.sweepAll) {
      if (upperIdx >= lowerIdx) return { error: "上桿必須在下桿上面" };
      if (lowerIdx - upperIdx > ro.sweepCount) return { error: "上下桿距離超過 " + ro.sweepCount + " 期" };
      if (upperIdx - ro.span < 0) return { error: "上桿上面不足 " + ro.span + " 期" };
    }
    if (lowerIdx - 1 - ro.span < 0) return { error: "下桿上面不足 " + (ro.span + 1) + " 期" };
    o.targetIdx = lowerIdx;
    o.upperIdx = p.sweepAll ? null : upperIdx;
    o.predictMode = "records";
    o.predictTop = ro.maxBall;
    o.frameEnd = Math.min(data.rows.length, lowerIdx); // 顯示區以下桿為底
    var pr = predict(data.rows, o);
    return {
      pr: pr, table: pr.records_.table, upperIdx: p.sweepAll ? null : upperIdx, lowerIdx: lowerIdx,
      upperDate: p.sweepAll ? null : data.meta[upperIdx].date, lowerDate: data.meta[lowerIdx] ? data.meta[lowerIdx].date : p.lowerDate,
      gap: p.sweepAll ? null : upperIdx - lowerIdx, positions: pr.records_.positions, histCount: pr.records_.histCount,
      subjects: pr.records_.subjects, actual: pr.actual, hits: pr.hits,
    };
  }

  return {
    NINE_GRID_DRAG_OFFSETS: NINE_GRID_DRAG_OFFSETS,
    GAME_PROFILES: GAME_PROFILES,
    DEFAULTS: DEFAULTS,
    resolveOpts: resolveOpts,
    nineGridDrag: nineGridDrag,
    cellKey: cellKey,
    markCha: markCha,
    countCha: countCha,
    runSingle: runSingle,
    frameEnd: frameEnd,
    visibleStart: visibleStart,
    targetIndex: targetIndex,
    rowNo: rowNo,
    idxOfRowNo: idxOfRowNo,
    searchFloor: searchFloor,
    sweepPositions: sweepPositions,
    sweep: sweep,
    topRankList: topRankList,
    aiRecords: aiRecords,
    upperRecords: upperRecords,
    upperLive: upperLive,
    predictByRecords: predictByRecords,
    flattenAiRecords: flattenAiRecords,
    aiConditionKey: aiConditionKey,
    aggregateAi: aggregateAi,
    offsetRanking: offsetRanking,
    offsetCrossTable: offsetCrossTable,
    AI_FIELDS: AI_FIELDS,
    aiFieldStats: aiFieldStats,
    gapFieldStats: gapFieldStats,
    statsCondFields: statsCondFields,
    bucketStats: bucketStats,
    backtest: backtest,
    predict: predict,
    predictByGapVote: predictByGapVote,
    summarize: summarize,
    fromRecords: fromRecords,
    appPredict: appPredict,
  };
});
