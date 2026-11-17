/**
 * ==========================================================================
 *  모바일 청첩장 백엔드  |  Code.gs
 *  Google Apps Script(V8) + Google Sheets(데이터베이스) + Google Drive(사진)
 * --------------------------------------------------------------------------
 *  [프론트엔드 ↔ 백엔드 통신 규약]
 *
 *   GET  {웹앱URL}?action=ping                         서버 상태 확인
 *   GET  {웹앱URL}?action=bootstrap                    첫 화면 데이터(설정·사진·댓글수·방명록 1페이지)
 *   GET  {웹앱URL}?action=photoComments&photoId=...    사진별 댓글 목록
 *   GET  {웹앱URL}?action=guestbook&cursor=...&limit=10  방명록 다음 페이지
 *
 *   POST {웹앱URL}   본문 = JSON 문자열, Content-Type: text/plain
 *        { action: 'addComment',   photoId, nickname, comment, requestId, clientId, website }
 *        { action: 'addGuestbook', nickname, message, requestId, clientId, website }
 *        { action: 'adminLogin',   password }  →  { token }
 *        { action: 'admin…',       token, ... }   관리자 전용 (서버에서 토큰 검증)
 *
 *   응답(항상 JSON)  { ok: true, data: {...} }
 *                    { ok: false, error: { code: 'VALIDATION', message: '...' } }
 *
 *  ※ POST를 text/plain 으로 보내는 이유
 *    application/json 으로 보내면 브라우저가 CORS 사전요청(OPTIONS)을 먼저 보내는데,
 *    Apps Script 웹앱은 OPTIONS 를 처리할 수 없어 요청이 실패합니다.
 *    text/plain 은 "단순 요청"이라 사전요청 없이 바로 전달됩니다.
 *
 *  ※ 보안 요약
 *    - 스프레드시트/드라이브 접근은 서버(이 스크립트)만 합니다. 프론트엔드에는 인증정보가 없습니다.
 *    - 관리자 비밀번호는 PBKDF2(HMAC-SHA256)+솔트로 해시하여 '스크립트 속성'에만 저장됩니다.
 *    - 관리자 기능은 매 요청마다 서버에서 세션 토큰을 검증합니다.
 *    - 모든 입력값은 서버에서 다시 검증하고, 시트 수식 주입(=, +, -, @)을 차단합니다.
 *    - LockService 로 동시 쓰기를 직렬화하고, requestId 로 중복 제출을 막습니다.
 * ==========================================================================
 */

var APP = {
  VERSION: '1.0.0',
  TZ: 'Asia/Seoul',

  SHEETS: {
    COMMENTS:  { name: 'PHOTO_COMMENTS', headers: ['comment_id', 'photo_id', 'nickname', 'comment', 'created_at', 'photo_name'] },
    GUESTBOOK: { name: 'GUESTBOOK',      headers: ['guestbook_id', 'nickname', 'message', 'created_at'] },
    PHOTOS:    { name: 'PHOTO_LIST',     headers: ['photo_id', 'image_url', 'sort_order', 'description', 'drive_file_id', 'file_name', 'created_at'] },
    SETTINGS:  { name: 'SETTINGS',       headers: ['key', 'value', 'description'] }
  },

  SETTING_KEYS: ['wedding_date', 'wedding_time', 'groom_name', 'bride_name',
                 'venue_name', 'venue_address', 'venue_detail', 'contact_info'],

  LIMITS: {
    NICKNAME: 20,             // 닉네임 최대 글자 수
    COMMENT: 300,             // 사진 댓글 최대 글자 수
    MESSAGE: 500,             // 방명록 최대 글자 수
    DESCRIPTION: 200,         // 사진 설명 최대 글자 수
    PAGE_DEFAULT: 10,         // 방명록 한 번에 불러오는 개수
    PAGE_MAX: 50,
    UPLOAD_BYTES: 10 * 1024 * 1024,  // 사진 1장 최대 10MB (프론트에서 자동 축소되므로 보통 1MB 내외)
    BODY_CHARS: 16 * 1024 * 1024
  },

  RATE: {
    GLOBAL_PER_MIN: 120,      // 전체 하객 합산 1분당 최대 작성 수 (스팸 폭주 방지)
    CLIENT_PER_MIN: 6,        // 한 기기(브라우저)당 1분 최대 작성 수
    DUP_WINDOW_SEC: 120       // 같은 내용 재등록 차단 시간(초)
  },

  ADMIN: {
    SESSION_SEC: 21600,       // 관리자 로그인 유지 6시간 (CacheService 최대치)
    MAX_FAILS: 5,             // 연속 실패 허용 횟수
    FAIL_WINDOW_SEC: 900,     // 실패 횟수 집계 구간(15분)
    LOCK_SEC: 900,            // 초과 시 로그인 잠금(15분)
    ITERATIONS: 1000,         // 비밀번호 해시 반복 횟수
    MIN_PASSWORD: 8
  },

  LOCK_WAIT_MS: 20000,        // 동시 쓰기 대기 최대 시간
  CACHE_TTL_SEC: 60,          // 첫 화면 데이터 캐시 시간(시트를 직접 고친 경우 최대 60초 뒤 반영)
  CACHE_KEY: 'bootstrap_v1',
  DRIVE_FOLDER_NAME: '모바일청첩장_사진'
};


/* ==========================================================================
 *  1. 진입점 (doGet / doPost)
 * ========================================================================== */

function doGet(e) {
  return respond_(function () {
    var p = (e && e.parameter) || {};
    var action = String(p.action || 'ping');

    if (action === 'ping') {
      return { service: 'wedding-invitation-api', version: APP.VERSION, time: new Date().toISOString() };
    }
    if (action === 'bootstrap') return getBootstrap_();
    if (action === 'photoComments') return getPhotoComments_(p.photoId);
    if (action === 'guestbook') return getGuestbookPage_(p.cursor, p.limit);

    throw apiError_('UNKNOWN_ACTION', '지원하지 않는 요청입니다.');
  });
}

function doPost(e) {
  return respond_(function () {
    var body = parseBody_(e);
    var action = String(body.action || '');

    var publicRoutes = {
      addComment: addComment_,
      addGuestbook: addGuestbook_,
      adminLogin: adminLogin_,
      adminLogout: adminLogout_
    };
    if (hasOwn_(publicRoutes, action)) return publicRoutes[action](body);

    var adminRoutes = {
      adminVerify: function () { return { valid: true }; },
      adminData: adminData_,
      adminDeleteComment: adminDeleteComment_,
      adminDeleteGuestbook: adminDeleteGuestbook_,
      adminUploadPhoto: adminUploadPhoto_,
      adminAddPhotoUrl: adminAddPhotoUrl_,
      adminUpdatePhotos: adminUpdatePhotos_,
      adminDeletePhoto: adminDeletePhoto_,
      adminSaveContent: adminSaveContent_
    };
    if (hasOwn_(adminRoutes, action)) {
      requireAdmin_(body.token);          // ★ 모든 관리자 기능은 서버에서 먼저 권한 확인
      return adminRoutes[action](body);
    }

    throw apiError_('UNKNOWN_ACTION', '지원하지 않는 요청입니다.');
  });
}

