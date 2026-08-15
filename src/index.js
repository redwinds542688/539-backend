const path = require("path");
const http = require("http");
const cron = require("node-cron");
const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");

const config = require("./config");
const { fetchOfficial } = require("./sources/official");
const { fetchGovOpenData } = require("./sources/govOpenData");
const { fetchThirdParty } = require("./sources/thirdParty");
const { fetchCloudDb, fetchCloudHistory } = require("./sources/cloudDb");
const { crossCheck } = require("./crossCheck");
const { createStore } = require("./store");
const { withRetry } = require("./utils/retry");

const OUTPUT_FILE = path.resolve(__dirname, config.outputPath);
const store = createStore(OUTPUT_FILE, { keepLatest: config.keepLatest });

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

// 最後一次執行的摘要，供 /api/status 診斷用——線上出問題時可以直接
// 打一個網址就看到「每個來源各自抓到什麼、為什麼沒寫入」，
// 不用去翻 Railway 的日誌。
let lastRun = null;

async function safeFetch(name, fn) {
  try {
    const value = await withRetry(() => fn(config.requestTimeoutMs), {
      attempts: config.fetchAttempts || 3,
      onRetry: (err, attempt, delay) =>
        log(`↻ ${name} 第 ${attempt} 次失敗（${err.message}），${delay}ms 後重試`),
    });
    log(`✅ ${name} 抓取成功:`, value.date, value.numbers.join(","));
    return { status: "ok", value };
  } catch (err) {
    log(`❌ ${name} 抓取失敗:`, err.message);
    return { status: "error", source: name, error: err.message };
  }
}

// 從雲端資料庫補齊歷史。
// 這是解決「Railway 容器檔案系統是暫時性的」的關鍵一步：容器一重啟
// data/results.json 就消失，而排程一次只會寫入最新一期，靠自己累積
// 要好幾個月才會有足堪使用的歷史（而且下次部署又歸零）。從雲端一次
// 拉回完整歷史，檔案才真的有意義。
async function seedFromCloud() {
  if (!config.cloudDb || !config.cloudDb.seedOnStart) return null;

  try {
    const records = await fetchCloudHistory(
      config.cloudDb.seedLimit || config.keepLatest,
      config.requestTimeoutMs,
      { baseUrl: config.cloudDb.baseUrl, game: config.cloudDb.game }
    );

    if (records.length === 0) {
      log("ℹ️ 雲端資料庫沒有回傳任何歷史資料，略過補齊");
      return { added: 0, corrected: 0, total: store.readAll().length };
    }

    const result = store.mergeMany(records);
    if (result.changed) {
      log(`☁️ 已從雲端補齊歷史：新增 ${result.added} 期、校正 ${result.corrected} 期，目前共 ${result.total} 期`);
    } else {
      log(`☁️ 雲端歷史已是最新，共 ${result.total} 期，檔案未變動`);
    }
    return result;
  } catch (err) {
    // 補齊歷史失敗不能讓服務起不來——這只是加值步驟，
    // 三個爬蟲來源照樣可以獨立運作。
    log("⚠️ 從雲端補齊歷史失敗（不影響其他功能）:", err.message);
    return null;
  }
}

