const axios = require("axios");

async function fetchGovOpenData(timeoutMs) {
  const url = "https://gaze.nta.gov.tw/dntmb/OpenData/csvDw?ntaCode=D423F";
  const res = await axios.get(url, { timeout: timeoutMs, responseType: "text" });

  const lines = res.data.split("\n").map((l) => l.trim()).filter(Boolean);
  const dataLines = lines.filter((l) => l.includes("今彩539"));

  if (dataLines.length === 0) {
    throw new Error("找不到今彩539的資料列");
  }

  const latest = dataLines[0];
  const cols = latest.split(",");

  const date = cols[1];
  const numbers = cols
    .slice(2, 7)
    .map((n) => parseInt(n, 10))
    .filter((n) => !isNaN(n))
    .sort((a, b) => a - b);

  if (numbers.length < 5) {
    throw new Error("解析不到5個號碼，CSV格式可能已改變");
  }

  return {
    source: "govOpenData",
    date,
    numbers,
  };
}

module.exports = { fetchGovOpenData };