/** 공통 응답 래퍼: 예외를 잡아 항상 JSON 으로 응답합니다. */
function respond_(fn) {
  var payload;
  try {
    payload = { ok: true, data: fn() };
  } catch (err) {
    if (err && err.apiCode) {
      payload = { ok: false, error: { code: err.apiCode, message: err.message } };
    } else {
      console.error('[SERVER_ERROR]', err && err.stack ? err.stack : err);
      payload = { ok: false, error: { code: 'SERVER_ERROR', message: '서버에서 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' } };
    }
  }
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function apiError_(code, message) {
  var err = new Error(message);
  err.apiCode = code;
  return err;
}

function parseBody_(e) {
  var raw = e && e.postData && e.postData.contents;
  if (!raw) throw apiError_('BAD_REQUEST', '요청 내용이 비어 있습니다.');
  if (raw.length > APP.LIMITS.BODY_CHARS) throw apiError_('TOO_LARGE', '요청 크기가 너무 큽니다.');
  var body;
  try { body = JSON.parse(raw); } catch (x) { throw apiError_('BAD_REQUEST', '요청 형식이 올바르지 않습니다.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw apiError_('BAD_REQUEST', '요청 형식이 올바르지 않습니다.');
  return body;
}


/* ==========================================================================
 *  2. 공개 조회 API
 * ========================================================================== */

/** 첫 화면에 필요한 데이터를 한 번에 돌려줍니다. (요청 수 최소화 + 60초 캐시) */
function getBootstrap_() {
  var cache = CacheService.getScriptCache();
  // 데이터 버전이 키에 포함되므로, 읽는 도중 새 글이 저장돼도 오래된 캐시가 다시 쓰이지 않습니다.
  var key = APP.CACHE_KEY + '_' + dataVersion_(cache);
  var hit = cache.get(key);
  if (hit) {
    try { return JSON.parse(hit); } catch (x) { /* 캐시 손상 시 새로 생성 */ }
  }

  var counts = commentCounts_();
  var data = {
    settings: readSettings_(),
    content: readContent_(),
    photos: listPhotos_().map(function (p) { return publicPhoto_(p, counts[p.id] || 0); }),
    guestbook: getGuestbookPage_(null, APP.LIMITS.PAGE_DEFAULT),
    generatedAt: new Date().toISOString()
  };

  try {
    var json = JSON.stringify(data);
    if (json.length < 95000) cache.put(key, json, APP.CACHE_TTL_SEC); // CacheService 값 한도 100KB
  } catch (x) { /* 캐시 실패는 무시 */ }
  return data;
}

function getPhotoComments_(photoId) {
  var id = cleanId_(photoId);
  var items = readTable_(sheet_(APP.SHEETS.COMMENTS)).rows
    .filter(function (r) { return str_(r.comment_id) && str_(r.photo_id) === id; })
    .map(function (r) {
      var c = publicComment_(r);
      c._ms = toMs_(r.created_at);
      c._row = r._row;
      return c;
    })
    .sort(function (a, b) { return (b._ms - a._ms) || (b._row - a._row); }) // 같은 시각이면 나중 행이 위로
    .map(function (c) { delete c._ms; delete c._row; return c; });
  return { photoId: id, items: items, count: items.length };
}

/** 방명록 페이지 조회 (최신순, 커서 기반 페이지네이션 → 새 글이 생겨도 중복/누락 없음) */
function getGuestbookPage_(cursor, limit) {
  var size = Math.min(Math.max(parseInt(limit, 10) || APP.LIMITS.PAGE_DEFAULT, 1), APP.LIMITS.PAGE_MAX);
  var all = allGuestbook_();

  var start = 0;
  var c = parseCursor_(cursor);
  if (c) {
    start = all.length;
    for (var i = 0; i < all.length; i++) {
      if (all[i]._ms < c.ms || (all[i]._ms === c.ms && all[i].id < c.id)) { start = i; break; }
    }
  }

  var page = all.slice(start, start + size);
  var hasMore = start + size < all.length;
  var last = page[page.length - 1];
  return {
    items: page.map(function (x) { return { id: x.id, nickname: x.nickname, message: x.message, createdAt: x.createdAt }; }),
    total: all.length,
    hasMore: hasMore,
    nextCursor: hasMore && last ? (last._ms + '_' + last.id) : null
  };
}

/** 방명록 전체 (최신순) */
function allGuestbook_() {
  return readTable_(sheet_(APP.SHEETS.GUESTBOOK)).rows
    .filter(function (r) { return str_(r.guestbook_id); })
    .map(function (r) {
      return {
        id: str_(r.guestbook_id),
        nickname: str_(r.nickname),
        message: str_(r.message),
        createdAt: toIso_(r.created_at),
        _ms: toMs_(r.created_at)
      };
    })
    .sort(byNewest_);
}

function parseCursor_(cursor) {
  var m = /^(\d{1,16})_([A-Za-z0-9_-]{1,64})$/.exec(String(cursor || ''));
  return m ? { ms: Number(m[1]), id: m[2] } : null;
}

function byNewest_(a, b) {
  var am = a._ms !== undefined ? a._ms : toMs_(a.createdAt);
  var bm = b._ms !== undefined ? b._ms : toMs_(b.createdAt);
  if (bm !== am) return bm - am;
  return a.id < b.id ? 1 : (a.id > b.id ? -1 : 0);
}


/* ==========================================================================
 *  3. 공개 작성 API (사진 댓글 / 방명록)
 * ========================================================================== */

function addComment_(body) {
  if (isBot_(body)) return { comment: null, count: null };

  var photoId = cleanId_(body.photoId);
  var nickname = cleanText_(body.nickname, '닉네임', APP.LIMITS.NICKNAME, false);
  var comment = cleanText_(body.comment, '댓글', APP.LIMITS.COMMENT, true);

  var photo = findPhoto_(photoId);
  if (!photo) throw apiError_('NOT_FOUND', '사진을 찾을 수 없습니다. 페이지를 새로고침해 주세요.');

  return guardedWrite_(body, ['comment', photoId, nickname, comment], function (now) {
    var row = {
      comment_id: newId_('c'),
      photo_id: photoId,
      nickname: nickname,
      comment: comment,
      created_at: now,
      photo_name: photo.fileName || photo.description || photoId
    };
    appendObject_(APP.SHEETS.COMMENTS, row);
    return { comment: publicComment_(row), count: countComments_(photoId) };
  });
}

function addGuestbook_(body) {
  if (isBot_(body)) return { entry: null };

  var nickname = cleanText_(body.nickname, '닉네임', APP.LIMITS.NICKNAME, false);
  var message = cleanText_(body.message, '축하 메시지', APP.LIMITS.MESSAGE, true);

  return guardedWrite_(body, ['guestbook', nickname, message], function (now) {
    var row = { guestbook_id: newId_('g'), nickname: nickname, message: message, created_at: now };
    appendObject_(APP.SHEETS.GUESTBOOK, row);
    return {
      entry: { id: row.guestbook_id, nickname: nickname, message: message, createdAt: row.created_at.toISOString() }
    };
  });
}

/** 스팸봇 함정(보이지 않는 입력칸 'website')이 채워져 있으면 저장하지 않습니다. */
function isBot_(body) {
  return String(body.website || '').trim() !== '';
}

/**
 * 쓰기 작업 보호막
 *  1) 스크립트 잠금(LockService)으로 동시 쓰기를 한 줄로 세움
 *  2) requestId 가 같으면 이전 결과를 그대로 반환 (네트워크 재시도/더블탭 중복 방지)
 *  3) 전체·기기별 분당 작성 수 제한
 *  4) 같은 내용 연속 등록 차단
 */
function guardedWrite_(body, dupParts, writer) {
  var cache = CacheService.getScriptCache();
  var requestId = cleanToken_(body.requestId);
  var clientId = cleanToken_(body.clientId);

  return withLock_(function () {
    if (requestId) {
      var prev = cache.get('req_' + requestId);
      if (prev) return JSON.parse(prev);
    }

    if (!bumpRate_(cache, 'g', APP.RATE.GLOBAL_PER_MIN)) {
      throw apiError_('RATE_LIMIT', '지금 작성 요청이 많아요. 1분 뒤에 다시 시도해 주세요.');
    }
    if (clientId && !bumpRate_(cache, 'c_' + clientId, APP.RATE.CLIENT_PER_MIN)) {
      throw apiError_('RATE_LIMIT', '너무 빠르게 작성하고 있어요. 잠시 후 다시 시도해 주세요.');
    }

    var dupKey = 'dup_' + sha256Hex_(dupParts.concat([clientId]).join('|' + String.fromCharCode(1) + '|'));
    if (cache.get(dupKey)) throw apiError_('DUPLICATE', '같은 내용이 방금 등록되었어요.');

    // 작성 시각이 겹치지 않도록(항상 증가) 보정 → 정렬·페이지 순서가 흔들리지 않음
    var nowMs = Date.now();
    var lastMs = Number(cache.get('last_write_ms') || 0);
    if (nowMs <= lastMs) nowMs = lastMs + 1;
    cache.put('last_write_ms', String(nowMs), 21600);

    var result = writer(new Date(nowMs));
    SpreadsheetApp.flush();

    cache.put(dupKey, '1', APP.RATE.DUP_WINDOW_SEC);
    if (requestId) cache.put('req_' + requestId, JSON.stringify(result), 600);
    invalidateCache_();
    return result;
  }, '지금 작성하는 분들이 많아 잠시 지연되고 있어요. 잠시 후 다시 시도해 주세요.');
}

function bumpRate_(cache, key, limit) {
  var bucket = Math.floor(Date.now() / 60000);
  var k = 'rl_' + key + '_' + bucket;
  var n = Number(cache.get(k) || 0);
  if (n >= limit) return false;
  cache.put(k, String(n + 1), 90);
  return true;
}


/* ==========================================================================
 *  4. 관리자 인증
 *     - 비밀번호: 스프레드시트 메뉴에서 설정 → 해시만 '스크립트 속성'에 저장
 *     - 로그인 성공 시 256비트 무작위 토큰 발급, 서버 캐시에는 토큰의 해시만 저장
 *     - 5회 연속 실패 시 15분간 로그인 잠금
 * ========================================================================== */

function adminLogin_(body) {
  var props = PropertiesService.getScriptProperties();
  var hash = props.getProperty('ADMIN_PW_HASH');
  var salt = props.getProperty('ADMIN_PW_SALT');
  var iterations = Number(props.getProperty('ADMIN_PW_ITER')) || APP.ADMIN.ITERATIONS;
  if (!hash || !salt) {
    throw apiError_('NOT_CONFIGURED', '관리자 비밀번호가 아직 설정되지 않았습니다. 스프레드시트 메뉴 [💌 청첩장 관리 → 관리자 비밀번호 설정]을 먼저 실행해 주세요.');
  }

  var cache = CacheService.getScriptCache();
  if (cache.get('adm_lock')) {
    throw apiError_('LOCKED', '로그인 실패가 반복되어 잠시 잠겼습니다. 15분 후 다시 시도해 주세요.');
  }

  var password = typeof body.password === 'string' ? body.password : '';
  var ok = password.length > 0 && password.length <= 128 &&
           safeEqual_(pbkdf2_(password, salt, iterations), hash);

  if (!ok) {
    try {
      withLock_(function () {
        var fails = Number(cache.get('adm_fail') || 0) + 1;
        if (fails >= APP.ADMIN.MAX_FAILS) {
          cache.put('adm_lock', '1', APP.ADMIN.LOCK_SEC);
          cache.remove('adm_fail');
        } else {
          cache.put('adm_fail', String(fails), APP.ADMIN.FAIL_WINDOW_SEC);
        }
      });
    } catch (x) { /* 잠금 대기 실패 시에도 로그인은 거부 */ }
    Utilities.sleep(700); // 무차별 대입 속도 늦추기
    throw apiError_('AUTH_FAILED', '비밀번호가 올바르지 않습니다.');
  }

  cache.remove('adm_fail');
  var token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').toLowerCase();
  cache.put('adm_s_' + sha256Hex_(token), sessionEpoch_(), APP.ADMIN.SESSION_SEC);
  return { token: token, expiresIn: APP.ADMIN.SESSION_SEC };
}

function adminLogout_(body) {
  if (isTokenFormat_(body.token)) {
    CacheService.getScriptCache().remove('adm_s_' + sha256Hex_(body.token));
  }
  return { loggedOut: true };
}

function requireAdmin_(token) {
  if (!isTokenFormat_(token)) throw apiError_('UNAUTHORIZED', '관리자 로그인이 필요합니다.');
  var cache = CacheService.getScriptCache();
  var key = 'adm_s_' + sha256Hex_(token);
  var epoch = cache.get(key);
  if (!epoch || epoch !== sessionEpoch_()) {
    throw apiError_('UNAUTHORIZED', '로그인이 만료되었습니다. 다시 로그인해 주세요.');
  }
  cache.put(key, epoch, APP.ADMIN.SESSION_SEC); // 사용할 때마다 유지 시간 연장
}

function isTokenFormat_(token) {
  return typeof token === 'string' && /^[a-f0-9]{64}$/.test(token);
}

/** 비밀번호 변경·전체 로그아웃 시 값이 바뀌어 기존 세션이 모두 무효화됩니다. */
function sessionEpoch_() {
  return PropertiesService.getScriptProperties().getProperty('ADMIN_SESSION_EPOCH') || '1';
}

/** PBKDF2-HMAC-SHA256 (32바이트 1블록) */
function pbkdf2_(password, saltB64, iterations) {
  var key = Utilities.newBlob(password).getBytes();
  var block = Array.prototype.slice.call(Utilities.base64Decode(saltB64)).concat([0, 0, 0, 1]);
  var u = Utilities.computeHmacSha256Signature(block, key);
  var t = Array.prototype.slice.call(u);
  for (var i = 1; i < iterations; i++) {
    u = Utilities.computeHmacSha256Signature(u, key);
    for (var j = 0; j < t.length; j++) t[j] ^= u[j];
  }
  return Utilities.base64Encode(t);
}

/** 길이와 무관하게 끝까지 비교 (타이밍 공격 완화) */
function safeEqual_(a, b) {
  a = String(a); b = String(b);
  var diff = a.length ^ b.length;
  for (var i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}


/* ==========================================================================
 *  5. 관리자 기능
 * ========================================================================== */

function adminData_() {
  var counts = commentCounts_();
  var photos = listPhotos_();
  var photoMap = {};
  photos.forEach(function (p) { photoMap[p.id] = p; });

  var comments = readTable_(sheet_(APP.SHEETS.COMMENTS)).rows
    .filter(function (r) { return str_(r.comment_id); })
    .map(function (r) {
      var c = publicComment_(r);
      c.photoName = str_(r.photo_name);
      c.photoExists = !!photoMap[c.photoId];
      return c;
    })
    .sort(byNewest_);

  var guestbook = allGuestbook_().map(function (x) {
    return { id: x.id, nickname: x.nickname, message: x.message, createdAt: x.createdAt };
  });

  return {
    photos: photos.map(function (p) {
      var o = publicPhoto_(p, counts[p.id] || 0);
      o.fileName = p.fileName;
      o.order = p.order;
      return o;
    }),
    comments: comments,
    guestbook: guestbook,
    content: readContent_(),
    settings: readSettings_(),
    sheetUrl: ss_().getUrl()
  };
}

function adminDeleteComment_(body) {
  var id = cleanId_(body.commentId);
  if (!deleteRowsWhere_(APP.SHEETS.COMMENTS, 'comment_id', id)) {
    throw apiError_('NOT_FOUND', '이미 삭제되었거나 찾을 수 없는 댓글입니다.');
  }
  return { deleted: id };
}

function adminDeleteGuestbook_(body) {
  var id = cleanId_(body.guestbookId);
  if (!deleteRowsWhere_(APP.SHEETS.GUESTBOOK, 'guestbook_id', id)) {
    throw apiError_('NOT_FOUND', '이미 삭제되었거나 찾을 수 없는 방명록입니다.');
  }
  return { deleted: id };
}

/** 관리자 페이지에서 올린 사진(Base64)을 Drive 폴더에 저장하고 PHOTO_LIST 에 등록 */
function adminUploadPhoto_(body) {
  var types = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
  var mime = String(body.mimeType || '').toLowerCase();
  if (!hasOwn_(types, mime)) throw apiError_('VALIDATION', 'JPG, PNG, WEBP, GIF 형식의 사진만 올릴 수 있습니다.');

  var b64 = String(body.data || '').replace(/^data:[^,]*,/, '');
  if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw apiError_('VALIDATION', '사진 데이터가 올바르지 않습니다.');
  var bytes = Utilities.base64Decode(b64);
  if (bytes.length > APP.LIMITS.UPLOAD_BYTES) throw apiError_('TOO_LARGE', '사진 용량이 너무 큽니다. (최대 10MB)');
  if (!looksLikeImage_(bytes, mime)) throw apiError_('VALIDATION', '이미지 파일이 아닙니다.');

  var description = cleanOptional_(body.description, '사진 설명', APP.LIMITS.DESCRIPTION);
  var fileName = safeFileName_(body.fileName, types[mime]);

  var file = uploadFolder_().createFile(Utilities.newBlob(bytes, mime, fileName));
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (err) {
    try { file.setTrashed(true); } catch (x) { /* 무시 */ }
    throw apiError_('SHARING_FAILED', 'Google Drive "링크가 있는 모든 사용자" 공유 설정에 실패했습니다. 회사·학교 계정은 외부 공유가 막혀 있을 수 있으니 개인 Gmail 계정으로 운영해 주세요.');
  }

  var photo = addPhotoRow_({
    image_url: 'https://drive.google.com/file/d/' + file.getId() + '/view',
    drive_file_id: file.getId(),
    description: description,
    file_name: fileName
  });
  return { photo: photo };
}

/** Drive 공유 링크 또는 https 이미지 주소로 사진 추가 */
function adminAddPhotoUrl_(body) {
  var url = String(body.url || '').trim();
  if (!url || url.length > 1000) throw apiError_('VALIDATION', '사진 주소를 입력해 주세요.');
  var description = cleanOptional_(body.description, '사진 설명', APP.LIMITS.DESCRIPTION);

  var driveId = extractDriveId_(url);
  var warning = '';
  var fileName = '';
  if (driveId) {
    try {
      var f = DriveApp.getFileById(driveId);
      fileName = f.getName();
      f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (err) {
      warning = 'Drive 파일의 공유 설정을 바꾸지 못했습니다. 해당 파일이 "링크가 있는 모든 사용자 - 뷰어"로 공유되어 있는지 확인해 주세요.';
    }
    url = 'https://drive.google.com/file/d/' + driveId + '/view';
  } else if (!/^https:\/\/[^\s"'<>]+$/i.test(url) && !isRelativeImagePath_(url)) {
    throw apiError_('VALIDATION', 'Google Drive 공유 링크, https:// 로 시작하는 이미지 주소, 또는 images/파일명.jpg 형식의 경로만 사용할 수 있습니다.');
  }

  var photo = addPhotoRow_({
    image_url: url,
    drive_file_id: driveId || '',
    description: description,
    file_name: safeFileNameOrEmpty_(fileName)
  });
  return { photo: photo, warning: warning };
}

/** 사진 순서·설명 일괄 저장. items 배열의 순서가 곧 노출 순서입니다. */
function adminUpdatePhotos_(body) {
  var items = Array.isArray(body.items) ? body.items : null;
  if (!items || items.length > 1000) throw apiError_('VALIDATION', '저장할 사진 목록이 올바르지 않습니다.');

  var wanted = {};
  items.forEach(function (it, i) {
    var id = cleanId_(it && it.id);
    wanted[id] = {
      order: i + 1,
      description: cleanOptional_(it && it.description, '사진 설명', APP.LIMITS.DESCRIPTION)
    };
  });

  return withLock_(function () {
    var def = APP.SHEETS.PHOTOS;
    var sh = sheet_(def);
    var headers = ensureHeaders_(sh, def.headers);
    var lastRow = sh.getLastRow();
    if (lastRow < 2) return { updated: 0 };

    var idCol = headers.indexOf('photo_id');
    var orderCol = headers.indexOf('sort_order');
    var descCol = headers.indexOf('description');
    var ids = sh.getRange(2, idCol + 1, lastRow - 1, 1).getValues();
    var orders = sh.getRange(2, orderCol + 1, lastRow - 1, 1).getValues();
    var descs = sh.getRange(2, descCol + 1, lastRow - 1, 1).getValues();

    var updated = 0;
    for (var i = 0; i < ids.length; i++) {
      var w = wanted[str_(ids[i][0]).trim()];
      if (!w) {
        descs[i][0] = textCell_(descs[i][0]);
        continue;
      }
      orders[i][0] = w.order;
      descs[i][0] = textCell_(w.description);
      updated++;
    }
    sh.getRange(2, orderCol + 1, ids.length, 1).setValues(orders);
    sh.getRange(2, descCol + 1, ids.length, 1).setValues(descs);
    SpreadsheetApp.flush();
    invalidateCache_();
    return { updated: updated };
  });
}

function adminDeletePhoto_(body) {
  var photoId = cleanId_(body.photoId);
  var deleteFile = body.deleteFile !== false;
  var deleteComments = body.deleteComments !== false;

  var photo = findPhoto_(photoId);
  if (!photo) throw apiError_('NOT_FOUND', '이미 삭제되었거나 찾을 수 없는 사진입니다.');

  deleteRowsWhere_(APP.SHEETS.PHOTOS, 'photo_id', photoId);
  var removedComments = deleteComments ? deleteRowsWhere_(APP.SHEETS.COMMENTS, 'photo_id', photoId) : 0;

  var fileTrashed = false;
  var warning = '';
  if (deleteFile && photo.driveId) {
    try {
      // 안전장치: 이 시스템이 만든 업로드 폴더 안의 파일만 휴지통으로 보냅니다(30일 내 복구 가능).
      var file = DriveApp.getFileById(photo.driveId);
      var folderId = PropertiesService.getScriptProperties().getProperty('PHOTO_FOLDER_ID');
      var inUploadFolder = false;
      var parents = file.getParents();
      while (parents.hasNext()) if (parents.next().getId() === folderId) inUploadFolder = true;
      if (inUploadFolder) {
        file.setTrashed(true);
        fileTrashed = true;
      } else {
        warning = '업로드 폴더 밖에 있는 파일이라 Drive 원본은 그대로 두었습니다.';
      }
    } catch (err) {
      warning = 'Drive 원본 파일은 이동하지 못했습니다. 필요하면 Drive 에서 직접 삭제해 주세요.';
    }
  }
  return { deleted: photoId, removedComments: removedComments, fileTrashed: fileTrashed, warning: warning };
}


/* ==========================================================================
 *  6. 사진 목록 / 설정 읽기
 * ========================================================================== */

var _photoCache = null;

function listPhotos_(skipFix) {
  if (_photoCache) return _photoCache;
  var rows = readTable_(sheet_(APP.SHEETS.PHOTOS)).rows;
  var list = [];
  var missingId = false;

  rows.forEach(function (r) {
    var raw = str_(r.image_url).trim();
    if (!raw) return;
    var id = str_(r.photo_id).trim();
    if (!id) { missingId = true; return; }
    var storedDriveId = str_(r.drive_file_id).trim();
    var img = resolveImage_(raw, storedDriveId);
    if (!img) return;
    var order = Number(r.sort_order);
    list.push({
      id: id,
      url: img.url,
      thumb: img.thumb,
      driveId: img.driveId,
      description: str_(r.description),
      fileName: str_(r.file_name),
      order: isFinite(order) && str_(r.sort_order) !== '' ? order : 100000 + r._row,
      _row: r._row
    });
  });

  // 시트에 직접 사진을 추가하면서 photo_id 를 비워둔 경우 자동으로 채웁니다.
  if (missingId && !skipFix && fillMissingPhotoIds_() > 0) {
    _photoCache = null;
    return listPhotos_(true);
  }

  list.sort(function (a, b) { return (a.order - b.order) || (a._row - b._row); });
  _photoCache = list;
  return list;
}

function findPhoto_(photoId) {
  var list = listPhotos_();
  for (var i = 0; i < list.length; i++) if (list[i].id === photoId) return list[i];
  return null;
}

function publicPhoto_(p, count) {
  return { id: p.id, url: p.url, thumb: p.thumb, driveId: p.driveId, description: p.description, commentCount: count };
}

function addPhotoRow_(fields) {
  return withLock_(function () {
    var def = APP.SHEETS.PHOTOS;
    var sh = sheet_(def);
    var headers = ensureHeaders_(sh, def.headers);
    var maxOrder = 0;
    var lastRow = sh.getLastRow();
    if (lastRow >= 2) {
      var orderCol = headers.indexOf('sort_order');
      sh.getRange(2, orderCol + 1, lastRow - 1, 1).getValues().forEach(function (v) {
        var n = Number(v[0]);
        if (isFinite(n) && n > maxOrder) maxOrder = n;
      });
    }
    var row = {
      photo_id: newId_('p'),
      image_url: fields.image_url,
      sort_order: maxOrder + 1,
      description: fields.description || '',
      drive_file_id: fields.drive_file_id || '',
      file_name: fields.file_name || '',
      created_at: new Date()
    };
    appendObject_(def, row);
    SpreadsheetApp.flush();
    invalidateCache_();
    var img = resolveImage_(row.image_url, row.drive_file_id);
    return {
      id: row.photo_id, url: img.url, thumb: img.thumb, driveId: img.driveId,
      description: row.description, commentCount: 0, fileName: row.file_name, order: row.sort_order
    };
  });
}

function fillMissingPhotoIds_() {
  return withLock_(function () {
    var def = APP.SHEETS.PHOTOS;
    var sh = sheet_(def);
    var headers = ensureHeaders_(sh, def.headers);
    var lastRow = sh.getLastRow();
    if (lastRow < 2) return 0;
    var idCol = headers.indexOf('photo_id');
    var urlCol = headers.indexOf('image_url');
    var values = sh.getRange(2, 1, lastRow - 1, headers.length).getValues();
    var filled = 0;
    var ids = values.map(function (row) {
      var id = str_(row[idCol]).trim();
      if (!id && str_(row[urlCol]).trim()) { filled++; return [newId_('p')]; }
      return [textCell_(row[idCol])];
    });
    if (filled) {
      sh.getRange(2, idCol + 1, ids.length, 1).setValues(ids);
      SpreadsheetApp.flush();
      invalidateCache_();
    }
    return filled;
  });
}

/**
 * 사진 주소 해석
 *  - Google Drive 링크/파일ID → lh3.googleusercontent.com 이미지 주소(썸네일·원본 크기별)
 *  - https 이미지 주소 또는 images/xxx.jpg 같은 상대경로 → 그대로 사용
 */
function resolveImage_(raw, storedDriveId) {
  var driveId = storedDriveId || extractDriveId_(raw);
  if (driveId) {
    var base = 'https://lh3.googleusercontent.com/d/' + driveId;
    return { driveId: driveId, url: base + '=w2000', thumb: base + '=w600' };
  }
  if (/^https:\/\/[^\s"'<>]+$/i.test(raw) || isRelativeImagePath_(raw)) {
    return { driveId: '', url: raw, thumb: raw };
  }
  return null;
}

function extractDriveId_(s) {
  s = String(s || '').trim();
  if (/^[A-Za-z0-9_-]{25,}$/.test(s)) return s; // 파일 ID만 입력한 경우
  if (!/^https:\/\/([a-z0-9-]+\.)*(google\.com|googleusercontent\.com)\//i.test(s)) return '';
  var m = /\/d\/([A-Za-z0-9_-]{20,})/.exec(s) || /[?&]id=([A-Za-z0-9_-]{20,})/.exec(s);
  return m ? m[1] : '';
}

function isRelativeImagePath_(s) {
  return /^(\.\/)?[A-Za-z0-9_\-/]+\.(jpe?g|png|webp|gif|avif)$/i.test(s) && s.indexOf('..') === -1 && s.indexOf('//') === -1;
}

function readSettings_() {
  var out = {};
  readTable_(sheet_(APP.SHEETS.SETTINGS), true).rows.forEach(function (r) {
    var key = str_(r.key).trim();
    if (APP.SETTING_KEYS.indexOf(key) === -1) return;
    var v = str_(r.value).trim();
    if (key === 'wedding_date') v = normalizeDate_(v);
    if (key === 'wedding_time') v = normalizeTime_(v);
    if (v) out[key] = v.slice(0, 300);
  });
  return out;
}

/** '2027-05-15', '2027. 5. 15', '2027/05/15' → '2027-05-15' */
function normalizeDate_(v) {
  var m = /(\d{4})\D+(\d{1,2})\D+(\d{1,2})/.exec(v);
  if (!m) return '';
  return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
}

/** '13:30', '오후 1:30:00', '1:30 PM' → '13:30' */
function normalizeTime_(v) {
  var m = /(\d{1,2}):(\d{2})/.exec(v);
  if (!m) return '';
  var h = Number(m[1]);
  if (/(오후|PM)/i.test(v) && h < 12) h += 12;
  if (/(오전|AM)/i.test(v) && h === 12) h = 0;
  if (h > 23) return '';
  return ('0' + h).slice(-2) + ':' + m[2];
}


/* ==========================================================================
 *  6-1. 청첩장 내용 (관리자 페이지 [청첩장 내용] 탭)
 *   - 전체 내용을 SETTINGS 시트의 content_json 행에 JSON 으로 저장
 *   - 기본 8개 항목(wedding_date 등)도 같은 값으로 SETTINGS 시트에 함께 기록
 *   - 적용 우선순위: config.js < 관리자 저장 내용 < SETTINGS 시트 8개 값(시트에서 직접 고친 경우)
 * ========================================================================== */

var CONTENT_KEY = 'content_json';

function readContent_() {
  var rows = readTable_(sheet_(APP.SHEETS.SETTINGS)).rows;
  for (var i = 0; i < rows.length; i++) {
    if (str_(rows[i].key).trim() !== CONTENT_KEY) continue;
    var raw = str_(rows[i].value).trim();
    if (!raw) return null;
    try {
      var obj = JSON.parse(raw);
      return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
    } catch (err) {
      console.warn('content_json 형식 오류', err);
      return null;
    }
  }
  return null;
}

function adminSaveContent_(body) {
  var content = sanitizeContent_(body.content);
  var json = JSON.stringify(content);
  if (json.length > 45000) throw apiError_('TOO_LARGE', '내용이 너무 깁니다. 문구를 조금 줄여 주세요.');

  var sync = {
    wedding_date: content.wedding.date,
    wedding_time: content.wedding.time,
    groom_name: content.groom.name,
    bride_name: content.bride.name,
    venue_name: content.venue.name,
    venue_address: content.venue.address,
    venue_detail: content.venue.hall,
    contact_info: content.venue.tel
  };
  sync[CONTENT_KEY] = json;

  return withLock_(function () {
    var def = APP.SHEETS.SETTINGS;
    var sh = sheet_(def);
    var headers = ensureHeaders_(sh, def.headers);
    var keyCol = headers.indexOf('key');
    var valCol = headers.indexOf('value');
    var descCol = headers.indexOf('description');
    var lastRow = sh.getLastRow();
    var keys = lastRow >= 2
      ? sh.getRange(2, keyCol + 1, lastRow - 1, 1).getValues().map(function (r) { return str_(r[0]).trim(); })
      : [];

    Object.keys(sync).forEach(function (k) {
      var value = settingCell_(sync[k]);
      var idx = keys.indexOf(k);
      if (idx >= 0) {
        sh.getRange(idx + 2, valCol + 1).setValue(value);
      } else {
        var row = headers.map(function () { return ''; });
        row[keyCol] = k;
        row[valCol] = value;
        if (descCol >= 0) row[descCol] = k === CONTENT_KEY
          ? '관리자 페이지 [청첩장 내용]에서 저장한 전체 내용입니다. 직접 수정하지 마세요.'
          : '';
        sh.appendRow(row);
        keys.push(k);
      }
    });
    SpreadsheetApp.flush();
    invalidateCache_();
    return { content: content, settings: readSettings_() };
  });
}

/** SETTINGS 시트 값: 수식으로 해석될 수 있는 첫 글자 앞에 공백(읽을 때 trim 됨) */
function settingCell_(v) {
  var s = String(v === null || v === undefined ? '' : v);
  return /^[=+\-@]/.test(s) ? ' ' + s : s;
}

/** 관리자가 보낸 청첩장 내용을 항목별로 검증하고 허용된 항목만 남깁니다. */
function sanitizeContent_(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw apiError_('VALIDATION', '저장할 내용이 올바르지 않습니다.');
  }
  function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
  function txt(v, label, max, required, multiline) {
    if (required) return cleanText_(v, label, max, !!multiline);
    if (v === null || v === undefined || String(v).trim() === '') return '';
    return cleanText_(v, label, max, !!multiline);
  }
  function httpsUrl(v, label) {
    var s = String(v === null || v === undefined ? '' : v).trim();
    if (!s) return '';
    if (s.length > 500 || !/^https:\/\/[^\s"'<>]+$/i.test(s)) {
      throw apiError_('VALIDATION', label + josa_(label, '은는') + ' https:// 로 시작하는 주소여야 합니다.');
    }
    return s;
  }
  function imageUrl(v, label) {
    var s = String(v === null || v === undefined ? '' : v).trim();
    if (!s) return '';
    if (s.length <= 500 && (/^https:\/\/[^\s"'<>]+$/i.test(s) || isRelativeImagePath_(s))) return s;
    throw apiError_('VALIDATION', label + josa_(label, '은는') + ' https:// 주소 또는 images/파일명.jpg 형식이어야 합니다.');
  }
  function phone(v, label) {
    var s = txt(v, label, 30, false);
    if (s && !/^[0-9+\-(). ]+$/.test(s)) throw apiError_('VALIDATION', label + '에는 숫자와 - 기호만 입력해 주세요.');
    return s;
  }
  function person(p, who) {
    p = obj(p);
    var f = obj(p.father);
    var m = obj(p.mother);
    return {
      name: txt(p.name, who + ' 이름', 20, true),
      shortName: txt(p.shortName, who + ' 짧은 이름', 20),
      relation: txt(p.relation, who + ' 관계', 10),
      phone: phone(p.phone, who + ' 연락처'),
      father: { name: txt(f.name, who + ' 아버지 성함', 20), deceased: f.deceased === true },
      mother: { name: txt(m.name, who + ' 어머니 성함', 20), deceased: m.deceased === true }
    };
  }
  function accountList(list, side) {
    if (list !== undefined && !Array.isArray(list)) throw apiError_('VALIDATION', side + ' 계좌 목록이 올바르지 않습니다.');
    var out = [];
    (list || []).forEach(function (a) {
      a = obj(a);
      var empty = ['role', 'name', 'bank', 'number', 'kakaopay'].every(function (k) { return String(a[k] || '').trim() === ''; });
      if (empty) return;
      out.push({
        role: txt(a.role, side + ' 계좌 구분', 20),
        name: txt(a.name, side + ' 예금주', 20, true),
        bank: txt(a.bank, side + ' 은행', 20, true),
        number: txt(a.number, side + ' 계좌번호', 40, true),
        kakaopay: httpsUrl(a.kakaopay, side + ' 카카오페이 링크')
      });
    });
    if (out.length > 10) throw apiError_('VALIDATION', side + ' 계좌는 10개까지 등록할 수 있습니다.');
    return out;
  }

  var w = obj(input.wedding);
  var date = String(w.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date + 'T00:00:00Z'))) {
    throw apiError_('VALIDATION', '예식 날짜를 2027-05-15 형식으로 입력해 주세요.');
  }
  var time = normalizeTime_(String(w.time || ''));
  if (!time) throw apiError_('VALIDATION', '예식 시간을 입력해 주세요.');

  var v = obj(input.venue);
  var ph = obj(input.photos);
  var t = obj(input.texts);
  var acc = obj(input.accounts);

  if (input.transport !== undefined && !Array.isArray(input.transport)) {
    throw apiError_('VALIDATION', '교통 안내 목록이 올바르지 않습니다.');
  }
  var transport = [];
  (input.transport || []).forEach(function (item) {
    item = obj(item);
    var rawLines = Array.isArray(item.lines) ? item.lines : String(item.lines || '').split('\n');
    var lines = rawLines.map(function (l) { return txt(l, '교통 안내 내용', 150); }).filter(function (l) { return l; });
    var title = txt(item.title, '교통 안내 제목', 30);
    if (!title && !lines.length) return;
    if (!title) throw apiError_('VALIDATION', '교통 안내 제목을 입력해 주세요.');
    if (lines.length > 10) throw apiError_('VALIDATION', '교통 안내 한 항목에는 10줄까지 입력할 수 있습니다.');
    transport.push({ title: title, lines: lines });
  });
  if (transport.length > 12) throw apiError_('VALIDATION', '교통 안내는 12개까지 등록할 수 있습니다.');

  var initial = parseInt(obj(input.gallery).initialCount, 10);
  if (!isFinite(initial)) initial = 9;

  return {
    wedding: { date: date, time: time },
    groom: person(input.groom, '신랑'),
    bride: person(input.bride, '신부'),
    venue: {
      name: txt(v.name, '예식장 이름', 50, true),
      hall: txt(v.hall, '층·홀 이름', 50),
      address: txt(v.address, '예식장 주소', 150, true),
      tel: phone(v.tel, '예식장 전화번호'),
      naverMapUrl: httpsUrl(v.naverMapUrl, '네이버 지도 링크'),
      kakaoMapUrl: httpsUrl(v.kakaoMapUrl, '카카오맵 링크'),
      mapImage: imageUrl(v.mapImage, '약도 이미지')
    },
    photos: {
      main: imageUrl(ph.main, '대표 사진'),
      ending: imageUrl(ph.ending, '마무리 사진')
    },
    texts: {
      introMessage: txt(t.introMessage, '첫 화면 문구', 300, false, true),
      invitationTitle: txt(t.invitationTitle, '초대 제목', 60),
      invitationMessage: txt(t.invitationMessage, '초대의 글', 2000, false, true),
      accountMessage: txt(t.accountMessage, '계좌 안내 문구', 500, false, true),
      closingMessage: txt(t.closingMessage, '마무리 인사', 1500, false, true)
    },
    transport: transport,
    accounts: { groom: accountList(acc.groom, '신랑측'), bride: accountList(acc.bride, '신부측') },
    gallery: { initialCount: Math.min(Math.max(initial, 3), 60) }
  };
}


/* ==========================================================================
 *  7. 댓글 집계
 * ========================================================================== */

function commentCounts_() {
  var counts = {};
  columnValues_(APP.SHEETS.COMMENTS, 'photo_id').forEach(function (v) {
    var id = str_(v).trim();
    if (id) counts[id] = (counts[id] || 0) + 1;
  });
  return counts;
}

function countComments_(photoId) {
  return commentCounts_()[photoId] || 0;
}

function publicComment_(r) {
  return {
    id: str_(r.comment_id),
    photoId: str_(r.photo_id),
    nickname: str_(r.nickname),
    comment: str_(r.comment),
    createdAt: toIso_(r.created_at)
  };
}


/* ==========================================================================
 *  8. 시트 접근 공통 함수
 * ========================================================================== */

var _ss = null;
var _sheets = {};

function ss_() {
  if (_ss) return _ss;
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (id) {
    try { _ss = SpreadsheetApp.openById(id); return _ss; } catch (err) { console.warn('SPREADSHEET_ID 로 열기 실패', err); }
  }
  _ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!_ss) throw apiError_('NOT_CONFIGURED', '스프레드시트가 연결되지 않았습니다. 초기 설정(setupAll)을 먼저 실행해 주세요.');
  return _ss;
}

function sheet_(def) {
  if (_sheets[def.name]) return _sheets[def.name];
  var ss = ss_();
  var sh = ss.getSheetByName(def.name);
  if (!sh) {
    sh = withLock_(function () {
      var again = ss.getSheetByName(def.name);
      if (again) return again;
      var created = ss.insertSheet(def.name);
      created.getRange(1, 1, 1, def.headers.length).setValues([def.headers]);
      created.setFrozenRows(1);
      return created;
    });
  }
  _sheets[def.name] = sh;
  return sh;
}

/** 헤더 행을 확인하고 빠진 열은 오른쪽 끝에 추가합니다. 현재 헤더 배열을 반환합니다. */
function ensureHeaders_(sh, headers) {
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var current = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return str_(h).trim(); });
  if (current.every(function (h) { return h === ''; })) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    return headers.slice();
  }
  while (current.length && current[current.length - 1] === '') current.pop();
  var missing = headers.filter(function (h) { return current.indexOf(h) === -1; });
  if (missing.length) {
    sh.getRange(1, current.length + 1, 1, missing.length).setValues([missing]);
    current = current.concat(missing);
  }
  return current;
}

/** 시트를 [{헤더: 값, _row: 행번호}] 형태로 읽습니다. 열 순서가 바뀌어도 헤더 이름으로 찾습니다. */
function readTable_(sh, displayValues) {
  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return { headers: [], rows: [] };
  var range = sh.getRange(1, 1, lastRow, lastCol);
  var values = displayValues ? range.getDisplayValues() : range.getValues();
  var headers = values[0].map(function (h) { return str_(h).trim(); });
  var rows = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var empty = true;
    for (var c = 0; c < row.length; c++) if (row[c] !== '' && row[c] !== null) { empty = false; break; }
    if (empty) continue;
    var obj = { _row: r + 1 };
    for (var k = 0; k < headers.length; k++) if (headers[k] && !hasOwn_(obj, headers[k])) obj[headers[k]] = row[k];
    rows.push(obj);
  }
  return { headers: headers, rows: rows };
}

function columnValues_(def, header) {
  var sh = sheet_(def);
  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return [];
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return str_(h).trim(); });
  var col = headers.indexOf(header);
  if (col === -1) return [];
  return sh.getRange(2, col + 1, lastRow - 1, 1).getValues().map(function (r) { return r[0]; });
}

/** 객체를 헤더 순서에 맞춰 한 행으로 추가합니다. 문자열은 모두 '텍스트'로 저장(수식 주입 차단). */
function appendObject_(def, obj) {
  var sh = sheet_(def);
  var headers = ensureHeaders_(sh, def.headers);
  var row = headers.map(function (h) {
    if (!hasOwn_(obj, h)) return '';
    return textCell_(obj[h]);
  });
  sh.appendRow(row);
}

/**
 * 시트에 쓸 값 변환
 *  - 문자열 앞에 ' 를 붙이면 Google Sheets 는 이를 "순수 텍스트"로 저장합니다.
 *    → '=IMPORTXML(...)' 같은 수식 주입, '1/2' 가 날짜로 바뀌는 문제를 모두 막습니다.
 *    (' 기호 자체는 셀 값에 포함되지 않습니다)
 */
function textCell_(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date || typeof v === 'number' || typeof v === 'boolean') return v;
  var s = String(v);
  return s === '' ? '' : "'" + s;
}

/** 지정 열의 값이 id 와 같은 행을 모두 삭제합니다. 삭제한 행 수를 반환합니다. */
function deleteRowsWhere_(def, header, id) {
  return withLock_(function () {
    var sh = sheet_(def);
    var lastRow = sh.getLastRow();
    var lastCol = sh.getLastColumn();
    if (lastRow < 2) return 0;
    var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return str_(h).trim(); });
    var col = headers.indexOf(header);
    if (col === -1) return 0;
    var values = sh.getRange(2, col + 1, lastRow - 1, 1).getValues();
    var removed = 0;
    // 아래쪽부터 연속 구간 단위로 삭제 (행 번호가 밀리지 않도록)
    var i = values.length - 1;
    while (i >= 0) {
      if (str_(values[i][0]).trim() === id) {
        var end = i;
        while (i - 1 >= 0 && str_(values[i - 1][0]).trim() === id) i--;
        var count = end - i + 1;
        if (count === 1) sh.deleteRow(i + 2); else sh.deleteRows(i + 2, count);
        removed += count;
      }
      i--;
    }
    if (removed) {
      SpreadsheetApp.flush();
      invalidateCache_();
    }
    return removed;
  });
}

