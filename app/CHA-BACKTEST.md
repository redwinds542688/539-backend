# C式差數 回測框架

把「名揚四海彩卷系統」裡 C式差數的統計邏輯抽成不依賴畫面的純函式，
再往上架「回溯 16 次、每次上桿掃 6 個位置」的回測。
之後的「新計算機率邏輯」接在這個框架的輸出上，不用再碰 App 的 DOM 程式。

## 檔案

| 檔案 | 用途 |
|---|---|
| `app/cha-backtest.js` | 純邏輯模組。Node 用 `require`，瀏覽器直接 `<script>` 載入後用 `window.ChaBacktest` |
| `app/cha-backtest-cli.js` | 命令列執行器，印出 16 次回測的對照表 |
| `test/cha-backtest.test.js` | 手算範例與規則測試（`npm test`） |

## 因與果

| 角色 | 資料 | 程式 |
|---|---|---|
| 因 | 上桿上方的標定號碼 + 上桿那一列真正開出的號碼 | `markCha()` 標定、`countCha()` 用上桿列驗證偏移 |
| 預期的果 | 下桿上方標定號碼套同一偏移，累計後的前幾名 | `sweep()` + `topRankList()` |
| 真實的果 | 下桿那一列真正開出的號碼 | `backtest()` 把它藏起來當答案 |

## 回測流程

```
rows = 由舊到新的開獎列（每列號碼由小到大，不含特別號）

固定框架（跟 App 畫面一致，回測全程不動）：
    顯示區 = 最新 16 期            rows[N-16 .. N-1]
    備用列 = 顯示區上方再 16 期    rows[N-32 .. N-17]

for t = 1 .. 16:                       # 下桿在顯示區裡上移 16 次
    lowerIdx = N - t                   # t=1 下桿在顯示第 16 期，t=16 在顯示第 1 期；這一期就是真實的果
    for upperIdx = lowerIdx-6 .. lowerIdx-1:   # 上桿掃 6 個位置（App 的 6期掃描）
        上桿上方不足 搜期 列 → 往顯示區上方的備用列讀（不顯示、只統計）
        下桿列與其下方是未來，永遠不讀
        連備用列都補不滿（資料真的不存在）才略過，殘缺結果不計入
        標定  markCha(rows, upperIdx, lowerIdx)
        統計  countCha(...)  → counts 累加
    predicted = topRankList(累計 counts)   # 前二名，不足 2 顆補第三名，最多 15 顆
    actual    = rows[lowerIdx]
    hits      = predicted ∩ actual
```

每一次回測產生一筆 `record`，欄位如下：

| 欄位 | 內容 |
|---|---|
| `t`, `lowerIdx`, `meta.date` | 第幾次回溯、下桿列索引、該期日期 |
| `upperPositions` | 這次實際掃到的上桿位置 |
| `earliestIdx`, `spareRowsUsed` | 這次最早讀到哪一列、其中幾列是畫面外的備用列（內部統計用） |
| `accCounts` | 6 個位置累計後的統計表（號碼 → 次數） |
| `steps[]` | 每個上桿位置各自的 `marked / pairs / counts / contribs` |
| `steps[].contribs[]` | 每一次加分的來源：`k`（往上第幾列）、`col`（欄）、`offset`（偏移）、`upper`、`lower`、`result` |
| `predicted`, `predictedNums` | 預期的果（含次數） |
| `actual`, `hits`, `hitCount` | 真實的果、命中號碼、命中顆數 |
| `expectedRandomHits` | 同樣顆數隨機挑的期望命中數（純機率基準） |

`summary` 給整體命中率、純機率基準與提升倍數；`frame` 給這次的顯示區與備用列索引範圍、實際跑了幾次。

## 差數ai統計（紀錄層）

每一組標定連線的「下桿側」兩顆號碼各當一次主角，一顆主角一筆 entry（`aiRecords()`）：

| 順序 | 欄位 | 定義 | 例（主角 25，連線對手 35） |
|---|---|---|---|
| 1 | `sameRow` 同列 | 連線對手所在列 − 主角所在列，往下為正，同一列 0 | −4 |
| 2 | `linkDiff` 連線差 | 連線對手號碼 − 主角號碼 | +10 |
| 3 | `rowDist` 列距 | 主角所在列 − 下桿列（等於 −k） | −1 |
| 4 | `hits` 九宮差 | 主角加哪些九宮差會變成真實的果；空陣列 = 沒中 x；答案未知 = null | [−1, 0] |
| 5 | `gap` 桿距 | 上桿列 − 下桿列 | −5 |

