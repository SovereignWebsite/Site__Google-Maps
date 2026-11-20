// Directions, and the cameras on the way.
// Google is loaded only when the visitor asks for a route. The cameras come from
// this site's own cameras.json; a camera's picture is fetched from its operator
// only when the visitor presses Play.
(function () {
  "use strict";
  var NEAR_M = 150;
  var cfg = window.SITE_CONFIG || {};
  var key = typeof cfg.googleMapsKey === "string" ? cfg.googleMapsKey.trim() : "";
  var form = document.getElementById("route-form");
  var status = document.getElementById("status");
  var results = document.getElementById("results");
  var list = document.getElementById("cameras");
  var mapEl = document.getElementById("map");
  var camerasPromise = null;
  var googlePromise = null;
  var map = null, renderer = null, markers = [];

  function say(text) { status.textContent = text; }

  if (!key) {
    document.getElementById("no-key").hidden = false;
    Array.prototype.forEach.call(form.elements, function (el) { el.disabled = true; });
    return;
  }

  function loadCameras() {
    if (!camerasPromise) {
      camerasPromise = fetch("cameras.json").then(function (r) {
        if (!r.ok) throw new Error("cameras.json " + r.status);
        return r.json();
      });
    }
    return camerasPromise;
  }

  function loadGoogle() {
    if (!googlePromise) {
      googlePromise = new Promise(function (resolve, reject) {
        window.__mapsReady = function () { resolve(window.google.maps); };
        var s = document.createElement("script");
        s.src = "https://maps.googleapis.com/maps/api/js?key=" + encodeURIComponent(key) +
          "&callback=__mapsReady&loading=async&language=en-GB";
        s.async = true;
        s.onerror = function () { reject(new Error("Google Maps did not load")); };
        document.head.appendChild(s);
      });
    }
    return googlePromise;
  }

  // Distance in metres from point p to segment a-b, on a local flat projection.
  function toXY(lat, lon, lat0) {
    var k = 111320;
    return [lon * k * Math.cos(lat0 * Math.PI / 180), lat * k];
  }
  function segDist(p, a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1];
    var len2 = dx * dx + dy * dy;
    var t = len2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    var x = a[0] + t * dx - p[0], y = a[1] + t * dy - p[1];
    return { d: Math.sqrt(x * x + y * y), t: t, len: Math.sqrt(len2) };
  }

  function camerasOnRoute(path, cameras) {
    var lat0 = path[0].lat;
    var pts = path.map(function (q) { return toXY(q.lat, q.lng, lat0); });
    var minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    path.forEach(function (q) {
      minLat = Math.min(minLat, q.lat); maxLat = Math.max(maxLat, q.lat);
      minLng = Math.min(minLng, q.lng); maxLng = Math.max(maxLng, q.lng);
    });
    var pad = 0.003;
    var found = [];
    cameras.forEach(function (c) {
      if (c.lat < minLat - pad || c.lat > maxLat + pad || c.lon < minLng - pad * 2 || c.lon > maxLng + pad * 2) return;
      var p = toXY(c.lat, c.lon, lat0);
      var best = { d: Infinity, along: 0 }, run = 0;
      for (var i = 1; i < pts.length; i++) {
        var s = segDist(p, pts[i - 1], pts[i]);
        if (s.d < best.d) best = { d: s.d, along: run + s.t * s.len };
        run += s.len;
      }
      if (best.d <= NEAR_M) found.push({ cam: c, d: best.d, along: best.along });
    });
    found.sort(function (a, b) { return a.along - b.along; });
    return found;
  }

  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (text) e.textContent = text;
    return e;
  }

  function safeUrl(u) {
    try { var x = new URL(u); return x.protocol === "https:" ? x.href : null; } catch (e) { return null; }
  }

  function render(found, data) {
    list.textContent = "";
    if (!found.length) {
      list.appendChild(el("li", {}, "No camera in our list is within " + NEAR_M + " m of this route. Most cameras with exact positions are in London."));
      return;
    }
    found.forEach(function (f, i) {
      var c = f.cam, op = data.operators[c.operator] || {};
      var li = el("li", { "class": "cam" });
      li.appendChild(el("h3", {}, (i + 1) + ". " + c.name));
      li.appendChild(el("p", { "class": "meta" }, (f.along / 1000).toFixed(1) + " km along the route, " + Math.round(f.d) + " m from it. " + c.operator + "."));
      var url = safeUrl(c.url);
      if (c.how === "embed" && url) {
        var btn = el("button", { type: "button", "class": "play" }, "Play this camera");
        btn.addEventListener("click", function () {
          var v = el("video", { controls: "", playsinline: "", muted: "", autoplay: "", preload: "none" });
          var poster = c.poster && safeUrl(c.poster);
          if (poster) v.setAttribute("poster", poster);
          v.muted = true;
          v.src = url;
          btn.replaceWith(v);
        });
        li.appendChild(btn);
      } else if (url) {
        li.appendChild(el("p", {}, "")).appendChild(el("a", { href: url, rel: "noopener", target: "_blank" }, "Watch on the operator's own page"));
      }
      if (op.credit) li.appendChild(el("p", { "class": "credit" }, op.credit));
      var terms = op.terms && safeUrl(op.terms);
      if (terms) li.appendChild(el("p", { "class": "credit" })).appendChild(el("a", { href: terms, rel: "noopener", target: "_blank" }, "The operator's terms"));
      list.appendChild(li);
    });
  }

  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var from = form.elements.from.value.trim(), to = form.elements.to.value.trim();
    if (!from || !to) { say("Please type both addresses."); return; }
    say("Asking Google for the route...");
    Promise.all([loadGoogle(), loadCameras()]).then(function (r) {
      var gm = r[0], data = r[1];
      if (!map) {
        mapEl.hidden = false;
        map = new gm.Map(mapEl, { center: { lat: 51.5072, lng: -0.1276 }, zoom: 11 });
        renderer = new gm.DirectionsRenderer({ map: map });
      }
      return new gm.DirectionsService().route({ origin: from, destination: to, travelMode: gm.TravelMode.DRIVING })
        .then(function (res) {
          renderer.setDirections(res);
          var path = res.routes[0].overview_path.map(function (q) { return { lat: q.lat(), lng: q.lng() }; });
          var found = camerasOnRoute(path, data.cameras);
          markers.forEach(function (m) { m.setMap(null); });
          markers = found.map(function (f, i) {
            return new gm.Marker({ map: map, position: { lat: f.cam.lat, lng: f.cam.lon }, label: String(i + 1), title: f.cam.name });
          });
          results.hidden = false;
          render(found, data);
          say(found.length + " camera" + (found.length === 1 ? "" : "s") + " within " + NEAR_M + " m of the route, in the order you pass them.");
        });
    }).catch(function (e) {
      say("That did not work: " + (e && e.message ? e.message : "Google could not find a route") + ".");
    });
  });
})();