/**
 * 스크립트 잠금 안에서 실행합니다.
 * 같은 실행 안에서 중첩 호출되면(이미 잠금 보유) 다시 잠그지 않고 그대로 실행합니다.
 */
var _lockDepth = 0;
function withLock_(fn, busyMessage) {
  if (_lockDepth > 0) {
    _lockDepth++;
    try { return fn(); } finally { _lockDepth--; }
  }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(APP.LOCK_WAIT_MS)) {
    throw apiError_('BUSY', busyMessage || '요청이 많아 잠시 지연되고 있어요. 잠시 후 다시 시도해 주세요.');
  }
  _lockDepth = 1;
  try {
    return fn();
  } finally {
    _lockDepth = 0;
    lock.releaseLock();
  }
}

/** 데이터가 바뀌면 버전을 갱신해 첫 화면 캐시를 무효화합니다. */
function invalidateCache_() {
  _photoCache = null;
  try {
    CacheService.getScriptCache().put('data_ver', String(Date.now()) + Utilities.getUuid().slice(0, 4), 21600);
  } catch (err) { /* 무시 */ }
}

function dataVersion_(cache) {
  var v = cache.get('data_ver');
  if (!v) {
    v = String(Date.now());
    cache.put('data_ver', v, 21600);
  }
  return v;
}


