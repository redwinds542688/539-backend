const axios = require("axios");
const cheerio = require("cheerio");
const { normalizeDate, normalizeNumbers } = require("../utils/dateUtils");

async function fetchThirdParty(timeoutMs) {
  const url = "https://www.pilio.idv.tw/lto539/list.asp";
  const res = await axios.get(url, { timeout: timeoutMs, responseType: "arraybuffer" });
  const html = new TextDecoder("big5").decode(res.data);
  const $ = cheerio.load(html);

  // 這個站的表格是「新的在上面」，但不硬性依賴這個假設——把所有
  // 解析得出來的列都收集起來，最後取日期真正最大的那一筆。萬一哪天
  // 站方改成舊的在上面（或中間插了公告列），也不會默默抓到舊資料。
  const rows = [];

  $("table tr").each((_, row) => {
    const cells = $(row).find("td");
    if (cells.length < 6) return;

    // 原本這裡直接把網站上的民國年字串（例如 "115/08/14"）當成 date
    // 回傳，完全沒有換算成西元，而 official 來源回傳的是 "2026-08-14"，
    // 兩者在 crossCheck() 眼中永遠是不同的 key，導致交叉比對永遠失敗。
    // 現在統一交給 normalizeDate() 換算成 "YYYY-MM-DD"。
    const date = normalizeDate($(cells[0]).text());
    if (!date) return;

    const numbers = normalizeNumbers(
      Array.from({ length: 5 }, (_, i) => $(cells[i + 1]).text())
    );
    if (numbers.length !== 5) return;

    rows.push({ date, numbers });
  });

  if (rows.length === 0) {
    const err = new Error("解析不到任何一期的完整資料，網站版型可能已改版");
    err.__noRetry = true; // 版型問題重試幾次都一樣
    throw err;
  }

  rows.sort((a, b) => a.date.localeCompare(b.date));
  const latest = rows[rows.length - 1];

  return { source: "thirdParty", date: latest.date, numbers: latest.numbers };
}

module.exports = { fetchThirdParty };
