/* ==========================================================================
 *  admin.js — 관리자 페이지
 *  - 비밀번호는 서버(Apps Script)에서만 검증합니다. 이 파일에는 비밀번호가 없습니다.
 *  - 로그인 토큰은 sessionStorage 에만 보관 → 브라우저 탭을 닫으면 사라집니다.
 *  - 모든 관리자 요청은 POST 본문에 토큰을 담아 보내고, 서버가 매번 검증합니다.
 * ========================================================================== */
(function () {
  'use strict';

  var API = window.WeddingAPI;
  var TOKEN_KEY = 'wd_admin_token';
  var TAB_KEY = 'wd_admin_tab';

  var token = sessionGet(TOKEN_KEY);
  var data = { photos: [], comments: [], guestbook: [], sheetUrl: '' };
  var draft = [];        // 사진 순서·설명 편집본 [{id, description}]
  var dirty = false;
  var uploading = false;
  var contentDraft = null;  // 청첩장 내용 편집본
  var contentDirty = false;
  var requiredInputs = {};

  /* ------------------------------------------------------------ 유틸 */

  function $(id) { return document.getElementById(id); }
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
  function sessionGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function sessionSet(k, v) {
    try { if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) { /* 무시 */ }
  }
  function pad(n) { return ('0' + n).slice(-2); }
  function fullTime(iso) {
    var t = Date.parse(iso);
    if (isNaN(t)) return '';
    var k = new Date(t + 9 * 3600 * 1000);
    return k.getUTCFullYear() + '.' + pad(k.getUTCMonth() + 1) + '.' + pad(k.getUTCDate()) + ' ' +
           pad(k.getUTCHours()) + ':' + pad(k.getUTCMinutes());
  }

  var toastTimer = null;
  function toast(message, isError) {
    var t = $('toast');
    t.textContent = message;
    t.classList.toggle('is-error', !!isError);
    t.classList.add('is-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('is-show'); }, isError ? 4200 : 2400);
  }

  var loadingCount = 0;
  function setLoading(on) {
    loadingCount = Math.max(0, loadingCount + (on ? 1 : -1));
    $('loading').hidden = loadingCount === 0;
  }

  function thumbImg(p, cls) {
    var img = el('img', { class: cls || '', alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    var triedFallback = false;
    img.addEventListener('error', function () {
      if (p.driveId && !triedFallback) {
        triedFallback = true;
        img.src = API.driveThumbFallback(p.driveId, 'w300');
      }
    });
    img.src = p.thumb;
    return img;
  }

  /* ------------------------------------------------------------ 인증 */

  function showLogin(message) {
    $('dashView').hidden = true;
    $('loginView').hidden = false;
    var err = $('loginError');
    err.hidden = !message;
    err.textContent = message || '';
    setTimeout(function () { $('password').focus(); }, 50);
  }

  function showDash() {
    $('loginView').hidden = true;
    $('dashView').hidden = false;
  }

  /** 관리자 요청 공통: 세션이 만료되면 로그인 화면으로 */
  function req(action, payload, retries) {
    return API.admin.request(action, token, payload, retries).catch(function (err) {
      if (err.code === 'UNAUTHORIZED') {
        token = null;
        sessionSet(TOKEN_KEY, null);
        showLogin(err.message);
      }
      throw err;
    });
  }

  $('loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var input = $('password');
    var btn = $('loginBtn');
    var pw = input.value;
    if (!pw) { showLogin('비밀번호를 입력해 주세요.'); return; }
    btn.disabled = true;
    btn.textContent = '확인 중…';
    API.admin.login(pw).then(function (res) {
      token = res.token;
      sessionSet(TOKEN_KEY, token);
      input.value = '';
      $('loginError').hidden = true;
      showDash();
      loadData();
    }).catch(function (err) {
      showLogin(err.message);
      input.select();
    }).then(function () {
      btn.disabled = false;
      btn.textContent = '로그인';
    });
  });

  $('logoutBtn').addEventListener('click', function () {
    if ((dirty || uploading || contentDirty) && !confirm('저장하지 않은 변경 내용이 있습니다. 로그아웃할까요?')) return;
    var old = token;
    token = null;
    sessionSet(TOKEN_KEY, null);
    dirty = false;
    contentDirty = false;
    if (old) API.admin.logout(old).catch(function () { /* 무시 */ });
    showLogin('로그아웃되었습니다.');
  });

  /* ------------------------------------------------------------ 데이터 */

  function loadData() {
    setLoading(true);
    return req('adminData').then(function (d) {
      data = d;
      var fresh = d.photos.map(function (p) { return { id: p.id, description: p.description || '' }; });
      if (dirty) {
        // 저장 전 편집 내용은 유지하고, 새로 생긴 사진만 뒤에 붙입니다.
        var exists = {};
        fresh.forEach(function (x) { exists[x.id] = x; });
        var merged = draft.filter(function (x) { return exists[x.id]; });
        var seen = {};
        merged.forEach(function (x) { seen[x.id] = true; });
        fresh.forEach(function (x) { if (!seen[x.id]) merged.push(x); });
        draft = merged;
      } else {
        draft = fresh;
      }
      if (!contentDirty) contentDraft = API.buildContent(window.WEDDING_CONFIG, d.content, d.settings);
      var link = $('sheetLink');
      link.hidden = !/^https:\/\//.test(d.sheetUrl || '');
      if (!link.hidden) link.href = d.sheetUrl;
      renderAll();
    }).catch(function (err) {
      if (err.code !== 'UNAUTHORIZED') toast(err.message, true);
    }).then(function () { setLoading(false); });
  }

  function renderAll() {
    renderContentForm();
    renderStats();
    renderPhotos();
    renderCommentFilter();
    renderComments();
    renderGuestbook();
  }

  function photoById(id) {
    for (var i = 0; i < data.photos.length; i++) if (data.photos[i].id === id) return data.photos[i];
    return null;
  }

  function renderStats() {
    var box = $('stats');
    box.textContent = '';
    [['사진', data.photos.length + '장'], ['사진 댓글', data.comments.length + '개'], ['방명록', data.guestbook.length + '개']]
      .forEach(function (s) {
        box.appendChild(el('div', { class: 'stat' }, [
          el('div', { class: 'stat__label', text: s[0] }),
          el('div', { class: 'stat__value', text: s[1] })
        ]));
      });
  }

  /* ---------------------------------------------------------- 사진 관리 */

  function markDirty() {
    dirty = true;
    $('saveOrder').disabled = false;
  }

  function renderPhotos() {
    var ol = $('photoList');
    ol.textContent = '';
    $('photoCount').textContent = draft.length + '장';
    $('saveOrder').disabled = !dirty;
    if (!draft.length) {
      ol.appendChild(el('li', { class: 'empty', text: '등록된 사진이 없습니다. 위에서 사진을 추가해 주세요.' }));
      return;
    }
    draft.forEach(function (d, i) {
      var p = photoById(d.id);
      if (!p) return;
      var desc = el('input', { class: 'input input--sm', type: 'text', maxlength: '200', placeholder: '사진 설명 (선택)', 'aria-label': (i + 1) + '번 사진 설명' });
      desc.value = d.description;
      desc.addEventListener('input', function () { d.description = desc.value; markDirty(); });

      ol.appendChild(el('li', { class: 'photo-row' }, [
        el('span', { class: 'photo-row__no', text: String(i + 1) }),
        el('div', { class: 'photo-row__thumb' }, [thumbImg(p)]),
        el('div', { class: 'photo-row__body' }, [
          desc,
          el('div', { class: 'photo-row__meta', text: '댓글 ' + (p.commentCount || 0) + '개' + (p.fileName ? ' · ' + p.fileName : '') })
        ]),
        el('div', { class: 'photo-row__actions' }, [
          el('button', { class: 'arrow-btn', type: 'button', text: '↑', 'aria-label': '위로 이동', disabled: i === 0, onclick: function () { move(i, -1); } }),
          el('button', { class: 'arrow-btn', type: 'button', text: '↓', 'aria-label': '아래로 이동', disabled: i === draft.length - 1, onclick: function () { move(i, 1); } }),
          el('button', { class: 'btn btn--danger btn--xs', type: 'button', text: '삭제', onclick: function () { deletePhoto(p); } })
        ])
      ]));
    });
  }

  function move(i, delta) {
    var j = i + delta;
    if (j < 0 || j >= draft.length) return;
    var tmp = draft[i];
    draft[i] = draft[j];
    draft[j] = tmp;
    markDirty();
    renderPhotos();
    var buttons = $('photoList').children[j].querySelectorAll('.arrow-btn');
    var target = buttons[delta < 0 ? 0 : 1];
    if (target && !target.disabled) target.focus();
  }

  $('saveOrder').addEventListener('click', function () {
    var btn = $('saveOrder');
    btn.disabled = true;
    setLoading(true);
    req('adminUpdatePhotos', {
      items: draft.map(function (d) { return { id: d.id, description: d.description.trim() }; })
    }).then(function () {
      dirty = false;
      toast('사진 순서와 설명을 저장했습니다');
      return loadData();
    }).catch(function (err) {
      btn.disabled = false;
      if (err.code !== 'UNAUTHORIZED') toast(err.message, true);
    }).then(function () { setLoading(false); });
  });

  function deletePhoto(p) {
    var msg = '이 사진을 삭제할까요?\n\n' +
      '· 사진에 달린 댓글 ' + (p.commentCount || 0) + '개도 함께 삭제됩니다.\n' +
      '· 관리자 페이지로 올린 사진은 Google Drive 휴지통으로 이동합니다(30일 이내 복구 가능).';
    if (dirty) msg += '\n\n※ 저장하지 않은 순서·설명 변경은 유지됩니다.';
    if (!confirm(msg)) return;
    setLoading(true);
    req('adminDeletePhoto', { photoId: p.id, deleteFile: true, deleteComments: true }, 0).then(function (res) {
      var text = '사진을 삭제했습니다' + (res.removedComments ? ' (댓글 ' + res.removedComments + '개 포함)' : '');
      toast(res.warning ? text + '\n' + res.warning : text, !!res.warning);
      return loadData();
    }).catch(function (err) {
      if (err.code !== 'UNAUTHORIZED') toast(err.message, true);
    }).then(function () { setLoading(false); });
  }

  /* -------------------------------------------------------- 사진 업로드 */

  function loadBitmap(file) {
    if (window.createImageBitmap) {
      return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(function () { return loadViaImg(file); });
    }
    return loadViaImg(file);
  }
  function loadViaImg(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('이미지를 읽을 수 없습니다. (HEIC 사진은 JPG로 변환한 뒤 올려주세요)'));
      };
      img.src = url;
    });
  }
  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result).split(',')[1] || ''); };
      reader.onerror = function () { reject(new Error('파일을 읽지 못했습니다.')); };
      reader.readAsDataURL(blob);
    });
  }

  /** 사진을 긴 변 2048px JPEG 로 변환 (용량 절감 + 회전 정보 반영) */
  function prepareImage(file) {
    if (!/^image\//.test(file.type) && !/\.(jpe?g|png|webp|gif|heic|heif)$/i.test(file.name)) {
      return Promise.reject(new Error('이미지 파일이 아닙니다.'));
    }
    return loadBitmap(file).then(function (src) {
      var w = src.width;
      var h = src.height;
      if (!w || !h) throw new Error('이미지 크기를 확인할 수 없습니다.');
      var scale = Math.min(1, 2048 / Math.max(w, h));
      var cw = Math.round(w * scale);
      var ch = Math.round(h * scale);
      var canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(src, 0, 0, cw, ch);
      if (src.close) src.close();
      return new Promise(function (resolve, reject) {
        canvas.toBlob(function (blob) {
          if (blob) resolve(blob); else reject(new Error('이미지 변환에 실패했습니다.'));
        }, 'image/jpeg', 0.86);
      });
    }).then(function (blob) {
      return blobToBase64(blob).then(function (b64) {
        return {
          data: b64,
          size: blob.size,
          mimeType: 'image/jpeg',
          fileName: (file.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg'
        };
      });
    });
  }

  $('fileInput').addEventListener('change', function () {
    var files = Array.prototype.slice.call(this.files || []);
    this.value = '';
    if (files.length) uploadFiles(files);
  });

  function uploadFiles(files) {
    if (uploading) { toast('업로드가 진행 중입니다. 끝난 뒤 다시 시도해 주세요.', true); return; }
    uploading = true;
    var queue = $('uploadQueue');
    var rows = files.map(function (f) {
      var status = el('span', { class: 'q-status', text: '대기' });
      var li = el('li', null, [el('span', { class: 'q-name', text: f.name }), status]);
      queue.appendChild(li);
      return { file: f, status: status, li: li };
    });
    var success = 0;

    var chain = Promise.resolve();
    rows.forEach(function (r) {
      chain = chain.then(function () {
        if (!token) throw new Error('stop');
        r.status.textContent = '변환 중…';
        return prepareImage(r.file).then(function (img) {
          r.status.textContent = '업로드 중… ' + Math.round(img.size / 1024) + 'KB';
          return req('adminUploadPhoto', { fileName: img.fileName, mimeType: img.mimeType, data: img.data, description: '' }, 0);
        }).then(function () {
          success++;
          r.status.textContent = '완료';
          r.li.classList.add('is-done');
        }).catch(function (err) {
          if (err && err.message === 'stop') throw err;
          r.status.textContent = '실패 · ' + (err && err.message ? err.message : '알 수 없는 오류');
          r.li.classList.add('is-failed');
        });
      });
    });

    chain.catch(function () { /* 로그아웃 등으로 중단 */ }).then(function () {
      uploading = false;
      if (success) {
        toast(success + '장을 추가했습니다');
        loadData();
      }
      setTimeout(function () {
        Array.prototype.slice.call(queue.querySelectorAll('li.is-done')).forEach(function (li) { li.remove(); });
      }, 5000);
    });
  }

  $('urlForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var form = e.target;
    var url = form.elements.url.value.trim();
    if (!url) { toast('사진 주소를 입력해 주세요.', true); form.elements.url.focus(); return; }
    var btn = form.querySelector('button');
    btn.disabled = true;
    req('adminAddPhotoUrl', { url: url, description: form.elements.description.value.trim() }, 0).then(function (res) {
      form.reset();
      toast(res.warning ? '사진을 추가했습니다\n' + res.warning : '사진을 추가했습니다', !!res.warning);
      return loadData();
    }).catch(function (err) {
      if (err.code !== 'UNAUTHORIZED') toast(err.message, true);
    }).then(function () { btn.disabled = false; });
  });

  /* ---------------------------------------------------------- 사진 댓글 */

  function renderCommentFilter() {
    var select = $('commentFilter');
    var current = select.value;
    select.textContent = '';
    select.appendChild(el('option', { value: '', text: '전체 사진 (' + data.comments.length + ')' }));
    data.photos.forEach(function (p, i) {
      var n = data.comments.filter(function (c) { return c.photoId === p.id; }).length;
      select.appendChild(el('option', { value: p.id, text: (i + 1) + '번 사진' + (p.description ? ' · ' + p.description : '') + ' (' + n + ')' }));
    });
    var orphan = data.comments.filter(function (c) { return !c.photoExists; }).length;
    if (orphan) select.appendChild(el('option', { value: '__orphan', text: '삭제된 사진의 댓글 (' + orphan + ')' }));
    select.value = current;
    if (select.value !== current) select.value = '';
  }

  function renderComments() {
    var filter = $('commentFilter').value;
    var q = $('commentSearch').value.trim().toLowerCase();
    var list = data.comments.filter(function (c) {
      if (filter === '__orphan' && c.photoExists) return false;
      if (filter && filter !== '__orphan' && c.photoId !== filter) return false;
      return !q || (c.nickname + ' ' + c.comment).toLowerCase().indexOf(q) !== -1;
    });
    var ul = $('commentAdminList');
    ul.textContent = '';
    $('commentResult').textContent = list.length + '개의 댓글';
    if (!list.length) {
      ul.appendChild(el('li', { class: 'empty', text: '표시할 댓글이 없습니다.' }));
      return;
    }
    list.forEach(function (c) {
      var p = photoById(c.photoId);
      var idx = p ? data.photos.indexOf(p) : -1;
      ul.appendChild(el('li', { class: 'item' }, [
        p ? thumbImg(p, 'item__thumb') : el('div', { class: 'item__thumb item__thumb--none', text: '삭제됨' }),
        el('div', { class: 'item__body' }, [
          el('div', { class: 'item__head' }, [el('strong', { text: c.nickname }), el('time', { text: fullTime(c.createdAt) })]),
          el('p', { class: 'item__text', text: c.comment }),
          el('div', { class: 'item__sub', text: p ? (idx + 1) + '번 사진' + (p.description ? ' · ' + p.description : '') : (c.photoName || c.photoId) })
        ]),
        el('button', { class: 'btn btn--danger btn--xs', type: 'button', text: '삭제', onclick: function () { deleteComment(c); } })
      ]));
    });
  }

  function deleteComment(c) {
    if (!confirm('이 댓글을 삭제할까요? 삭제하면 되돌릴 수 없습니다.\n\n' + c.nickname + ' : ' + c.comment.slice(0, 80))) return;
    setLoading(true);
    req('adminDeleteComment', { commentId: c.id }, 0).then(function () {
      data.comments = data.comments.filter(function (x) { return x.id !== c.id; });
      var p = photoById(c.photoId);
      if (p) p.commentCount = Math.max(0, (p.commentCount || 0) - 1);
      renderStats();
      renderPhotos();
      renderCommentFilter();
      renderComments();
      toast('댓글을 삭제했습니다');
    }).catch(function (err) {
      if (err.code !== 'UNAUTHORIZED') toast(err.message, true);
    }).then(function () { setLoading(false); });
  }

  $('commentFilter').addEventListener('change', renderComments);
  $('commentSearch').addEventListener('input', renderComments);

  /* ------------------------------------------------------------ 방명록 */

  function renderGuestbook() {
    var q = $('gbSearch').value.trim().toLowerCase();
    var list = data.guestbook.filter(function (g) {
      return !q || (g.nickname + ' ' + g.message).toLowerCase().indexOf(q) !== -1;
    });
    var ul = $('gbAdminList');
    ul.textContent = '';
    $('gbResult').textContent = list.length + '개의 메시지';
    if (!list.length) {
      ul.appendChild(el('li', { class: 'empty', text: '표시할 방명록이 없습니다.' }));
      return;
    }
    list.forEach(function (g) {
      ul.appendChild(el('li', { class: 'item' }, [
        el('div', { class: 'item__body' }, [
          el('div', { class: 'item__head' }, [el('strong', { text: g.nickname }), el('time', { text: fullTime(g.createdAt) })]),
          el('p', { class: 'item__text', text: g.message })
        ]),
        el('button', { class: 'btn btn--danger btn--xs', type: 'button', text: '삭제', onclick: function () { deleteGuestbook(g); } })
      ]));
    });
  }

  function deleteGuestbook(g) {
    if (!confirm('이 방명록을 삭제할까요? 삭제하면 되돌릴 수 없습니다.\n\n' + g.nickname + ' : ' + g.message.slice(0, 80))) return;
    setLoading(true);
    req('adminDeleteGuestbook', { guestbookId: g.id }, 0).then(function () {
      data.guestbook = data.guestbook.filter(function (x) { return x.id !== g.id; });
      renderStats();
      renderGuestbook();
      toast('방명록을 삭제했습니다');
    }).catch(function (err) {
      if (err.code !== 'UNAUTHORIZED') toast(err.message, true);
    }).then(function () { setLoading(false); });
  }

  $('gbSearch').addEventListener('input', renderGuestbook);

  /* ------------------------------------------------------- 청첩장 내용 */

  function getPath(obj, path) {
    return path.split('.').reduce(function (o, k) { return o === null || o === undefined ? undefined : o[k]; }, obj);
  }
  function setPath(obj, path, value) {
    var keys = path.split('.');
    var o = obj;
    for (var i = 0; i < keys.length - 1; i++) {
      if (!o[keys[i]] || typeof o[keys[i]] !== 'object') o[keys[i]] = {};
      o = o[keys[i]];
    }
    o[keys[keys.length - 1]] = value;
  }

  function updateSaveBar() {
    $('saveContent').disabled = !contentDirty;
    $('contentSavebar').classList.toggle('is-dirty', contentDirty);
    $('contentSaveMsg').textContent = contentDirty ? '저장하지 않은 변경 내용이 있어요' : '저장된 내용과 같습니다';
  }
  function markContentDirty() {
    contentDirty = true;
    updateSaveBar();
  }

  var fieldSeq = 0;
  /** 입력칸 하나 (getter/setter 로 편집본과 연결) */
  function fieldEl(f, getter, setter) {
    var id = 'cf_' + (++fieldSeq);
    var value = getter();
    var input;
    if (f.type === 'checkbox') {
      input = el('input', { type: 'checkbox', id: id });
      input.checked = value === true;
      input.addEventListener('change', function () { setter(input.checked); markContentDirty(); });
      return el('label', { class: 'check', 'for': id }, [input, el('span', { text: f.label })]);
    }
    if (f.type === 'textarea' || f.type === 'lines') {
      input = el('textarea', { class: 'input input--sm', id: id, rows: String(f.rows || 4), maxlength: f.max ? String(f.max) : null, placeholder: f.placeholder || '' });
      input.value = f.type === 'lines' ? (Array.isArray(value) ? value.join('\n') : String(value || '')) : String(value || '');
      input.addEventListener('input', function () {
        setter(f.type === 'lines' ? input.value.split('\n') : input.value);
        markContentDirty();
      });
    } else {
      input = el('input', {
        class: 'input input--sm', id: id, type: f.type || 'text',
        maxlength: f.max && f.type !== 'number' ? String(f.max) : null,
        min: f.min !== undefined ? String(f.min) : null,
        max: f.maxValue !== undefined ? String(f.maxValue) : null,
        placeholder: f.placeholder || '',
        inputmode: f.type === 'tel' ? 'tel' : null
      });
      input.value = value === undefined || value === null ? '' : String(value);
      input.addEventListener('input', function () {
        setter(f.type === 'number' ? (input.value === '' ? '' : Number(input.value)) : input.value);
        markContentDirty();
      });
    }
    if (f.required && f.path) requiredInputs[f.path] = input;
    var children = [
      el('span', { class: 'field__label' }, [f.label, f.required ? el('em', { class: 'req', text: ' *' }) : null]),
      input
    ];
    if (f.hint) children.push(el('small', { class: 'field__hint', text: f.hint }));
    return el('label', { class: 'field' + (f.wide ? ' field--wide' : ''), 'for': id }, children);
  }

  /** 사진 입력칸: 경로/링크 직접 입력 + 갤러리 사진에서 고르기 + 미리보기 */
  function imageField(f) {
    var input = el('input', { class: 'input input--sm', type: 'text', placeholder: 'images/main.jpg 또는 https://… (Drive 공유 링크 가능)', 'aria-label': f.label });
    input.value = getPath(contentDraft, f.path) || '';
    var preview = el('img', { class: 'img-preview', alt: '', referrerpolicy: 'no-referrer' });
    function updatePreview() {
      var src = API.resolveImage(input.value.trim(), 'w400');
      preview.hidden = !src;
      if (src) {
        preview.onerror = function () { preview.hidden = true; };
        preview.src = src;
      }
    }
    var select = el('select', { class: 'input input--sm', 'aria-label': f.label + ' — 갤러리 사진에서 고르기' });
    select.appendChild(el('option', { value: '', text: '갤러리 사진에서 고르기…' }));
    data.photos.forEach(function (p, i) {
      select.appendChild(el('option', { value: p.url, text: (i + 1) + '번 사진' + (p.description ? ' · ' + p.description : '') }));
    });
    select.addEventListener('change', function () {
      if (!select.value) return;
      input.value = select.value;
      setPath(contentDraft, f.path, select.value);
      select.value = '';
      markContentDirty();
      updatePreview();
    });
    input.addEventListener('input', function () {
      setPath(contentDraft, f.path, input.value.trim());
      markContentDirty();
      updatePreview();
    });
    updatePreview();
    return el('div', { class: 'field field--wide' }, [
      el('span', { class: 'field__label', text: f.label }),
      el('div', { class: 'img-field' }, [preview, el('div', { class: 'img-field__inputs' }, [input, select])]),
      el('small', { class: 'field__hint', text: f.hint || 'GitHub images 폴더의 파일은 images/파일명.jpg, 갤러리에 올린 사진은 아래 목록에서 고르세요. 비우면 자리표시가 나옵니다.' })
    ]);
  }

  /** 여러 항목 편집기 (교통 안내, 계좌 목록) */
  function listEditor(cfg) {
    var wrap = el('div', { class: 'list-editor' });
    function arr() {
      var a = getPath(contentDraft, cfg.path);
      if (!Array.isArray(a)) { a = []; setPath(contentDraft, cfg.path, a); }
      return a;
    }
    function move(i, d) {
      var a = arr();
      var j = i + d;
      if (j < 0 || j >= a.length) return;
      var t = a[i]; a[i] = a[j]; a[j] = t;
      markContentDirty();
      render();
    }
    function render() {
      wrap.textContent = '';
      var a = arr();
      a.forEach(function (item, i) {
        var fields = cfg.itemFields.map(function (f) {
          return fieldEl(f, function () { return item[f.key]; }, function (v) { item[f.key] = v; });
        });
        wrap.appendChild(el('div', { class: 'list-item' }, [
          el('div', { class: 'list-item__head' }, [
            el('strong', { text: cfg.itemTitle(i) }),
            el('div', { class: 'list-item__tools' }, [
              el('button', { class: 'arrow-btn', type: 'button', text: '↑', 'aria-label': '위로 이동', disabled: i === 0, onclick: function () { move(i, -1); } }),
              el('button', { class: 'arrow-btn', type: 'button', text: '↓', 'aria-label': '아래로 이동', disabled: i === a.length - 1, onclick: function () { move(i, 1); } }),
              el('button', { class: 'btn btn--danger btn--xs', type: 'button', text: '삭제', onclick: function () { a.splice(i, 1); markContentDirty(); render(); } })
            ])
          ]),
          el('div', { class: 'form-grid' }, fields)
        ]));
      });
      if (!a.length) wrap.appendChild(el('p', { class: 'hint hint--left', text: cfg.emptyText }));
      wrap.appendChild(el('button', {
        class: 'btn btn--ghost btn--sm', type: 'button', text: '+ ' + cfg.addLabel, disabled: a.length >= cfg.max,
        onclick: function () { arr().push(cfg.newItem()); markContentDirty(); render(); }
      }));
    }
    render();
    return wrap;
  }

  function accountListCfg(path) {
    return {
      path: path, max: 10, addLabel: '계좌 추가',
      emptyText: '등록된 계좌가 없습니다. 비워두면 이 묶음은 청첩장에 표시되지 않습니다.',
      newItem: function () { return { role: '', name: '', bank: '', number: '', kakaopay: '' }; },
      itemTitle: function (i) { return '계좌 ' + (i + 1); },
      itemFields: [
        { key: 'role', label: '구분', max: 20, placeholder: '신랑 / 신랑 아버지' },
        { key: 'name', label: '예금주', max: 20 },
        { key: 'bank', label: '은행', max: 20, placeholder: '국민은행' },
        { key: 'number', label: '계좌번호', max: 40, placeholder: '000000-00-000000' },
        { key: 'kakaopay', label: '카카오페이 송금 링크 (선택)', type: 'url', max: 500, wide: true }
      ]
    };
  }

  function personFields(who, key) {
    return [
      { path: key + '.name', label: who + ' 이름', required: true, max: 20 },
      { path: key + '.shortName', label: '짧은 이름', max: 20, hint: '첫 화면·마무리에 표시 (비우면 이름 전체)' },
      { path: key + '.relation', label: '관계', max: 10, placeholder: who === '신랑' ? '장남 / 차남 / 아들' : '장녀 / 차녀 / 딸' },
      { path: key + '.phone', label: who + ' 연락처', type: 'tel', max: 30, hint: '비우면 연락하기 버튼이 숨겨집니다' },
      { path: key + '.father.name', label: '아버지 성함', max: 20 },
      { path: key + '.father.deceased', label: '아버지 故 표시', type: 'checkbox' },
      { path: key + '.mother.name', label: '어머니 성함', max: 20 },
      { path: key + '.mother.deceased', label: '어머니 故 표시', type: 'checkbox' }
    ];
  }

  function contentSections() {
    return [
      { title: '예식 일시', fields: [
        { path: 'wedding.date', label: '예식 날짜', type: 'date', required: true },
        { path: 'wedding.time', label: '예식 시간', type: 'time', required: true }
      ] },
      { title: '신랑 · 혼주', fields: personFields('신랑', 'groom') },
      { title: '신부 · 혼주', fields: personFields('신부', 'bride') },
      { title: '예식장', fields: [
        { path: 'venue.name', label: '예식장 이름', required: true, max: 50 },
        { path: 'venue.hall', label: '층·홀 이름', max: 50, placeholder: '3층 그랜드홀' },
        { path: 'venue.address', label: '주소', required: true, max: 150, wide: true, hint: '지도 검색과 주소 복사에 쓰입니다' },
        { path: 'venue.tel', label: '예식장 전화번호', type: 'tel', max: 30 },
        { path: 'venue.naverMapUrl', label: '네이버 지도 링크 (선택)', type: 'url', max: 500, wide: true, hint: '네이버 지도 앱에서 예식장 → 공유 → 링크 복사. 비우면 주소로 검색합니다' },
        { path: 'venue.kakaoMapUrl', label: '카카오맵 링크 (선택)', type: 'url', max: 500, wide: true, hint: '카카오맵 앱에서 예식장 → 공유 → 링크 복사. 비우면 주소로 검색합니다' },
        { path: 'venue.mapImage', label: '약도 이미지 (선택)', type: 'image', hint: '비우면 약도 없이 지도 버튼만 표시됩니다' }
      ] },
      { title: '대표 사진', fields: [
        { path: 'photos.main', label: '첫 화면 사진 (세로 3:4 권장)', type: 'image' },
        { path: 'photos.ending', label: '마무리 사진 (세로 4:5 권장)', type: 'image' }
      ] },
      { title: '문구', fields: [
        { path: 'texts.introMessage', label: '첫 화면 문구', type: 'textarea', rows: 3, max: 300, wide: true },
        { path: 'texts.invitationTitle', label: '초대 제목', max: 60, wide: true },
        { path: 'texts.invitationMessage', label: '초대의 글', type: 'textarea', rows: 9, max: 2000, wide: true },
        { path: 'texts.accountMessage', label: '계좌 안내 문구', type: 'textarea', rows: 3, max: 500, wide: true },
        { path: 'texts.closingMessage', label: '마무리 인사', type: 'textarea', rows: 6, max: 1500, wide: true }
      ] },
      { title: '오시는 길 (교통 안내)', list: {
        path: 'transport', max: 12, addLabel: '교통 안내 추가', emptyText: '등록된 교통 안내가 없습니다.',
        newItem: function () { return { title: '', lines: [] }; },
        itemTitle: function (i) { return '안내 ' + (i + 1); },
        itemFields: [
          { key: 'title', label: '제목', max: 30, placeholder: '지하철 / 버스 / 주차' },
          { key: 'lines', label: '내용 (한 줄에 하나씩)', type: 'lines', rows: 3, wide: true }
        ]
      } },
      { title: '마음 전하실 곳 — 신랑측 계좌', list: accountListCfg('accounts.groom') },
      { title: '마음 전하실 곳 — 신부측 계좌', list: accountListCfg('accounts.bride') },
      { title: '갤러리', fields: [
        { path: 'gallery.initialCount', label: '처음에 보여줄 사진 수', type: 'number', min: 3, maxValue: 60, hint: '나머지는 [사진 더보기]로 펼쳐집니다 (3~60)' }
      ] }
    ];
  }

  function renderContentForm() {
    var box = $('contentForm');
    box.textContent = '';
    requiredInputs = {};
    if (!contentDraft) return;
    contentSections().forEach(function (sec) {
      var body;
      if (sec.list) {
        body = listEditor(sec.list);
      } else {
        body = el('div', { class: 'form-grid' }, sec.fields.map(function (f) {
          if (f.type === 'image') return imageField(f);
          return fieldEl(f,
            function () { return getPath(contentDraft, f.path); },
            function (v) { setPath(contentDraft, f.path, v); });
        }));
      }
      box.appendChild(el('div', { class: 'card' }, [el('h2', { class: 'card__title', text: sec.title }), body]));
    });
    updateSaveBar();
  }

  var REQUIRED = [
    ['wedding.date', '예식 날짜를 입력해 주세요.'],
    ['wedding.time', '예식 시간을 입력해 주세요.'],
    ['groom.name', '신랑 이름을 입력해 주세요.'],
    ['bride.name', '신부 이름을 입력해 주세요.'],
    ['venue.name', '예식장 이름을 입력해 주세요.'],
    ['venue.address', '예식장 주소를 입력해 주세요.']
  ];

  $('saveContent').addEventListener('click', function () {
    if (!contentDraft) return;
    for (var i = 0; i < REQUIRED.length; i++) {
      if (!String(getPath(contentDraft, REQUIRED[i][0]) || '').trim()) {
        toast(REQUIRED[i][1], true);
        var input = requiredInputs[REQUIRED[i][0]];
        if (input) { input.scrollIntoView({ block: 'center' }); input.focus(); }
        return;
      }
    }
    var payload = {};
    ['wedding', 'groom', 'bride', 'venue', 'photos', 'texts', 'transport', 'accounts', 'gallery'].forEach(function (k) {
      payload[k] = contentDraft[k];
    });
    var btn = $('saveContent');
    btn.disabled = true;
    setLoading(true);
    req('adminSaveContent', { content: payload }, 0).then(function (res) {
      contentDirty = false;
      data.content = res.content;
      data.settings = res.settings;
      contentDraft = API.buildContent(window.WEDDING_CONFIG, res.content, res.settings);
      renderContentForm();
      toast('저장했습니다. 청첩장을 새로고침하면 반영됩니다.');
    }).catch(function (err) {
      btn.disabled = false;
      if (err.code !== 'UNAUTHORIZED') toast(err.message, true);
    }).then(function () { setLoading(false); });
  });

  /* -------------------------------------------------------------- 탭 */

  function selectTab(name) {
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      var on = t.getAttribute('data-tab') === name;
      t.setAttribute('aria-selected', String(on));
      $('panel-' + t.getAttribute('data-tab')).hidden = !on;
    });
    sessionSet(TAB_KEY, name);
  }
  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
    t.addEventListener('click', function () { selectTab(t.getAttribute('data-tab')); });
  });

  $('refreshBtn').addEventListener('click', function () { loadData(); });

  window.addEventListener('beforeunload', function (e) {
    if (dirty || uploading || contentDirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  /* ------------------------------------------------------------- 시작 */

  if (API.isDemo) $('demoBanner').hidden = false;
  selectTab(sessionGet(TAB_KEY) || 'content');

  if (token) {
    setLoading(true);
    req('adminVerify', {}, 1).then(function () {
      showDash();
      return loadData();
    }).catch(function (err) {
      if (err.code !== 'UNAUTHORIZED') showLogin(err.message);
    }).then(function () { setLoading(false); });
  } else {
    showLogin('');
  }
})();
