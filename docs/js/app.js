/* ==========================================================================
 *  app.js — 모바일 청첩장 화면 동작
 *  - 사용자 입력은 모두 textContent 로만 출력합니다(innerHTML 미사용) → XSS 차단
 * ========================================================================== */
(function () {
  'use strict';
  document.documentElement.classList.add('js');

  var API = window.WeddingAPI;
  var BASE = window.WEDDING_CONFIG || {};
  var CONTENT_CACHE_KEY = 'wd_content_v1';

  // 화면에 쓰는 실제 내용 = config.js + 관리자 페이지에서 저장한 내용 + SETTINGS 시트 값
  // 다시 방문한 하객은 지난번 내용을 바로 보여주고, 서버 응답이 오면 최신 내용으로 갱신합니다.
  var cachedContent = null;
  try { cachedContent = JSON.parse(localStorage.getItem(CONTENT_CACHE_KEY) || 'null'); } catch (e) { cachedContent = null; }
  var CFG = cachedContent
    ? API.buildContent(BASE, cachedContent.content, cachedContent.settings)
    : API.buildContent(BASE, null, null);

  // 처음 방문 + 실제 서버 연결 시: 최신 내용을 받을 때까지(최대 3.5초) 첫 화면 등장 효과를 잠시 멈춤
  // → config.js 의 예전 이름·문구가 잠깐 보였다 바뀌는 현상 방지
  if (!API.isDemo && !cachedContent) {
    document.documentElement.classList.add('content-pending');
    setTimeout(releaseContentGate, 3500);
  }
  function releaseContentGate() { document.documentElement.classList.remove('content-pending'); }

  /* ------------------------------------------------------------------ 유틸 */

  function $(id) { return document.getElementById(id); }

  /** 안전한 DOM 생성기: text 는 textContent 로 들어가므로 HTML 로 해석되지 않습니다. */
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.indexOf('on') === 0 && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : String(v));
      });
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function icon(name) {
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'ico');
    svg.setAttribute('aria-hidden', 'true');
    var use = document.createElementNS(NS, 'use');
    use.setAttribute('href', '#i-' + name);
    use.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#i-' + name);
    svg.appendChild(use);
    return svg;
  }

  function setText(id, text) {
    var n = $(id);
    if (n) n.textContent = text === null || text === undefined ? '' : String(text);
  }

  function pad(n) { return ('0' + n).slice(-2); }
  function digits(s) { return String(s || '').replace(/[^\d+]/g, ''); }
  function isHttps(u) { return /^https:\/\//i.test(String(u || '')); }
  function charLen(s) { return Array.from(s).length; }

  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 저장 불가 환경 무시 */ } }
  };

  // 기기 식별값(무작위): 서버의 '기기당 작성 속도 제한'에만 사용
  var clientId = store.get('wd_client');
  if (!clientId || !/^[A-Za-z0-9_-]{8,64}$/.test(clientId)) {
    clientId = API.uuid();
    store.set('wd_client', clientId);
  }

  /* ------------------------------------------------------------ 날짜·시간 */

  var DOW_KO = ['일', '월', '화', '수', '목', '금', '토'];
  var DOW_EN = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

  function weddingInfo() {
    var d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(CFG.wedding.date || '') || [0, '2027', '01', '01'];
    var t = /^(\d{1,2}):(\d{2})$/.exec(CFG.wedding.time || '') || [0, '12', '00'];
    var w = { y: +d[1], m: +d[2], d: +d[3], hh: +t[1], mm: +t[2] };
    w.dow = new Date(Date.UTC(w.y, w.m - 1, w.d)).getUTCDay();
    return w;
  }
  function koTime(w) {
    var p = w.hh < 12 ? '오전' : (w.hh === 12 ? '낮' : '오후');
    return p + ' ' + (w.hh % 12 || 12) + '시' + (w.mm ? ' ' + w.mm + '분' : '');
  }
  function enTime(w) { return (w.hh < 12 ? 'AM ' : 'PM ') + (w.hh % 12 || 12) + ':' + pad(w.mm); }
  function koDate(w) { return w.y + '년 ' + w.m + '월 ' + w.d + '일 ' + DOW_KO[w.dow] + '요일'; }

  /** 작성 시각 표시 (한국 시간 기준) */
  function formatTime(iso) {
    var t = Date.parse(iso);
    if (isNaN(t)) return '';
    var diff = (Date.now() - t) / 1000;
    if (diff < 60) return '방금 전';
    if (diff < 3600) return Math.floor(diff / 60) + '분 전';
    if (diff < 86400) return Math.floor(diff / 3600) + '시간 전';
    var k = new Date(t + 9 * 3600 * 1000);
    return k.getUTCFullYear() + '.' + pad(k.getUTCMonth() + 1) + '.' + pad(k.getUTCDate()) + ' ' +
           pad(k.getUTCHours()) + ':' + pad(k.getUTCMinutes());
  }

  /* --------------------------------------------------------- 토스트·복사 */

  var toastTimer = null;
  function toast(message, isError) {
    var t = $('toast');
    t.textContent = message;
    t.classList.toggle('is-error', !!isError);
    t.classList.add('is-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('is-show'); }, isError ? 3400 : 2200);
  }

  function copyText(text, okMessage) {
    function legacyCopy() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '0';
      ta.style.left = '0';
      ta.style.opacity = '0';
      ta.style.fontSize = '16px';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      return ok;
    }
    function done() { toast(okMessage || '복사되었습니다'); }
    function failed() { toast('복사하지 못했어요. 길게 눌러 직접 복사해 주세요.', true); }

    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, function () { if (legacyCopy()) done(); else failed(); });
    } else if (legacyCopy()) {
      done();
    } else {
      failed();
    }
  }

  /* -------------------------------------------- 스크롤 잠금 · 뒤로가기 처리 */

  var lockCount = 0;
  var savedScrollY = 0;
  function lockScroll() {
    if (lockCount++ > 0) return;
    savedScrollY = window.scrollY || window.pageYOffset || 0;
    var s = document.body.style;
    s.position = 'fixed';
    s.top = -savedScrollY + 'px';
    s.left = '0';
    s.right = '0';
    s.width = '100%';
  }
  function unlockScroll() {
    if (lockCount === 0 || --lockCount > 0) return;
    var s = document.body.style;
    s.position = s.top = s.left = s.right = s.width = '';
    window.scrollTo(0, savedScrollY);
  }

  // 사진 뷰어·댓글 창을 열면 history 에 기록 → 휴대폰 '뒤로가기'로 창이 닫히게 합니다.
  var layers = [];
  function openLayer(name, onClose) {
    layers.push({ name: name, onClose: onClose });
    try { history.pushState({ wdLayer: name }, ''); } catch (e) { /* 무시 */ }
  }
  function closeTopLayer() {
    if (!layers.length) return;
    if (history.state && history.state.wdLayer) {
      history.back();
    } else {
      layers.pop().onClose();
    }
  }
  window.addEventListener('popstate', function () {
    var layer = layers.pop();
    if (layer) layer.onClose();
  });

  /* -------------------------------------------------------- 상태 표시 */

  function showState(id, kind, message, retry) {
    var box = $(id);
    box.textContent = '';
    box.hidden = false;
    if (kind === 'loading') {
      box.appendChild(el('div', { class: 'spinner' }));
      box.appendChild(el('div', { text: message || '불러오는 중이에요…' }));
      return;
    }
    box.appendChild(el('div', { text: message }));
    if (retry) box.appendChild(el('button', { class: 'btn btn--ghost', type: 'button', text: '다시 시도', onclick: retry }));
  }
  function hideState(id) {
    var box = $(id);
    box.hidden = true;
    box.textContent = '';
  }

  /** 이미지 로드 (실패 시 대체 주소 → 그래도 실패하면 onFail) */
  function loadImage(img, src, fallback, onFail) {
    var usedFallback = false;
    img.addEventListener('error', function onError() {
      if (fallback && !usedFallback) {
        usedFallback = true;
        img.src = fallback;
        return;
      }
      img.removeEventListener('error', onError);
      if (onFail) onFail();
    });
    img.src = src;
  }

  function driveFallback(src, size) {
    var m = /lh3\.googleusercontent\.com\/d\/([A-Za-z0-9_-]+)/.exec(src || '');
    return m ? API.driveThumbFallback(m[1], size) : '';
  }

  /* ------------------------------------------------- 정적 정보 렌더링 */

  /** 서버에서 받은 내용(관리자 저장 내용 + SETTINGS 시트)을 반영하고, 바뀐 경우에만 다시 그립니다. */
  function applyServerContent(content, settings) {
    try {
      localStorage.setItem(CONTENT_CACHE_KEY, JSON.stringify({ content: content || null, settings: settings || {} }));
    } catch (e) { /* 저장 불가 환경 무시 */ }
    var next = API.buildContent(BASE, content, settings);
    if (JSON.stringify(next) === JSON.stringify(CFG)) return;
    CFG = next;
    renderAllContent();
  }

  function renderAllContent() {
    renderInfo();
    renderAccounts();
    renderMainPhotos();
    if (!state.expanded) state.shown = Number(CFG.gallery.initialCount) || 9;
  }

  function renderInfo() {
    var w = weddingInfo();
    var g = CFG.groom;
    var b = CFG.bride;
    var v = CFG.venue;
    var T = CFG.texts;
    var gs = g.shortName || g.name || '';
    var bs = b.shortName || b.name || '';

    document.title = (g.name || '') + ' ♥ ' + (b.name || '') + ' 결혼합니다';

    // ① 인트로
    setText('introGroom', gs);
    setText('introBride', bs);
    setText('introDate', w.y + '. ' + pad(w.m) + '. ' + pad(w.d) + ' ' + DOW_EN[w.dow] + '  ·  ' + enTime(w));
    setText('introVenue', [v.name, v.hall].filter(Boolean).join(' '));
    setText('introMessage', T.introMessage);

    // ② 초대의 글
    setText('invitationTitle', T.invitationTitle || '초대합니다');
    setText('invitationMessage', T.invitationMessage);
    renderFamily();
    renderContacts();

    // ③ 예식 안내
    setText('wdDate', koDate(w) + '\n' + koTime(w));
    renderCalendar(w);
    renderDday(w, gs, bs);
    setText('venueName', v.name);
    setText('venueHall', v.hall);
    setText('venueAddress', v.address);
    var tel = $('venueTel');
    tel.hidden = !v.tel;
    if (v.tel) {
      tel.href = 'tel:' + digits(v.tel);
      setText('venueTelText', '예식장 ' + v.tel);
    }
    var q = encodeURIComponent(v.address || v.name || '');
    $('naverMap').href = isHttps(v.naverMapUrl) ? v.naverMapUrl : 'https://map.naver.com/p/search/' + q;
    $('kakaoMap').href = isHttps(v.kakaoMapUrl) ? v.kakaoMapUrl : 'https://map.kakao.com/link/search/' + q;
    var mapSrc = API.resolveImage(v.mapImage, 'w1600');
    var mapImg = $('mapImage');
    $('mapImageWrap').hidden = !mapSrc;
    if (mapSrc && mapImg.getAttribute('data-src') !== mapSrc) {
      mapImg.setAttribute('data-src', mapSrc);
      mapImg.referrerPolicy = 'no-referrer';
      mapImg.onerror = function () { $('mapImageWrap').hidden = true; };
      mapImg.src = mapSrc;
    }
    renderTransport();

    // ⑦ 마무리
    setText('closingMessage', T.closingMessage);
    setText('closingSign', w.y + '. ' + pad(w.m) + '. ' + pad(w.d) + '\n' + gs + '  &  ' + bs);
    setText('footer', 'WITH LOVE, ' + gs + ' & ' + bs);
  }

  function renderFamily() {
    function parent(p) {
      if (!p || !p.name) return null;
      var span = el('span');
      if (p.deceased) span.appendChild(el('span', { class: 'family__deceased', text: '故' }));
      span.appendChild(document.createTextNode(p.name));
      return span;
    }
    function row(person) {
      var parents = [parent(person.father), parent(person.mother)].filter(Boolean);
      var p = el('p', { class: 'family__row' });
      parents.forEach(function (n, i) {
        if (i) p.appendChild(document.createTextNode(' · '));
        p.appendChild(n);
      });
      if (parents.length) p.appendChild(el('span', { class: 'family__rel', text: '의 ' + (person.relation || '') }));
      p.appendChild(el('span', { class: 'family__name', text: person.shortName || person.name || '' }));
      return p;
    }
    var box = $('family');
    box.textContent = '';
    box.appendChild(row(CFG.groom));
    box.appendChild(row(CFG.bride));
  }

  function renderContacts() {
    var box = $('coupleContacts');
    box.textContent = '';
    [['신랑', CFG.groom], ['신부', CFG.bride]].forEach(function (pair) {
      var person = pair[1];
      if (!person.phone) return;
      var num = digits(person.phone);
      box.appendChild(el('div', { class: 'contact-card' }, [
        el('span', { class: 'contact-card__label' }, [pair[0], el('b', { text: person.shortName || person.name || '' })]),
        el('div', { class: 'contact-card__btns' }, [
          el('a', { class: 'round-btn', href: 'tel:' + num, 'aria-label': pair[0] + '에게 전화하기' }, [icon('phone')]),
          el('a', { class: 'round-btn', href: 'sms:' + num, 'aria-label': pair[0] + '에게 문자 보내기' }, [icon('sms')])
        ])
      ]));
    });
    box.hidden = !box.children.length;
  }

  function renderCalendar(w) {
    var box = $('calendar');
    box.textContent = '';
    box.appendChild(el('div', { class: 'cal__head', text: w.y + '. ' + pad(w.m) }));
    var grid = el('div', { class: 'cal__grid' });
    DOW_KO.forEach(function (d, i) { grid.appendChild(el('div', { class: 'cal__dow' + (i === 0 ? ' is-sun' : ''), text: d })); });
    var first = new Date(Date.UTC(w.y, w.m - 1, 1)).getUTCDay();
    var days = new Date(Date.UTC(w.y, w.m, 0)).getUTCDate();
    for (var i = 0; i < first; i++) grid.appendChild(el('div', { class: 'cal__day', 'aria-hidden': 'true' }));
    for (var d = 1; d <= days; d++) {
      var dow = (first + d - 1) % 7;
      var cls = 'cal__day' + (dow === 0 ? ' is-sun' : '') + (d === w.d ? ' is-wedding' : '');
      var cell = el('div', { class: cls }, [el('span', { text: String(d) })]);
      if (d === w.d) cell.setAttribute('aria-label', '예식일 ' + w.m + '월 ' + d + '일');
      grid.appendChild(cell);
    }
    box.appendChild(grid);
  }

  function renderDday(w, gs, bs) {
    var box = $('dday');
    box.textContent = '';
    var now = new Date(Date.now() + 9 * 3600 * 1000); // 한국 시간
    var today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    var diff = Math.round((Date.UTC(w.y, w.m - 1, w.d) - today) / 86400000);
    var heart = icon('heart');
    if (diff > 0) {
      [gs, ' ', heart, ' ', bs, '의 결혼식이 ', el('b', { text: diff + '일' }), ' 남았습니다'].forEach(add);
    } else if (diff === 0) {
      ['오늘은 ', gs, ' ', heart, ' ', bs, '의 결혼식 날입니다'].forEach(add);
    } else {
      [gs, ' ', heart, ' ', bs, '의 결혼식에 함께해 주셔서 감사합니다'].forEach(add);
    }
    function add(n) { box.appendChild(typeof n === 'string' ? document.createTextNode(n) : n); }
  }

  function renderTransport() {
    var dl = $('transport');
    dl.textContent = '';
    (CFG.transport || []).forEach(function (t) {
      if (!t || !t.title) return;
      dl.appendChild(el('div', { class: 'transport__item' }, [
        el('dt', { text: t.title }),
        el('dd', { text: (t.lines || []).join('\n') })
      ]));
    });
    dl.hidden = !dl.children.length;
  }

  function renderAccounts() {
    setText('accountMessage', CFG.texts.accountMessage);
    var box = $('accounts');
    box.textContent = '';
    var groups = [['groom', '신랑측 계좌번호'], ['bride', '신부측 계좌번호']];
    groups.forEach(function (group) {
      var list = (CFG.accounts || {})[group[0]] || [];
      if (!list.length) return;
      var panelId = 'acc-panel-' + group[0];
      var head = el('button', { class: 'acc__head', type: 'button', 'aria-expanded': 'false', 'aria-controls': panelId },
        [el('span', { text: group[1] }), icon('down')]);
      var ul = el('ul', { class: 'acc__list' });
      list.forEach(function (a) {
        var account = (a.bank || '') + ' ' + (a.number || '');
        var buttons = [
          el('button', {
            class: 'mini-btn', type: 'button', 'aria-label': (a.role || '') + ' 계좌번호 복사',
            onclick: function () { copyText(account.trim(), (a.role || '') + ' 계좌번호를 복사했어요'); }
          }, [icon('copy'), '복사'])
        ];
        if (isHttps(a.kakaopay)) {
          buttons.push(el('a', { class: 'mini-btn', href: a.kakaopay, target: '_blank', rel: 'noopener noreferrer' }, ['카카오페이']));
        }
        ul.appendChild(el('li', { class: 'acc-item' }, [
          el('div', null, [
            el('div', null, [el('span', { class: 'acc-item__role', text: a.role || '' }), el('span', { class: 'acc-item__holder', text: a.name || '' })]),
            el('div', { class: 'acc-item__number', text: account.trim() })
          ]),
          el('div', { class: 'acc-item__btns' }, buttons)
        ]));
      });
      var acc = el('div', { class: 'acc' }, [
        head,
        el('div', { class: 'acc__panel', id: panelId, role: 'region', 'aria-label': group[1] }, [el('div', { class: 'acc__inner' }, [ul])])
      ]);
      head.addEventListener('click', function () {
        var open = acc.classList.toggle('is-open');
        head.setAttribute('aria-expanded', String(open));
      });
      box.appendChild(acc);
    });
  }

  function renderMainPhotos() {
    var photos = CFG.photos || {};
    [['mainPhoto', photos.main], ['endingPhoto', photos.ending]].forEach(function (pair) {
      var img = $(pair[0]);
      var fig = img.parentNode;
      var src = API.resolveImage(pair[1], 'w1600');
      if (img.getAttribute('data-src') === src && img.hasAttribute('data-src')) return; // 같은 사진이면 그대로
      img.setAttribute('data-src', src);
      img.referrerPolicy = 'no-referrer';
      function empty() {
        img.onerror = null;
        fig.classList.add('is-empty');
        img.hidden = true;
        img.removeAttribute('src');
      }
      if (!src) return empty();
      fig.classList.remove('is-empty');
      img.hidden = false;
      var fallback = driveFallback(src, 'w1600');
      var usedFallback = false;
      img.onerror = function () {
        if (fallback && !usedFallback) { usedFallback = true; img.src = fallback; return; }
        empty();
      };
      img.src = src;
    });
  }

  /* --------------------------------------------------------------- 상태 */

  var state = {
    photos: [],
    shown: Number(CFG.gallery.initialCount) || 9,
    expanded: false,
    gbIds: {},
    gbCursor: null,
    gbHasMore: false,
    gbTotal: 0,
    gbLoading: false,
    lastSync: 0
  };
  var countEls = {};

  function findPhoto(id) {
    for (var i = 0; i < state.photos.length; i++) if (state.photos[i].id === id) return state.photos[i];
    return null;
  }

  /* ------------------------------------------------------------ 갤러리 */

  function renderGallerySkeleton() {
    var grid = $('galleryGrid');
    grid.textContent = '';
    for (var i = 0; i < 6; i++) grid.appendChild(el('li', { class: 'gallery__skel skeleton', 'aria-hidden': 'true' }));
  }

  function renderGallery() {
    var grid = $('galleryGrid');
    grid.textContent = '';
    countEls = {};
    var n = state.photos.length;
    if (!n) showState('galleryState', 'empty', '사진을 준비하고 있어요.');
    else hideState('galleryState');
    state.photos.slice(0, state.shown).forEach(function (p, i) { grid.appendChild(galleryItem(p, i)); });
    var rest = n - Math.min(state.shown, n);
    var more = $('galleryMore');
    more.hidden = rest <= 0;
    more.textContent = '사진 더보기 (+' + rest + ')';
  }

  function galleryItem(p, i) {
    var img = el('img', {
      alt: p.description || ((i + 1) + '번째 웨딩 사진'),
      loading: i < 6 ? 'eager' : 'lazy',
      decoding: 'async',
      referrerpolicy: 'no-referrer',
      draggable: 'false'
    });
    var btn = el('button', {
      class: 'gallery__thumb', type: 'button', 'aria-label': (i + 1) + '번째 사진 크게 보기',
      onclick: function () { openViewer(i); }
    }, [img]);
    img.addEventListener('load', function () { img.classList.add('is-loaded'); });
    loadImage(img, p.thumb, p.driveId ? API.driveThumbFallback(p.driveId, 'w600') : '', function () { btn.classList.add('is-broken'); });

    var count = el('span', { text: String(p.commentCount || 0) });
    var meta = el('div', {
      class: 'gallery__meta' + (p.commentCount ? ' has-comments' : ''),
      'aria-label': '댓글 ' + (p.commentCount || 0) + '개'
    }, [icon('chat'), count]);
    countEls[p.id] = { meta: meta, count: count };
    return el('li', { class: 'gallery__item' }, [btn, meta]);
  }

  /** 사진별 댓글 수 갱신 (그리드·뷰어·댓글창 모두) */
  function setCommentCount(photoId, n) {
    var p = findPhoto(photoId);
    if (!p || typeof n !== 'number') return;
    p.commentCount = n;
    var c = countEls[photoId];
    if (c) {
      c.count.textContent = String(n);
      c.meta.classList.toggle('has-comments', n > 0);
      c.meta.setAttribute('aria-label', '댓글 ' + n + '개');
    }
    var cur = currentPhoto();
    if (viewer.open && cur && cur.id === photoId) setText('viewerCommentCount', n);
    if (sheet.photoId === photoId) setText('sheetCount', n);
  }

  /* --------------------------------------------------------- 사진 뷰어 */

  var viewer = { open: false, index: 0, token: 0 };
  var preloadCache = {};

  function currentPhoto() { return state.photos[viewer.index] || null; }

  function preload(url, fallback) {
    if (preloadCache[url]) return preloadCache[url];
    var promise = new Promise(function (resolve, reject) {
      var im = new Image();
      var usedFallback = false;
      im.referrerPolicy = 'no-referrer';
      im.onload = function () { resolve(im.src); };
      im.onerror = function () {
        if (fallback && !usedFallback) { usedFallback = true; im.src = fallback; return; }
        reject(new Error('이미지 로드 실패'));
      };
      im.src = url;
    });
    preloadCache[url] = promise;
    promise.catch(function () { delete preloadCache[url]; });
    return promise;
  }

  function fullFallback(p) { return p.driveId ? API.driveThumbFallback(p.driveId, 'w2000') : ''; }

  function openViewer(index) {
    if (!state.photos.length) return;
    viewer.index = index;
    viewer.open = true;
    var v = $('viewer');
    v.hidden = false;
    v.style.backgroundColor = '';
    lockScroll();
    showPhoto(0);
    requestAnimationFrame(function () { v.classList.add('is-open'); });
    openLayer('viewer', closeViewerNow);
    try { $('viewerClose').focus({ preventScroll: true }); } catch (e) { /* 무시 */ }
  }

  function closeViewerNow() {
    viewer.open = false;
    viewer.token++;
    var v = $('viewer');
    v.classList.remove('is-open');
    setTimeout(function () {
      if (viewer.open) return;
      v.hidden = true;
      $('viewerImg').removeAttribute('src');
    }, 300);
    unlockScroll();
  }

  function showPhoto(dir) {
    var p = currentPhoto();
    if (!p) return;
    var n = state.photos.length;
    var img = $('viewerImg');
    var token = ++viewer.token;

    setText('viewerCount', (viewer.index + 1) + ' / ' + n);
    var desc = $('viewerDesc');
    desc.textContent = p.description || '';
    desc.hidden = !p.description;
    setText('viewerCommentCount', p.commentCount || 0);
    img.alt = p.description || ((viewer.index + 1) + '번째 웨딩 사진');
    $('viewerPrev').hidden = $('viewerNext').hidden = n < 2;
    $('viewerError').hidden = true;

    var spinnerTimer = setTimeout(function () { if (token === viewer.token) $('viewerSpinner').hidden = false; }, 180);
    var outDone = dir ? animateOut(img, dir) : Promise.resolve();
    var loaded = preload(p.url, fullFallback(p)).catch(function () { return null; });

    Promise.all([outDone, loaded]).then(function (res) {
      if (token !== viewer.token) return;
      clearTimeout(spinnerTimer);
      $('viewerSpinner').hidden = true;
      if (!res[1]) {
        img.removeAttribute('src');
        $('viewerError').hidden = false;
        return;
      }
      img.src = res[1];
      animateIn(img, dir);
    });

    // 앞뒤 사진 미리 불러오기
    if (n > 1) {
      [1, -1].forEach(function (d) {
        var q = state.photos[(viewer.index + d + n) % n];
        preload(q.url, fullFallback(q)).catch(function () { /* 무시 */ });
      });
    }
  }

  function animateOut(img, dir) {
    return new Promise(function (resolve) {
      img.style.transition = 'transform .2s ease-in, opacity .2s ease-in';
      img.style.transform = 'translateX(' + (dir > 0 ? -16 : 16) + '%)';
      img.style.opacity = '0';
      setTimeout(resolve, 200);
    });
  }

  function animateIn(img, dir) {
    img.style.transition = 'none';
    img.style.transform = dir ? 'translateX(' + (dir > 0 ? 16 : -16) + '%)' : 'scale(.97)';
    img.style.opacity = '0';
    void img.offsetWidth; // 강제 리플로우로 시작 위치 확정
    img.style.transition = 'transform .34s cubic-bezier(.22,.61,.36,1), opacity .34s ease';
    img.style.transform = 'none';
    img.style.opacity = '1';
  }

  function go(delta) {
    var n = state.photos.length;
    if (n < 2) return;
    viewer.index = (viewer.index + delta + n) % n;
    showPhoto(delta);
  }

  function bindViewer() {
    var stage = $('viewerStage');
    var img = $('viewerImg');
    var v = $('viewer');
    var sx = 0, sy = 0, dx = 0, dy = 0, t0 = 0, axis = null, active = false, pid = null;

    stage.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (e.target.closest && e.target.closest('button')) return;
      active = true;
      pid = e.pointerId;
      sx = e.clientX; sy = e.clientY; dx = 0; dy = 0; axis = null; t0 = Date.now();
      try { stage.setPointerCapture(pid); } catch (x) { /* 무시 */ }
      img.style.transition = 'none';
    });
    stage.addEventListener('pointermove', function (e) {
      if (!active || e.pointerId !== pid) return;
      dx = e.clientX - sx;
      dy = e.clientY - sy;
      if (!axis && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (axis === 'x') {
        img.style.transform = 'translateX(' + dx + 'px)';
      } else if (axis === 'y' && dy > 0) {
        img.style.transform = 'translateY(' + dy + 'px) scale(' + Math.max(0.85, 1 - dy / 1400) + ')';
        v.style.backgroundColor = 'rgba(22, 18, 15, ' + Math.max(0.45, 0.97 - dy / 500) + ')';
      }
    });
    function end(e) {
      if (!active || (e && e.pointerId !== pid)) return;
      active = false;
      var quick = Date.now() - t0 < 280;
      if (axis === 'x' && state.photos.length > 1 && (Math.abs(dx) > 60 || (quick && Math.abs(dx) > 25))) {
        go(dx < 0 ? 1 : -1);
      } else if (axis === 'y' && dy > 110) {
        closeTopLayer(); // 아래로 쓸어내리면 닫기
      } else {
        img.style.transition = 'transform .25s ease';
        img.style.transform = 'none';
        v.style.backgroundColor = '';
      }
      axis = null;
    }
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);

    $('viewerPrev').addEventListener('click', function () { go(-1); });
    $('viewerNext').addEventListener('click', function () { go(1); });
    $('viewerClose').addEventListener('click', closeTopLayer);
    $('viewerCommentBtn').addEventListener('click', openComments);

    document.addEventListener('keydown', function (e) {
      if (sheet.open) {
        if (e.key === 'Escape') closeTopLayer();
        return;
      }
      if (!viewer.open) return;
      if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'Escape') closeTopLayer();
    });
  }

  /* ------------------------------------------------------- 사진 댓글 */

  var sheet = { open: false, photoId: null, token: 0 };

  function openComments() {
    var p = currentPhoto();
    if (!p) return;
    sheet.open = true;
    sheet.photoId = p.id;
    var s = $('commentSheet');
    s.hidden = false;
    var thumb = $('sheetThumb');
    thumb.style.visibility = '';
    thumb.onerror = function () { thumb.style.visibility = 'hidden'; };
    thumb.src = p.thumb;
    setText('sheetCount', p.commentCount || 0);
    $('commentList').textContent = '';
    clearFormError($('commentForm'));
    requestAnimationFrame(function () { s.classList.add('is-open'); });
    openLayer('comments', closeCommentsNow);
    loadComments(p.id);
  }

  function closeCommentsNow() {
    sheet.open = false;
    sheet.token++;
    var s = $('commentSheet');
    s.classList.remove('is-open');
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    setTimeout(function () {
      if (sheet.open) return;
      s.hidden = true;
      sheet.photoId = null;
    }, 400);
  }

  function loadComments(photoId) {
    var token = ++sheet.token;
    showState('commentState', 'loading');
    API.photoComments(photoId).then(function (res) {
      if (token !== sheet.token) return;
      var ul = $('commentList');
      ul.textContent = '';
      (res.items || []).forEach(function (c) { ul.appendChild(commentItem(c, false)); });
      if (!res.items || !res.items.length) showState('commentState', 'empty', '아직 댓글이 없어요. 첫 댓글을 남겨주세요 💌');
      else hideState('commentState');
      setCommentCount(photoId, res.count);
    }).catch(function (err) {
      if (token !== sheet.token) return;
      showState('commentState', 'error', '댓글을 불러오지 못했어요. ' + err.message, function () { loadComments(photoId); });
    });
  }

  function commentItem(c, isNew) {
    return el('li', { class: 'comment' + (isNew ? ' is-new' : '') }, [
      el('div', { class: 'comment__head' }, [
        el('span', { class: 'comment__name', text: c.nickname }),
        el('time', { class: 'comment__time', datetime: c.createdAt, text: formatTime(c.createdAt) })
      ]),
      el('p', { class: 'comment__text', text: c.comment })
    ]);
  }

  /* ------------------------------------------------------------ 폼 공통 */

  function clearFormError(form) {
    var box = form.querySelector('.form__error');
    box.hidden = true;
    box.textContent = '';
    Array.prototype.forEach.call(form.querySelectorAll('.is-invalid'), function (n) { n.classList.remove('is-invalid'); });
  }

  /**
   * 작성 폼 연결
   *  - 필수값·글자 수 검사(서버에서도 다시 검사)
   *  - 전송 중 버튼 잠금 → 더블탭 중복 제출 방지
   *  - requestId: 같은 내용을 재전송하면 서버가 한 번만 저장
   *  - 실패해도 입력 내용은 지우지 않음
   */
  function setupForm(form, opts) {
    var btn = form.querySelector('button[type="submit"]');
    var errorBox = form.querySelector('.form__error');
    var idleText = btn.textContent;
    var busy = false;

    var savedNick = store.get('wd_nick');
    if (savedNick && form.elements.nickname && !form.elements.nickname.value) form.elements.nickname.value = savedNick;

    function updateCounters() {
      Array.prototype.forEach.call(form.querySelectorAll('.counter'), function (c) {
        var input = form.elements[c.getAttribute('data-for')];
        var max = Number(input.getAttribute('maxlength')) || 0;
        var len = charLen(input.value);
        c.textContent = len + ' / ' + max;
        c.classList.toggle('is-over', max && len > max);
      });
    }
    function showError(message, input) {
      errorBox.textContent = message;
      errorBox.hidden = false;
      if (input) input.classList.add('is-invalid');
    }

    form.addEventListener('input', function (e) {
      delete form.dataset.rid; // 내용이 바뀌면 새 요청으로 취급
      if (e.target && e.target.classList) e.target.classList.remove('is-invalid');
      errorBox.hidden = true;
      updateCounters();
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (busy) return;
      clearFormError(form);

      var values = {};
      for (var i = 0; i < opts.fields.length; i++) {
        var f = opts.fields[i];
        var input = form.elements[f.name];
        var value = input.value.replace(/\r\n?/g, '\n').trim();
        if (!value) { showError(f.empty, input); input.focus(); return; }
        if (charLen(value) > f.max) { showError(f.tooLong, input); input.focus(); return; }
        values[f.name] = value;
      }
      values.website = form.elements.website ? form.elements.website.value : '';
      if (!form.dataset.rid) form.dataset.rid = API.uuid();
      values.requestId = form.dataset.rid;
      values.clientId = clientId;

      busy = true;
      btn.disabled = true;
      btn.textContent = '등록 중…';

      opts.submit(values).then(function (res) {
        delete form.dataset.rid;
        store.set('wd_nick', values.nickname);
        Array.prototype.forEach.call(document.querySelectorAll('input[name="nickname"]'), function (n) {
          if (!n.value) n.value = values.nickname; // 다른 폼에도 같은 닉네임 미리 채우기
        });
        opts.fields.forEach(function (f) { if (f.name !== 'nickname') form.elements[f.name].value = ''; });
        updateCounters();
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        opts.onSuccess(res || {});
      }).catch(function (err) {
        showError(err.message || '저장하지 못했어요. 잠시 후 다시 시도해 주세요.');
        if (err.code === 'VALIDATION' || err.code === 'DUPLICATE' || err.code === 'NOT_FOUND') delete form.dataset.rid;
      }).then(function () {
        busy = false;
        btn.disabled = false;
        btn.textContent = idleText;
      });
    });

    updateCounters();
  }

  function bindForms() {
    setupForm($('commentForm'), {
      fields: [
        { name: 'nickname', max: 20, empty: '닉네임을 입력해 주세요.', tooLong: '닉네임은 20자 이내로 입력해 주세요.' },
        { name: 'comment', max: 300, empty: '댓글 내용을 입력해 주세요.', tooLong: '댓글은 300자 이내로 입력해 주세요.' }
      ],
      submit: function (values) {
        values.photoId = sheet.photoId;
        return API.addComment(values);
      },
      onSuccess: function (res) {
        if (!res.comment) return;
        hideState('commentState');
        var ul = $('commentList');
        ul.insertBefore(commentItem(res.comment, true), ul.firstChild);
        ul.parentNode.scrollTop = 0;
        var p = findPhoto(res.comment.photoId);
        setCommentCount(res.comment.photoId, typeof res.count === 'number' ? res.count : (p ? (p.commentCount || 0) + 1 : 1));
        toast('댓글이 등록되었어요');
      }
    });

    setupForm($('guestbookForm'), {
      fields: [
        { name: 'nickname', max: 20, empty: '닉네임을 입력해 주세요.', tooLong: '닉네임은 20자 이내로 입력해 주세요.' },
        { name: 'message', max: 500, empty: '축하 메시지를 입력해 주세요.', tooLong: '축하 메시지는 500자 이내로 입력해 주세요.' }
      ],
      submit: function (values) { return API.addGuestbook(values); },
      onSuccess: function (res) {
        if (!res.entry) return;
        var list = $('gbList');
        if (!state.gbIds[res.entry.id]) {
          state.gbIds[res.entry.id] = true;
          list.insertBefore(gbItem(res.entry, true), list.firstChild);
          state.gbTotal += 1;
        }
        updateGuestbookMeta();
        toast('축하 메시지가 등록되었어요. 감사합니다 💌');
      }
    });
  }

  /* -------------------------------------------------------------- 방명록 */

  function gbItem(x, isNew) {
    return el('li', { class: 'gb-item' + (isNew ? ' is-new' : '') }, [
      el('div', { class: 'gb-item__head' }, [
        el('strong', { class: 'gb-item__name', text: x.nickname }),
        el('time', { class: 'gb-item__time', datetime: x.createdAt, text: formatTime(x.createdAt) })
      ]),
      el('p', { class: 'gb-item__msg', text: x.message })
    ]);
  }

  function setGuestbook(page, append) {
    var list = $('gbList');
    if (!append) {
      state.gbIds = {};
      list.textContent = '';
    }
    (page.items || []).forEach(function (x) {
      if (state.gbIds[x.id]) return;
      state.gbIds[x.id] = true;
      list.appendChild(gbItem(x, false));
    });
    state.gbCursor = page.nextCursor || null;
    state.gbHasMore = !!page.hasMore;
    state.gbTotal = page.total || 0;
    updateGuestbookMeta();
  }

  function updateGuestbookMeta() {
    var total = $('gbTotal');
    total.textContent = '';
    if (state.gbTotal > 0) {
      total.appendChild(document.createTextNode('지금까지 '));
      total.appendChild(el('b', { text: state.gbTotal + '개' }));
      total.appendChild(document.createTextNode('의 축하 메시지가 도착했어요'));
    }
    $('gbMore').hidden = !state.gbHasMore;
    if (!state.gbTotal) showState('gbState', 'empty', '아직 작성된 메시지가 없어요.\n첫 번째 축하를 남겨주세요!');
    else hideState('gbState');
  }

  function loadMoreGuestbook() {
    if (state.gbLoading || !state.gbCursor) return;
    state.gbLoading = true;
    var btn = $('gbMore');
    btn.disabled = true;
    btn.textContent = '불러오는 중…';
    API.guestbook(state.gbCursor, CFG.guestbook.pageSize || 10)
      .then(function (page) {
        var total = state.gbTotal;
        setGuestbook(page, true);
        if (page.total < total) state.gbTotal = total;
      })
      .catch(function (err) { toast(err.message, true); })
      .then(function () {
        state.gbLoading = false;
        btn.disabled = false;
        btn.textContent = '더 보기';
      });
  }

  /* ---------------------------------------------------------- 데이터 로드 */

  function loadAll(isRefresh) {
    if (!isRefresh) {
      renderGallerySkeleton();
      hideState('galleryState');
      showState('gbState', 'loading');
    }
    return API.bootstrap().then(function (data) {
      state.lastSync = Date.now();
      applyServerContent(data.content, data.settings);
      releaseContentGate();
      var photos = data.photos || [];
      var gb = data.guestbook || { items: [], total: 0 };

      if (!isRefresh) {
        state.photos = photos;
        renderGallery();
        setGuestbook(gb, false);
        return;
      }

      // 다시 화면으로 돌아왔을 때: 사진 구성이 같으면 댓글 수만, 다르면 갤러리를 새로 그림
      var same = photos.length === state.photos.length &&
        photos.every(function (p, i) { return p.id === state.photos[i].id; });
      if (same) photos.forEach(function (p) { setCommentCount(p.id, p.commentCount); });
      else if (!viewer.open) { state.photos = photos; renderGallery(); }

      var list = $('gbList');
      (gb.items || []).filter(function (x) { return !state.gbIds[x.id]; }).reverse().forEach(function (x) {
        state.gbIds[x.id] = true;
        list.insertBefore(gbItem(x, true), list.firstChild);
      });
      state.gbTotal = gb.total || state.gbTotal;
      updateGuestbookMeta();
    }).catch(function (err) {
      releaseContentGate();
      if (isRefresh) return;
      $('galleryGrid').textContent = '';
      showState('galleryState', 'error', '사진을 불러오지 못했어요. ' + err.message, function () { loadAll(false); });
      showState('gbState', 'error', '방명록을 불러오지 못했어요.', function () { loadAll(false); });
    });
  }

  /* ------------------------------------------------------------- 기타 */

  function setupReveal() {
    var items = document.querySelectorAll('.reveal');
    if (!('IntersectionObserver' in window)) {
      Array.prototype.forEach.call(items, function (n) { n.classList.add('is-in'); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          en.target.classList.add('is-in');
          io.unobserve(en.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    Array.prototype.forEach.call(items, function (n) { io.observe(n); });
  }

  function bindMisc() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-scroll-to]'), function (b) {
      b.addEventListener('click', function () {
        var target = $(b.getAttribute('data-scroll-to'));
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
    $('toTop').addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });
    $('copyAddress').addEventListener('click', function () { copyText(CFG.venue.address || '', '주소를 복사했어요'); });
    $('galleryMore').addEventListener('click', function () {
      state.expanded = true;
      state.shown = state.photos.length;
      renderGallery();
    });
    $('gbMore').addEventListener('click', loadMoreGuestbook);

    var pageUrl = location.href.split('#')[0];
    $('shareBtn').addEventListener('click', function () {
      if (navigator.share) {
        navigator.share({ title: document.title, text: '저희 결혼식에 초대합니다.', url: pageUrl }).catch(function () { /* 사용자가 취소 */ });
      } else {
        copyText(pageUrl, '청첩장 링크를 복사했어요');
      }
    });
    $('copyLinkBtn').addEventListener('click', function () { copyText(pageUrl, '청첩장 링크를 복사했어요'); });

    Array.prototype.forEach.call(document.querySelectorAll('[data-sheet-close]'), function (b) {
      b.addEventListener('click', closeTopLayer);
    });

    // 다른 앱에 갔다가 돌아오면(60초 이상) 댓글 수·새 방명록을 다시 확인
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && state.lastSync && Date.now() - state.lastSync > 60000) loadAll(true);
    });

    if (API.isDemo) $('demoBanner').hidden = false;
  }

  /* ------------------------------------------------------------- 시작 */

  renderInfo();
  renderAccounts();
  renderMainPhotos();
  bindViewer();
  bindForms();
  bindMisc();
  setupReveal();
  loadAll(false);
})();
