/*
 * Rutube TV без рекламы — мод TizenBrew для официального ТВ-приложения Rutube.
 * Интерфейс, вход и плеер — родные; мод только правит данные, на которых держится реклама.
 *
 * Открываем сборку Rutube для LG webOS (https://rutube.ru/tv-release/webos.server/webos/),
 * а не для Samsung: Samsung-сборка играет видео только через webapis.avplay, а у TizenBrew
 * нет разрешения на этот плеер. webOS-сборка играет обычным <video> + MediaSource —
 * проверено в Chrome: 1080p идёт. Отличаются коды кнопок пульта — их переводим ниже.
 *
 * Откуда реклама (разбор main.*.js и записи сети, 19.10.2026):
 * - список рекламных вставок приходит полем `advert` (advert.video — шаблоны VAST)
 *   в ответе GET /api/play/options/<id>/ и разбирается в parseAdverts(t.advert.video);
 * - правила показа — meta.advert_rule_id / advert_limit_rule_id, midroll_watch_time и т.п.;
 * - белый список авторов без рекламы — GET /api/play/options/advert/white-list/.
 * Ответы API приложение читает и через Response.json(), и через JSON.parse, поэтому
 * перехватываем оба пути и обнуляем рекламные поля у объекта «параметров видео».
 *
 * Пишется в ES5: TizenBrew может подключить его и в старом веб-движке Tizen.
 */
