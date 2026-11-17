/**
 * ==========================================================================
 *  모바일 청첩장 백엔드  |  Setup.gs
 *  - 스프레드시트 메뉴 "💌 청첩장 관리"
 *  - 시트 4개 자동 생성 및 서식 지정, Drive 사진 폴더 생성
 *  - 관리자 비밀번호 설정 (코드에 비밀번호를 적지 않도록 대화상자로 입력)
 *  - 자가 진단 테스트
 * ==========================================================================
 */

/** 스프레드시트를 열 때 메뉴를 추가합니다. */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('💌 청첩장 관리')
    .addItem('① 초기 설정 (시트·사진 폴더 만들기)', 'setupAll')
    .addItem('② 관리자 비밀번호 설정 / 변경', 'setAdminPassword')
    .addSeparator()
    .addItem('설정 상태 확인', 'showStatus')
    .addItem('자가 진단 테스트 실행', 'runSelfTest')
    .addSeparator()
    .addItem('시트를 직접 고친 뒤 즉시 반영하기', 'clearApiCache')
    .addItem('사진 ID 빈칸 자동 채우기', 'fillPhotoIds')
    .addItem('모든 관리자 로그아웃', 'revokeAdminSessions')
    .addItem('관리자 로그인 잠금 해제', 'unlockAdminLogin')
    .addToUi();
}

/** ① 초기 설정: 시트 생성/정리, 시간대 설정, 사진 폴더 생성 */
function setupAll() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error('이 스크립트는 스프레드시트에서 [확장 프로그램 → Apps Script]로 만든 프로젝트여야 합니다.');
  }
  var props = PropertiesService.getScriptProperties();
  props.setProperty('SPREADSHEET_ID', ss.getId());
  try { ss.setSpreadsheetTimeZone(APP.TZ); } catch (err) { /* 무시 */ }

  setupSheet_(ss, APP.SHEETS.PHOTOS, {
    widths: [150, 380, 90, 260, 260, 180, 160],
    dateCols: ['created_at']
  });
  setupSheet_(ss, APP.SHEETS.COMMENTS, {
    widths: [170, 150, 120, 380, 160, 180],
    dateCols: ['created_at'],
    wrapCols: ['comment']
  });
  setupSheet_(ss, APP.SHEETS.GUESTBOOK, {
    widths: [170, 120, 460, 160],
    dateCols: ['created_at'],
    wrapCols: ['message']
  });
  setupSheet_(ss, APP.SHEETS.SETTINGS, {
    widths: [160, 300, 460],
    textCols: ['value'],
    wrapCols: ['description']
  });
  seedSettings_(ss);
  removeEmptyDefaultSheet_(ss);
  ss.setActiveSheet(ss.getSheetByName(APP.SHEETS.SETTINGS.name));

  var folder = uploadFolder_();
  invalidateCache_();

  notify_('✅ 초기 설정 완료', [
    '시트 4개(PHOTO_LIST, PHOTO_COMMENTS, GUESTBOOK, SETTINGS)를 준비했습니다.',
    '사진 저장 폴더: ' + folder.getName(),
    folder.getUrl(),
    '',
    '다음 단계: 메뉴 [💌 청첩장 관리 → ② 관리자 비밀번호 설정]을 실행하세요.'
  ].join('\n'));
}

function setupSheet_(ss, def, opt) {
  var sh = ss.getSheetByName(def.name) || ss.insertSheet(def.name);
  _sheets[def.name] = sh;
  var headers = ensureHeaders_(sh, def.headers);

  var head = sh.getRange(1, 1, 1, headers.length);
  head.setFontWeight('bold').setBackground('#efe7dc').setFontColor('#5e4a3b');
  sh.setFrozenRows(1);

  (opt.widths || []).forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });

  var maxRows = sh.getMaxRows();
  (opt.dateCols || []).forEach(function (name) {
    var c = headers.indexOf(name) + 1;
    if (c > 0 && maxRows > 1) sh.getRange(2, c, maxRows - 1, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  });
  (opt.textCols || []).forEach(function (name) {
    var c = headers.indexOf(name) + 1;
    if (c > 0 && maxRows > 1) sh.getRange(2, c, maxRows - 1, 1).setNumberFormat('@'); // 날짜·시간 자동 변환 방지
  });
  (opt.wrapCols || []).forEach(function (name) {
    var c = headers.indexOf(name) + 1;
    if (c > 0 && maxRows > 1) sh.getRange(2, c, maxRows - 1, 1).setWrap(true);
  });

  // 머리글을 실수로 수정하면 경고가 뜨도록 보호(경고만, 편집은 가능)
  try {
    var exists = sh.getProtections(SpreadsheetApp.ProtectionType.RANGE).some(function (p) {
      return p.getDescription() === '청첩장 머리글';
    });
    if (!exists) head.protect().setDescription('청첩장 머리글').setWarningOnly(true);
  } catch (err) { /* 보호 설정 실패는 무시 */ }
  return sh;
}

