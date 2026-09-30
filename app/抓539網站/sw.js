/* 抓539 離線背景程式(service worker)
   2026-09-30 19:48 使用者回報「已經上傳新版，舊版卻沒有更新提示」而改寫：
   ・網頁(index.html)與版本檢查一律「先上網抓最新」，抓不到(沒網路)才用手機裡存的，不會再因為快取拿到舊版而收不到更新提示。
   ・版本檢查只讀檔案開頭(Range)，這種請求直接上網，不存進快取。
   ・圖示、manifest.json 等其他檔案：先用手機裡的(開得快)，同時在背景更新。
   ・換上新版 sw.js 後立刻接管所有畫面(skipWaiting + clients.claim)，並刪掉舊版快取。
   以後修改這個檔案時把 CACHE 的版本號加 1。 */
const CACHE = "zhua539-v3";
const CORE = ["./", "./index.html", "./manifest.json", "./icon-192.png", "./apple-touch-icon.png"];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      /* 逐一存，某個檔案不存在(例如沒有上傳圖示)也不會讓整個安裝失敗 */
      return Promise.all(CORE.map(function (u) {
        return fetch(u, { cache: "no-store" }).then(function (r) { if (r.ok) return c.put(u, r); }).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

function isPage(req) {
  if (req.mode === "navigate") return true;
  const u = new URL(req.url);
  return u.origin === location.origin && (/\/$/.test(u.pathname) || /\.html?$/.test(u.pathname));
}

self.addEventListener("fetch", function (e) {
  const req = e.request;
  if (req.method !== "GET") return;
  const u = new URL(req.url);
  if (u.origin !== location.origin) return; /* 雲端資料等外部網址不經過這裡 */

  /* 版本檢查(只讀開頭幾 KB，或網址帶 _v= / u=)：直接上網，不用也不存快取 */
  if (req.headers.has("range") || u.searchParams.has("_v") || u.searchParams.has("u")) {
    e.respondWith(fetch(req, { cache: "no-store" }).catch(function () { return caches.match(req, { ignoreSearch: true }); }));
    return;
  }

  /* 網頁：先上網抓最新，成功就順便更新手機裡的；沒網路才用手機裡的 */
  if (isPage(req)) {
    e.respondWith(
      fetch(req, { cache: "no-store" }).then(function (r) {
        if (r && r.ok) { const copy = r.clone(); caches.open(CACHE).then(function (c) { c.put("./index.html", copy); }); }
        return r;
      }).catch(function () {
        return caches.match(req, { ignoreSearch: true }).then(function (m) { return m || caches.match("./index.html"); });
      })
    );
    return;
  }

  /* 其他檔案(圖示、manifest.json)：先用手機裡的，同時在背景更新 */
  e.respondWith(
    caches.match(req).then(function (m) {
      const net = fetch(req).then(function (r) {
        if (r && r.ok) { const copy = r.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
        return r;
      }).catch(function () { return m; });
      return m || net;
    })
  );
});