/* ==========================================================================
 *  9. Drive
 * ========================================================================== */

function uploadFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('PHOTO_FOLDER_ID');
  if (id) {
    try {
      var existing = DriveApp.getFolderById(id);
      if (!existing.isTrashed()) return existing;
    } catch (err) { /* 폴더가 지워졌으면 새로 만듦 */ }
  }
  var folder = DriveApp.createFolder(APP.DRIVE_FOLDER_NAME);
  props.setProperty('PHOTO_FOLDER_ID', folder.getId());
  return folder;
}

/** 파일 앞부분(매직 넘버)으로 실제 이미지인지 확인 */
function looksLikeImage_(bytes, mime) {
  function b(i) { return bytes[i] & 0xff; }
  if (bytes.length < 12) return false;
  if (mime === 'image/jpeg') return b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff;
  if (mime === 'image/png') return b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47;
  if (mime === 'image/gif') return b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46;
  if (mime === 'image/webp') return b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46 &&
                                    b(8) === 0x57 && b(9) === 0x45 && b(10) === 0x42 && b(11) === 0x50;
  return false;
}

function safeFileName_(name, ext) {
  var base = String(name || '').replace(/\.[^.]*$/, '').replace(/[^\w\-가-힣 ]+/g, '').trim().slice(0, 60);
  if (!base) base = 'photo_' + Utilities.formatDate(new Date(), APP.TZ, 'yyyyMMdd_HHmmss');
  return base + '.' + ext;
}

