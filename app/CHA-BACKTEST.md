# C式差數 回測框架

把「名揚四海彩卷系統」裡 C式差數的統計邏輯抽成不依賴畫面的純函式，
再往上架「回溯 16 次、每次上桿掃 6 個位置」的回測。
之後的「新計算機率邏輯」接在這個框架的輸出上，不用再碰 App 的 DOM 程式。

## 設計守則（不可變更）

C式差數的靈魂是這兩段，任何版本都不得更動，測試檔以截圖實際資料守著：

1. **九宮拖牌**（`nineGridDrag`）：固定 9 個偏移 −11、−10、−9、−1、0、+1、+9、+10、+11；超過球數才減球數，小於等於 0 才加球數。
2. **標定號碼**（`markCha`）：上桿與下桿同樣往上第 k1、k2 列、同樣欄位取兩顆，差值相等且落在九宮差內（並有打勾）才標定；差值直接相減不繞圈。

回測、五個記錄、統計層、預測計分都建立在這兩段之上，只能在「標定之後」動手，不能反過來改它們。

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

固定框架（跟 App 畫面一致，回測全程不動）；統一列號從備用列第一期 = 1 算起：
    備用列 = 第 1 ~ 32 列          rows[N-48 .. N-17]
    顯示區 = 第 33 ~ 48 列         rows[N-16 .. N-1]   （App 畫面的第 1 ~ 16 期）
    空白第 1 列 = 第 49 列         idx N               （App 畫面的第 17 列）

targetIdx = 預測期 N（下桿真正的位置）；預設 rows.length = 第 49 列
錨定期    = N-1（anchorRows = 1，不回測）
回溯區    = N-2 … N-17（16 次）

for t = 1 .. 16:
    lowerIdx = targetIdx - anchorRows - t   # 預測期第 49 列 → 錨定期第 48 列 → 回溯第 47..32 列
                                            # 這一期就是真實的果
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
| `t`, `lowerIdx`, `lowerRowNo`, `meta.date` | 第幾次回溯、下桿列索引、下桿統一列號、該期日期 |
| `upperPositions` | 這次實際掃到的上桿位置 |
| `earliestIdx`, `spareRowsUsed` | 這次最早讀到哪一列、其中幾列是畫面外的備用列（內部統計用） |
| `accCounts` | 6 個位置累計後的統計表（號碼 → 次數） |
| `steps[]` | 每個上桿位置各自的 `marked / pairs / counts / contribs` |
| `steps[].contribs[]` | 每一次加分的來源：`k`（往上第幾列）、`col`（欄）、`offset`（偏移）、`upper`、`lower`、`result` |
| `predicted`, `predictedNums` | 預期的果（含次數） |
| `actual`, `hits`, `hitCount` | 真實的果、命中號碼、命中顆數 |
| `expectedRandomHits` | 同樣顆數隨機挑的期望命中數（純機率基準） |

`summary` 給整體命中率、純機率基準與提升倍數；`frame` 給顯示區與備用列的索引與列號範圍、目標列號、回溯起訖列號、實際跑了幾次。
`rowNo(rows, idx)` / `idxOfRowNo(rows, no)` 在索引與統一列號之間換算。

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
`aggregateAi()` 依條件（桿距、同列、連線差、列距）分組，給每組有中的主角數 `n` 與各九宮差命中數。沒中（x）不列入。

回測時 `sweep()` 對每個上桿位置都會產生 entries（答案 = 下桿列真實開出）；
實際預測（下桿在空白期）時 `hits` 為 null，只留條件欄位，等機率模型查表。
測試檔用 2026-08-26 ~ 09-12 的實際 16 期資料驗證，標定結果與 App 截圖一致，
主角 05/06/25/35/28/29 的紀錄與手算相同。

## 差數ai統計（統計層）

`aiFieldStats(entries)` 把 16 次回測累積的紀錄集合起來，只取有中的紀錄（九宮差 = x 的不列入計算與排行），
對五個記錄各自算次數分布：

- `count` / `prob`：這個值在有中的紀錄裡出現幾筆、佔幾成。
- `top`：出現最多筆的值（同分並列）。

`backtest()` 結果的 `aiFields` 就是這份統計；CLI `--ai` 會印出五個記錄各自的最高值與完整分布。

## 預測下一期（predict）

```
1. backtest(rows)                      → 回溯 N-2..N-17 共 16 次，五個記錄的排行與百分比 aiFields
2. sweep(rows[0..targetIdx), targetIdx) → 下桿固定在預測期 N（預設第 49 列），上桿掃上 1..上 6
                                          標定連線 → 主角 entries（答案未知，hits = null，只有記錄 1/2/3/5）
3. 計分（依 predictMode）
4. 依分數排序，取前 predictTop 顆
```

預設計分規則 `predictMode = "anchor"`（錨定式，百分比相加）：

1. 每顆主角把第 1/2/3/5 個記錄的值到回溯排行查百分比，四個相加 = 主角分數。
2. 回溯第 4 個記錄排行取前 `predictOffsetTop`（預設 3）名九宮差。
3. 每顆主角各套這幾個九宮差，得到的號碼記到預測統計表，分數 = 主角分數 + 該九宮差的百分比；同一顆號碼累加。
   結果的 `anchor_` 給每顆主角的四個百分比、分數、套出的號碼，以及整張預測統計表 `table`。

