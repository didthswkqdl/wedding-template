/* ==========================================================================
 *  mock.js — 미리보기 모드 전용 가짜 서버
 *  config.js 의 API_URL 이 비어 있을 때만 사용됩니다.
 *  데이터는 이 브라우저(localStorage)에만 임시 저장되며 Google Sheets 와 무관합니다.
 *  실제 운영(API_URL 입력 후)에서는 이 파일이 전혀 쓰이지 않습니다.
 * ========================================================================== */
(function () {
  'use strict';

  var KEY = 'wd_demo_db_v1';
  var memory = null;

  function placeholder(i, portrait) {
    var palettes = [
      ['#E9DCCB', '#BFA386'], ['#F1E8DC', '#CDB79C'], ['#E2D5C6', '#A98E74'],
      ['#EDE3D6', '#C7AE93'], ['#E6DED3', '#B8A089'], ['#F2EADF', '#D2BCA2']
    ];
    var p = palettes[i % palettes.length];
    var w = portrait ? 600 : 800;
    var h = portrait ? 800 : 600;
    var svg =
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 " + w + ' ' + h + "'>" +
      "<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>" +
      "<stop offset='0' stop-color='" + p[0] + "'/><stop offset='1' stop-color='" + p[1] + "'/></linearGradient></defs>" +
      "<rect width='100%' height='100%' fill='url(#g)'/>" +
      "<circle cx='" + (w * 0.72) + "' cy='" + (h * 0.3) + "' r='" + (w * 0.22) + "' fill='#fff' opacity='.16'/>" +
      "<circle cx='" + (w * 0.25) + "' cy='" + (h * 0.78) + "' r='" + (w * 0.14) + "' fill='#fff' opacity='.12'/>" +
      "<text x='50%' y='52%' text-anchor='middle' font-family='Georgia, serif' font-style='italic' font-size='" + Math.round(w / 11) +
      "' fill='#fff' opacity='.92'>Photo " + ('0' + (i + 1)).slice(-2) + '</text></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  function seed() {
    var now = Date.now();
    var photos = [];
    for (var i = 0; i < 12; i++) {
      var src = placeholder(i, i % 3 !== 1);
      photos.push({ id: 'demo_p' + (i + 1), url: src, thumb: src, driveId: '', description: i === 0 ? '처음 만난 봄날' : '', order: i + 1, fileName: 'sample_' + (i + 1) + '.jpg' });
    }
    return {
      photos: photos,
      comments: [
        { id: 'demo_c1', photoId: 'demo_p1', nickname: '지은', comment: '두 사람 너무 잘 어울려요 💛', createdAt: new Date(now - 3600e3 * 5).toISOString() },
        { id: 'demo_c2', photoId: 'demo_p1', nickname: '대학동기 현우', comment: '사진 분위기 최고!', createdAt: new Date(now - 3600e3 * 2).toISOString() },
        { id: 'demo_c3', photoId: 'demo_p3', nickname: '이모', comment: '예쁘다 우리 서연이', createdAt: new Date(now - 3600e3 * 26).toISOString() }
      ],
      guestbook: [
        { id: 'demo_g1', nickname: '민지', message: '결혼 진심으로 축하해!\n늘 지금처럼 행복하게 지내길 바랄게 :)', createdAt: new Date(now - 3600e3 * 30).toISOString() },
        { id: 'demo_g2', nickname: '회사 동료 수빈', message: '두 분의 새로운 출발을 응원합니다. 예쁜 가정 이루세요!', createdAt: new Date(now - 3600e3 * 8).toISOString() },
        { id: 'demo_g3', nickname: '준호', message: '축하한다 친구야 🎉', createdAt: new Date(now - 60e3 * 12).toISOString() }
      ]
    };
  }

  function db() {
    if (memory) return memory;
    try { memory = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { memory = null; }
    if (!memory || !memory.photos) memory = seed();
    return memory;
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(memory)); return true; } catch (e) { return false; }
  }

  function ok(data) { return { ok: true, data: JSON.parse(JSON.stringify(data)) }; }
  function fail(code, message) { return { ok: false, error: { code: code, message: message } }; }
  function newest(a, b) { return a.createdAt < b.createdAt ? 1 : (a.createdAt > b.createdAt ? -1 : 0); }
  function id(prefix) { return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  // label 예: ['닉네임', '을', '은']  → "닉네임을 입력해 주세요" / "닉네임은 20자 이내로…"
  function clean(v, label, max, multiline) {
    var s = String(v == null ? '' : v).replace(/\r\n?/g, '\n');
    s = multiline ? s.replace(/\n{3,}/g, '\n\n') : s.replace(/\s+/g, ' ');
    s = s.trim();
    if (!s) throw fail('VALIDATION', label[0] + label[1] + ' 입력해 주세요.');
    if (Array.from(s).length > max) throw fail('VALIDATION', label[0] + label[2] + ' ' + max + '자 이내로 입력해 주세요.');
    return s;
  }

  function counts() {
    var c = {};
    db().comments.forEach(function (x) { c[x.photoId] = (c[x.photoId] || 0) + 1; });
    return c;
  }

  function guestbookPage(cursor, limit) {
    var all = db().guestbook.slice().sort(newest);
    var start = 0;
    if (cursor) {
      var idx = all.findIndex(function (x) { return x.id === cursor; });
      start = idx >= 0 ? idx + 1 : all.length;
    }
    var size = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 50);
    var page = all.slice(start, start + size);
    var hasMore = start + size < all.length;
    return { items: page, total: all.length, hasMore: hasMore, nextCursor: hasMore ? page[page.length - 1].id : null };
  }

  function sortedPhotos() {
    return db().photos.slice().sort(function (a, b) { return a.order - b.order; });
  }

  var demoToken = 'demo'.repeat(16);

  function handleSync(method, p) {
    var d = db();
    var action = p.action;

    if (action === 'bootstrap') {
      var c = counts();
      return ok({
        settings: {},
        content: d.content || null,
        photos: sortedPhotos().map(function (x) { return Object.assign({}, x, { commentCount: c[x.id] || 0 }); }),
        guestbook: guestbookPage(null, 10)
      });
    }
    if (action === 'photoComments') {
      var items = d.comments.filter(function (x) { return x.photoId === p.photoId; }).sort(newest);
      return ok({ photoId: p.photoId, items: items, count: items.length });
    }
    if (action === 'guestbook') return ok(guestbookPage(p.cursor, p.limit));

    if (action === 'addComment') {
      var nick = clean(p.nickname, ['닉네임', '을', '은'], 20, false);
      var text = clean(p.comment, ['댓글', '을', '은'], 300, true);
      if (!d.photos.some(function (x) { return x.id === p.photoId; })) return fail('NOT_FOUND', '사진을 찾을 수 없습니다.');
      var cm = { id: id('c'), photoId: p.photoId, nickname: nick, comment: text, createdAt: new Date().toISOString() };
      d.comments.push(cm);
      save();
      return ok({ comment: cm, count: counts()[p.photoId] || 0 });
    }
    if (action === 'addGuestbook') {
      var gnick = clean(p.nickname, ['닉네임', '을', '은'], 20, false);
      var msg = clean(p.message, ['축하 메시지', '를', '는'], 500, true);
      var entry = { id: id('g'), nickname: gnick, message: msg, createdAt: new Date().toISOString() };
      d.guestbook.push(entry);
      save();
      return ok({ entry: entry });
    }

    if (action === 'adminLogin') {
      if (!p.password) return fail('AUTH_FAILED', '비밀번호를 입력해 주세요.');
      return ok({ token: demoToken, expiresIn: 21600 });
    }
    if (action === 'adminLogout') return ok({ loggedOut: true });
    if (action.indexOf('admin') === 0 && p.token !== demoToken) return fail('UNAUTHORIZED', '관리자 로그인이 필요합니다.');

    if (action === 'adminVerify') return ok({ valid: true });
    if (action === 'adminData') {
      var cc = counts();
      var map = {};
      d.photos.forEach(function (x) { map[x.id] = x; });
      return ok({
        photos: sortedPhotos().map(function (x) { return Object.assign({}, x, { commentCount: cc[x.id] || 0 }); }),
        comments: d.comments.slice().sort(newest).map(function (x) {
          return Object.assign({}, x, { photoName: map[x.photoId] ? map[x.photoId].fileName : '', photoExists: !!map[x.photoId] });
        }),
        guestbook: d.guestbook.slice().sort(newest),
        content: d.content || null,
        settings: {},
        sheetUrl: ''
      });
    }
    if (action === 'adminSaveContent') {
      var ct = p.content || {};
      if (!ct.groom || !String(ct.groom.name || '').trim()) return fail('VALIDATION', '신랑 이름을 입력해 주세요.');
      if (!ct.bride || !String(ct.bride.name || '').trim()) return fail('VALIDATION', '신부 이름을 입력해 주세요.');
      if (!ct.wedding || !/^\d{4}-\d{2}-\d{2}$/.test(ct.wedding.date || '')) return fail('VALIDATION', '예식 날짜를 2027-05-15 형식으로 입력해 주세요.');
      d.content = JSON.parse(JSON.stringify(ct));
      save();
      return ok({ content: d.content, settings: {} });
    }
    if (action === 'adminDeleteComment') {
      var before = d.comments.length;
      d.comments = d.comments.filter(function (x) { return x.id !== p.commentId; });
      if (before === d.comments.length) return fail('NOT_FOUND', '이미 삭제된 댓글입니다.');
      save();
      return ok({ deleted: p.commentId });
    }
    if (action === 'adminDeleteGuestbook') {
      var gb = d.guestbook.length;
      d.guestbook = d.guestbook.filter(function (x) { return x.id !== p.guestbookId; });
      if (gb === d.guestbook.length) return fail('NOT_FOUND', '이미 삭제된 방명록입니다.');
      save();
      return ok({ deleted: p.guestbookId });
    }
    if (action === 'adminUploadPhoto' || action === 'adminAddPhotoUrl') {
      var src = action === 'adminUploadPhoto' ? ('data:' + p.mimeType + ';base64,' + p.data) : String(p.url || '').trim();
      if (!src) return fail('VALIDATION', '사진 주소를 입력해 주세요.');
      if (action === 'adminAddPhotoUrl') src = window.WeddingAPI ? window.WeddingAPI.resolveImage(src) : src;
      var maxOrder = d.photos.reduce(function (m, x) { return Math.max(m, x.order); }, 0);
      var photo = { id: id('p'), url: src, thumb: src, driveId: '', description: String(p.description || '').trim().slice(0, 200), order: maxOrder + 1, fileName: p.fileName || '' };
      d.photos.push(photo);
      if (!save()) {
        d.photos.pop();
        return fail('TOO_LARGE', '미리보기 모드의 브라우저 저장 공간이 부족합니다. (실제 운영에서는 Google Drive 에 저장됩니다)');
      }
      return ok({ photo: Object.assign({ commentCount: 0 }, photo), warning: '' });
    }
    if (action === 'adminUpdatePhotos') {
      (p.items || []).forEach(function (it, i) {
        var ph = d.photos.find(function (x) { return x.id === it.id; });
        if (ph) { ph.order = i + 1; ph.description = String(it.description || '').trim().slice(0, 200); }
      });
      save();
      return ok({ updated: (p.items || []).length });
    }
    if (action === 'adminDeletePhoto') {
      var n = d.photos.length;
      d.photos = d.photos.filter(function (x) { return x.id !== p.photoId; });
      if (n === d.photos.length) return fail('NOT_FOUND', '이미 삭제된 사진입니다.');
      var removed = 0;
      if (p.deleteComments !== false) {
        var m = d.comments.length;
        d.comments = d.comments.filter(function (x) { return x.photoId !== p.photoId; });
        removed = m - d.comments.length;
      }
      save();
      return ok({ deleted: p.photoId, removedComments: removed, fileTrashed: false, warning: '' });
    }
    return fail('UNKNOWN_ACTION', '지원하지 않는 요청입니다.');
  }

  window.WeddingMock = {
    handle: function (method, params) {
      return new Promise(function (resolve) {
        setTimeout(function () {
          try { resolve(handleSync(method, params || {})); }
          catch (e) { resolve(e && e.ok === false ? e : fail('SERVER_ERROR', String(e && e.message || e))); }
        }, 250 + Math.random() * 250);
      });
    },
    reset: function () { memory = null; try { localStorage.removeItem(KEY); } catch (e) { /* 무시 */ } }
  };
})();