function safeFileNameOrEmpty_(name) {
  return String(name || '').replace(/[\u0000-\u001f]/g, '').slice(0, 100);
}


/* ==========================================================================
 *  10. 입력값 검증 / 유틸리티
 * ========================================================================== */

/**
 * 사용자 입력 정리 + 검증
 *  - 제어문자, 보이지 않는 문자, 텍스트 방향 조작 문자 제거
 *  - 한 줄 입력은 공백 정리, 여러 줄 입력은 3줄 이상 빈 줄을 2줄로
 *  - 비어 있거나 최대 글자 수를 넘으면 오류
 *  ※ HTML 이스케이프는 '출력 시점'(프론트엔드 textContent)에 합니다.
 *    시트에는 사람이 읽을 수 있는 원문 그대로 저장됩니다.
 */
/** 제어문자·보이지 않는 문자·텍스트 방향 조작 문자 (소스에 특수문자를 직접 넣지 않도록 실행 시 생성) */
var INVISIBLE_CHARS_ = (function () {
  var ranges = [[0x00, 0x08], [0x0B, 0x0C], [0x0E, 0x1F], [0x7F, 0x9F], [0x200B, 0x200B], [0x200E, 0x200F],
                [0x2028, 0x2029], [0x202A, 0x202E], [0x2066, 0x2069], [0xFEFF, 0xFEFF]];
  function u(n) { return '\\u' + ('000' + n.toString(16)).slice(-4); }
  return new RegExp('[' + ranges.map(function (r) { return u(r[0]) + '-' + u(r[1]); }).join('') + ']', 'g');
})();

