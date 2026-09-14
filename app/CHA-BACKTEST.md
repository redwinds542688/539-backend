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
錨定期    = N（就是下桿所在的預測期；anchorRows 預設 0）
回溯區    = N-1 … N-16（16 次）

for t = 1 .. 16:
    lowerIdx = targetIdx - anchorRows - t   # 下桿第 48 列 → 錨定期第 48 列 → 回溯第 47..32 列
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
1. backtest(rows)                      → 回溯 N-1..N-16 共 16 次，五個記錄的排行與百分比 aiFields
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

桿距分開統計（巧合法）`anchorStatsCond`（預設 `"global"`）：

- 設成 `"gap"` 時，回溯 16 次的主角先依桿距分桶，每顆即時主角只用「同桿距」的回溯主角算五個記錄的百分比與九宮差前三名：
  差 6 只計算差 6 的，差 5 只計算差 5 的。同桶沒有任何命中紀錄才退回全體統計（`bucket.fallback = true`）。
- 也可以給欄位陣列，例如 `["gap", "rowDist"]`（桿距與列距都相同才算同桶）、四欄全給就是「四個記錄完全相同才算」的完全巧合。
- 九宮差排行的取樣範圍另有 `anchorOffsetCond`（只分開九宮差排行，記錄 1/2/3/5 仍用全體）；同時設定時以 `anchorOffsetCond` 的排行為準。
- `anchor_.subjects[i].bucket` 給每顆主角的桶鍵、桶內主角數、有中主角數、是否退回全體；CLI 用 `--stats-cond gap`（可逗號串多欄）。

九宮差比對表（`backtest().offsetByPairDiff`，`offsetCrossTable(entries, "pairDiff")`）：

- 依標定連線的九宮差（`pairDiff`，例 +11 的兩個標定號碼）分組，數每組主角「加哪個九宮差會中」：
  命中主角數、命中率（命中主角數 / 該組主角數，純機率約 5/39 = 12.8%）、最常中的九宮差。CLI `--ai` 會印出來。
- 要拿來預測：`anchorOffsetCond: "pairDiff"`（每顆主角只套同 pairDiff 歷史主角最常中的九宮差）或 `anchorStatsCond: "pairDiff"`。
- 分組欄位可換成 gap / rowDist / sameRow / linkDiff。

`predictMode = "gapvote"`（桿距投票）：

1. 差 6 統計差 6 的、差 5 統計差 5 的 … 差 1 統計差 1 的：每個桿距各自用同桿距的回溯主角做五個記錄的統計，
   套到同桿距的即時主角（anchor 的算法），得到一份預測表，最多 6 份。回溯裡該桿距沒有命中紀錄的表空白。
2. 6 份表比：哪一號出現的份數最多就取哪一號；份數相同時用各表分數總和排先後。
3. `gapVoteTop`（預設 null）限制每份表只拿前幾顆投票。結果的 `gapvote_` 給每份表的主角數、九宮差前三名、表內號碼，以及每號的份數。
   CLI：`--predict-mode gapvote --vote-top 5`。

`predictMode = "records"`（紀錄法，使用者 2026-09-14 定義；回溯紀錄 `upperRecords`）：

1. 回溯每一次、每個桿差，以每一顆「上桿側標定號碼」記四個紀錄：
   紀錄 1 桿距（上桿在下桿上幾期）、紀錄 2 位置（標定號碼在上桿上幾期）、
   紀錄 3 標定號碼加哪個九宮差落在上桿那一列、紀錄 4 對應下桿號碼（同 k 同欄）加哪個九宮差落在下桿那一列（真實的果）。
   紀錄 3 命中 m 個、紀錄 4 命中 n 個 → m×n 筆；任一邊沒命中整筆不記；上下桿同號（回音）照記。