function seedSettings_(ss) {
  var sh = ss.getSheetByName(APP.SHEETS.SETTINGS.name);
  var descriptions = {
    wedding_date: '예식 날짜. 예) 2027-05-15  ※ 비워두면 config.js 값을 사용합니다.',
    wedding_time: '예식 시간(24시간). 예) 13:30',
    groom_name: '신랑 이름. 예) 김민준',
    bride_name: '신부 이름. 예) 이서연',
    venue_name: '예식장 이름. 예) 더 그레이스 웨딩홀',
    venue_address: '예식장 도로명 주소 (지도 검색·주소 복사에 사용)',
    venue_detail: '층·홀 이름. 예) 3층 그랜드홀',
    contact_info: '예식장 대표 연락처. 예) 02-000-0000'
  };
  var existing = readTable_(sh).rows.map(function (r) { return str_(r.key).trim(); });
  var add = APP.SETTING_KEYS
    .filter(function (k) { return existing.indexOf(k) === -1; })
    .map(function (k) { return [k, '', descriptions[k] || '']; });
  if (add.length) {
    sh.getRange(sh.getLastRow() + 1, 1, add.length, 3).setValues(add);
  }
}

function removeEmptyDefaultSheet_(ss) {
  ['시트1', 'Sheet1'].forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (sh && ss.getSheets().length > 1 && sh.getLastRow() === 0 && sh.getLastColumn() === 0) {
      ss.deleteSheet(sh);
    }
  });
}


/* ---------------------------- 관리자 비밀번호 ---------------------------- */

/** ② 관리자 비밀번호 설정/변경 (스프레드시트 메뉴에서 실행) */
function setAdminPassword() {
  var ui;
  try { ui = SpreadsheetApp.getUi(); } catch (err) {
    Logger.log('이 기능은 스프레드시트 메뉴 [💌 청첩장 관리 → ② 관리자 비밀번호 설정]에서 실행해 주세요.');
    return;
  }
  var first = ui.prompt(
    '관리자 비밀번호 설정',
    APP.ADMIN.MIN_PASSWORD + '자 이상으로 입력하세요. (영문·숫자·기호 조합, 12자 이상 권장)\n' +
    '※ 입력 내용이 화면에 보이니 주변을 확인해 주세요.\n' +
    '※ 비밀번호는 암호화(해시)되어 저장되며 코드나 시트에는 남지 않습니다.',
    ui.ButtonSet.OK_CANCEL);
  if (first.getSelectedButton() !== ui.Button.OK) return;
  var pw = first.getResponseText();

  var second = ui.prompt('비밀번호 확인', '같은 비밀번호를 한 번 더 입력하세요.', ui.ButtonSet.OK_CANCEL);
  if (second.getSelectedButton() !== ui.Button.OK) return;
  if (second.getResponseText() !== pw) {
    ui.alert('두 비밀번호가 서로 다릅니다. 다시 시도해 주세요.');
    return;
  }

  try {
    setAdminPasswordValue_(pw);
  } catch (err) {
    ui.alert(err.message);
    return;
  }
  ui.alert('✅ 완료', '관리자 비밀번호가 저장되었습니다.\n기존에 로그인되어 있던 관리자 화면은 모두 로그아웃됩니다.', ui.ButtonSet.OK);
}

function setAdminPasswordValue_(pw) {
  pw = String(pw || '');
  if (pw.length < APP.ADMIN.MIN_PASSWORD) throw new Error('비밀번호는 ' + APP.ADMIN.MIN_PASSWORD + '자 이상이어야 합니다.');
  if (pw.length > 128) throw new Error('비밀번호가 너무 깁니다. (128자 이하)');
  if (pw.trim() !== pw) throw new Error('비밀번호 앞뒤에는 공백을 넣을 수 없습니다.');

  var randomBytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    Utilities.getUuid() + Utilities.getUuid() + Date.now(),
    Utilities.Charset.UTF_8);
  var salt = Utilities.base64Encode(Array.prototype.slice.call(randomBytes, 0, 16));
  var hash = pbkdf2_(pw, salt, APP.ADMIN.ITERATIONS);

  PropertiesService.getScriptProperties().setProperties({
    ADMIN_PW_HASH: hash,
    ADMIN_PW_SALT: salt,
    ADMIN_PW_ITER: String(APP.ADMIN.ITERATIONS),
    ADMIN_SESSION_EPOCH: String(Date.now())
  });
  CacheService.getScriptCache().removeAll(['adm_lock', 'adm_fail']);
}

