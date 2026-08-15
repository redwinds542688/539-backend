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

## 後端指令

```bash
npm install
npm start        # 啟動排程 + API 伺服器
npm run run-once # 只跑一次抓取後結束
```
