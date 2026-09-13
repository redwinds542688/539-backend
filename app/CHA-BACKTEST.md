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

for t = 1 .. 16:                       # 回溯 16 次
    lowerIdx = rows.length - t         # 下桿放在倒數第 t 期，這一期就是真實的果
    for upperIdx = lowerIdx-6 .. lowerIdx-1:   # 上桿掃 6 個位置（App 的 6期掃描）
        上桿上方不足 搜期 列 → 往畫面外的備用列讀（不顯示、只統計）
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

`summary` 給整體命中率、純機率基準與提升倍數。

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
回測時上桿上方不足搜期的位置，直接往備用列讀取來標定與統計，不做任何顯示；
每筆 record 的 `spareRowsUsed` 記錄這次用了幾列備用列。
只有連備用列都補不滿整整搜期列（歷史資料真的不存在）的位置才略過，避免殘缺結果計入。

## 使用

```bash
npm test                                          # 跑測試
npm run cha-backtest -- --demo                    # 亂數資料試跑框架
npm run cha-backtest -- --file data/results.json  # 真實資料（[{date, numbers}]）
npm run cha-backtest -- --game lotto --span 5 --offsets -1,0,1,9,10,11
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
