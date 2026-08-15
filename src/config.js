module.exports = {
  outputPath: "../data/results.json",
  keepLatest: 400,

  // 排程時間是「台灣時間」。
  // 原本沒有指定時區，node-cron 預設跟著容器走，而 Railway 的容器
  // 預設是 UTC——"45 20 * * *" 原意是台灣晚上 8:45（539 晚上 8:30
  // 開獎後 15 分鐘），在 UTC 下實際會變成台灣時間隔天凌晨 4:45 才跑，
  // 整整晚了 8 小時。加上 cronTimezone 之後才會真的在開獎後執行。
  cronSchedule: [
    "45 20 * * *",
    "35 21 * * *",
    "40 21 * * *",
    "45 21 * * *",
    "0 22 * * *",
  ],
  cronTimezone: "Asia/Taipei",

  requestTimeoutMs: 30000,

  // 交叉比對門檻：至少要有幾個來源回報「同一期、同一組號碼」才寫入。
  //
  // 原本的設定是 requireAllThreeMatch:true，也就是「3 個來源全部一致」。
  // 現在來源變成 4 個（新增雲端資料庫），沿用「全部一致」會變成任何
  // 一個來源掛掉就整批不更新，太脆弱；設成 3 則是「4 個裡面至少 3 個
  // 一致」，嚴格程度跟原本相當（都要 3 個獨立來源背書），但容許其中
  // 一個來源暫時失效。
  // 想更保守可以改成 4（全部一致），想更寬鬆可以改成 2。
  minAgreeingSources: 3,

  // 每個來源的重試次數（只對網路層／5xx 這類暫時性錯誤重試，
  // 版型改版造成的解析失敗不重試）。
  fetchAttempts: 3,

  apiPort: process.env.PORT || 3939,

  // 樂透雲端資料庫（唯一有完整歷史的地方，由使用者電腦上的
  // lottery_scraper.py 負責寫入，這個服務只讀不寫）。
  cloudDb: {
    baseUrl: "https://hearty-vitality-production-0687.up.railway.app/draws",
    game: "今彩539",
    // 開機時要從雲端拉回多少期來重建 data/results.json。
    // Railway 的容器檔案系統是暫時性的，每次重新部署檔案就消失，
    // 靠這一步才能讓檔案立刻恢復完整歷史，而不是從零開始一天累積一筆。
    seedLimit: 400,
    // 是否把雲端資料庫也當成第 4 個交叉比對來源。
    useAsSource: true,
    // 是否在開機時、以及每次排程執行後，從雲端補齊歷史。
    seedOnStart: true,
  },
};
