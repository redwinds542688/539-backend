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
    targetIdx: null, // 預測目標列（下桿位置）的索引；null = rows.length（空白第 1 列，App 第 17 列）
    predictTop: 5, // predict() 取前幾顆
    predictMode: "top", // predict() 計分規則："top"（最高值篩選，預設）、"field"（五個記錄機率相乘）、"condition"（同條件歷史命中率）
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
   * 差數ai統計：把 entries 依條件分組，算每個九宮差的命中次數與沒中次數。
   * 回傳 { byCondition: {key: {n, x, hitEntries, byOffset:{offset: count}}}, byOffset: {offset: count}, total, x }
   * n = 這個條件下出現過幾顆主角（分母），x = 其中沒中的顆數。
   */
  function aggregateAi(entries, keyFn) {
    var key = keyFn || aiConditionKey;
    var byCondition = {};
    var byOffset = {};
    var total = 0, x = 0;
    NINE_GRID_DRAG_OFFSETS.forEach(function (off) { byOffset[off] = 0; });
    entries.forEach(function (e) {
      if (e.hits === null) return; // 未知答案不進統計
      var k = key(e);
      var c = byCondition[k];
      if (!c) {
        c = byCondition[k] = { n: 0, x: 0, hitEntries: 0, byOffset: {} };
        NINE_GRID_DRAG_OFFSETS.forEach(function (off) { c.byOffset[off] = 0; });
      }
      c.n++; total++;
      if (e.hits.length === 0) { c.x++; x++; return; }
      c.hitEntries++;
      e.hits.forEach(function (off) { c.byOffset[off]++; byOffset[off]++; });
    });
    return { byCondition: byCondition, byOffset: byOffset, total: total, x: x };
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
   * 把回測累積的 entries 攤成一筆一筆紀錄，對五個記錄各自算「每個值出現幾次、機率多少」，找出最高的。
   *   - 機率的分母是「有中的紀錄數」（九宮差 = x 的不算，因為它們沒有第 4 個記錄）
   *   - 另外附上每個值的「命中率」：這個值出現過幾顆主角（含沒中），其中幾顆有中
   * 回傳 { totalRecords, hitRecords, subjects, fields: { sameRow: {label, no, list:[{value,count,prob,subjects,hitSubjects,hitRate}], top:[values]} , ... } }
   */
  function aiFieldStats(entries) {
    var known = entries.filter(function (e) { return e.hits !== null; });
    var flat = flattenAiRecords(known);
    var hitFlat = flat.filter(function (r) { return r.offset !== "x"; });
    var out = { totalRecords: flat.length, hitRecords: hitFlat.length, subjects: known.length, fields: {} };
    AI_FIELDS.forEach(function (f) {
      var counts = {};
      hitFlat.forEach(function (r) {
        var v = r[f.key];
        counts[v] = (counts[v] || 0) + 1;
      });
      // 每個值的主角數與有中主角數（第 4 個記錄「九宮差」以主角總數當分母）
      var subj = {}, subjHit = {};
      known.forEach(function (e) {
        if (f.key === "offset") {
          e.hits.forEach(function (off) { subjHit[off] = (subjHit[off] || 0) + 1; });
          return;
        }
        var v = e[f.key];
        subj[v] = (subj[v] || 0) + 1;
        if (e.hits.length) subjHit[v] = (subjHit[v] || 0) + 1;
      });
      var list = Object.keys(counts).map(function (k) {
        var v = parseInt(k, 10);
        var subjects = f.key === "offset" ? known.length : (subj[v] || 0);
        var hitSubjects = subjHit[v] || 0;
        return {
          value: v,
          count: counts[k],
          prob: hitFlat.length ? counts[k] / hitFlat.length : 0,
          subjects: subjects,
          hitSubjects: hitSubjects,
          hitRate: subjects ? hitSubjects / subjects : 0,
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

  /** 6期掃描（App 長按差數鍵）：逐位置跑 runSingle，次數加總；同時產生差數ai統計的 entries。 */
  function sweep(rows, lowerIdx, opts) {
    var o = resolveOpts(opts);
    var positions = sweepPositions(rows, lowerIdx, o);
    var acc = emptyCounts(o.maxBall);
    var steps = [];
    var aiEntries = [];
    // 下桿列真正開出的號碼：回測時存在；實際預測（下桿在空白期、lowerIdx 超出 rows）時為 null
    var actual = lowerIdx < rows.length && rows[lowerIdx] ? rows[lowerIdx].slice(0, o.colCount) : null;
    positions.forEach(function (u) {
      var r = runSingle(rows, u, lowerIdx, o);
      addCounts(acc, r.counts);
      r.aiEntries = aiRecords(rows, u, lowerIdx, actual, o);
      aiEntries = aiEntries.concat(r.aiEntries);
      steps.push(r);
    });
    var usage = spareUsage(rows, positions, o);
    return {
      lowerIdx: lowerIdx, positions: positions, accCounts: acc, steps: steps,
      earliestIdx: usage.earliestIdx, spareRowsUsed: usage.spareRowsUsed,
      aiEntries: aiEntries,
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

  /** 預測目標列（下桿位置）的索引：預設 rows.length = 空白第 1 列（App 第 17 列） */
  function targetIndex(rows, o) {
    return o.targetIdx === null || o.targetIdx === undefined ? rows.length : o.targetIdx;
  }

  /**
   * 回測：以「預測目標列」為基準，下桿從目標列的上一列開始往上移 steps 次。
   *   目標在第 17 列（空白第 1 列）→ 回溯第 16、15 … 1 列
   *   目標在第 16 列              → 回溯第 15、14 … 0 列（第 0 列已在備用列）
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
    for (var t = 1; t <= o.steps; t++) {
      var lowerIdx = target - t;
      if (lowerIdx < 0) break;
      var sw = sweep(rows, lowerIdx, o);
      var predicted = topRankList(sw.accCounts, o);
      var actual = (rows[lowerIdx] || []).slice(0, o.colCount);
      var hits = predicted.filter(function (p) { return actual.indexOf(p.n) !== -1; });
      var record = {
        t: t,
        lowerIdx: lowerIdx,
        meta: meta ? meta[lowerIdx] : undefined,
        upperPositions: sw.positions,
        earliestIdx: sw.earliestIdx, // 這次最早讀到的列
        spareRowsUsed: sw.spareRowsUsed, // 其中有幾列是畫面外的備用列（內部統計用）
        accCounts: sw.accCounts,
        steps: sw.steps,
        aiEntries: sw.aiEntries, // 差數ai統計：這次回測所有連線主角的紀錄（含命中的九宮差）
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
    var allAi = [];
    records.forEach(function (r) { allAi = allAi.concat(r.aiEntries); });
    return {
      records: records,
      summary: summarize(records),
      ai: aggregateAi(allAi),
      aiFields: aiFieldStats(allAi), // 五個記錄各自的機率分布與最高值
      aiEntries: allAi,
      opts: o,
      targetIdx: target,
      frame: {
        visibleStart: visibleStart(rows, o), visibleEnd: end - 1,
        spareStart: searchFloor(rows, o), spareEnd: visibleStart(rows, o) - 1,
        targetIdx: target, targetRowNo: target - visibleStart(rows, o) + 1, // 顯示列號：1..16，17 = 空白第 1 列
        firstLowerIdx: target - 1, lastLowerIdx: Math.max(0, target - o.steps),
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

  function predict(rows, opts, backtestResult) {
    var o = resolveOpts(opts);
    var topN = o.predictTop || 5;
    var mode = o.predictMode || "top";
    var bt = backtestResult || backtest(rows, o);
    var st = bt.aiFields;
    var byCond = bt.ai.byCondition;
    function P(field, value) {
      var item = st.fields[field].list.find(function (x) { return x.value === value; });
      return item ? item.prob : 0;
    }
    var lowerIdx = targetIndex(rows, o);
    var known = lowerIdx < rows.length && rows[lowerIdx] ? rows[lowerIdx].slice(0, o.colCount) : null;
    // 標定/主角只用目標列以前的資料：sweep 內部 rowCells 不讀 lowerIdx 以下；答案先藏起來
    var live = sweep(rows.slice(0, lowerIdx), lowerIdx, o);
    var score = {};
    var reasons = {};
    var topInfo = null;
    for (var n = 1; n <= o.maxBall; n++) { score[n] = 0; reasons[n] = []; }
    if (mode === "top") {
      topInfo = predictByTop(live, st, o, topN);
      score = topInfo.score;
      reasons = topInfo.reasons;
    }
    if (mode !== "top") live.aiEntries.forEach(function (e) {
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
      targetRowNo: lowerIdx - visibleStart(rows, o) + 1,
      mode: mode,
      live: live,
      subjects: live.aiEntries.length,
      ranked: ranked,
      top: ranked.slice(0, topN),
      topNums: topNums,
      actual: known,
      hits: known ? topNums.filter(function (n) { return known.indexOf(n) !== -1; }) : null,
      top_: topInfo ? { topValues: topInfo.topValues, matchLevel: topInfo.matchLevel, keptSubjects: topInfo.keptSubjects, offsetRounds: topInfo.offsetRounds } : null,
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
    searchFloor: searchFloor,
    sweepPositions: sweepPositions,
    sweep: sweep,
    topRankList: topRankList,
    aiRecords: aiRecords,
    flattenAiRecords: flattenAiRecords,
    aiConditionKey: aiConditionKey,
    aggregateAi: aggregateAi,
    AI_FIELDS: AI_FIELDS,
    aiFieldStats: aiFieldStats,
    backtest: backtest,
    predict: predict,
    summarize: summarize,
    fromRecords: fromRecords,
  };
});