function cleanText_(value, label, max, multiline) {
  var s = typeof value === 'string' ? value : (value === null || value === undefined ? '' : String(value));
  if (s.length > max * 10) throw apiError_('VALIDATION', label + josa_(label, '은는') + ' ' + max + '자 이내로 입력해 주세요.');
  if (s.normalize) s = s.normalize('NFC');
  s = s.replace(/\r\n?/g, '\n')
       .replace(INVISIBLE_CHARS_, '');
  if (multiline) {
    s = s.replace(/[^\S\n]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  } else {
    s = s.replace(/\s+/g, ' ');
  }
  s = s.trim();
  if (!s) throw apiError_('VALIDATION', label + josa_(label, '을를') + ' 입력해 주세요.');
  if (charLength_(s) > max) throw apiError_('VALIDATION', label + josa_(label, '은는') + ' ' + max + '자 이내로 입력해 주세요.');
  return s;
}

function cleanOptional_(value, label, max) {
  if (value === null || value === undefined || String(value).trim() === '') return '';
  return cleanText_(value, label, max, false);
}

function cleanId_(v) {
  var s = String(v === null || v === undefined ? '' : v).trim();
  if (!s || s.length > 64 || /[\u0000-\u001f<>"'`]/.test(s)) throw apiError_('VALIDATION', '잘못된 요청입니다.');
  return s;
}

function cleanToken_(v) {
  return (typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v)) ? v : '';
}

function charLength_(s) {
  return Array.from(s).length; // 이모지 등도 1글자로 계산
}

/** 한글 조사 선택: josa_('닉네임','을를') → '을' */
function josa_(word, pair) {
  var code = word.charCodeAt(word.length - 1);
  var hasFinal = code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 !== 0;
  return hasFinal ? pair.charAt(0) : pair.charAt(1);
}

function newId_(prefix) {
  return prefix + '_' + Utilities.formatDate(new Date(), APP.TZ, 'yyMMdd') +
         Utilities.getUuid().replace(/-/g, '').slice(0, 10);
}

function sha256Hex_(s) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function str_(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function toMs_(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v > 100000000000 ? v : 0;
  var t = Date.parse(String(v || ''));
  return isNaN(t) ? 0 : t;
}

function toIso_(v) {
  var ms = toMs_(v);
  return ms ? new Date(ms).toISOString() : '';
}

function hasOwn_(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}