2. 預測：每顆即時上桿標定號碼拿 (紀錄 1, 2, 3) 到回溯紀錄找三個都相同的，取紀錄 4 出現最多的九宮差（同樣最多全取），
   套到對應下桿號碼，存進 39 格統計表（次數 +1）。上桿沒命中、或回溯找不到相同的，不預測。
3. `upperIdx` 指定真正的上桿位置就只用那一個位置；不指定就 6 期掃描的位置都用。
   CLI：`--records`（列出全部回溯紀錄）、`--predict --predict-mode records --upper 43`。

其他規則：

- `predictMode = "field"`：`score(號碼) += P1(同列) × P2(連線差) × P3(列距) × P5(桿距) × P4(九宮差)`，Pn 是該值在回測有中紀錄裡的機率。
- `predictMode = "condition"`：四個條件完全相同的歷史紀錄若存在，改用那一組裡各九宮差的命中率；沒有就退回 field。

回傳 `ranked`（每顆號碼的分數與來源：哪顆主角加哪個九宮差）、`top`、`topNums`；
目標列已開出時另附 `actual`、`hits`。
CLI：`--target 49`（統一列號，49 = 空白第 1 列、48 = 顯示區最後一期）、`--predict [N]`、`--predict-mode anchor|top|field|condition|app`、`--anchor-detail`、`--stats-cond gap`。

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

以下各表都是在舊定義（anchorRows = 1，回溯 N-2 … N-17）下跑的；現行定義（錨定期 = N，回溯 N-1 … N-16）
對應第一張表的「錨定期也回測」那一列（11.4%），其餘變體換成現行定義後的數字量級相同。

2026-09 用 App 內嵌的 325 期真實 539 資料（2025-08-07 ~ 2026-08-17，277 個目標期）評估的結果：
全部 20 個變體的命中率落在 10.0% ~ 13.7%，App 原邏輯 12.5%；把順序打亂 3 次，各變體同樣落在 12.0% ~ 14.4%。
結論：目前沒有任何變體在統計上超過純機率，變體之間的差異是雜訊。

同一批資料再加「巧合法」（`anchorStatsCond`，回溯 16 期但統計依桿距分開）的 8 個變體：

| 變體 | 真實順序 | 亂序 ×3 |
| --- | --- | --- |
| 桿距分開統計（差 6 只算差 6） | 12.1% | 11.9% ~ 14.0% |
| 桿距 + 列距分開 | 11.5% | 13.7% ~ 14.7% |
| 桿距 + 同列分開 | 12.6% | 11.6% ~ 13.1% |
| 桿距 + 連線差分開 | 11.4% | 11.4% ~ 13.2% |
| 四記錄完全相同才算（完全巧合） | 13.4% | 13.6% ~ 14.2% |
| 桿距分開 + 九宮差前 1 | 12.7% | 12.7% ~ 14.2% |
| 桿距分開 + 只看九宮差 | 11.6% | 12.0% ~ 14.4% |
| 桿距分開 + 回溯 32 次 | 12.5% | 12.8% ~ 14.1% |

真實順序沒有一個高過亂序，分桶越細（桶內只剩幾筆）數字越飄，仍是雜訊。

再加「比對法」（依標定連線的九宮差 pairDiff 分組，看 +11 的標定往往加哪個九宮差會中）的 6 個變體：

| 變體 | 真實順序 | 亂序 ×3 |
| --- | --- | --- |
| 九宮差依 pairDiff 排行 | 13.1% | 11.6% ~ 13.8% |
| pairDiff 排行 + 不看主角分數 | 13.5% | 12.1% ~ 13.3% |
| pairDiff 排行前 1 + 不看主角分數 | 12.8% | 12.9% ~ 13.3% |
| pairDiff 整套分開統計 | 13.6% | 12.2% ~ 13.1% |
| pairDiff + 桿距分開統計 | 12.6% | 12.0% ~ 13.1% |
| pairDiff 排行 + 回溯 32 次 | 12.0% | 12.2% ~ 13.6% |

