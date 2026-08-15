// data/results.json 的儲存層。
//
// 原本這段邏輯直接寫在 index.js 裡，抽出來的原因不只是整理，而是
// 這一層現在多了兩個必要的職責：
//
//   1. 補上 weekday 欄位
//      App（539app.html）的每一筆資料是 {date, weekday, numbers}，
//      weekday 是中文星期字元（"一"～"日"），實際用在：
//        - 星期欄的渲染（539app.html:2607）
//        - 星期一分隔線的判斷 r.weekday === "一"（539app.html:2576）
//        - 版面計算 WD_INDEX[r.weekday]（539app.html:2551）
//        - 標題列的「(星期X)」（539app.html:2620）
//      原本後端只寫 {date, numbers}，缺 weekday，一旦 App 真的成功
//      讀到後端檔案，星期欄會變成 undefined、星期一分隔線也會失效。
//
//   2. 從雲端資料庫重建歷史
//      Railway 的容器檔案系統是暫時性的，每次重新部署 data/results.json
//      就整個消失，而原本的合併邏輯一次只加「最新一筆」，所以
//      keepLatest:400 這個設定實際上永遠達不到。開機時先從雲端資料庫
//      拉一次完整歷史回來重建檔案，這個檔案才真的有意義。

const fs = require("fs");
const path = require("path");
const { normalizeDate, normalizeNumbers, weekdayOf } = require("./utils/dateUtils");

// 把任何一筆記錄整理成 App 需要的標準格式，格式不對回傳 null。
// 舊版檔案裡沒有 weekday 的記錄，會在這裡被自動補上。
function normalizeRecord(record) {
  if (!record) return null;
  const date = normalizeDate(record.date);
  const numbers = normalizeNumbers(record.numbers);
  if (!date || numbers.length !== 5) return null;
  return { date, weekday: record.weekday || weekdayOf(date), numbers };
}

function createStore(outputFile, options = {}) {
  const keepLatest = options.keepLatest || 400;

  function readAll() {
    if (!fs.existsSync(outputFile)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(outputFile, "utf8"));
      if (!Array.isArray(parsed)) return [];
      return parsed.map(normalizeRecord).filter(Boolean);
    } catch {
      // 檔案毀損（例如上次寫入寫到一半被中斷）時當作空的重來，
      // 不要讓整個服務起不來——反正開機的 seeding 會再從雲端補回來。
      return [];
    }
  }

  function writeAll(records) {
    const sorted = [...records].sort((a, b) => a.date.localeCompare(b.date));
    const trimmed = sorted.slice(-keepLatest);

    // 先寫暫存檔再 rename：rename 在同一個檔案系統上是原子操作，
    // 避免 App 剛好在寫入的當下讀到只寫了一半的 JSON。
    const tmpFile = `${outputFile}.tmp`;
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(tmpFile, JSON.stringify(trimmed, null, 2), "utf8");
    fs.renameSync(tmpFile, outputFile);
    return trimmed;
  }

  // 合併單筆（排程抓到的最新一期）。
  // 回傳 { changed, reason }，changed=false 代表檔案完全沒動。
  function upsert(date, numbers) {
    const incoming = normalizeRecord({ date, numbers });
    if (!incoming) return { changed: false, reason: "資料格式不正確，未寫入" };

    const existing = readAll();
    const index = existing.findIndex((r) => r.date === incoming.date);

    if (index === -1) {
      existing.push(incoming);
      writeAll(existing);
      return { changed: true, reason: "新增一期" };
    }

    if (existing[index].numbers.join(",") === incoming.numbers.join(",")) {
      return { changed: false, reason: "這期資料已存在且號碼相同" };
    }

    // 同一天但號碼不同 = 來源後來校正過，以新抓到的為準覆蓋。
    existing[index] = incoming;
    writeAll(existing);
    return { changed: true, reason: "同一期號碼經校正後覆蓋" };
  }

  // 批次合併（開機時從雲端資料庫拉回來的完整歷史）。
  // 已存在且號碼相同的略過，號碼不同的以傳入的為準覆蓋。
  function mergeMany(records) {
    const existing = readAll();
    const byDate = new Map(existing.map((r) => [r.date, r]));

    let added = 0;
    let corrected = 0;
    for (const raw of records) {
      const incoming = normalizeRecord(raw);
      if (!incoming) continue;
      const current = byDate.get(incoming.date);
      if (!current) {
        byDate.set(incoming.date, incoming);
        added += 1;
      } else if (current.numbers.join(",") !== incoming.numbers.join(",")) {
        byDate.set(incoming.date, incoming);
        corrected += 1;
      }
    }

    if (added === 0 && corrected === 0) {
      return { changed: false, added: 0, corrected: 0, total: existing.length };
    }

    const merged = writeAll([...byDate.values()]);
    return { changed: true, added, corrected, total: merged.length };
  }

  function latest() {
    const all = readAll();
    return all.length ? all[all.length - 1] : null;
  }

  return { readAll, writeAll, upsert, mergeMany, latest, outputFile };
}

module.exports = { createStore, normalizeRecord };
