// 多來源交叉比對。
//
// 【原本的致命 bug】
// 這個函式用 `${date}|${numbers}` 當 key 去統計「有幾個來源回報同一個
// 結果」，但三個來源回傳的日期格式本來完全不一樣：
//     official   → "2026-08-14"（已換算成西元）
//     thirdParty → "115/08/14"（民國年，原本完全沒換算）
//     govOpenData→ CSV 原始欄位
// 格式不同就是不同的 key，所以就算三個來源抓到的其實是同一期、同一組
// 號碼，統計出來也永遠是「三個各自為政、每個 count=1」，配上 config 的
// requireAllThreeMatch:true（門檻 3），結果是這個服務從來沒有成功寫出
// 過任何一筆資料。
//
// 【修法】
// 進來的每一筆都先用 normalizeDate()／normalizeNumbers() 正規化，
// 讓比對只看真正的內容，不受各來源的格式差異影響。

const { normalizeDate, normalizeNumbers } = require("./utils/dateUtils");

function crossCheck(results, minAgreeingSources) {
  const threshold = Math.max(1, minAgreeingSources || 2);

  const ok = [];
  const malformed = [];
  for (const r of results) {
    if (r.status !== "ok" || !r.value) continue;
    const date = normalizeDate(r.value.date);
    const numbers = normalizeNumbers(r.value.numbers);
    if (!date || numbers.length !== 5) {
      // 抓取本身成功、但內容解析不出合法的日期／5 個號碼，
      // 當成這個來源無效，並記下來讓日誌看得出是哪一家的問題。
      malformed.push(`${r.value.source}(${r.value.date} / ${r.value.numbers})`);
      continue;
    }
    ok.push({ source: r.value.source, date, numbers });
  }

  if (ok.length === 0) {
    const detail = malformed.length ? `，另有格式異常的來源：${malformed.join("、")}` : "";
    return {
      matched: false,
      agreed: null,
      reason: `所有來源都沒有取得可用的資料${detail}`,
      tally: [],
    };
  }

  const tally = new Map();
  for (const r of ok) {
    const key = `${r.date}|${r.numbers.join(",")}`;
    if (!tally.has(key)) tally.set(key, { count: 0, sources: [], value: r });
    const entry = tally.get(key);
    entry.count += 1;
    entry.sources.push(r.source);
  }

  const sorted = [...tally.values()].sort((a, b) => b.count - a.count);
  const top = sorted[0];

  // 統計摘要，不管成功失敗都回傳，方便從 /api/refresh 的回應
  // 直接看出「每個來源各自抓到什麼」，不用去翻伺服器日誌。
  const summary = sorted.map((e) => ({
    date: e.value.date,
    numbers: e.value.numbers,
    sources: e.sources,
    count: e.count,
  }));

  if (top.count >= threshold) {
    return {
      matched: true,
      agreed: { date: top.value.date, numbers: top.value.numbers },
      agreedBy: top.sources,
      reason: `${top.sources.join("、")} 共 ${top.count} 個來源一致`,
      tally: summary,
    };
  }

  const detail = summary
    .map((e) => `[${e.sources.join("+")}] ${e.date} ${e.numbers.join(",")}`)
    .join(" / ");

  return {
    matched: false,
    agreed: null,
    reason:
      `比對失敗：需要至少 ${threshold} 個來源一致，目前最多只有 ${top.count} 個。` +
      `實際抓到的結果 → ${detail}`,
    tally: summary,
  };
}

module.exports = { crossCheck };
