const axios = require("axios");
const cheerio = require("cheerio");
const { normalizeDate } = require("../util/date");

async function fetchThirdParty(timeoutMs) {
  const url = "https://www.pilio.idv.tw/lto539/list.asp";
  const res = await axios.get(url, { timeout: timeoutMs, responseType: "arraybuffer" });
  const html = new TextDecoder("big5").decode(res.data);
  const $ = cheerio.load(html);

  let date = null;
  let numbers = [];

  $("table tr").each((i, row) => {
    if (numbers.length > 0) return;
    const cells = $(row).find("td");
    if (cells.length < 6) return;

    const dateText = $(cells[0]).text().trim();
    if (!/^\d{2,3}\/\d{1,2}\/\d{1,2}$/.test(dateText)) return;

    const nums = [];
    for (let i = 1; i <= 5; i++) {
      const n = parseInt($(cells[i]).text().trim(), 10);
      if (!isNaN(n)) nums.push(n);
    }

    if (nums.length === 5) {
      // dateText 是民國格式（例："115/8/14"），正規化成西元 YYYY-MM-DD
      // 才能跟其他來源比對，否則同一期會產生不同的 key、永遠比不出共識。
      date = normalizeDate(dateText);
      numbers = nums.sort((a, b) => a - b);
    }
  });

  if (numbers.length < 5) {
    throw new Error("解析不到5個號碼，網站版型可能已改版");
  }
  if (!date) {
    throw new Error("日期格式無法解析，網站版型可能已改版");
  }

  return {
    source: "thirdParty",
    date,
    numbers,
  };
}

module.exports = { fetchThirdParty };
