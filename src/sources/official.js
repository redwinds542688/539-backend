const axios = require("axios");
const { normalizeDate, normalizeNumbers } = require("../utils/dateUtils");

async function fetchOfficial(timeoutMs) {
  const url = "https://lotto.family.net.tw/";
  const res = await axios.get(url, { timeout: timeoutMs, responseType: "text" });
  const text = res.data;

  const dateMatch = text.match(/(\d{2,3})\/(\d{1,2})\/(\d{1,2})[^\d]{0,10}今彩539開獎直播/);
  if (!dateMatch) {
    const err = new Error("找不到今彩539的開獎日期，網站版型可能已改版");
    err.__noRetry = true; // 版型問題重試幾次都一樣，不浪費退避等待時間
    throw err;
  }

  // 民國年換算統一交給 normalizeDate()（原本是在這裡自己 +1911），
  // 讓四個來源用同一套換算邏輯，不會出現「其中一家換算方式不一樣」
  // 的隱性差異。
  const date = normalizeDate(`${dateMatch[1]}/${dateMatch[2]}/${dateMatch[3]}`);
  if (!date) {
    const err = new Error(`開獎日期解析失敗：${dateMatch[0]}`);
    err.__noRetry = true;
    throw err;
  }

  const afterText = text.slice(dateMatch.index, dateMatch.index + 500);
  const numMatch = afterText.match(/大小排序：\s*([\d\s]{10,40})/);
  if (!numMatch) {
    const err = new Error("解析不到5個號碼，網站版型可能已改版");
    err.__noRetry = true;
    throw err;
  }

  const numbers = normalizeNumbers(numMatch[1].match(/\d{1,2}/g) || []);
  if (numbers.length !== 5) {
    const err = new Error(`解析出的號碼數量不是5個（${numbers.join(",")}），網站版型可能已改版`);
    err.__noRetry = true;
    throw err;
  }

  return { source: "official", date, numbers };
}

module.exports = { fetchOfficial };
