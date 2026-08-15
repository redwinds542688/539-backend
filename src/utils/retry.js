// 帶指數退避的重試包裝。
//
// 為什麼需要：三個抓取來源都是外部網站，偶發的連線重置／短暫 5xx
// 很常見。原本的寫法只要抓一次失敗就整個來源作廢，一旦兩個來源
// 同時遇到偶發失敗，交叉比對就達不到門檻、當天整批資料就不會更新
// （而且要等下一個排程時間才會再試）。加上重試之後，這種暫時性的
// 抖動大多能在同一次執行裡自己恢復。
//
// 注意：只對「暫時性錯誤」重試才有意義。版型改版造成的解析失敗
// （例如「找不到今彩539的開獎日期」）重試幾次都是一樣的結果，
// 白白拖長執行時間，所以用 shouldRetry 讓呼叫端決定哪些錯誤值得重試。

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 解析類的錯誤重試沒有意義（網站版型改了，再抓幾次還是一樣），
// 只有網路層／伺服器端的暫時性錯誤才重試。
function isTransientError(err) {
  if (!err) return false;
  if (err.__noRetry) return false;

  const status = err.response && err.response.status;
  // 4xx 是「請求本身有問題」，重試不會變好；5xx 跟完全沒有 response
  // （連線層面失敗、逾時）才當成暫時性錯誤。
  if (typeof status === "number") return status >= 500;

  return true;
}

async function withRetry(fn, options = {}) {
  const attempts = options.attempts || 3;
  const baseDelayMs = options.baseDelayMs || 1000;
  const shouldRetry = options.shouldRetry || isTransientError;
  const onRetry = options.onRetry;

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt >= attempts || !shouldRetry(err)) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      if (onRetry) onRetry(err, attempt, delay);
      await sleep(delay);
    }
  }
  throw lastError;
}

module.exports = { withRetry, isTransientError, sleep };