function revokeAdminSessions() {
  PropertiesService.getScriptProperties().setProperty('ADMIN_SESSION_EPOCH', String(Date.now()));
  notify_('완료', '모든 관리자 로그인 세션을 해제했습니다.');
}

function unlockAdminLogin() {
  CacheService.getScriptCache().removeAll(['adm_lock', 'adm_fail']);
  notify_('완료', '관리자 로그인 잠금을 해제했습니다.');
}


/* ------------------------------ 유지 관리 ------------------------------ */

function clearApiCache() {
  invalidateCache_();
  notify_('완료', '캐시를 비웠습니다. 청첩장을 새로고침하면 시트 내용이 바로 반영됩니다.');
}

function fillPhotoIds() {
  var n = fillMissingPhotoIds_();
  notify_('완료', n ? ('비어 있던 사진 ID ' + n + '개를 채웠습니다.') : '비어 있는 사진 ID가 없습니다.');
}

function showStatus() {
  var props = PropertiesService.getScriptProperties();
  var lines = [];
  lines.push('관리자 비밀번호: ' + (props.getProperty('ADMIN_PW_HASH') ? '설정됨 ✅' : '미설정 ❌ (② 메뉴에서 설정하세요)'));
  try {
    var folder = uploadFolder_();
    lines.push('사진 폴더: ' + folder.getName() + '\n  ' + folder.getUrl());
  } catch (err) {
    lines.push('사진 폴더: 확인 실패 ❌ ' + err.message);
  }
  lines.push('사진: ' + listPhotos_().length + '장');
  lines.push('사진 댓글: ' + readTable_(sheet_(APP.SHEETS.COMMENTS)).rows.length + '개');
  lines.push('방명록: ' + readTable_(sheet_(APP.SHEETS.GUESTBOOK)).rows.length + '개');
  var settings = readSettings_();
  lines.push('SETTINGS 시트에서 적용 중인 값: ' + (Object.keys(settings).length ? Object.keys(settings).join(', ') : '없음 (config.js 값 사용)'));
  lines.push('서버 버전: ' + APP.VERSION);
  notify_('설정 상태', lines.join('\n'));
}

/**
 * 자가 진단: 실제로 시트에 방명록을 저장 → 조회 → 삭제해 봅니다.
 * (배포 전에 권한·시트 구조가 정상인지 확인하는 용도)
 */
function runSelfTest() {
  var lines = [];
  function step(name, fn) {
    try {
      var r = fn();
      lines.push('✅ ' + name + (r ? ' — ' + r : ''));
      return true;
    } catch (err) {
      lines.push('❌ ' + name + ' — ' + (err && err.message ? err.message : err));
      return false;
    }
  }

  step('시트 연결', function () {
    Object.keys(APP.SHEETS).forEach(function (k) { sheet_(APP.SHEETS[k]); });
    return ss_().getName();
  });

  var createdId = null;
  var ok = step('방명록 저장', function () {
    var res = addGuestbook_({
      nickname: '자가진단',
      message: '자가 진단 테스트 ' + Utilities.formatDate(new Date(), APP.TZ, 'yyyy-MM-dd HH:mm:ss'),
      requestId: 'selftest' + Date.now()
    });
    createdId = res.entry.id;
    return createdId;
  });

  if (ok) {
    step('방명록 조회', function () {
      var page = getGuestbookPage_(null, 5);
      var found = page.items.some(function (x) { return x.id === createdId; });
      if (!found) throw new Error('방금 저장한 글이 조회되지 않습니다.');
      return '전체 ' + page.total + '건';
    });
    step('방명록 삭제(관리자 기능)', function () {
      var n = deleteRowsWhere_(APP.SHEETS.GUESTBOOK, 'guestbook_id', createdId);
      if (n !== 1) throw new Error('삭제된 행 수: ' + n);
      return '테스트 글 삭제 완료';
    });
  }

  step('사진 목록 읽기', function () { return listPhotos_().length + '장'; });
  step('Drive 사진 폴더', function () { return uploadFolder_().getName(); });
  step('관리자 비밀번호', function () {
    if (!PropertiesService.getScriptProperties().getProperty('ADMIN_PW_HASH')) throw new Error('아직 설정되지 않았습니다.');
    return '설정됨';
  });

  notify_('자가 진단 결과', lines.join('\n'));
  return lines;
}

/** 스프레드시트 화면이면 알림창, 편집기에서 실행했으면 실행 로그에 출력 */
function notify_(title, message) {
  try {
    SpreadsheetApp.getUi().alert(title, message, SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (err) {
    Logger.log(title + '\n' + message);
  }
}
