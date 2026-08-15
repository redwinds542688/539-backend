// 雲端資料庫讀取的整合測試。
//
// 這裡用一個本機的假伺服器模擬 hearty-vitality 雲端資料庫的回傳格式，
// 驗證解析邏輯真的對得上——因為真正的雲端網址在 CI／開發環境不一定
// 連得到，不能靠「手動打一次看看」來確認。
//
// 假資料的欄位形狀是照著實際 API 的規格寫的（見 app/539app.html 的
// fetchSingleGameCloudLatest() 與交接文件 2.1 節）：
//   - 回傳直接是 JSON 陣列，不是包在 {draws:[...]} 裡
//   - draw_date 是日期字串、numbers 是「空白分隔的補0字串」
//   - 查不到資料時回 404，body 是 {"detail":"找不到「xxx」的資料"}

const assert = require("assert");
const http = require("http");
const { fetchCloudDb, fetchCloudHistory } = require("../src/sources/cloudDb");
const { getGame } = require("../src/games");

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    console.error(`  ❌ ${name}\n     ${err.message}`);
    process.exitCode = 1;
  }
}

// 模擬雲端資料庫。requests 會記錄收到的請求，用來驗證網址組法。
function startMockCloud(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    handler(req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}/draws`,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function jsonResponse(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

const SAMPLE = [
  { draw_date: "2026-08-14", numbers: "07 19 21 25 34", special_number: "", agreeing_sources: 3 },
  { draw_date: "2026-08-13", numbers: "05 11 12 17 18", special_number: "", agreeing_sources: 3 },
  { draw_date: "2026-08-12", numbers: "07 12 17 20 32", special_number: "", agreeing_sources: 2 },
];

async function main() {
  console.log("\n[cloudDb]");

  await test("解析雲端回傳的陣列格式，補上 weekday 並由舊到新排序", async () => {
    const mock = await startMockCloud((req, res) => jsonResponse(res, 200, SAMPLE));
    try {
      const records = await fetchCloudHistory(400, 5000, { baseUrl: mock.baseUrl });
      assert.strictEqual(records.length, 3);
      assert.deepStrictEqual(records[0], {
        date: "2026-08-12",
        weekday: "三",
        numbers: [7, 12, 17, 20, 32],
      });
      assert.strictEqual(records[records.length - 1].date, "2026-08-14");
    } finally {
      await mock.close();
    }
  });

  await test("玩法名稱放在路徑裡並正確 URL encode", async () => {
    const mock = await startMockCloud((req, res) => jsonResponse(res, 200, SAMPLE));
    try {
      await fetchCloudHistory(50, 5000, { baseUrl: mock.baseUrl, game: "今彩539" });
      const url = mock.requests[0];
      assert.ok(
        url.startsWith(`/draws/${encodeURIComponent("今彩539")}?`),
        `玩法應該在路徑裡，實際收到：${url}`
      );
      assert.ok(url.includes("limit=50"), `應該帶 limit，實際收到：${url}`);
      assert.ok(url.includes("_ts="), `應該帶避開快取的時間戳，實際收到：${url}`);
    } finally {
      await mock.close();
    }
  });

  await test("fetchCloudDb 取到最新一期，格式跟其他來源一致", async () => {
    const mock = await startMockCloud((req, res) => jsonResponse(res, 200, SAMPLE));
    try {
      const latest = await fetchCloudDb(5000, { baseUrl: mock.baseUrl });
      assert.deepStrictEqual(latest, {
        source: "cloudDb",
        date: "2026-08-14",
        numbers: [7, 19, 21, 25, 34],
      });
    } finally {
      await mock.close();
    }
  });

  await test("404（該玩法沒資料）當成「沒資料」，不是連線失敗", async () => {
    const mock = await startMockCloud((req, res) =>
      jsonResponse(res, 404, { detail: "找不到「今彩539」的資料" })
    );
    try {
      const records = await fetchCloudHistory(400, 5000, { baseUrl: mock.baseUrl });
      assert.deepStrictEqual(records, [], "404 應該回傳空陣列而不是丟例外");

      await assert.rejects(
        () => fetchCloudDb(5000, { baseUrl: mock.baseUrl }),
        /沒有今彩539的資料/,
        "當作交叉比對來源時，沒資料要視為這個來源失效"
      );
    } finally {
      await mock.close();
    }
  });

  await test("容錯：萬一 API 改成包一層 {draws:[...]} 也能處理", async () => {
    const mock = await startMockCloud((req, res) => jsonResponse(res, 200, { draws: SAMPLE }));
    try {
      const records = await fetchCloudHistory(400, 5000, { baseUrl: mock.baseUrl });
      assert.strictEqual(records.length, 3);
    } finally {
      await mock.close();
    }
  });

  await test("跳過壞掉的資料列，不讓半筆髒資料汙染整批歷史", async () => {
    const mock = await startMockCloud((req, res) =>
      jsonResponse(res, 200, [
        { draw_date: "2026-08-14", numbers: "07 19 21 25 34" },
        { draw_date: "壞掉的日期", numbers: "01 02 03 04 05" },
        { draw_date: "2026-08-13", numbers: "05 11 12" }, // 號碼不足5個
        { draw_date: "2026-08-12", numbers: "07 12 17 20 32" },
      ])
    );
    try {
      const records = await fetchCloudHistory(400, 5000, { baseUrl: mock.baseUrl });
      assert.deepStrictEqual(
        records.map((r) => r.date),
        ["2026-08-12", "2026-08-14"]
      );
    } finally {
      await mock.close();
    }
  });

  await test("伺服器錯誤要往上拋，不能默默當成沒資料", async () => {
    const mock = await startMockCloud((req, res) => jsonResponse(res, 500, { error: "boom" }));
    try {
      await assert.rejects(() => fetchCloudHistory(400, 5000, { baseUrl: mock.baseUrl }));
    } finally {
      await mock.close();
    }
  });

  await test("大樂透：6 個號碼 + 特別號都要正確解析", async () => {
    const mock = await startMockCloud((req, res) =>
      jsonResponse(res, 200, [
        {
          draw_date: "2026-08-14",
          numbers: "05 12 25 33 34 35",
          special_number: "27",
          agreeing_sources: 3,
        },
      ])
    );
    try {
      const records = await fetchCloudHistory(400, 5000, {
        baseUrl: mock.baseUrl,
        game: "大樂透",
        gameRules: getGame("lotto"),
      });
      assert.deepStrictEqual(records[0], {
        date: "2026-08-14",
        weekday: "五",
        numbers: [5, 12, 25, 33, 34, 35],
        special: 27,
      });
    } finally {
      await mock.close();
    }
  });

  await test("用 539 的規則去讀大樂透資料會整批被擋（號碼個數不符）", async () => {
    const mock = await startMockCloud((req, res) =>
      jsonResponse(res, 200, [
        { draw_date: "2026-08-14", numbers: "05 12 25 33 34 35", special_number: "27" },
      ])
    );
    try {
      // 沒有傳 gameRules 就會套用 539 的規則（5 個號碼），
      // 6 個號碼的大樂透資料應該全部被過濾掉，不會混進 539 的檔案。
      const records = await fetchCloudHistory(400, 5000, { baseUrl: mock.baseUrl });
      assert.deepStrictEqual(records, []);
    } finally {
      await mock.close();
    }
  });

  await test("超出範圍的號碼會被過濾掉", async () => {
    const mock = await startMockCloud((req, res) =>
      jsonResponse(res, 200, [
        { draw_date: "2026-08-14", numbers: "07 19 21 25 34" },
        { draw_date: "2026-08-13", numbers: "07 19 21 25 40" }, // 40 超出 539 的 1~39
      ])
    );
    try {
      const records = await fetchCloudHistory(400, 5000, { baseUrl: mock.baseUrl });
      assert.deepStrictEqual(records.map((r) => r.date), ["2026-08-14"]);
    } finally {
      await mock.close();
    }
  });

  console.log(`\n${process.exitCode ? "有測試失敗" : `全部通過（${passed} 項）`}\n`);
}

main();
