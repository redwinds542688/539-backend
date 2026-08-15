// 純函式的煙霧測試，不碰網路——可以在任何環境直接 `npm test` 跑。
//
// 重點在於守住這次修掉的那個致命 bug：三個來源的日期格式不一致，
// 導致 crossCheck() 永遠比對失敗、服務從來沒寫出過資料。下面
// 「不同格式的同一期資料要能比對成功」那個案例就是在守這件事，
// 之後如果有人把正規化拿掉，這個測試會立刻紅燈。

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { normalizeDate, weekdayOf, normalizeNumbers } = require("../src/utils/dateUtils");
const { crossCheck } = require("../src/crossCheck");
const { createStore } = require("../src/store");
const { getGame, validateNumbers, validateDate } = require("../src/games");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    console.error(`  ❌ ${name}\n     ${err.message}`);
    process.exitCode = 1;
  }
}

console.log("\n[dateUtils]");

test("民國年換算成西元", () => {
  assert.strictEqual(normalizeDate("115/08/14"), "2026-08-14");
  assert.strictEqual(normalizeDate("115/8/14"), "2026-08-14");
  assert.strictEqual(normalizeDate("115-08-14"), "2026-08-14");
  assert.strictEqual(normalizeDate("1150814"), "2026-08-14");
});

test("西元格式維持不變", () => {
  assert.strictEqual(normalizeDate("2026-08-14"), "2026-08-14");
  assert.strictEqual(normalizeDate("2026/08/14"), "2026-08-14");
  assert.strictEqual(normalizeDate("20260814"), "2026-08-14");
});

test("去掉 CSV 的引號與 BOM", () => {
  assert.strictEqual(normalizeDate('"115/08/14"'), "2026-08-14");
  assert.strictEqual(normalizeDate("﻿2026-08-14"), "2026-08-14");
});

test("不合法的日期回傳 null", () => {
  assert.strictEqual(normalizeDate("2026-02-30"), null); // 這一天不存在
  assert.strictEqual(normalizeDate("2026-13-01"), null);
  assert.strictEqual(normalizeDate("開獎日期"), null);
  assert.strictEqual(normalizeDate(""), null);
  assert.strictEqual(normalizeDate(null), null);
});

test("星期字元跟 App 的 WD_BY_JSDAY 一致", () => {
  // 對照 539app.html 的內嵌資料：2026-08-14 是星期五、2026-08-10 是星期一
  assert.strictEqual(weekdayOf("2026-08-14"), "五");
  assert.strictEqual(weekdayOf("2026-08-10"), "一");
  assert.strictEqual(weekdayOf("2026-08-15"), "六");
});

test("號碼正規化成排序過的整數陣列", () => {
  assert.deepStrictEqual(normalizeNumbers("07 19 21 25 34"), [7, 19, 21, 25, 34]);
  assert.deepStrictEqual(normalizeNumbers([34, 7, 25, 19, 21]), [7, 19, 21, 25, 34]);
  assert.deepStrictEqual(normalizeNumbers(["07", "19"]), [7, 19]);
  assert.deepStrictEqual(normalizeNumbers("7,19,21"), [7, 19, 21]);
});

console.log("\n[crossCheck]");

test("不同日期格式的同一期資料要能比對成功（這次修掉的致命 bug）", () => {
  const results = [
    { status: "ok", value: { source: "official", date: "2026-08-14", numbers: [7, 19, 21, 25, 34] } },
    { status: "ok", value: { source: "thirdParty", date: "115/08/14", numbers: [34, 7, 25, 19, 21] } },
    { status: "ok", value: { source: "govOpenData", date: "1150814", numbers: ["07", "19", "21", "25", "34"] } },
  ];
  const check = crossCheck(results, 3);
  assert.strictEqual(check.matched, true, "三個來源其實是同一期，應該要比對成功");
  assert.strictEqual(check.agreed.date, "2026-08-14");
  assert.deepStrictEqual(check.agreed.numbers, [7, 19, 21, 25, 34]);
});

test("真的不一致時要擋下來", () => {
  const results = [
    { status: "ok", value: { source: "official", date: "2026-08-14", numbers: [7, 19, 21, 25, 34] } },
    { status: "ok", value: { source: "thirdParty", date: "2026-08-14", numbers: [1, 2, 3, 4, 5] } },
    { status: "ok", value: { source: "govOpenData", date: "2026-08-14", numbers: [9, 9, 9, 9, 9] } },
  ];
  assert.strictEqual(crossCheck(results, 3).matched, false);
});

