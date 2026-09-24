// 樂透雲端資料庫（hearty-vitality）讀取模組。
//
// 這是這個服務原本完全沒有用到、但其實是整個系統裡「唯一有完整歷史
// 資料」的地方。背景說明：
//
//   - 雲端資料庫由使用者自己電腦上的 lottery_scraper.py 負責寫入
//     （POST 邏輯不在這個 repo 裡，這裡只讀不寫）。
//   - 手機 App（app/539app.html）本來就會直接讀這個資料庫來比對
//     「本機資料有沒有落後雲端」（見 fetchSingleGameCloudLatest()）。
//   - 但這個後端服務原本只把抓到的號碼寫進容器裡的 data/results.json，
//     而 Railway 的容器檔案系統是暫時性的，每次重新部署就整個清空，
//     加上原本的合併邏輯一次只加「最新一筆」，所以那個檔案永遠只有
//     「上次部署之後累積到的幾筆」，App 讀到之後判斷資料太少就退回
//     內嵌資料（EMBEDDED_DATA）——這就是使用者必須手動更新 HTML 裡
//     內嵌號碼的根本原因。
//
// 這個模組提供兩個能力：
//   1. fetchCloudDb()      —— 當作第 4 個交叉比對來源（獨立於三個爬蟲）
//   2. fetchCloudHistory() —— 開機時把完整歷史一次拉回來，重建
//                             data/results.json，讓它不再受容器重啟影響

const axios = require("axios");
const { normalizeDate, normalizeNumbers, weekdayOf } = require("../utils/dateUtils");
const { getGame, validateNumbers } = require("../games");

// 依照 App 裡的註解（見 539app.html 的 fetchSingleGameCloudLatest()）記載的
// 規格，這裡把三個容易踩錯的點寫清楚，避免之後又改回錯的寫法：
//   1. 網址是 hearty-vitality-production-0687，不是舊的 api-production-6a938
//   2. 玩法要放在「路徑」裡（/draws/{game}），不是查詢字串（?game=xxx）
//      —— 放查詢字串會變成查「全部玩法」，沒有依玩法篩選
//   3. 回傳「直接就是 JSON 陣列」，不是包在 {draws:[...]} 物件裡
const DEFAULT_BASE_URL = "https://hearty-vitality-production-0687.up.railway.app/draws";
const DEFAULT_GAME = "今彩539";

function buildUrl(baseUrl, game, limit) {
  // 玩法是中文，一定要 encode。加上時間戳記避免中間層的快取，
  // 讓「剛寫進雲端的最新一期」不會因為快取而讀到舊值。
  return `${baseUrl}/${encodeURIComponent(game)}?limit=${limit}&_ts=${Date.now()}`;
}

async function requestDraws(options, limit) {
  const baseUrl = options.baseUrl || DEFAULT_BASE_URL;
  const game = options.game || DEFAULT_GAME;
  const timeoutMs = options.timeoutMs || 30000;

  const res = await axios.get(buildUrl(baseUrl, game, limit), {
    timeout: timeoutMs,
    headers: { "Cache-Control": "no-cache" },
    // 404 是這個 API 表達「這個玩法目前沒有資料」的合法回應
    // （body 是 {"detail":"找不到「xxx」的資料"}），不是連線失敗，
    // 所以放行讓下面自己判斷，不要讓 axios 直接丟例外。
    validateStatus: (status) => (status >= 200 && status < 300) || status === 404,
  });

  if (res.status === 404) return [];

  // 主要格式是「直接一個陣列」；同時保留對「萬一哪天 API 改成包一層
  // 物件」的容錯，跟 App 端的處理方式保持一致。
  const raw = Array.isArray(res.data) ? res.data : (res.data && res.data.draws) || [];
  if (!Array.isArray(raw)) return [];

  // 玩法規則（號碼個數／範圍／有沒有特別號）。沒有指定時預設今彩539，
  // 維持原本只服務 539 時的行為。注意上面的 game 是「查詢用的中文
  // 玩法名稱」，這裡的 rules 是「驗證用的規則物件」，兩者不同。
  const rules = options.gameRules || getGame("539");

  const records = [];
  for (const row of raw) {
    if (!row) continue;
    const date = normalizeDate(row.draw_date);
    const numbers = normalizeNumbers(row.numbers);
    if (!date) continue;

    // 特別號只有大樂透／六合彩用得到；539 跟天天樂的 special_number
    // 是空字串，parseInt 會得到 NaN，這裡統一轉成 null。
    let special = null;
    if (rules.hasSpecial) {
      const parsed = parseInt(row.special_number, 10);
      special = Number.isFinite(parsed) ? parsed : null;
    }

    // 不符合這個玩法規則的資料列直接跳過，不要讓半筆壞資料汙染整批歷史。
    if (validateNumbers(rules, numbers, special)) continue;

    const record = { date, weekday: weekdayOf(date), numbers };
    if (rules.hasSpecial && special !== null) record.special = special;
    records.push(record);
  }

  // 依日期由舊到新排序，跟 data/results.json 以及 App 端的
  // EMBEDDED_DATA 一致（App 是用 data[data.length-1] 取最新一期）。
  records.sort((a, b) => a.date.localeCompare(b.date));
  return records;
}

// 交叉比對來源用：只取最新一期，回傳格式跟其他三個來源一致。
async function fetchCloudDb(timeoutMs, options = {}) {
  const records = await requestDraws({ ...options, timeoutMs }, options.latestLimit || 5);

  if (records.length === 0) {
    // 這裡標記 __noRetry：雲端「確實連上了、只是沒有資料」，
    // 重試幾次結果都一樣，不需要浪費時間退避重試。
    const err = new Error(`雲端資料庫沒有${options.game || DEFAULT_GAME}的資料`);
    err.__noRetry = true;
    throw err;
  }

  const latest = records[records.length - 1];
  const result = { source: "cloudDb", date: latest.date, numbers: latest.numbers };
  if (latest.special !== undefined) result.special = latest.special;
  return result;
}

// 重建歷史用：一次取回最近 limit 期，回傳已正規化、由舊到新排序的陣列。
// 失敗時不丟例外而是回傳空陣列——開機 seeding 只是「有就更好」的加值
// 步驟，雲端暫時連不上不應該讓整個服務起不來。
async function fetchCloudHistory(limit, timeoutMs, options = {}) {
  return requestDraws({ ...options, timeoutMs }, limit);
}

module.exports = { fetchCloudDb, fetchCloudHistory, DEFAULT_BASE_URL, DEFAULT_GAME };