325 期全部回測的比對表本身：9 組 × 9 個九宮差共 81 格，命中率落在 10% ~ 17%，
最高的一格（pairDiff 0 加 −11，17%）在亂序資料的比對表裡也會出現同樣高的格子（亂序最高 16% ~ 17%）。
同一顆主角在同一個目標期會被不同上桿位置、不同連線重複計到，格子的有效樣本數比顯示的主角數小很多，所以格子之間的高低是雜訊。

再加「桿距投票」（`predictMode = "gapvote"`，6 份桿距表比份數）的 8 個變體：

| 變體 | 真實順序 | 亂序 ×3 |
| --- | --- | --- |
| 6 份表全部號碼投票 | 11.3% | 13.2% ~ 13.7% |
| 每份表前 3 顆投票 | 11.8% | 11.8% ~ 14.0% |
| 每份表前 5 顆投票 | 11.0% | 12.9% ~ 13.6% |
| 每份表前 10 顆投票 | 10.8% | 12.6% ~ 14.2% |
| 前 5 顆 + 不看主角分數 | 12.0% | 12.5% ~ 14.2% |
| 前 5 顆 + 九宮差前 1 | 12.9% | 12.1% ~ 14.1% |
| 前 5 顆 + 九宮差全部 9 | 11.4% | 11.8% ~ 14.8% |
| 前 5 顆 + 回溯 32 次 | 12.6% | 12.3% ~ 13.0% |

真實順序全部落在或低於亂序範圍，份數最多的號碼並沒有比較常開出。

紀錄法（`predictMode = "records"`）用 Lottery-database 的 348 期真實資料（2025-08-07 ~ 2026-09-12，300 個目標期，
上桿 6 個位置都掃、每期取 5 顆）：

| 變體 | 真實順序 | 亂序 ×3 |
| --- | --- | --- |
| 紀錄法 回溯 16 次 | 11.7% | 13.1% ~ 14.5% |
| 紀錄法 回溯 32 次 | 11.5% | 12.7% ~ 13.7% |
| 紀錄法 回溯 64 次 | 12.5% | 12.2% ~ 13.4% |
| App 原邏輯（同一批資料） | 13.1% | 12.2% ~ 14.2% |

三個紀錄都要相同，808 筆回溯裡通常只找到 1 到 3 筆，紀錄 4 的「最多」多半是 1 筆對 1 筆的平手；真實順序沒有高過亂序。

anchor 模式的可調變體（給評估用，預設值就是使用者定義的規則）：
`anchorSubjectScore`（sum / product / none）、`anchorOffsetWeight`（add / mul / none）、
`anchorOffsetCond`（global / gap / rowDist / sameRow / linkDiff：九宮差排行只取同條件的歷史主角）、
`anchorStatsCond`（global / 欄位名 / 欄位陣列：整套統計依該記錄分桶，差 6 只算差 6 的）、
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
npm run cha-backtest -- --ai                      # 加印 差數ai統計 彙總與九宮差比對表
npm run cha-backtest -- --ai-detail               # 加印每一筆 [同列,連線差,列距,九宮差,桿距]
npm run cha-backtest -- --anchor-detail --stats-cond gap   # 預測：桿距分開統計，並列出每顆主角用的桶
npm run cha-backtest -- --predict 5 --predict-mode gapvote --vote-top 5   # 預測：6 份桿距表投票
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

## 接進 App（長按 Ai 鍵）

`app/名揚四海彩卷系統-紀錄法.html` = 使用者 2026-09-13 上傳的 App 原檔 + 三處改動（原檔其餘一字不動）：

1. 第一個 `<script>` 前內嵌整個 `cha-backtest.js`（`window.ChaBacktest`），App 在手機上是單一檔案，不能外連 js。
2. C 式閉包裡（`attachCSubModeLongPress(fullBtn, …)` 之後）加 `window.__chaRecordsPredictShow`：
   讀 `findCModeTargetRows()` 的 A/B 列日期、`currentAllData`、搜期、九宮拖牌打勾、間隔打勾，
   呼叫 `ChaBacktest.appPredict()`，把 39 格統計表用 `renderCModeDingStatGridContent` 畫成「差數 紀錄法 統計表（長按Ai）」，
   下面附每顆上桿標定號碼的查找明細；B 已開出時附真實的果與命中。
