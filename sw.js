/* InglesDux · service worker */
var VERSION = "duxlingo-v77";
var SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icons/dux/icon-192.png", "./icons/dux/icon-512.png", "./icons/logo.png", "./icons/dux/apple-touch-icon.png", "./img/mascota.webp", "./img/bienvenida.webp", "./audio/success.mp3", "./audio/error.mp3", "./img/avatar-nino.jpg", "./img/gatito.jpg"];
self.addEventListener("install", function (e) { e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); })); });
self.addEventListener("activate", function (e) { e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k.indexOf("duxlingo-") === 0 && k !== VERSION; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); })); });
self.addEventListener("fetch", function (e) {
  var req = e.request; if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin && url.hostname.indexOf("fonts.") === -1 && url.hostname !== "cdnjs.cloudflare.com") return;
  if (req.mode === "navigate" || url.pathname.endsWith(".html")) {
    e.respondWith(fetch(req).then(function (r) { var c = r.clone(); caches.open(VERSION).then(function (x) { x.put(req, c); }); return r; })
      .catch(function () { return caches.match(req).then(function (r) { return r || caches.match("./index.html"); }); }));
    return;
  }
  e.respondWith(caches.match(req).then(function (hit) { return hit || fetch(req).then(function (r) { if (r.ok) { var c = r.clone(); caches.open(VERSION).then(function (x) { x.put(req, c); }); } return r; }); }));
});
