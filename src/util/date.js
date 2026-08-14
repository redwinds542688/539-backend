// 把各來源的日期字串統一正規化成西元、補0的 YYYY-MM-DD。
//
// 為什麼需要（踩過的坑）：
//   三個來源回傳的日期格式原本不一致——
//     official（台彩官網）已是西元 "YYYY-MM-DD"；
//     thirdParty（第三方站）是民國 "XXX/M/D"（未補0）；
//     govOpenData（政府開放資料）依 CSV 而定，可能民國也可能西元。
//   crossCheck() 是用「日期|號碼」當作比對用的 key，只要格式不一致，
//   同一期開獎在不同來源就會產生不同的 key，導致永遠比不出共識、
//   data/results.json 永遠不會更新（整個服務等於空轉）。
//   統一在來源端正規化，才能正確比對，也讓寫進 results.json 的日期格式一致。
function pad2(n) {
  return String(parseInt(n, 10)).padStart(2, "0");
}

function normalizeDate(input) {
  if (input == null) return null;
  const s = String(input).trim();

  // 西元：YYYY-MM-DD 或 YYYY/MM/DD（4 位數年份）
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) {
    return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  }

  // 民國：XXX/M/D 或 XXX-M-D（2~3 位數年份）→ 加 1911 換算西元
  m = s.match(/^(\d{2,3})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) {
    const year = parseInt(m[1], 10) + 1911;
    return `${year}-${pad2(m[2])}-${pad2(m[3])}`;
  }

  return null; // 無法辨識的格式，交由呼叫端決定要不要當成解析失敗
}

module.exports = { normalizeDate };