3. Ai 鍵長按：C 式 + 差數定位中 → 跑紀錄法；其他子模式維持原本的第四顆長按（搜期 3→6）。非 C 式照舊開檢視器。
4. 統計表開出的同時，把最高排行前五名（次數多在前、同次數號碼小在前，取 5 顆；2026-09-14 由 3 改 5）直排顯示在左側 Ai 欄
   （`#c-ding-ai-box`，彩球圖下方，每格一列高、底色依次數、左上角次數角標）；關統計表或退出 C 式就清掉。
   統計表本身只有標題與 39 格，沒有文字說明。
5. `aiArm()` 不再把 `period-btn` 的 armed 熄掉：那顆的 armed 是「定期十六」的旗標，`__reapplyMagnifierState()` 在切回 App 重畫後用它反推
   recentOnly；長按 Ai 熄掉它之後一切回 App，四欄會全部攤開、16+4 壓縮套在四欄上（使用者回報「畫面都亂了」，版面監視記錄與模擬器都重現）。
   這是 App 原本雙擊/長按 Ai 就有的潛在問題，這裡一併修掉。
6. 「差數 同差法 統計表」（使用者 2026-09-14 指示）：上桿標定號碼加哪個九宮差落在上桿列（可能不只一個），對應下桿號碼就加同一個九宮差，
   上桿差 6 到差 1 全部累計（= App 原本 computeCModeChaStatCounts 的 6 期掃描；模組 `appSameOffset`，不跑回溯）。
   **單擊「差數」鍵**開這張表（再單擊關），前三名（照 App 前幾名的定義：次數最高的三個名次、同次數並列都算、次數必須大於 1、最多 15 顆）用 App 原本的填空白格機制填進下方空白期；
   **長按 Ai** 只開紀錄法那張表，但空白期照樣填同差法前三名；**雙擊 Ai**（差數定位中）等同單擊差數：開同差法統計表並填空白期前三名。兩張表互斥（開一張就關另一張）；退出 C 式全部關；
   移動桿子時開著的那張歸零、落定後重算同一張。
7. 統計表開著時移動上下桿：拖曳開始就把 39 格歸零、Ai 欄清空（`window.__chaRecordsReset`），
   桿子落定後（App 原本重算掃描表的同一個地方）自動再跑一次長按 Ai 的功能。
8. 號碼在格子裡置中（使用者 2026-09-14 指示「不管是什麼字體、螢幕顯示還是存圖檔，號碼都必須在格子裡置中」）：
   App 原本靠手調的 `.cell-shift{transform:translate(百分比)}` 逐一補償，換字體就偏掉；存圖時 `textBaseline="middle"` 畫在 span 盒子中心也會隨字體偏。
   改成量字形墨跡：canvas `measureText` 的 `actualBoundingBox*`（用 200px 量再等比縮回，避開小字級的整數化；量前把 textAlign/textBaseline 歸零）
   算出真正的墨跡框，把墨跡中心對到格子 padding box（格線之間）的中心。
   - 畫面：新加的全域 `<script>` 對 `table.road` 的 `td.num` / 非月初 `td.day` 裡的 `.cell-shift` 以 inline `transform:translate(px)` 修正（保留 CSS 原本的 scale），
     表格重畫、body class 改變（定期模式、字體、色系、放大鏡）、字型載入完成、視窗尺寸改變時重算；祖先縮放用整張表格的尺寸估（小格子的整數 offsetWidth 誤差太大）。
   - 存圖：body 帶 `capturing-*` 時先清掉 inline 修正（文字透明、由 canvas 補畫）；三處 `fillText`（一般格、點擊圈、C 式標定圈）都改 `fillTextInkCentered()`。
     定期/C 式截圖原本是讓 html2canvas 原生排字再用 `capturing-plain` 的手調偏移補償，現在 `td.num` / `td.day` 的號碼也改成 canvas 補畫（重新標定之後才收集、顏色取當下 computed、畫完還原）。
   - 模擬器量測（scratchpad `pw/center.js`，墨跡中心對格線內緣中心，CSS px）：存圖 539/六合彩 平均偏移 0.0～0.4、最大 1.0 以內（改前約 1 px、且隨字體變）；
     螢幕在放大鏡 2.3 倍下逐列有 ±1 px 的像素貼齊殘差（瀏覽器排字的整數貼齊），正常倍率看不出來。
