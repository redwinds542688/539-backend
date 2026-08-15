# 539 專案

這個 repo 同時放了**後端服務**跟**前端 App**，方便接手時一次拿到完整上下文。

## 目錄結構

| 路徑 | 內容 |
|---|---|
| `src/` | 後端服務：今彩539 開獎號碼爬蟲 + 排程 + API（Node.js，部署在 Railway） |
| `app/539app.html` | 前端 App：單一 HTML 檔（約 6800 行，HTML/CSS/JS 全部內嵌），在 Android 原生瀏覽器直接開啟本機檔案執行，**不是**部署在網頁伺服器上 |
| `docs/` | 前端 App 的交接文件與規格基準 |

## 兩邊怎麼串起來

`app/539app.html` 會呼叫這個後端的兩個端點（見 `src/index.js`）：

- `GET https://539-backend-production.up.railway.app/data/results.json` — 讀取開獎結果（`app/539app.html:5705`）
- `POST https://539-backend-production.up.railway.app/api/refresh` — 觸發後端重新抓一次資料，純觸發訊號，不夾帶號碼（`app/539app.html:6020`）

App 另外會讀一個**跟這個 repo 無關**的樂透雲端資料庫 `https://hearty-vitality-production-0687.up.railway.app/draws/{game}`，寫入那個資料庫的爬蟲跑在使用者自己的電腦上（`lottery_scraper.py`），不在這個 repo 裡。

## 文件導讀

先讀 `docs/專案交接說明.md`（總覽），再視需要看細部規格：

- `docs/定期16初始.md` — 「定期十六」模式的**畫面顯示**邏輯基準（對應 `applyRecentOnly()`）
- `docs/定期十六截圖初始.md` — 「定期十六」模式的**存檔擷取**邏輯基準（對應 `saveAsImage()`）

⚠️ 交接說明第六節有註記：`定期十六截圖初始.md` 是會話中段的快照，之後又經過數輪調整，**已知有一定程度過時**，接手時建議先照第八節的「核對清單」重新核對程式碼再更新文件。

## 後端運作方式

資料流：

```
台彩官網 ─┐
政府開放平臺 ─┼─► 交叉比對（至少 3 個來源一致）─► data/results.json ─► App
第三方資訊站 ─┤                                        ▲
樂透雲端資料庫 ┘ ────── 開機／每次排程補齊完整歷史 ──────┘
```

App 端四個玩法都會讀對應的端點，讀不到就退回 HTML 裡的內嵌資料
（`loadData()` 與 `loadOtherGamesFromBackend()`），所以**不再需要為了新開獎
手動修改 `539app.html` 的內嵌資料**。

**為什麼要從雲端資料庫補齊歷史**：Railway 的容器檔案系統是暫時性的，
每次重新部署 `data/results.json` 就整個消失，而排程一次只會寫入最新
一期，靠自己累積要好幾個月才會有堪用的歷史（而且下次部署又歸零）。
所以開機時會先從雲端資料庫一次拉回完整歷史重建這個檔案。

### API 端點

| 端點 | 用途 |
|---|---|
| `GET /data/results.json` | 今彩539。回傳 `[{date, weekday, numbers}]`，由舊到新排序（App 用 `data[length-1]` 取最新）。沒有資料時回 `[]`（200） |
| `GET /data/results-daily.json` | 加州天天樂（從雲端資料庫鏡像） |
| `GET /data/results-mark6.json` | 香港六合彩（含 `special` 特別號） |
| `GET /data/results-lotto.json` | 大樂透（含 `special` 特別號） |
| `POST /api/refresh` | 觸發重新抓取。回應含每個來源各自抓到什麼、比對統計 |
| `GET /api/health` | 存活檢查 |
| `GET /api/status` | 診斷用：目前有幾期、最新／最舊一期、上次執行時每個來源的結果 |

### 主要設定（`src/config.js`）

| 設定 | 說明 |
|---|---|
| `minAgreeingSources` | 至少幾個來源一致才寫入（預設 3，共 4 個來源） |
| `cronTimezone` | 排程時區，**必須是 `Asia/Taipei`**，否則會照容器的 UTC 跑，晚 8 小時 |
| `cloudDb.seedLimit` | 開機時從雲端拉回多少期重建歷史 |
| `cloudDb.useAsSource` | 是否把雲端資料庫也當成第 4 個交叉比對來源 |
| `mirrorGames` | 要從雲端鏡像哪些玩法（539 以外的三個） |

環境變數 `CLOUD_DB_URL` 可覆寫雲端資料庫網址（測試或搬家用）。

### 四個玩法的號碼規則

`src/games.js` 裡的規則是掃過 App 內嵌資料共 1111 筆真實開獎紀錄統計出來的，
用來擋掉「來源解析錯誤但格式看起來正常」的資料：

| 玩法 | 號碼個數 | 範圍 | 特別號 |
|---|---|---|---|
| 今彩539 | 5 | 1~39 | 無 |
| 加州天天樂 | 5 | 1~39 | 無 |
| 香港六合彩 | 6 | 1~49 | 1~49 |
| 大樂透 | 6 | 1~49 | 1~49 |

## 後端指令

```bash
npm install
npm start        # 啟動排程 + API 伺服器
npm run run-once # 只跑一次抓取後結束
npm test         # 跑測試（純本機，不需要外網）
```
