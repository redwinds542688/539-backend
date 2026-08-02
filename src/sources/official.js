const axios = require("axios");

async function fetchOfficial(timeoutMs) {
  const url = "https://lotto.family.net.tw/";
  const res = await axios.get(url, { timeout: timeoutMs, responseType: "text" });
  const text = res.data;

  const dateMatch = text.match(/(\d{2,3})\/(\d{1,2})\/(\d{1,2})[^\d]{0,10}今彩539開獎直播/);
  if (!dateMatch) {
    throw new Error("找不到今彩539的開獎日期，網站版型可能已改版");
  }
  const rocYear = parseInt(dateMatch[1], 10);
  const month = parseInt(dateMatch[2], 10);
  const day = parseInt(dateMatch[3], 10);
  const year = rocYear + 1911;
  const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

  const afterText = text.slice(dateMatch.index, dateMatch.index + 500);
  const numMatch = afterText.match(/大小排序：\s*([\d\s]{10,40})/);
  if (!numMatch) {
    throw new Error("解析不到5個號碼，網站版型可能已改版");
  }
  const numbers = (numMatch[1].match(/\d{1,2}/g) || [])
    .slice(0, 5)
    .map((n) => parseInt(n, 10))
    .sort((a, b) => a - b);

  if (numbers.length < 5) {
    throw new Error("解析不到5個號碼，網站版型可能已改版");
  }

  return {
    source: "official",
    date,
    numbers,
  };
}

module.exports = { fetchOfficial };