9. 格子完整（使用者 2026-09-14 指示「任何標定號碼/指定號碼/上下桿/連線顯示與存檔都要保持格子完整不被破壞」）。
   全程式盤點會改到格子邊框/尺寸的地方，用模擬器逐格比對 rect、四邊框寬、outline、box-shadow（scratchpad `pw/grid.js`，情境：首頁無標記、
   首頁點擊/拖曳標記+連線、C 式差數/合匯/定位、E 式等距；`pw/emode.js`、`pw/hecrop.js` 另做 E 式與合匯的畫面/存圖裁圖）：
   - 合匯上桿列真實命中格：原本加四條 1.5px 邊框（顏色同底色、看不見），會把格線推歪、格子縮小 → 所有模式一律不加（之前只在差數不加）。
   - 合匯下桿指定格：原本用 1.5px 邊框畫上下框線 → 改成格內絕對定位的 `<i class="c-mode-he-b-ring">`（CSS 畫上下/兩端線），td 的 border 不動；
     換指定格、清 C 式著色時一併移除。截圖由 html2canvas 原生畫出，跟畫面一致。
   - 截圖：`c-mode-ab-suppress-circle` 的格子（合匯上/下桿指定格等）畫面上只有底色不畫圈，存圖原本仍畫圈（直徑 1.1 倍格高、蓋到格線）→ 比照畫面不畫。
   - 保留不動（都是原設計、不改變格子位置）：拖曳標記的 0.5px 邊框+0.7px 外框（框線顏色蓋在格線上）、點擊/標定圓圈（1.1 倍格高）、
     上下桿列與週起始列的 inset 陰影線、空白期外框（1px）、C 式最後一列的白色遮蓋列（border:none）、連線 SVG。
   稽核結果：各情境所有格子的 rect 對齊（左右/上下偏差 <0.15px），除遮蓋列外沒有任何格子的邊框寬度跟同表其他格子不同，沒有 outline（拖曳標記除外）。

App 目前用 `sweepAll: true`（使用者 2026-09-14 指示「上下桿差 6 到 1 都要加入統計」）：上桿差 1 到差 6 各跑一次紀錄法，
全部累進同一張 39 格表，畫面上的 A 位置不影響結果，只有 B 決定預測期。回溯次數 `steps: 100`、備用列 `spareRows: 96`（使用者 2026-09-14 指示；16+96 = 112 列，回溯第 100 次差 6 的上桿往上搜 6 期剛好到備用列第 1 期）；CLI 與模組預設仍是 16，用 `--steps 7` 可對照。

`appPredict({records, upperDate, lowerDate, blanksBelow, sweepAll, game, span, offsetsChecked, intervals})`：
B 在空白列時用 `blanksBelow`（B 在最後一期下面第幾列）換算 `targetIdx`；上桿不在已開出的期、上下桿距離超過 6、上桿上面不足搜期都回 `error`。
`test/cha-backtest.test.js` 有對應測試；scratchpad 的 Playwright 冒煙測試確認頁面載入無錯誤、模組與掛勾存在、用 App 內嵌資料能跑出統計表。

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