test("門檻 3、4 個來源中 3 個一致要放行", () => {
  const agree = { date: "2026-08-14", numbers: [7, 19, 21, 25, 34] };
  const results = [
    { status: "ok", value: { source: "official", ...agree } },
    { status: "ok", value: { source: "thirdParty", date: "115/08/14", numbers: agree.numbers } },
    { status: "ok", value: { source: "cloudDb", ...agree } },
    { status: "error", source: "govOpenData", error: "timeout" },
  ];
  const check = crossCheck(results, 3);
  assert.strictEqual(check.matched, true);
  assert.strictEqual(check.agreedBy.length, 3);
});

test("全部來源失敗時回報失敗、不丟例外", () => {
  const check = crossCheck(
    [
      { status: "error", source: "official", error: "timeout" },
      { status: "error", source: "thirdParty", error: "timeout" },
    ],
    3
  );
  assert.strictEqual(check.matched, false);
  assert.ok(check.reason.includes("沒有取得可用的資料"));
});

test("號碼數量不對的來源不列入統計", () => {
  const results = [
    { status: "ok", value: { source: "official", date: "2026-08-14", numbers: [7, 19, 21] } },
    { status: "ok", value: { source: "thirdParty", date: "2026-08-14", numbers: [7, 19, 21, 25, 34] } },
  ];
  const check = crossCheck(results, 2);
  assert.strictEqual(check.matched, false, "只有一個來源合法，不該達到門檻 2");
});

console.log("\n[games 號碼/日期驗證]");

test("539：5 個號碼、範圍 1~39", () => {
  const g = getGame("539");
  assert.strictEqual(validateNumbers(g, [7, 19, 21, 25, 34], null), null);
  assert.ok(validateNumbers(g, [7, 19, 21, 25], null), "只有 4 個號碼應該被擋");
  assert.ok(validateNumbers(g, [7, 19, 21, 25, 40], null), "40 超出 1~39 應該被擋");
  assert.ok(validateNumbers(g, [0, 19, 21, 25, 34], null), "0 應該被擋");
  assert.ok(validateNumbers(g, [-3, 19, 21, 25, 34], null), "負數應該被擋");
});

test("大樂透：6 個號碼、範圍 1~49、特別號 1~49", () => {
  const g = getGame("lotto");
  assert.strictEqual(validateNumbers(g, [5, 12, 25, 33, 34, 35], 27), null);
  assert.ok(validateNumbers(g, [5, 12, 25, 33, 34], 27), "只有 5 個號碼應該被擋");
  assert.ok(validateNumbers(g, [5, 12, 25, 33, 34, 50], 27), "50 超出範圍應該被擋");
  assert.ok(validateNumbers(g, [5, 12, 25, 33, 34, 35], 50), "特別號 50 超出範圍應該被擋");
});

test("重複號碼會被擋下（去重後個數不足）", () => {
  const g = getGame("539");
  // normalizeNumbers 會去重，[7,7,19,21,25] 去重後只剩 4 個
  assert.ok(validateNumbers(g, normalizeNumbers([7, 7, 19, 21, 25]), null));
});

test("未來的日期會被擋下", () => {
  const now = Date.parse("2026-08-15T00:00:00Z");
  assert.strictEqual(validateDate("2026-08-14", { now }), null);
  assert.strictEqual(validateDate("2026-08-15", { now }), null);
  assert.ok(validateDate("2026-09-01", { now }), "未來日期應該被擋");
});

test("過舊的日期會被擋下", () => {
  const now = Date.parse("2026-08-15T00:00:00Z");
  assert.ok(validateDate("2015-01-01", { now }), "10 年前的日期應該被擋");
  assert.strictEqual(validateDate("2024-01-01", { now }), null, "2 年前還在容許範圍");
});

console.log("\n[store]");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "539-store-"));
const tmpFile = path.join(tmpDir, "data", "results.json");
const store = createStore(tmpFile, { keepLatest: 5 });

test("寫入的記錄含 App 需要的 weekday 欄位", () => {
  const r = store.upsert("2026-08-14", [7, 19, 21, 25, 34]);
  assert.strictEqual(r.changed, true);
  const all = store.readAll();
  assert.strictEqual(all.length, 1);
  assert.deepStrictEqual(all[0], {
    date: "2026-08-14",
    weekday: "五",
    numbers: [7, 19, 21, 25, 34],
  });
});

