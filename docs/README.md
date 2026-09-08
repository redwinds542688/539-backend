# 抓牌 網址版（PWA）

這個資料夾是 GitHub Pages 的發佈根目錄。

- `index.html`：與 `../app/抓牌.html` 完全相同的副本。**每次更新 app/抓牌.html 後，記得複製一份過來**（`cp app/抓牌.html docs/index.html`）。
- `manifest.json`：App 名稱「抓牌」、直向、standalone（沒有瀏覽器網址列）。
- `sw.js`：離線快取。index.html 網路優先（上線就拿最新版），圖示快取優先，雲端 data.json 等跨網域請求不攔。要強制所有手機更新時改 `CACHE` 版本字串。
- `icons/`：由使用者提供的「手抓 539彩球」圖產生：192／512（any）、192／512（maskable，四周留 10% 安全區）、apple-touch-icon 180。

## 啟用步驟（只要做一次）

GitHub → 這個 repo → Settings → Pages → Build and deployment：
Source 選「Deploy from a branch」，Branch 選放這個資料夾的分支、Folder 選 `/docs`，Save。

幾分鐘後網址是：`https://redwinds542688.github.io/539-backend/`

## 手機安裝

用 Chrome 開上面的網址 → 右上「⋮」→「加到主畫面」（或「安裝應用程式」）→ 主畫面就會出現 539彩球圖示，點開沒有網址列。
iPhone 用 Safari → 分享 → 加入主畫面。

## 注意

- 網址版與 `content://` 本機檔案版是不同來源，localStorage／IndexedDB 不共用：標記、設定、手動輸入的資料不會自動搬過來；開獎資料由內嵌資料＋GitHub 雲端同步補齊。
- service worker 只在 https 下註冊（程式已判斷），本機 `content://` 開啟不受影響。