(function () {
  'use strict';
  if (window.__rutubeNoAds) return;
  window.__rutubeNoAds = { stripped: 0 };

  // «Параметры видео» узнаём по форме, а не по URL: у Response.json() адреса может не быть
  function isPlayOptions(o) {
    return o && typeof o === 'object' && !Array.isArray(o) &&
      'video_balancer' in o && 'advert' in o;
  }

  function strip(o) {
    if (!isPlayOptions(o)) return o;
    o.advert = null;
    if (o.meta && typeof o.meta === 'object') {
      o.meta.advert_rule_id = null;
      o.meta.advert_limit_rule_id = null;
    }
    window.__rutubeNoAds.stripped++;
    return o;
  }

  var origParse = JSON.parse;
  JSON.parse = function (text, reviver) {
    return strip(origParse.call(JSON, text, reviver));
  };

  if (window.Response && Response.prototype.json) {
    var origJson = Response.prototype.json;
    Response.prototype.json = function () {
      return origJson.call(this).then(strip);
    };
  }

  // Пульт Samsung -> коды пульта LG, которые ждёт webOS-сборка
  // (в её бандле keys: {RETURN: 461, PLAY: 415, PAUSE: 19, STOP: 413, RW: 412, FF: 417}).
  // Совпадают все, кроме «Назад» (Tizen 10009) и «Пуск/пауза» одной кнопкой (Tizen 10252).
  var REMAP = { 10009: 461 };
  var playing = false;
  function retarget(e) {
    var code = e.keyCode;
    var to = REMAP[code];
    if (code === 10252) {
      // у LG нет общей кнопки — шлём PLAY или PAUSE по состоянию видео
      var v = document.querySelector('video');
      playing = v ? !v.paused : !playing;
      to = playing ? 19 : 415;
    }
    if (!to || e.__rutubeRemapped) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    var ev = new KeyboardEvent(e.type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'keyCode', { get: function () { return to; } });
    Object.defineProperty(ev, 'which', { get: function () { return to; } });
    ev.__rutubeRemapped = true;
    (document.activeElement || document.body || document).dispatchEvent(ev);
  }
  window.addEventListener('keydown', retarget, true);
  window.addEventListener('keyup', retarget, true);

  // Автозапуск. Плеер webOS-сборки сам зовёт video.play() после загрузки — на LG это
  // разрешено, а браузерный движок может запретить звук без нажатия (NotAllowedError):
  // видео загружено, но стоит, и крутится вечная заглушка. Тогда запускаем без звука
  // (это разрешено всегда) и возвращаем звук при первом нажатии на пульт.
  var origPlay = HTMLMediaElement.prototype.play;
  var mutedByMod = null;
  HTMLMediaElement.prototype.play = function () {
    var el = this;
    var p = origPlay.apply(el, arguments);
    if (!p || !p.then) return p;
    return p.then(null, function (err) {
      if (!err || err.name !== 'NotAllowedError' || el.muted) throw err;
      el.muted = true;
      mutedByMod = el;
      showHint('Нажмите любую кнопку, чтобы включить звук');
      return origPlay.call(el);
    });
  };
  window.addEventListener('keydown', function () {
    if (mutedByMod) {
      mutedByMod.muted = false;
      mutedByMod = null;
      showHint('');
    }
  }, true);

  var hintEl = null;
  function showHint(text) {
    if (!document.body) return;
    if (!hintEl) {
      hintEl = document.createElement('div');
      hintEl.style.cssText = 'position:fixed;left:50%;bottom:8%;transform:translateX(-50%);z-index:2147483647;' +
        'background:rgba(0,0,0,.75);color:#fff;font:28px sans-serif;padding:14px 26px;border-radius:12px;pointer-events:none';
      document.body.appendChild(hintEl);
    }
    hintEl.textContent = text;
    hintEl.style.display = text ? 'block' : 'none';
  }
  window.__rutubeNoAds.hint = function () { return hintEl ? hintEl.textContent : ''; };

  // ---------- Диагностика (временно, пока видео на ТВ не заиграет) ----------
  // Экрана телевизора с Mac не видно, поэтому, если видео 6 с не идёт, мод сам
  // показывает панель: версия мода, состояние <video>, поддержка MSE, последние ошибки
  // и неудачные запросы. Красная кнопка пульта (403) — показать/скрыть вручную.
  var MOD_VERSION = '0.1.4';
  var logs = [];
  function log(s) {
    var t = new Date();
    logs.push(('0' + t.getMinutes()).slice(-2) + ':' + ('0' + t.getSeconds()).slice(-2) + ' ' + String(s).slice(0, 140));
    if (logs.length > 14) logs.shift();
  }
  function short(u) {
    try { var a = document.createElement('a'); a.href = u; return a.hostname.replace('rutube.ru', 'r') + a.pathname.slice(0, 40); }
    catch (e) { return String(u).slice(0, 50); }
  }
  window.addEventListener('error', function (e) {
    if (e.target && e.target !== window && e.target.tagName) log('load fail ' + e.target.tagName + ' ' + short(e.target.src || e.target.href || ''));
    else log('js: ' + (e.message || e.error));
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason; log('promise: ' + (r && (r.name + ' ' + (r.message || '')) || r));
  });
  var XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__u = u; return XO.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    var x = this;
    x.addEventListener('loadend', function () {
      if (x.status === 0 || x.status >= 400) log('xhr ' + x.status + ' ' + short(x.__u));
    });
    return XS.apply(this, arguments);
  };
  if (window.fetch) {
    var F = window.fetch;
    window.fetch = function (u) {
      var url = typeof u === 'string' ? u : (u && u.url);
      return F.apply(this, arguments).then(function (r) {
        if (!r.ok) log('fetch ' + r.status + ' ' + short(url));
        return r;
      }, function (err) { log('fetch fail ' + short(url) + ' ' + err); throw err; });
    };
  }
  ['loadstart', 'loadedmetadata', 'canplay', 'playing', 'waiting', 'stalled', 'error', 'abort', 'emptied'].forEach(function (n) {
    document.addEventListener(n, function (e) {
      var v = e.target;
      if (!v || v.tagName !== 'VIDEO' || /preloader/.test(v.currentSrc || '')) return;
      log('video ' + n + (n === 'error' && v.error ? ' code ' + v.error.code + ' ' + (v.error.message || '') : ''));
    }, true);
  });

  var panel = null, panelOn = false, stuckSince = 0;
  function mainVideo() {
    var vs = document.querySelectorAll('video');
    for (var i = 0; i < vs.length; i++) if (!/preloader/.test(vs[i].currentSrc || '')) return vs[i];
    return null;
  }
  function mse(type) {
    try { return window.MediaSource && MediaSource.isTypeSupported(type) ? 'да' : 'нет'; } catch (e) { return '?'; }
  }
  function render() {
    if (!panelOn || !document.body) { if (panel) panel.style.display = 'none'; return; }
    if (!panel) {
      panel = document.createElement('pre');
      panel.style.cssText = 'position:fixed;left:2%;top:3%;max-width:60%;z-index:2147483646;margin:0;' +
        'background:rgba(0,0,0,.85);color:#9f9;font:18px/1.3 monospace;padding:12px 16px;border-radius:10px;' +
        'white-space:pre-wrap;pointer-events:none';
      document.body.appendChild(panel);
    }
    var v = mainVideo();
    var lines = [
      'Rutube мод ' + MOD_VERSION + ' · реклама снята: ' + window.__rutubeNoAds.stripped,
      'UA: ' + navigator.userAgent.slice(0, 70),
      'MSE: ' + (window.MediaSource ? 'есть' : 'НЕТ') + ' · h264 ' + mse('video/mp4; codecs="avc1.42c01f,mp4a.40.2"') +
        ' · hls родной ' + (document.createElement('video').canPlayType('application/vnd.apple.mpegurl') || 'нет') +
        ' · webOS ' + typeof window.webOS + ' · tizen ' + typeof window.tizen,
      v ? 'video: t=' + v.currentTime.toFixed(1) + ' paused=' + v.paused + ' muted=' + v.muted + ' ready=' + v.readyState +
        ' net=' + v.networkState + ' ' + v.videoWidth + 'x' + v.videoHeight + (v.error ? ' ERR ' + v.error.code : '') +
        '\nsrc: ' + short(v.currentSrc || v.src || '(нет)') : 'video: нет элемента',
      'адрес: ' + location.hash.slice(0, 60),
      '--- последние события ---'
    ].concat(logs);
    panel.textContent = lines.join('\n');
    panel.style.display = 'block';
  }
  setInterval(function () {
    var v = mainVideo();
    var onVideo = /video\//.test(location.hash);
    var moving = v && !v.paused && v.readyState >= 3;
    if (onVideo && !moving) { if (!stuckSince) stuckSince = Date.now(); }
    else stuckSince = 0;
    if (stuckSince && Date.now() - stuckSince > 6000) panelOn = true;
    render();
  }, 1000);
  window.addEventListener('keydown', function (e) {
    if (e.keyCode === 403) { panelOn = !panelOn; render(); }
  }, true);
  // Поток через hls.js. Плеер webOS-сборки кладёт ссылку на m3u8 прямо в video.src
  // (на LG телевизор играет HLS сам). Движок Samsung отвечает canPlayType «maybe», грузит
  // описание потока, но кадров не отдаёт: на ТВ видели ready=1, 0x0 и вечный waiting.
  // Поэтому такие ссылки перехватываем и играем через hls.js + MediaSource (MSE на ТВ есть,
  // CDN Rutube отдаёт CORS для rutube.ru). hls.js 1.4 — сборка в ES5, подходит старому движку.
  var HLS_URL = 'https://cdn.jsdelivr.net/npm/hls.js@1.4.14/dist/hls.min.js';
  var hlsQueue = [];
  (function loadHls() {
    var s = document.createElement('script');
    s.src = HLS_URL;
    s.onload = function () {
      log('hls.js загружен, MSE ' + (window.Hls && Hls.isSupported() ? 'да' : 'нет'));
      var q = hlsQueue; hlsQueue = [];
      for (var i = 0; i < q.length; i++) q[i]();
    };
    s.onerror = function () { log('hls.js не загрузился'); var q = hlsQueue; hlsQueue = []; for (var i = 0; i < q.length; i++) q[i](); };
    // TizenBrew подмешивает мод до появления <html> — ждём, куда вставить тег
    (function append() {
      var parent = document.head || document.documentElement;
      if (parent) parent.appendChild(s); else setTimeout(append, 10);
    })();
  })();

  // Плеер ставит поток не в video.src, а дочерним <source src="…m3u8"> (проверено в Chrome).
  // Ссылку у <source> забираем себе (родной плеер её не видит) и подключаем hls.js к <video>.
  // hls.js сам пишет video.src = blob:… и зовёт removeAttribute('src')/load() — это пропускаем.
  var srcDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
  var sourceDesc = Object.getOwnPropertyDescriptor(HTMLSourceElement.prototype, 'src');
  var origLoad = HTMLMediaElement.prototype.load;
  var origSetAttr = Element.prototype.setAttribute;
  var origRemoveAttr = Element.prototype.removeAttribute;
  function isHlsUrl(u) { return /\.m3u8(\?|$)|\/route\/[0-9a-f]{32}/i.test(String(u || '')); }
  function detachHls(el) {
    var h = el.__hls;
    el.__hls = null;
    el.__hlsSrc = null;
    if (h) { el.__hlsInternal = true; try { h.destroy(); } catch (e) { /* уже уничтожен */ } el.__hlsInternal = false; }
  }
  function attachHls(el, url) {
    if (el.__hlsSrc === url) return; // тот же поток уже подключён или ждёт hls.js
    detachHls(el);
    el.__hlsSrc = url;
    function go() {
      if (el.__hlsSrc !== url) return; // ссылку успели сменить
      if (!window.Hls || !Hls.isSupported()) {
        log('hls.js недоступен — отдаю родному плееру');
        el.__hlsSrc = null;
        srcDesc.set.call(el, url);
        return;
      }
      var h = new Hls({ maxBufferLength: 30 });
      el.__hls = h;
      h.on(Hls.Events.MANIFEST_PARSED, function (ev, d) { log('hls: поток разобран, качеств ' + (d.levels ? d.levels.length : '?')); });
      h.on(Hls.Events.ERROR, function (ev, d) {
        if (!d.fatal) return;
        log('hls fatal ' + d.type + ' ' + d.details);
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR) h.startLoad();
        else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) h.recoverMediaError();
      });
      el.__hlsInternal = true;
      h.loadSource(url);
      h.attachMedia(el);
      el.__hlsInternal = false;
      log('видео через hls.js');
    }
    if (window.Hls) go(); else hlsQueue.push(go);
  }
  function claimSource(srcEl, url) {
    srcEl.__hlsUrl = url;
    var v = srcEl.parentNode;
    if (v && v.tagName === 'VIDEO') attachHls(v, url);
  }

  Object.defineProperty(HTMLMediaElement.prototype, 'src', {
    configurable: true,
    enumerable: srcDesc.enumerable,
    get: function () { return this.__hlsSrc || srcDesc.get.call(this); },
    set: function (v) {
      if (this.tagName === 'VIDEO' && isHlsUrl(v)) { attachHls(this, v); return; }
      if (!this.__hlsInternal && !/^blob:/.test(String(v))) detachHls(this);
      srcDesc.set.call(this, v);
    }
  });
  Object.defineProperty(HTMLSourceElement.prototype, 'src', {
    configurable: true,
    enumerable: sourceDesc.enumerable,
    get: function () { return this.__hlsUrl || sourceDesc.get.call(this); },
    set: function (v) {
      if (isHlsUrl(v)) { claimSource(this, v); return; }
      this.__hlsUrl = null;
      sourceDesc.set.call(this, v);
    }
  });
  Element.prototype.setAttribute = function (name, value) {
    var isSrc = String(name).toLowerCase() === 'src';
    if (isSrc && isHlsUrl(value)) {
      if (this.tagName === 'VIDEO') { attachHls(this, value); return; }
      if (this.tagName === 'SOURCE') { claimSource(this, value); return; }
    }
    return origSetAttr.apply(this, arguments);
  };
  Element.prototype.removeAttribute = function (name) {
    if (this.tagName === 'VIDEO' && String(name).toLowerCase() === 'src' && !this.__hlsInternal) detachHls(this);
    return origRemoveAttr.apply(this, arguments);
  };
  // load() сбрасывает видеоэлемент и отрывает MediaSource — при hls.js он не нужен
  HTMLMediaElement.prototype.load = function () {
    if (this.__hlsSrc && !this.__hlsInternal) return;
    return origLoad.apply(this, arguments);
  };
  // <source> с потоком вставили в <video> уже после того, как ему дали ссылку
  (function watch() {
    if (!document.documentElement) { setTimeout(watch, 10); return; }
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var n = added[j];
          if (n.nodeType !== 1) continue;
          var list = n.tagName === 'SOURCE' ? [n] : (n.querySelectorAll ? n.querySelectorAll('source') : []);
          for (var k = 0; k < list.length; k++) {
            if (list[k].__hlsUrl && list[k].parentNode && list[k].parentNode.tagName === 'VIDEO') attachHls(list[k].parentNode, list[k].__hlsUrl);
          }
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  })();

  // Выход. Кнопка «Выйти» в webOS-сборке зовёт webOS.platformBack() — на LG это закрывает
  // приложение, а на Samsung ничего не делает, и приложение просто уходит на главную.
  // Подменяем platformBack на выход из приложения Tizen (TizenBrew); объект webOS
  // создаёт бандл позже нас, поэтому ловим момент его записи в window.
  function exitApp() {
    log('выход: tizen=' + typeof window.tizen);
    try { window.tizen.application.getCurrentApplication().exit(); return true; }
    catch (e) { log('выход через tizen не удался: ' + e); }
    try { window.close(); } catch (e2) { /* не вышло — ниже лог */ }
    log('выход недоступен в этом окружении');
    return false;
  }
  function patchWebOS(w) {
    if (w && typeof w === 'object' && !w.__rutubeExit) {
      try { w.platformBack = exitApp; w.__rutubeExit = true; } catch (e) { log('webOS patch: ' + e); }
    }
  }
  var webOSObj = window.webOS;
  patchWebOS(webOSObj);
  try {
    Object.defineProperty(window, 'webOS', {
      configurable: true,
      get: function () { return webOSObj; },
      set: function (v) { webOSObj = v; patchWebOS(v); }
    });
  } catch (e) { log('webOS defineProperty: ' + e); }

  log('мод ' + MOD_VERSION + ' загружен');
})();
