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
})();
