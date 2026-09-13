"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Cha = require("../app/cha-backtest.js");

// ---------- 九宮拖牌 ----------
test("nineGridDrag：539 一般值", () => {
  assert.deepEqual(Cha.nineGridDrag(20, 39), [9, 10, 11, 19, 20, 21, 29, 30, 31]);
});

test("nineGridDrag：超過球數才繞回（38+1=39 不繞、38+9=47→08）", () => {
  assert.deepEqual(Cha.nineGridDrag(38, 39), [27, 28, 29, 37, 38, 39, 8, 9, 10]);
});

test("nineGridDrag：小於等於 0 加球數（05-11=-6→33）", () => {
  assert.deepEqual(Cha.nineGridDrag(5, 39), [33, 34, 35, 4, 5, 6, 14, 15, 16]);
});

// ---------- 手算範例：搜期 1，上桿 idx1、下桿 idx3 ----------
// r0 (上桿上方) : 10 19 25 30 35   → (10,19) 差 9
// r1 (上桿列)   : 20 21 22 23 24   → 驗證用答案
// r2 (下桿上方) : 22 31 33 36 38   → (22,31) 差 9，與上桿同欄位同差值 → 標定
// r3 (下桿列)   : 真實的果
const HAND_ROWS = [
  [10, 19, 25, 30, 35],
  [20, 21, 22, 23, 24],
  [22, 31, 33, 36, 38],
  [5, 32, 36, 37, 39],
];
const HAND_OPTS = { game: "539", span: 1 };

test("markCha：差值相等且在九宮差內才標定，四格都標", () => {
  const m = Cha.markCha(HAND_ROWS, 1, 3, HAND_OPTS);
  assert.deepEqual([...m.marked].sort(), ["0:0", "0:1", "2:0", "2:1"]);
  assert.equal(m.pairs.length, 1);
  assert.equal(m.pairs[0].diff, 9);
  assert.equal(m.echoes.length, 0);
});

test("markCha：偏移 +9 沒打勾就不標定", () => {
  const checked = Cha.NINE_GRID_DRAG_OFFSETS.map((o) => o !== 9);
  const m = Cha.markCha(HAND_ROWS, 1, 3, { ...HAND_OPTS, offsetsChecked: checked });
  assert.equal(m.marked.size, 0);
});

test("markCha：兩桿同組號碼也可標定，並記為 echo", () => {
  const rows = [
    [10, 19, 25, 30, 35],
    [1, 2, 3, 4, 5],
    [10, 19, 26, 27, 28],
    [1, 2, 3, 4, 5],
  ];
  const m = Cha.markCha(rows, 1, 3, HAND_OPTS);
  assert.equal(m.echoes.length, 1);
  assert.deepEqual(m.echoes[0].upper, [10, 19]);
});

test("countCha：上桿驗證成功的偏移套到下桿標定號碼", () => {
  // 上方 10 → +10=20、+11=21 都在上桿列 → 下方 22+10=32、22+11=33
  // 上方 19 → +1=20 在上桿列       → 下方 31+1=32
  const m = Cha.markCha(HAND_ROWS, 1, 3, HAND_OPTS);
  const c = Cha.countCha(HAND_ROWS, 1, 3, m.marked, HAND_OPTS);
  const nonZero = Object.keys(c.counts).filter((n) => c.counts[n] > 0).map(Number);
  assert.deepEqual(nonZero, [32, 33]);
  assert.equal(c.counts[32], 2);
  assert.equal(c.counts[33], 1);
  assert.equal(c.contribs.length, 3);
  assert.deepEqual(
    c.contribs.map((x) => x.offset).sort((a, b) => a - b),
    [1, 10, 11]
  );
});

test("countCha：偏移沒打勾就不計", () => {
  const m = Cha.markCha(HAND_ROWS, 1, 3, HAND_OPTS);
  const checked = Cha.NINE_GRID_DRAG_OFFSETS.map((o) => o === 9); // 只留 +9（標定要用）
  const c = Cha.countCha(HAND_ROWS, 1, 3, m.marked, { ...HAND_OPTS, offsetsChecked: checked });
  assert.equal(Object.values(c.counts).reduce((a, b) => a + b, 0), 0);
});

test("countCha：上下號碼相同的格子略過", () => {
  const rows = [
    [10, 19, 25, 30, 35],
    [20, 21, 22, 23, 24],
    [10, 19, 33, 36, 38], // 與上方同號碼
    [1, 2, 3, 4, 5],
  ];
  const m = Cha.markCha(rows, 1, 3, HAND_OPTS);
  assert.equal(m.marked.size, 4);
  const c = Cha.countCha(rows, 1, 3, m.marked, HAND_OPTS);
  assert.equal(Object.values(c.counts).reduce((a, b) => a + b, 0), 0);
});

// ---------- 前幾名 ----------
test("topRankList：前二個次數值對應的所有號碼", () => {
  const counts = { 5: 3, 7: 3, 9: 2, 11: 1 };
  assert.deepEqual(Cha.topRankList(counts).map((x) => x.n), [5, 7, 9]);
});

