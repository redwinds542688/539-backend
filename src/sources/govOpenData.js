const axios = require("axios");
const { normalizeDate } = require("../util/date");

async function fetchGovOpenData(timeoutMs) {
  const url = "https://gaze.nta.gov.tw/dntmb/OpenData/csvDw?ntaCode=D423F";
  const res = await axios.get(url, { timeout: timeoutMs, responseType: "text" });

  const lines = res.data.split("\n").map((l) => l.trim()).filter(Boolean);
  const dataLines = lines.filter((l) => l.includes("今彩539"));

  if (dataLines.length === 0) {
    throw new Error("找不到今彩539的資料列");
  }

  // 不再假設 dataLines[0] 就是最新一期——CSV 排序方向不保證（可能舊到新），
  // 直接掃過所有資料列、挑出日期最大的那筆，比較穩健。
  // 日期一律用 normalizeDate 換算成西元 YYYY-MM-DD，跟其他來源格式一致才能比對。
  let best = null;
  for (const line of dataLines) {
    const cols = line.split(",");
    const date = normalizeDate(cols[1]);
    const numbers = cols
      .slice(2, 7)
      .map((n) => parseInt(n, 10))
      .filter((n) => !isNaN(n))
      .sort((a, b) => a - b);

    if (!date || numbers.length < 5) continue;
    if (!best || date > best.date) {
      best = { date, numbers };
    }
  }

  if (!best) {
    throw new Error("解析不到有效的今彩539資料列，CSV格式可能已改變");
  }

  return {
    source: "govOpenData",
    date: best.date,
    numbers: best.numbers,
  };
}

module.exports = { fetchGovOpenData };
