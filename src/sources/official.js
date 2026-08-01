const axios = require("axios");
const cheerio = require("cheerio");

async function fetchOfficial(timeoutMs) {
  const url = "https://www.taiwanlottery.com/lotto/result/daily_cash";
  const res = await axios.get(url, { timeout: timeoutMs });
  const $ = cheerio.load(res.data);

  const dateText = $(".contents_box02 .ball_tx").first().text().trim();
  const balls = [];
  $(".contents_box02 .ball_red, .contents_box02 .ball_tx .ball")
    .each((i, el) => {
      const n = parseInt($(el).text().trim(), 10);
      if (!isNaN(n)) balls.push(n);
    });

  if (balls.length < 5) {
    throw new Error("解析不到5個號碼，網站版型可能已改版");
  }

  return {
    source: "official",
    date: dateText,
    numbers: balls.slice(0, 5).sort((a, b) => a - b),
  };
}

module.exports = { fetchOfficial };
