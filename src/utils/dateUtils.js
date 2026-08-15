// 日期／號碼的正規化工具。
//
// 為什麼需要這個檔案：三個抓取來源回傳的日期格式本來完全不一樣——
//   official     → "2026-08-14"（已經自己換算成西元）
//   thirdParty   → "115/08/14"（民國年，原本完全沒換算）
//   govOpenData  → CSV 原始欄位（格式跟著政府平臺走，不保證）
// 而 crossCheck() 是用「日期|號碼」當 key 去比對三個來源一不一致，
// 格式不同就是不同的 key，等於三個來源永遠不可能取得共識，加上
// config 的 requireAllThreeMatch:true（要 3 個全部一致），結果就是
// 這個服務永遠寫不出任何一筆資料。
//
// 修法：所有來源抓回來的日期，一律先過 normalizeDate() 轉成
// "YYYY-MM-DD" 再進比對，號碼一律過 normalizeNumbers() 轉成排序好的
// 整數陣列，讓比對只看「真正的內容」，不受各家格式差異影響。

// 對齊 App（539app.html）的 WD_BY_JSDAY，索引是 JS 的 getDay()（0=星期日）。
// 兩邊字串必須完全一致，App 才能正確查 WD_INDEX、判斷星期一分隔線。
const WD_BY_JSDAY = ["日", "一", "二", "三", "四", "五", "六"];

// 把各種常見寫法的日期統一轉成 "YYYY-MM-DD"，無法解析時回傳 null
// （回傳 null 而不是丟例外，是因為呼叫端通常想「跳過這一列」而不是
// 讓整批資料解析失敗，例如 CSV 裡混進標題列或空白列）。
//
// 支援的輸入格式：
//   2026-08-14 / 2026/08/14 / 2026.08.14 / 20260814   → 西元
//   115-08-14  / 115/08/14  / 115/8/14   / 1150814    → 民國（+1911）
function normalizeDate(raw) {
  if (raw === null || raw === undefined) return null;

  // 去掉前後空白、CSV 常見的包覆引號、以及檔案開頭可能混進來的 BOM。
  const text = String(raw).replace(/^﻿/, "").trim().replace(/^["']|["']$/g, "");
  if (!text) return null;

  let year;
  let month;
  let day;

  const separated = text.match(/^(\d{2,4})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})$/);
  if (separated) {
    year = parseInt(separated[1], 10);
    month = parseInt(separated[2], 10);
    day = parseInt(separated[3], 10);
    // 2~3 碼的年份視為民國年（115 → 2026）；4 碼視為西元年。
    if (separated[1].length <= 3) year += 1911;
  } else {
    // 沒有分隔符號的連續數字：8 碼當西元（20260814），7 碼當民國（1150814）。
    const compact = text.match(/^(\d{7,8})$/);
    if (!compact) return null;
    const digits = compact[1];
    if (digits.length === 8) {
      year = parseInt(digits.slice(0, 4), 10);
      month = parseInt(digits.slice(4, 6), 10);
      day = parseInt(digits.slice(6, 8), 10);
    } else {
      year = parseInt(digits.slice(0, 3), 10) + 1911;
      month = parseInt(digits.slice(3, 5), 10);
      day = parseInt(digits.slice(5, 7), 10);
    }
  }

  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  // 用 UTC 建構再回頭核對，可以擋掉 2026-02-30 這種「格式對但日期不存在」
  // 的輸入（JS 的 Date 會自動進位成 3/2，不核對就會靜靜地寫錯一天）。
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// 由 "YYYY-MM-DD" 算出中文星期字元（"一"～"日"）。
// 固定走 UTC，避免容器時區（Railway 預設 UTC）跟台灣時區的差異
// 讓同一個日期字串算出差一天的星期。
function weekdayOf(isoDate) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ""));
  if (!parts) return null;
  const probe = new Date(
    Date.UTC(parseInt(parts[1], 10), parseInt(parts[2], 10) - 1, parseInt(parts[3], 10))
  );
  return WD_BY_JSDAY[probe.getUTCDay()];
}

// 把號碼統一成「排序好的整數陣列」。
// 接受陣列（[7,19,21]）或雲端資料庫那種空白分隔的補0字串（"07 19 21 25 34"），
// 也順手擋掉 NaN 跟重複值——重複代表來源解析錯了，寧可讓長度檢查失敗，
// 也不要把一組壞號碼當成正常結果寫出去。
function normalizeNumbers(input) {
  let list;
  if (Array.isArray(input)) {
    list = input;
  } else if (typeof input === "string") {
    list = input.trim().split(/[\s,、]+/);
  } else {
    return [];
  }

  const numbers = list
    .map((n) => parseInt(String(n).trim(), 10))
    .filter((n) => Number.isFinite(n));

  return [...new Set(numbers)].sort((a, b) => a - b);
}

module.exports = { normalizeDate, weekdayOf, normalizeNumbers, WD_BY_JSDAY };
