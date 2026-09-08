/* 抓牌 PWA service worker
   策略：index.html 用「網路優先、離線才用快取」（確保每次上線都拿到最新版程式）；
   manifest／圖示用「快取優先」；跨網域請求（GitHub raw 的 data.json 等）一律不攔、不快取。
   要強制所有裝置更新時，改下面的 CACHE 版本字串即可。 */
const CACHE = "zhuapai-v1";
const SHELL = ["./", "./index.html", "./manifest.json",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png",
  "./icons/icon-192-maskable.png", "./icons/icon-512-maskable.png"];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener("fetch", function (e) {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; /* 跨網域(雲端資料)不攔 */
  const isShellPage = url.pathname.endsWith("/") || url.pathname.endsWith("/index.html");
  if (isShellPage) {
    e.respondWith(fetch(req).then(function (res) {
      const copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); return res;
    }).catch(function () { return caches.match(req).then(function (r) { return r || caches.match("./index.html"); }); }));
    return;
  }
  e.respondWith(caches.match(req).then(function (r) { return r || fetch(req).then(function (res) {
    const copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); return res; }); }));
});
