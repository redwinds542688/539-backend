const axios = require("axios");
const { normalizeDate, normalizeNumbers } = require("../utils/dateUtils");

// 政府資料開放平臺的 CSV 沒有保證編碼，實務上 UTF-8 跟 Big5 都可能。
// 原本的寫法固定用 axios 預設的 UTF-8 解碼，萬一對方是 Big5，
// `包含「今彩539」的資料列` 這個條件會完全比對不到，錯誤訊息卻是
// 「找不到今彩539的資料列」，看起來像版型改版、其實是編碼問題，
// 很難從日誌看出真正原因。這裡改成兩種編碼都試。
function decodeCsv(buffer) {
  const utf8 = new TextDecoder("utf-8").decode(buffer);
  if (utf8.includes("今彩539")) return utf8;

  const big5 = new TextDecoder("big5").decode(buffer);
  if (big5.includes("今彩539")) return big5;

  // 兩種都找不到就回傳 UTF-8 版本，讓後續的錯誤訊息照常拋出。
  return utf8;
}

async function fetchGovOpenData(timeoutMs) {
  const url = "https://gaze.nta.gov.tw/dntmb/OpenData/csvDw?ntaCode=D423F";
  const res = await axios.get(url, { timeout: timeoutMs, responseType: "arraybuffer" });

  const text = decodeCsv(res.data);
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const dataLines = lines.filter((l) => l.includes("今彩539"));

  if (dataLines.length === 0) {
    const err = new Error("找不到今彩539的資料列，CSV 格式或編碼可能已改變");
    err.__noRetry = true;
    throw err;
  }

  // 原本直接取 dataLines[0] 當成最新一期，這是假設 CSV 一定是
  // 「新的排在前面」。政府平臺的匯出順序沒有這種保證（實務上不少
  // 開放資料是由舊到新），一旦順序相反就會固定抓到最早那一期。
  // 改成把每一列都解析出來，取日期真正最大的那一筆。
  const rows = [];
  for (const line of dataLines) {
    const cols = line.split(",").map((c) => c.trim().replace(/^["']|["']$/g, ""));
    const date = normalizeDate(cols[1]);
    if (!date) continue;
    const numbers = normalizeNumbers(cols.slice(2, 7));
    if (numbers.length !== 5) continue;
    rows.push({ date, numbers });
  }

  if (rows.length === 0) {
    const err = new Error("找到今彩539的資料列但解析不出日期／5個號碼，CSV 欄位可能已改變");
    err.__noRetry = true;
    throw err;
  }

  rows.sort((a, b) => a.date.localeCompare(b.date));
  const latest = rows[rows.length - 1];

  return { source: "govOpenData", date: latest.date, numbers: latest.numbers };
}

module.exports = { fetchGovOpenData };