async function runOnce(options = {}) {
  log("===== 開始更新今彩539資料 =====");

  const tasks = [
    safeFetch("official (台彩官網)", fetchOfficial),
    safeFetch("govOpenData (政府資料開放平臺)", fetchGovOpenData),
    safeFetch("thirdParty (第三方資訊站)", fetchThirdParty),
  ];

  if (config.cloudDb && config.cloudDb.useAsSource) {
    tasks.push(
      safeFetch("cloudDb (樂透雲端資料庫)", (timeoutMs) =>
        fetchCloudDb(timeoutMs, { baseUrl: config.cloudDb.baseUrl, game: config.cloudDb.game })
      )
    );
  }

  const results = await Promise.all(tasks);

  // 不論比對成不成功，都順手從雲端補齊歷史——這樣就算今天的號碼
  // 因為門檻沒過而沒寫入，App 至少還是拿得到完整的過往資料。
  // （開機那一次已經在 main() 裡單獨補過，用 skipSeed 避免重複打一次雲端）
  const seed = options.skipSeed ? null : await seedFromCloud();

  const check = crossCheck(results, config.minAgreeingSources);

  const summary = {
    time: new Date().toISOString(),
    sources: results.map((r) =>
      r.status === "ok"
        ? { source: r.value.source, ok: true, date: r.value.date, numbers: r.value.numbers }
        : { source: r.source, ok: false, error: r.error }
    ),
    tally: check.tally,
    seeded: seed,
  };

  if (!check.matched) {
    log(`⚠️ 本次不更新最新一期：${check.reason}`);
    lastRun = { ...summary, updated: false, reason: check.reason };
    return { updated: false, reason: check.reason, ...summary };
  }

  const { date, numbers } = check.agreed;
  log(`✅ 比對成功（${check.reason}）：${date} → ${numbers.join(",")}`);

  const write = store.upsert(date, numbers);
  log(write.changed ? `💾 已寫入 ${OUTPUT_FILE}（${write.reason}）` : `ℹ️ ${date} ${write.reason}`);

  lastRun = { ...summary, updated: write.changed, date, numbers, reason: write.reason };
  return { updated: write.changed, date, numbers, reason: write.reason, ...summary };
}

let refreshInFlight = null;

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function startServer(port) {
  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // 查詢字串（App 會加 _ts 之類的參數避開快取）不能影響路由判斷，
    // 所以先把 pathname 切出來再比對。
    const pathname = (req.url || "").split("?")[0];

    if (pathname === "/api/refresh" && (req.method === "POST" || req.method === "GET")) {
      try {
        if (!refreshInFlight) {
          refreshInFlight = runOnce().finally(() => {
            refreshInFlight = null;
          });
        }
        const result = await refreshInFlight;
        sendJson(res, 200, { ok: true, ...result });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String((err && err.message) || err) });
      }
      return;
    }

    if (pathname === "/api/health") {
      sendJson(res, 200, { ok: true, time: new Date().toISOString() });
      return;
    }

    // 診斷用：一次看完「檔案裡有幾期、最新一期是哪天、上次執行時
    // 每個來源各自抓到什麼」，線上出問題時不用翻 Railway 日誌。
    if (pathname === "/api/status") {
      const all = store.readAll();
      sendJson(res, 200, {
        ok: true,
        time: new Date().toISOString(),
        timezone: config.cronTimezone,
        totalRecords: all.length,
        latest: all.length ? all[all.length - 1] : null,
        earliest: all.length ? all[0] : null,
        minAgreeingSources: config.minAgreeingSources,
        cronSchedule: config.cronSchedule,
        lastRun,
      });
      return;
    }

    if (pathname === "/data/results.json") {
      // 檔案還不存在時原本回 404，改成回一個合法的空陣列（200）——
      // App 端兩種情況都會退回內嵌資料，行為一致，但空陣列是語意上
      // 正確的「目前沒有資料」，其他呼叫端不用特別處理 404。
      try {
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(store.readAll()));
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String((err && err.message) || err) });
      }
      return;
    }

    sendJson(res, 404, { ok: false, error: "not found" });
  });

  server.listen(port, () => {
    log(`🌐 API 伺服器已啟動： http://localhost:${port}/api/refresh`);
  });

  return server;
}

async function main() {
  if (process.argv.includes("--once")) {
    await runOnce();
    process.exit(0);
  }

  log(
    `539 資料同步排程已啟動（時區 ${config.cronTimezone}），排程時間：`,
    config.cronSchedule.join(" / ")
  );

  for (const schedule of config.cronSchedule) {
    cron.schedule(
      schedule,
      () => {
        runOnce().catch((err) => log("排程執行發生未預期錯誤:", err));
      },
      // 指定時區，否則會跟著容器的 UTC 跑，實際執行時間會晚 8 小時。
      { timezone: config.cronTimezone }
    );
  }

  startServer(config.apiPort || 3939);

  // 開機先補一次雲端歷史，讓剛部署完的容器立刻就有完整資料可供
  // App 讀取，不用等到第一個排程時間。
  await seedFromCloud();
  runOnce({ skipSeed: true }).catch((err) => log("啟動時執行發生未預期錯誤:", err));
}

main();