test("topRankList：只湊到 2 顆以下時放寬到第三名", () => {
  const counts = { 5: 3, 9: 2, 11: 1, 12: 1 };
  assert.deepEqual(Cha.topRankList(counts).map((x) => x.n), [5, 9, 11, 12]);
});

test("topRankList：已達 3 顆就不放寬", () => {
  const counts = { 5: 3, 9: 1, 11: 1, 12: 0 };
  assert.deepEqual(Cha.topRankList(counts).map((x) => x.n), [5, 9, 11]);
});

test("topRankList：同次數依號碼由小到大", () => {
  const counts = { 30: 2, 3: 2, 17: 2 };
  assert.deepEqual(Cha.topRankList(counts).map((x) => x.n), [3, 17, 30]);
});

// ---------- 6期掃描位置 ----------
test("sweepPositions：下桿上方 6..1 列，資料真的不存在才略過", () => {
  const rows = new Array(30).fill([1, 2, 3, 4, 5]);
  // 下桿 idx16（App 第 17 列）：上桿 10..15 → 6 個
  assert.deepEqual(Cha.sweepPositions(rows, 16, { span: 6 }), [10, 11, 12, 13, 14, 15]);
  // 下桿 idx10：上桿 4..9，上桿 4、5 上方連備用列都沒有整整 6 列（資料從 0 開始）→ 略過
  assert.deepEqual(Cha.sweepPositions(rows, 10, { span: 6 }), [6, 7, 8, 9]);
  assert.deepEqual(Cha.sweepPositions(rows, 29, { span: 6 }), [23, 24, 25, 26, 27, 28]);
});

test("固定框架：顯示區 = 最新 16 期、備用列 = 再往上 16 期", () => {
  const rows = new Array(40).fill([1, 2, 3, 4, 5]);
  const o = Cha.resolveOpts({});
  assert.equal(Cha.visibleStart(rows, o), 24); // 顯示區 idx24..39
  assert.equal(Cha.searchFloor(rows, o), 8); // 備用列 idx8..23
});

test("備用列：下桿在顯示區第 1 期時，上桿與搜尋列全在備用列，不略過", () => {
  const rows = new Array(40).fill([1, 2, 3, 4, 5]);
  // 下桿 idx24 = 顯示區第 1 期；上桿 18..23，最早讀到 18-6 = idx12，備用列下限 idx8 → 全部 6 個位置都跑
  assert.deepEqual(Cha.sweepPositions(rows, 24, { span: 6 }), [18, 19, 20, 21, 22, 23]);
  const sw = Cha.sweep(rows, 24, { span: 6 });
  assert.equal(sw.earliestIdx, 12);
  assert.equal(sw.spareRowsUsed, 12); // 顯示第 1 期 idx24 - 12 = 用了 12 列備用列，16 列夠用
  // 沒有備用列的話，這個位置的 6 個上桿位置全部不夠搜期 → 全部略過
  assert.deepEqual(Cha.sweepPositions(rows, 24, { span: 6, spareRows: 0 }), []);
});

test("下桿列與其下方是未來，不可讀", () => {
  const rows = new Array(6).fill([1, 2, 3, 4, 5]); // 每列相同，只要讀得到就一定會標定
  // 下桿 idx1、上桿 idx2、搜期 1：上桿上方是 idx1 = 下桿列本身 → 不可讀 → 標不到
  assert.equal(Cha.markCha(rows, 2, 1, { span: 1 }).marked.size, 0);
  // 對照：下桿 idx3、上桿 idx2 → 上桿上方 idx1 在下桿之上 → 可讀 → 有標定
  assert.ok(Cha.markCha(rows, 2, 3, { span: 1 }).marked.size > 0);
  // 統計用的上桿列若等於下桿列也不可讀 → 全部 0
  const m = Cha.markCha(rows, 2, 3, { span: 1 });
  const c = Cha.countCha(rows, 3, 3, m.marked, { span: 1 });
  assert.equal(Object.values(c.counts).reduce((a, b) => a + b, 0), 0);
});

test("備用列：標定/統計會實際讀到備用列的號碼", () => {
  // 手算範例整組往後推：前面塞 20 列雜訊當歷史，顯示區只有 2 期(idx22,23) → 上桿與搜尋列全在備用列裡
  const noise = new Array(20).fill([2, 4, 6, 8, 12]);
  const rows = noise.concat(HAND_ROWS); // HAND 的 r0..r3 變成 idx20..23
  const opts = { ...HAND_OPTS, windowSize: 2, spareRows: 0 };
  // 沒有備用列：上桿 21 與其上方 idx20 都在顯示區外 → 標不到
  assert.equal(Cha.markCha(rows, 21, 23, opts).marked.size, 0);
  // 開備用列：標定與統計結果跟原本手算完全一樣
  const withSpare = { ...opts, spareRows: 16 };
  const m = Cha.markCha(rows, 21, 23, withSpare);
  assert.deepEqual([...m.marked].sort(), ["20:0", "20:1", "22:0", "22:1"]);
  const c = Cha.countCha(rows, 21, 23, m.marked, withSpare);
  assert.equal(c.counts[32], 2);
  assert.equal(c.counts[33], 1);
});