`flattenAiRecords()` 把 entry 攤成使用者定義的一筆一筆紀錄 `[同列, 連線差, 列距, 九宮差, 桿距]`：
命中幾個九宮差就幾筆，沒中一筆、九宮差欄記 `"x"`。
`aggregateAi()` 依條件（桿距、同列、連線差、列距）分組，給每組的主角數 `n`（分母）、沒中數 `x`、各九宮差命中數。

回測時 `sweep()` 對每個上桿位置都會產生 entries（答案 = 下桿列真實開出）；
實際預測（下桿在空白期）時 `hits` 為 null，只留條件欄位，等機率模型查表。
測試檔用 2026-08-26 ~ 09-12 的實際 16 期資料驗證，標定結果與 App 截圖一致，
主角 05/06/25/35/28/29 的紀錄與手算相同。

## 差數ai統計（統計層）

`aiFieldStats(entries)` 把 16 次回測累積的紀錄集合起來，對五個記錄各自算次數分布：

- `count` / `prob`：這個值在「有中的紀錄」裡出現幾筆、佔幾成（九宮差 = x 的紀錄沒有第 4 個記錄，不進分母）。
- `subjects` / `hitSubjects` / `hitRate`：這個值出現過幾顆主角（含沒中）、其中幾顆有中、命中率。第 4 個記錄「九宮差」以主角總數當分母。
- `top`：出現最多筆的值（同分並列）。

`backtest()` 結果的 `aiFields` 就是這份統計；CLI `--ai` 會印出五個記錄各自的最高值與完整分布。

## 之後接機率邏輯的位置

1. **`opts.scorer(record, ctx)`**：每筆 record 算完後呼叫，回傳的物件會合併到 record。
   新的機率模型可以在這裡讀 `accCounts`、`contribs`、`hits`，寫回自己的分數。
2. **`contribs`** 已經把每一分的來源（偏移、往上第幾列、哪一欄）都留著，
   要按「偏移」「搜期」「間隔」分別統計命中率，直接從這裡分組即可。
3. **參數全部可調**：`span`（搜期 3~6）、`sweepCount`（掃幾個位置）、`offsetsChecked`（九宮拖牌打勾）、
   `intervals`（間隔打勾）、`windowSize`（畫面 16 期）、`spareRows`（備用列 16 期）、`steps`（回溯次數）。
   要比較不同設定的落差，用不同 opts 各跑一次 `backtest()` 比 `summary` 就行。

## 備用列

App 為了捲動回溯，在畫面 16+4 視窗上方常駐備好 16 期（備用列，視覺上看不到）。
回測時顯示區與備用列固定不動，下桿在顯示區裡從第 16 期上移到第 1 期；
上桿上方不足搜期的位置，直接往備用列讀取來標定與統計，不做任何顯示。
每筆 record 的 `spareRowsUsed` 記錄這次讀到顯示第 1 期之上幾列。

下桿上移到顯示第 1 期時最深：上桿 6 列 + 搜期 6 列 = 12 列，備用列 16 期足夠，
所以 16 次回測沒有任何位置會被略過。只有歷史資料真的比 32 期還少時才會略過，避免殘缺結果計入。
`steps` 超過 `windowSize` 會被截掉，下桿不會離開顯示區。

## 使用

```bash
npm test                                          # 跑測試
npm run cha-backtest -- --demo                    # 亂數資料試跑框架
npm run cha-backtest -- --file data/results.json  # 真實資料（[{date, numbers}]）
npm run cha-backtest -- --game lotto --span 5 --offsets -1,0,1,9,10,11
npm run cha-backtest -- --ai                      # 加印 差數ai統計 彙總
npm run cha-backtest -- --ai-detail               # 加印每一筆 [同列,連線差,列距,九宮差,桿距]
npm run cha-backtest -- --json > out.json         # 完整 record 輸出給後續邏輯用
```

瀏覽器內（之後要接回 App 時）：

```html
<script src="cha-backtest.js"></script>
<script>
  var data = ChaBacktest.fromRecords(EMBEDDED_DATA, { game: "539" });
  var result = ChaBacktest.backtest(data.rows, { game: "539" }, data.meta);
  console.log(result.summary);
</script>
```

## 與 App 的對照

| App 函式 | 這裡 |
|---|---|
| `calcNineGridDrag` | `nineGridDrag` |
| `runCModeChaSearch` | `markCha` |
| `computeCModeChaStatCounts` | `countCha` |
| `computeCModeTopRankList` | `topRankList` |
| `runCModeChaStatSweepThenShow` | `sweep` |
| 捲動區回溯 + 手動比對 | `backtest` |

規則細節（差值直接相減不繞圈、九宮拖牌超過球數才繞回、兩桿同組號碼可標定、
上下號碼相同的格子略過、偏移沒打勾就不標定也不計分）都照 App 現況移植，
測試檔裡有手算範例逐條驗證。
