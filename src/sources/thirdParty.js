const axios = require("axios");
const cheerio = require("cheerio");

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
      date = dateText;
      numbers = nums.sort((a, b) => a - b);
    }
  });

  if (numbers.length < 5) {
    throw new Error("解析不到5個號碼，網站版型可能已改版");
  }

  return {
    source: "thirdParty",
    date,
    numbers,
  };
}

module.exports = { fetchThirdParty };