`predictMode = "top"`（最高值篩選）：

1. 第 1/2/3/5 個記錄各取機率最高的值（同分並列都算）。
2. 每顆主角數四個條件有幾個落在最高值上，只留符合最多的那一群（全中優先，沒有就退到 3、2、1）。
3. 留下的主角先套第 4 個記錄機率最高的九宮差得到候選；候選不足 topN 顆時，依機率順序再套下一個九宮差補滿。
4. 候選分數 = 推到它的主角數，越早輪次的九宮差分數越高。
   結果的 `top_` 給最高值、符合幾個條件、留下幾顆主角、九宮差的輪次。

其他規則：

- `predictMode = "field"`：`score(號碼) += P1(同列) × P2(連線差) × P3(列距) × P5(桿距) × P4(九宮差)`，Pn 是該值在回測有中紀錄裡的機率。
- `predictMode = "condition"`：四個條件完全相同的歷史紀錄若存在，改用那一組裡各九宮差的命中率；沒有就退回 field。

回傳 `ranked`（每顆號碼的分數與來源：哪顆主角加哪個九宮差）、`top`、`topNums`；
目標列已開出時另附 `actual`、`hits`。
CLI：`--target 49`（統一列號，49 = 空白第 1 列、48 = 顯示區最後一期）、`--predict [N]`、`--predict-mode anchor|top|field|condition`、`--anchor-detail`。

## 滾動評估（cha-eval）

`app/cha-eval.js` 在真實資料上逐期預測、逐期對答案：對每個目標期 T，只餵 T 以前的資料
（框架跟著目標期走，T 就是空白第 1 列），取前 5 顆跟 rows[T] 比。所有變體用同一批目標期。

```bash
npm run cha-eval -- --file data/results.json          # 比較全部內建變體
npm run cha-eval -- --file x.json --from 60 --to 300 --top 5
```

輸出每個變體的命中/預測、命中率、相對純機率（5/39 = 12.8%）的提升倍數、至少中 1 顆的次數與隨機期望。
1385 次預測的純機率標準差約 ±0.9 個百分點；差異在 ±2 個百分點內都可能只是雜訊。
判斷有沒有訊號的方法：把期數順序打亂再跑一次，打亂後任何規律都應消失；若打亂後的命中率跟真實順序一樣，就是雜訊。

2026-09 用 App 內嵌的 325 期真實 539 資料（2025-08-07 ~ 2026-08-17，277 個目標期）評估的結果：
全部 20 個變體的命中率落在 10.0% ~ 13.7%，App 原邏輯 12.5%；把順序打亂 3 次，各變體同樣落在 12.0% ~ 14.4%。
結論：目前沒有任何變體在統計上超過純機率，變體之間的差異是雜訊。

anchor 模式的可調變體（給評估用，預設值就是使用者定義的規則）：
`anchorSubjectScore`（sum / product / none）、`anchorOffsetWeight`（add / mul / none）、
`anchorOffsetCond`（global / gap / rowDist / sameRow / linkDiff：九宮差排行只取同條件的歷史主角）、
`fieldCountMode`（records / subjects）、`predictOffsetTop`；`predictMode = "app"` 是 App 原本的 6 期掃描前二名。

## 之後接機率邏輯的位置

1. **`opts.scorer(record, ctx)`**：每筆 record 算完後呼叫，回傳的物件會合併到 record。
   新的機率模型可以在這裡讀 `accCounts`、`contribs`、`hits`，寫回自己的分數。
2. **`contribs`** 已經把每一分的來源（偏移、往上第幾列、哪一欄）都留著，
   要按「偏移」「搜期」「間隔」分別統計命中率，直接從這裡分組即可。
3. **參數全部可調**：`span`（搜期 3~6）、`sweepCount`（掃幾個位置）、`offsetsChecked`（九宮拖牌打勾）、
   `intervals`（間隔打勾）、`windowSize`（畫面 16 期）、`spareRows`（備用列 32 期）、`steps`（回溯次數）。
   要比較不同設定的落差，用不同 opts 各跑一次 `backtest()` 比 `summary` 就行。

## 備用列

App 為了捲動回溯，在畫面 16+4 視窗上方常駐備好備用列（視覺上看不到）；這裡預設 32 期，`spareRows` 可調。
回測時顯示區與備用列固定不動，下桿在顯示區裡從第 16 期上移到第 1 期；
上桿上方不足搜期的位置，直接往備用列讀取來標定與統計，不做任何顯示。
每筆 record 的 `spareRowsUsed` 記錄這次讀到顯示第 1 期之上幾列。

下桿上移到顯示第 1 期時最深：上桿 6 列 + 搜期 6 列 = 12 列，備用列 32 期綽綽有餘，
所以 16 次回測沒有任何位置會被略過。只有歷史資料真的比 32 期還少時才會略過，避免殘缺結果計入。
回測起點跟著預測目標列走（目標列 − 1 往上 16 次），目標在第 48 列時最後一次回溯落在第 32 列，也就是備用列最後一期，仍然夠用。

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
