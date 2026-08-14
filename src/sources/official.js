const axios = require("axios");
const { normalizeDate } = require("../util/date");

async function fetchOfficial(timeoutMs) {
  const url = "https://lotto.family.net.tw/";
  const res = await axios.get(url, { timeout: timeoutMs, responseType: "text" });
  const text = res.data;

  const dateMatch = text.match(/(\d{2,3})\/(\d{1,2})\/(\d{1,2})[^\d]{0,10}今彩539開獎直播/);
  if (!dateMatch) {
    throw new Error("找不到今彩539的開獎日期，網站版型可能已改版");
  }
  // 官網日期是民國格式（例："115/8/14"），統一交給 normalizeDate 換算成
  // 西元補0的 YYYY-MM-DD，跟其他兩個來源用同一套格式才能正確比對。
  const date = normalizeDate(`${dateMatch[1]}/${dateMatch[2]}/${dateMatch[3]}`);
  if (!date) {
    throw new Error("今彩539開獎日期格式無法解析，網站版型可能已改版");
  }

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