test("同一期同號碼不重複寫入", () => {
  assert.strictEqual(store.upsert("2026-08-14", [7, 19, 21, 25, 34]).changed, false);
});

test("同一期不同號碼要覆蓋（來源校正）", () => {
  assert.strictEqual(store.upsert("2026-08-14", [1, 2, 3, 4, 5]).changed, true);
  assert.deepStrictEqual(store.latest().numbers, [1, 2, 3, 4, 5]);
});

test("民國年輸入也能正確寫入", () => {
  store.upsert("115/08/15", [4, 7, 10, 25, 31]);
  assert.strictEqual(store.latest().date, "2026-08-15");
  assert.strictEqual(store.latest().weekday, "六");
});

test("批次合併雲端歷史", () => {
  const result = store.mergeMany([
    { date: "2026-08-12", numbers: "07 12 17 20 32" },
    { date: "2026-08-13", numbers: "05 11 12 17 18" },
    { date: "2026-08-15", numbers: [4, 7, 10, 25, 31] }, // 已存在且相同 → 不算異動
  ]);
  assert.strictEqual(result.added, 2);
  assert.strictEqual(result.corrected, 0);
});

test("資料由舊到新排序（App 用 data[length-1] 取最新）", () => {
  const all = store.readAll();
  const dates = all.map((r) => r.date);
  assert.deepStrictEqual(dates, [...dates].sort());
  assert.strictEqual(all[all.length - 1].date, "2026-08-15");
});

test("超過 keepLatest 只保留最新的幾期", () => {
  store.mergeMany([
    { date: "2026-08-17", numbers: [1, 2, 3, 4, 6] },
    { date: "2026-08-18", numbers: [1, 2, 3, 4, 7] },
    { date: "2026-08-19", numbers: [1, 2, 3, 4, 8] },
  ]);
  const all = store.readAll();
  assert.strictEqual(all.length, 5, "keepLatest 設 5，應該只留 5 期");
  assert.strictEqual(all[all.length - 1].date, "2026-08-19");
});

test("檔案毀損時當作空的重來、不丟例外", () => {
  fs.writeFileSync(tmpFile, "{ 這不是合法的 JSON", "utf8");
  assert.deepStrictEqual(store.readAll(), []);
});

test("舊格式（沒有 weekday）讀取時自動補上", () => {
  fs.writeFileSync(
    tmpFile,
    JSON.stringify([{ date: "2026-08-14", numbers: [7, 19, 21, 25, 34] }]),
    "utf8"
  );
  assert.strictEqual(store.readAll()[0].weekday, "五");
});

console.log("\n[store 多玩法]");

const lottoFile = path.join(tmpDir, "data", "results-lotto.json");
const lottoStore = createStore(lottoFile, { keepLatest: 10, game: getGame("lotto") });

test("大樂透寫入時保留特別號", () => {
  const r = lottoStore.upsert("2026-08-14", [5, 12, 25, 33, 34, 35], 27);
  assert.strictEqual(r.changed, true);
  assert.deepStrictEqual(lottoStore.latest(), {
    date: "2026-08-14",
    weekday: "五",
    numbers: [5, 12, 25, 33, 34, 35],
    special: 27,
  });
});

test("只有特別號不同也算校正、要覆蓋", () => {
  const r = lottoStore.upsert("2026-08-14", [5, 12, 25, 33, 34, 35], 28);
  assert.strictEqual(r.changed, true, "特別號變了就該覆蓋");
  assert.strictEqual(lottoStore.latest().special, 28);
});

test("不符合玩法規則的號碼不會被寫入", () => {
  // 大樂透是 6 個號碼，傳 5 個應該整筆被拒絕
  const r = lottoStore.upsert("2026-08-15", [5, 12, 25, 33, 34]);
  assert.strictEqual(r.changed, false);
  assert.strictEqual(lottoStore.latest().date, "2026-08-14", "不該新增 08-15");
});

test("超出範圍的號碼不會被寫入", () => {
  const r = lottoStore.upsert("2026-08-15", [5, 12, 25, 33, 34, 50], 27);
  assert.strictEqual(r.changed, false, "50 超出 1~49 應該被拒絕");
});

test("539 的 store 不會產生 special 欄位", () => {
  assert.strictEqual("special" in store.readAll()[0], false);
});

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${process.exitCode ? "有測試失敗" : `全部通過（${passed} 項）`}\n`);
