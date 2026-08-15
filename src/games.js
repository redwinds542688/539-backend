// 四個玩法的定義。
//
// key／cloudName 對齊 App 的 getCloudGameMap()（539app.html:6138），
// 兩邊必須一致，否則雲端查詢會查不到東西。
//
// count／min／max 不是憑印象填的，是把 App 內嵌資料（EMBEDDED_COMPACT
// 等四組，共 1111 筆真實開獎紀錄）全部掃過一遍統計出來的實測值：
//     今彩539      323 筆　5 個號碼　1~39　無特別號
//     加州天天樂    242 筆　5 個號碼　1~39　無特別號
//     香港六合彩    243 筆　6 個號碼　1~49　特別號 1~49
//     大樂透        303 筆　6 個號碼　1~49　特別號 1~49
//
// 這些規則用來擋掉「來源解析錯誤但格式看起來正常」的資料。舉例：
// 網站改版後 regex 抓到的其實是頁面上的其他數字，湊巧也是 5 個，
// 只檢查「有沒有 5 個號碼」是攔不住的，但檢查範圍就能攔下 40、
// 0、-3 這種不可能出現的號碼。寫錯開獎號碼是這個服務最嚴重的失效
// 模式（比「今天沒更新」嚴重得多），所以寧可嚴格。

const GAMES = {
  "539": {
    key: "539",
    cloudName: "今彩539",
    label: "今彩539",
    count: 5,
    min: 1,
    max: 39,
    hasSpecial: false,
    // 539 是這個服務原本就在處理的玩法，檔名維持 results.json 不變，
    // 因為 App 寫死在 loadData() 裡（539app.html:5705），改檔名會壞掉。
    file: "results.json",
  },
  daily: {
    key: "daily",
    cloudName: "加州天天樂",
    label: "加州天天樂",
    count: 5,
    min: 1,
    max: 39,
    hasSpecial: false,
    file: "results-daily.json",
  },
  mark6: {
    key: "mark6",
    cloudName: "香港六合彩",
    label: "香港六合彩",
    count: 6,
    min: 1,
    max: 49,
    hasSpecial: true,
    file: "results-mark6.json",
  },
  lotto: {
    key: "lotto",
    cloudName: "大樂透",
    label: "大樂透",
    count: 6,
    min: 1,
    max: 49,
    hasSpecial: true,
    file: "results-lotto.json",
  },
};

// 檢查一組號碼符不符合這個玩法的規則，合法回傳 null，
// 不合法回傳一段可以直接寫進日誌的中文說明。
function validateNumbers(game, numbers, special) {
  if (!Array.isArray(numbers) || numbers.length !== game.count) {
    return `號碼個數應為 ${game.count} 個，實際 ${Array.isArray(numbers) ? numbers.length : 0} 個`;
  }

  const outOfRange = numbers.filter((n) => !Number.isInteger(n) || n < game.min || n > game.max);
  if (outOfRange.length) {
    return `號碼超出 ${game.min}~${game.max} 的範圍：${outOfRange.join(",")}`;
  }

  // normalizeNumbers() 已經去過重複，這裡再確認一次——長度對得上
  // 就代表沒有重複被吃掉（例如來源給了 [7,7,19,21,25]，去重後只剩
  // 4 個，會在上面的個數檢查被擋下）。

  if (game.hasSpecial && special !== null && special !== undefined) {
    if (!Number.isInteger(special) || special < game.min || special > game.max) {
      return `特別號超出 ${game.min}~${game.max} 的範圍：${special}`;
    }
  }

  return null;
}

// 日期合理性檢查。
// 主要擋兩件事：
//   1. 未來的日期——來源解析錯誤（例如把「下期開獎日」當成開獎日）
//      會寫進一筆還沒開獎的號碼，App 顯示出來會非常誤導。
//      容許 1 天的寬容度，避免容器時區跟台灣時區的落差造成誤判。
//   2. 太久以前的日期——通常代表解析到頁面上的歷史區塊或廣告。
function validateDate(isoDate, options = {}) {
  const maxFutureDays = options.maxFutureDays === undefined ? 1 : options.maxFutureDays;
  const maxPastYears = options.maxPastYears === undefined ? 5 : options.maxPastYears;

  const time = Date.parse(`${isoDate}T00:00:00Z`);
  if (!Number.isFinite(time)) return `日期無法解析：${isoDate}`;

  const now = options.now === undefined ? Date.now() : options.now;
  const dayMs = 24 * 60 * 60 * 1000;

  if (time > now + maxFutureDays * dayMs) {
    return `日期是未來的日期（${isoDate}），來源可能解析錯誤`;
  }
  if (time < now - maxPastYears * 365 * dayMs) {
    return `日期過舊（${isoDate}），來源可能解析到歷史區塊`;
  }
  return null;
}

function getGame(key) {
  return GAMES[key] || null;
}

module.exports = { GAMES, getGame, validateNumbers, validateDate };