test("sweep：累計等於各位置 counts 相加", () => {
  const rows = [];
  let s = 7;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = 0; i < 40; i++) {
    const set = new Set();
    while (set.size < 5) set.add(1 + Math.floor(rnd() * 39));
    rows.push([...set].sort((a, b) => a - b));
  }
  const sw = Cha.sweep(rows, 39);
  assert.equal(sw.positions.length, 6);
  const manual = {};
  for (let n = 1; n <= 39; n++) manual[n] = 0;
  sw.steps.forEach((st) => { for (const n in st.counts) manual[n] += st.counts[n]; });
  assert.deepEqual(sw.accCounts, manual);
});

// ---------- 回測 ----------
test("backtest：手算範例回溯 1 次，命中 32", () => {
  const r = Cha.backtest(HAND_ROWS, { ...HAND_OPTS, steps: 1, sweepCount: 2 });
  assert.equal(r.records.length, 1);
  const rec = r.records[0];
  assert.equal(rec.lowerIdx, 3);
  // 上桿位置 1、2；位置 2 的上方 k=1 是 r1 vs r2，差值型態不同不會標定
  assert.deepEqual(rec.upperPositions, [1, 2]);
  assert.deepEqual(rec.predictedNums, [32, 33]);
  assert.deepEqual(rec.actual, [5, 32, 36, 37, 39]);
  assert.deepEqual(rec.hits, [32]);
  assert.equal(rec.hitCount, 1);
  assert.equal(r.summary.totalPredicted, 2);
  assert.equal(r.summary.totalHits, 1);
  assert.equal(r.summary.hitRate, 0.5);
});

test("backtest：回溯 16 次，每次下桿在倒數第 t 期", () => {
  const rows = [];
  let s = 3;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = 0; i < 60; i++) {
    const set = new Set();
    while (set.size < 5) set.add(1 + Math.floor(rnd() * 39));
    rows.push([...set].sort((a, b) => a - b));
  }
  const r = Cha.backtest(rows);
  assert.equal(r.records.length, 16);
  assert.deepEqual(r.frame, { visibleStart: 44, visibleEnd: 59, spareStart: 28, spareEnd: 43, stepsRequested: 16, stepsRun: 16 });
  r.records.forEach((rec, i) => {
    assert.equal(rec.t, i + 1);
    assert.equal(rec.lowerIdx, 60 - (i + 1));
    assert.equal(rec.upperPositions.length, 6); // 16 次都是 6 個位置，沒有任何略過
    // 備用列用量：下桿在顯示第 16 期(t=1) 最早讀到 idx47 → 0 列；第 1 期(t=16) 最早 idx32 → 12 列
    assert.equal(rec.spareRowsUsed, Math.max(0, 44 - (rec.lowerIdx - 6 - 6)));
    assert.deepEqual(rec.actual, rows[rec.lowerIdx]);
    rec.hits.forEach((n) => assert.ok(rec.actual.includes(n)));
    rec.predictedNums.forEach((n) => assert.ok(n >= 1 && n <= 39));
  });
  const sumHits = r.records.reduce((a, x) => a + x.hitCount, 0);
  assert.equal(r.summary.totalHits, sumHits);
});

test("backtest：下桿不離開顯示區，steps 超過 windowSize 會被截到 16", () => {
  const rows = new Array(60).fill([1, 2, 3, 4, 5]);
  const r = Cha.backtest(rows, { steps: 30 });
  assert.equal(r.records.length, 16);
  assert.equal(r.frame.stepsRequested, 30);
  assert.equal(r.frame.stepsRun, 16);
});

test("backtest：scorer 掛勾可以把額外欄位掛到 record", () => {
  const r = Cha.backtest(HAND_ROWS, {
    ...HAND_OPTS, steps: 1, sweepCount: 2,
    scorer: (rec) => ({ myScore: rec.hitCount * 10 }),
  });
  assert.equal(r.records[0].myScore, 10);
});

// ---------- 資料整理 ----------
test("fromRecords：依日期排序、號碼由小到大、去掉特別號", () => {
  const data = Cha.fromRecords([
    { date: "2026-01-02", numbers: [9, 3, 1, 20, 5] },
    { date: "2026-01-01", numbers: [39, 38, 37, 36, 35] },
  ]);
  assert.deepEqual(data.rows, [[35, 36, 37, 38, 39], [1, 3, 5, 9, 20]]);
  assert.deepEqual(data.meta.map((m) => m.date), ["2026-01-01", "2026-01-02"]);
  const lotto = Cha.fromRecords([{ date: "2026-01-01", numbers: [1, 2, 3, 4, 5, 6], special: 7 }], { game: "lotto" });
  assert.deepEqual(lotto.rows, [[1, 2, 3, 4, 5, 6]]);
});
