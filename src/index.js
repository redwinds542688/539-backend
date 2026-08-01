const fs = require("fs");
const path = require("path");
const http = require("http");
const cron = require("node-cron");

const config = require("./config");
const { fetchOfficial } = require("./sources/official");
const { fetchGovOpenData } = require("./sources/govOpenData");
const { fetchThirdParty } = require("./sources/thirdParty");
const { crossCheck } = require("./crossCheck");

const OUTPUT_FILE = path.resolve(__dirname, config.outputPath);

async function safeFetch(name, fn) {
  try {
    const value = await fn(config.requestTimeoutMs);
    console.log(`[${new Date().toISOString()}] ✅ ${name} 抓取成功:`, value.date, value.numbers.join(","));
    return { status: "ok", value };
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ❌ ${name} 抓取失敗:`, err.message);
    return { status: "error", error: err.message };
  }
}
async function runOnce() {
  console.log(`\n===== ${new Date().toISOString()} 開始更新今彩539資料 =====`);

  const results = await Promise.all([
    safeFetch("official (台彩官網)", fetchOfficial),
    safeFetch("govOpenData (政府資料開放平臺)", fetchGovOpenData),
    safeFetch("thirdParty (第三方資訊站)", fetchThirdParty),
  ]);

  const check = crossCheck(results, config.requireAllThreeMatch);

  if (!check.matched) {
    console.warn(`⚠️ 本次不更新檔案：${check.reason}`);
    return { updated: false, reason: check.reason };
  }

  const { date, numbers } = check.agreed;
  console.log(`✅ 比對成功（${check.reason}）：${date} → ${numbers.join(",")}`);

  const updated = mergeIntoResultsFile(date, numbers);
  if (updated) {
    console.log(`💾 已寫入 ${OUTPUT_FILE}`);
  } else {
    console.log(`ℹ️ ${date} 這筆資料已存在，檔案未變動`);
  }

  return { updated, date, numbers };
}

function mergeIntoResultsFile(date, numbers) {
  let existing = [];
  if (fs.existsSync(OUTPUT_FILE)) {
    try {
      existing = JSON.parse(fs.readFileSync(OUTPUT_FILE, "utf8"));
      if (!Array.isArray(existing)) existing = [];
    } catch {
      existing = [];
    }
  }

  const already = existing.find((r) => r.date === date);
  if (already) {
    if (already.numbers.join(",") === numbers.join(",")) return false;
    already.numbers = numbers;
  } else {
    existing.push({ date, numbers });
  }

  existing.sort((a, b) => a.date.localeCompare(b.date));
  const trimmed = existing.slice(-config.keepLatest);

  const tmpFile = OUTPUT_FILE + ".tmp";
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(tmpFile, JSON.stringify(trimmed, null, 2), "utf8");
  fs.renameSync(tmpFile, OUTPUT_FILE);
  return true;
}
let refreshInFlight = null;

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

    if (req.url === "/api/refresh" && (req.method === "POST" || req.method === "GET")) {
      try {
        if (!refreshInFlight) {
          refreshInFlight = runOnce().finally(() => {
            refreshInFlight = null;
          });
        }
        const result = await refreshInFlight;
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, ...result }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err) }));
      }
      return;
    }

    if (req.url === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, time: new Date().toISOString() }));
      return;
    }

    if (req.url === "/data/results.json") {
      try {
        const content = fs.readFileSync(OUTPUT_FILE, "utf8");
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(content);
      } catch (err) {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "results.json 還不存在，請先執行一次更新" }));
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "not found" }));
  });

  server.listen(port, () => {
    console.log(`🌐 更新用的 API 伺服器已啟動： http://localhost:${port}/api/refresh`);
  });

  return server;
}
async function main() {
  const runOnceMode = process.argv.includes("--once");

  if (runOnceMode) {
    await runOnce();
    process.exit(0);
  }

  console.log("539 資料同步排程已啟動，排程時間：", config.cronSchedule.join(" / "));
  for (const schedule of config.cronSchedule) {
    cron.schedule(schedule, () => {
      runOnce().catch((err) => console.error("排程執行發生未預期錯誤:", err));
    });
  }

  startServer(config.apiPort || 3939);

  runOnce().catch((err) => console.error("啟動時執行發生未預期錯誤:", err));
}

main();


