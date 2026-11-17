/* ==========================================================================
 *  api.js — Google Apps Script 백엔드 통신 모듈 (청첩장·관리자 페이지 공용)
 *
 *  - GET  : 조회 (?action=...)
 *  - POST : 작성/관리자 기능. 본문은 JSON 문자열, Content-Type 은 text/plain
 *           → CORS 사전요청(OPTIONS) 없이 Apps Script 로 바로 전달됩니다.
 *  - 응답 : { ok: true, data } | { ok: false, error: { code, message } }
 *  - API_URL 이 비어 있으면 mock.js 의 미리보기용 가짜 서버를 사용합니다.
 * ========================================================================== */
(function () {
  'use strict';

  var cfg = window.WEDDING_CONFIG || {};
  var API_URL = String(cfg.API_URL || '').trim();
  var DEMO = !API_URL;
  var TIMEOUT_MS = 25000;

  function ApiError(code, message, retryable) {
    var err = new Error(message);
    err.code = code;
    err.retryable = !!retryable;
    return err;
  }

  function uuid() {
    var c = window.crypto || window.msCrypto;
    if (c && c.randomUUID) return c.randomUUID().replace(/-/g, '');
    var bytes = new Uint8Array(16);
    if (c && c.getRandomValues) c.getRandomValues(bytes);
    else for (var i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    return Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function unwrap(json) {
    if (json && json.ok === true) return json.data;
    var e = (json && json.error) || {};
    var code = e.code || 'UNKNOWN';
    throw ApiError(code, e.message || '요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.',
      code === 'BUSY' || code === 'SERVER_ERROR');
  }

  async function send(method, params) {
    if (DEMO) {
      if (!window.WeddingMock) throw ApiError('NOT_CONFIGURED', 'config.js 에 API_URL 을 입력해 주세요.');
      return unwrap(await window.WeddingMock.handle(method, params));
    }

    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (controller) controller.abort(); }, TIMEOUT_MS);
    var res;
    try {
      if (method === 'GET') {
        var qs = new URLSearchParams(params).toString();
        res = await fetch(API_URL + (API_URL.indexOf('?') === -1 ? '?' : '&') + qs, {
          method: 'GET',
          redirect: 'follow',
          signal: controller ? controller.signal : undefined
        });
      } else {
        res = await fetch(API_URL, {
          method: 'POST',
          redirect: 'follow',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(params),
          signal: controller ? controller.signal : undefined
        });
      }
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw ApiError('TIMEOUT', '서버 응답이 늦어지고 있어요. 잠시 후 다시 시도해 주세요.', true);
      }
      throw ApiError('NETWORK', '인터넷 연결을 확인한 뒤 다시 시도해 주세요.', true);
    } finally {
      clearTimeout(timer);
    }

    var text = await res.text();
    var json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      // 권한 오류·배포 설정 오류 시 Google 이 JSON 대신 HTML 페이지를 돌려줍니다.
      throw ApiError('BAD_RESPONSE', '서버 응답을 확인할 수 없어요. 잠시 후 다시 시도해 주세요.', true);
    }
    return unwrap(json);
  }

  /** 재시도: 네트워크 오류 등 일시적 문제일 때만. 작성 요청은 requestId 덕분에 재시도해도 중복 저장되지 않습니다. */
  async function call(method, params, retries) {
    var max = typeof retries === 'number' ? retries : 1;
    for (var attempt = 0; ; attempt++) {
      try {
        return await send(method, params);
      } catch (err) {
        if (attempt < max && err.retryable) {
          await sleep(900 * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
  }

  /** Google Drive 파일 ID → 이미지 주소 (프론트에서 직접 쓰는 사진용) */
  function driveImage(id, size) {
    return 'https://lh3.googleusercontent.com/d/' + id + '=' + (size || 'w2000');
  }
  function driveThumbFallback(id, size) {
    return 'https://drive.google.com/thumbnail?id=' + encodeURIComponent(id) + '&sz=' + (size || 'w2000');
  }
  /** config.js 의 사진 경로가 Drive 링크면 이미지 주소로 바꿔 줍니다. */
  function resolveImage(src, size) {
    src = String(src || '').trim();
    if (!src) return '';
    var m = /^https:\/\/([a-z0-9-]+\.)*(google\.com|googleusercontent\.com)\//i.test(src) &&
            (/\/d\/([A-Za-z0-9_-]{20,})/.exec(src) || /[?&]id=([A-Za-z0-9_-]{20,})/.exec(src));
    return m ? driveImage(m[1], size) : src;
  }

  /* ---------------------------------------------------------------------
   *  청첩장 내용 합치기
   *  적용 순서: config.js  <  관리자 페이지에서 저장한 내용  <  SETTINGS 시트 8개 값
   *  (같은 종류의 값만 덮어씀 → 시트를 잘못 고쳐도 화면이 깨지지 않음)
   * --------------------------------------------------------------------- */
  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

  function mergeInto(target, src) {
    if (!isObj(src)) return target;
    Object.keys(src).forEach(function (k) {
      if (k === 'API_URL') return;
      var v = src[k];
      var cur = target[k];
      if (isObj(v)) {
        if (cur !== undefined && !isObj(cur)) return;
        if (!isObj(cur)) target[k] = {};
        mergeInto(target[k], v);
      } else if (Array.isArray(v)) {
        if (cur !== undefined && !Array.isArray(cur)) return;
        target[k] = clone(v);
      } else if (v !== undefined && v !== null) {
        if (cur !== undefined && cur !== null && typeof cur !== typeof v) return;
        target[k] = v;
      }
    });
    return target;
  }

  function shortName(full) { return /^[가-힣]{3}$/.test(full) ? full.slice(1) : full; }
  function padTime(t) {
    var m = /^(\d{1,2}):(\d{2})/.exec(String(t || ''));
    return m ? ('0' + m[1]).slice(-2) + ':' + m[2] : '';
  }

  function buildContent(base, content, settings) {
    var c = mergeInto({}, clone(base || {}));
    delete c.API_URL;
    mergeInto(c, content);
    ['wedding', 'groom', 'bride', 'venue', 'photos', 'texts', 'gallery', 'guestbook', 'accounts'].forEach(function (k) {
      if (!isObj(c[k])) c[k] = {};
    });
    ['groom', 'bride'].forEach(function (k) {
      if (!isObj(c[k].father)) c[k].father = {};
      if (!isObj(c[k].mother)) c[k].mother = {};
    });
    if (!Array.isArray(c.transport)) c.transport = [];
    if (!Array.isArray(c.accounts.groom)) c.accounts.groom = [];
    if (!Array.isArray(c.accounts.bride)) c.accounts.bride = [];

    var s = settings || {};
    if (/^\d{4}-\d{2}-\d{2}$/.test(s.wedding_date || '')) c.wedding.date = s.wedding_date;
    if (padTime(s.wedding_time)) c.wedding.time = padTime(s.wedding_time);
    if (s.groom_name && s.groom_name !== c.groom.name) { c.groom.name = s.groom_name; c.groom.shortName = shortName(s.groom_name); }
    if (s.bride_name && s.bride_name !== c.bride.name) { c.bride.name = s.bride_name; c.bride.shortName = shortName(s.bride_name); }
    if (s.venue_name) c.venue.name = s.venue_name;
    if (s.venue_address) c.venue.address = s.venue_address;
    if (s.venue_detail) c.venue.hall = s.venue_detail;
    if (s.contact_info) c.venue.tel = s.contact_info;
    c.wedding.time = padTime(c.wedding.time) || '12:00';
    return c;
  }

  window.WeddingAPI = {
    isDemo: DEMO,
    uuid: uuid,
    driveImage: driveImage,
    driveThumbFallback: driveThumbFallback,
    resolveImage: resolveImage,
    buildContent: buildContent,

    bootstrap: function () { return call('GET', { action: 'bootstrap' }); },
    photoComments: function (photoId) { return call('GET', { action: 'photoComments', photoId: photoId }); },
    guestbook: function (cursor, limit) {
      return call('GET', { action: 'guestbook', cursor: cursor || '', limit: String(limit || 10) });
    },
    addComment: function (payload) { return call('POST', Object.assign({ action: 'addComment' }, payload), 2); },
    addGuestbook: function (payload) { return call('POST', Object.assign({ action: 'addGuestbook' }, payload), 2); },

    admin: {
      login: function (password) { return call('POST', { action: 'adminLogin', password: password }, 0); },
      logout: function (token) { return call('POST', { action: 'adminLogout', token: token }, 0); },
      /** 관리자 기능 호출 (토큰은 URL 이 아닌 POST 본문으로만 전송) */
      request: function (action, token, payload, retries) {
        return call('POST', Object.assign({}, payload || {}, { action: action, token: token }), retries === undefined ? 1 : retries);
      }
    }
  };
})();
