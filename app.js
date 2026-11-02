'use strict';
(() => {
  // ---------- 定数 ----------
  const DATA_KEY = 'salaryApp.data.v2';
  const SET_KEY = 'salaryApp.settings.v2';
  const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
  const FILE_NAME = 'salary-data.json';
  const DAY = 86400000;
  const TOMB_TTL = 180 * DAY;
  const MAX_TEXT = 5e6;
  const PBKDF2_ITER = 600000;
  const NIGHT_WINDOWS = [[0, 300], [1320, 1440]]; // 0:00-5:00 / 22:00-24:00（分）
  const CLIENT_ID_RE = /^[\w.-]+\.apps\.googleusercontent\.com$/;
  const ID_RE = /^[\w-]{8,64}$/;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  // ---------- ユーティリティ ----------
  const $ = (id) => document.getElementById(id);
  const pad = (n) => String(n).padStart(2, '0');
  const yen = new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY', maximumFractionDigits: 0 });
  const WD = ['日', '月', '火', '水', '木', '金', '土'];

  class AppErr extends Error {
    constructor(msg, code) { super(msg); this.code = code; }
  }

  function uid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const a = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch { /* noop */ } },
  };

  // DOM生成（ユーザー入力は必ず textContent 経由）
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, '');
      else if (v !== false && v != null) e.setAttribute(k, v);
    }
    for (const c of kids.flat()) {
      if (c == null || c === false) continue;
      e.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return e;
  }

  // ---------- データ検証（ローカル・Drive・ファイル全て共通で通す） ----------
  const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  const isNum = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
  const arr = (v) => (Array.isArray(v) ? v : []);

  function validDate(s) {
    if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return y >= 2000 && y <= 2100 && dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
  }

  function cleanWp(w) {
    if (!w || typeof w !== 'object' || typeof w.id !== 'string' || !ID_RE.test(w.id)) return null;
    if (!isNum(w.updatedAt, 0, 1e14)) return null;
    if (w.deleted === true) return { id: w.id, name: '', wage: 0, rate: 0, updatedAt: w.updatedAt, deleted: true };
    const name = typeof w.name === 'string' ? w.name.trim().slice(0, 40) : '';
    if (!name || !isNum(w.wage, 0, 1e6) || !isNum(w.rate, 0, 300)) return null;
    return { id: w.id, name, wage: w.wage, rate: w.rate, updatedAt: w.updatedAt, deleted: false };
  }

  function cleanShift(s) {
    if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !ID_RE.test(s.id)) return null;
    if (!isNum(s.updatedAt, 0, 1e14)) return null;
    if (s.deleted === true) return { id: s.id, wp: '', date: '2000-01-01', sh: 0, sm: 0, eh: 0, em: 0, updatedAt: s.updatedAt, deleted: true };
    if (typeof s.wp !== 'string' || !ID_RE.test(s.wp) || !validDate(s.date)) return null;
    if (!isInt(s.sh, 0, 23) || !isInt(s.eh, 0, 23) || !isInt(s.sm, 0, 59) || !isInt(s.em, 0, 59)) return null;
    if (s.sh * 60 + s.sm === s.eh * 60 + s.em) return null;
    return { id: s.id, wp: s.wp, date: s.date, sh: s.sh, sm: s.sm, eh: s.eh, em: s.em, updatedAt: s.updatedAt, deleted: false };
  }

  function cleanDoc(d) {
    const out = { workplaces: [], shifts: [] };
    if (!d || typeof d !== 'object') return out;
    for (const w of arr(d.workplaces).slice(0, 500)) { const r = cleanWp(w); if (r) out.workplaces.push(r); }
    for (const s of arr(d.shifts).slice(0, 50000)) { const r = cleanShift(s); if (r) out.shifts.push(r); }
    return out;
  }

  function mergeLists(a, b) {
    const m = new Map();
    for (const r of [...a, ...b]) {
      const x = m.get(r.id);
      if (!x || r.updatedAt > x.updatedAt) m.set(r.id, r);
    }
    const now = Date.now();
    return [...m.values()].filter((r) => !(r.deleted && now - r.updatedAt > TOMB_TTL));
  }
  const mergeDocs = (a, b) => (b ? { workplaces: mergeLists(a.workplaces, b.workplaces), shifts: mergeLists(a.shifts, b.shifts) } : a);
  const canon = (d) => JSON.stringify({
    w: [...d.workplaces].sort((x, y) => (x.id < y.id ? -1 : 1)),
    s: [...d.shifts].sort((x, y) => (x.id < y.id ? -1 : 1)),
  });

  // ---------- 給与計算 ----------
  function overlap(a0, a1, b0, b1) { return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)); }

  function calc(wage, rate, sh, sm, eh, em) {
    const s = sh * 60 + sm;
    let e = eh * 60 + em;
    if (e === s) return null;
    let cross = false;
    if (e < s) { e += 1440; cross = true; }
    const total = e - s;
    let night = 0;
    for (let k = 0; k < 3; k++) {
      for (const [a, b] of NIGHT_WINDOWS) night += overlap(s, e, k * 1440 + a, k * 1440 + b);
    }
    const base = Math.round((wage * total) / 60);
    const prem = Math.round((wage * (rate / 100) * night) / 60);
    return { total, night, cross, base, prem, pay: base + prem };
  }

  // ---------- 状態 ----------
  let db = loadData();
  let settings = loadSettings();
  let tab = 'log';
  let editShift = null;
  let editWp = null;
  let pass = ''; // メモリのみ。保存しない

  function loadData() {
    const raw = store.get(DATA_KEY);
    if (!raw) return { workplaces: [], shifts: [] };
    try { return cleanDoc(JSON.parse(raw)); } catch { return { workplaces: [], shifts: [] }; }
  }
  function loadSettings() {
    const d = new Date();
    const def = { h24: true, theme: 'auto', month: `${d.getFullYear()}-${pad(d.getMonth() + 1)}`, clientId: '', linked: false };
    try {
      const j = JSON.parse(store.get(SET_KEY) || '{}');
      return {
        h24: typeof j.h24 === 'boolean' ? j.h24 : def.h24,
        theme: ['auto', 'light', 'dark'].includes(j.theme) ? j.theme : def.theme,
        month: /^\d{4}-(0[1-9]|1[0-2])$/.test(j.month) ? j.month : def.month,
        clientId: typeof j.clientId === 'string' && CLIENT_ID_RE.test(j.clientId) ? j.clientId : '',
        linked: j.linked === true,
      };
    } catch { return def; }
  }
  const saveSettings = () => store.set(SET_KEY, JSON.stringify(settings));
  const persist = () => store.set(DATA_KEY, JSON.stringify(db));

  const activeWps = () => db.workplaces.filter((w) => !w.deleted).sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  const wpById = (id) => db.workplaces.find((w) => w.id === id && !w.deleted);
  const activeShifts = () => db.shifts.filter((s) => !s.deleted);

  function commit() {
    persist();
    render();
    scheduleSync();
  }

  // ---------- 表示フォーマット ----------
  function fmtTime(hh, mm) {
    if (settings.h24) return `${pad(hh)}:${pad(mm)}`;
    return `${hh < 12 ? '午前' : '午後'}${hh % 12 || 12}:${pad(mm)}`;
  }
  function fmtDur(min) {
    const hh = Math.floor(min / 60), mm = min % 60;
    if (!hh) return `${mm}分`;
    return mm ? `${hh}時間${mm}分` : `${hh}時間`;
  }
  function fmtDate(s) {
    const [y, m, d] = s.split('-').map(Number);
    return `${m}/${d}(${WD[new Date(y, m - 1, d).getDay()]})`;
  }
  const monthText = (ym) => `${ym.slice(0, 4)}年${Number(ym.slice(5))}月`;

  // ---------- テーマ ----------
  const THEME_LABEL = { auto: '自動', light: 'ライト', dark: 'ダーク' };
  function applyTheme() {
    if (settings.theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.dataset.theme = settings.theme;
    $('themeBtn').textContent = THEME_LABEL[settings.theme];
    $('themeBtn').setAttribute('aria-label', `テーマ切替（現在: ${THEME_LABEL[settings.theme]}）`);
  }

  // ---------- 時刻セレクト ----------
  function fillTimeSelects() {
    for (const id of ['fSH', 'fEH']) {
      const sel = $(id);
      const cur = sel.value || (id === 'fSH' ? '9' : '17');
      sel.replaceChildren();
      for (let i = 0; i < 24; i++) {
        const label = settings.h24 ? pad(i) : `${i < 12 ? '午前' : '午後'}${i % 12 || 12}`;
        sel.append(h('option', { value: String(i) }, label));
      }
      sel.value = cur;
    }
    for (const id of ['fSM', 'fEM']) {
      const sel = $(id);
      if (sel.options.length) continue;
      for (let i = 0; i < 60; i++) sel.append(h('option', { value: String(i) }, pad(i)));
      sel.value = '0';
    }
  }

  const readForm = () => ({
    wp: $('fWp').value,
    date: $('fDate').value,
    sh: Number($('fSH').value), sm: Number($('fSM').value),
    eh: Number($('fEH').value), em: Number($('fEM').value),
  });

  function renderPreview() {
    const f = readForm();
    const w = wpById(f.wp);
    const p = $('fPrev');
    if (!w) { p.textContent = ''; return; }
    const r = calc(w.wage, w.rate, f.sh, f.sm, f.eh, f.em);
    if (!r) { p.textContent = '開始と終了が同じ時刻です。'; return; }
    p.textContent = `実働 ${fmtDur(r.total)}（うち深夜 ${fmtDur(r.night)}）／ ${yen.format(r.pay)}${r.cross ? '／翌日終了' : ''}`;
  }

  // ---------- 描画 ----------
  function render() {
    $('h24').checked = settings.h24;
    applyTheme();
    fillTimeSelects();
    $('monthLabel').textContent = monthText(settings.month);
    $('monthBar').hidden = !(tab === 'log' || tab === 'sum');
    for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    for (const t of ['log', 'wp', 'sum', 'sync']) $(`tab-${t}`).hidden = t !== tab;
    renderWpSelect();
    renderShifts();
    renderWps();
    renderSummary();
    renderSyncUi();
    renderPreview();
  }

  function renderWpSelect() {
    const sel = $('fWp');
    const cur = sel.value;
    const list = activeWps();
    sel.replaceChildren(...list.map((w) => h('option', { value: w.id }, w.name)));
    if (list.some((w) => w.id === cur)) sel.value = cur;
    const none = list.length === 0;
    $('noWpHint').hidden = !none;
    for (const id of ['fWp', 'fDate', 'fSH', 'fSM', 'fEH', 'fEM', 'fSave']) $(id).disabled = none;
  }

  function renderShifts() {
    const ul = $('shiftList');
    const rows = activeShifts()
      .filter((s) => s.date.slice(0, 7) === settings.month && wpById(s.wp))
      .sort((a, b) => (a.date === b.date ? b.sh * 60 + b.sm - (a.sh * 60 + a.sm) : a.date < b.date ? 1 : -1));
    if (!rows.length) { ul.replaceChildren(h('li', { class: 'empty' }, 'この月の記録はありません')); return; }
    ul.replaceChildren(...rows.map((s) => {
      const w = wpById(s.wp);
      const r = calc(w.wage, w.rate, s.sh, s.sm, s.eh, s.em);
      return h('li', { class: 'item' },
        h('div', { class: 'main' },
          h('div', { class: 't1' }, `${fmtDate(s.date)}　${w.name}`),
          h('div', { class: 't2' }, `${fmtTime(s.sh, s.sm)} → ${r.cross ? '翌 ' : ''}${fmtTime(s.eh, s.em)}`),
          h('div', { class: 't3' }, `${fmtDur(r.total)}`, r.night ? h('span', { class: 'night' }, `（深夜 ${fmtDur(r.night)}）`) : null)),
        h('div', { class: 'side' },
          h('div', { class: 'pay' }, yen.format(r.pay)),
          h('div', { class: 'acts' },
            h('button', { type: 'button', class: 'small', onclick: () => startEditShift(s.id) }, '編集'),
            h('button', { type: 'button', class: 'small danger', onclick: () => deleteShift(s.id) }, '削除'))));
    }));
  }

  function renderWps() {
    const ul = $('wpList');
    const list = activeWps();
    if (!list.length) { ul.replaceChildren(h('li', { class: 'empty' }, '職場がまだありません')); return; }
    ul.replaceChildren(...list.map((w) => h('li', { class: 'item' },
      h('div', { class: 'main' },
        h('div', { class: 't1' }, w.name),
        h('div', { class: 't2' }, `時給 ${yen.format(w.wage)}／深夜割増 ${w.rate}%`)),
      h('div', { class: 'acts' },
        h('button', { type: 'button', class: 'small', onclick: () => startEditWp(w.id) }, '編集'),
        h('button', { type: 'button', class: 'small danger', onclick: () => deleteWp(w.id) }, '削除')))));
  }

  function renderSummary() {
    const box = $('sumBody');
    const per = new Map();
    for (const s of activeShifts()) {
      if (s.date.slice(0, 7) !== settings.month) continue;
      const w = wpById(s.wp);
      if (!w) continue;
      const r = calc(w.wage, w.rate, s.sh, s.sm, s.eh, s.em);
      const a = per.get(w.id) || { w, n: 0, total: 0, night: 0, base: 0, prem: 0, pay: 0 };
      a.n++; a.total += r.total; a.night += r.night; a.base += r.base; a.prem += r.prem; a.pay += r.pay;
      per.set(w.id, a);
    }
    const items = [...per.values()].sort((a, b) => b.pay - a.pay);
    const sum = items.reduce((t, a) => ({ n: t.n + a.n, total: t.total + a.total, night: t.night + a.night, pay: t.pay + a.pay }), { n: 0, total: 0, night: 0, pay: 0 });
    const nodes = [
      h('div', { class: 'total' },
        h('div', { class: 'lab' }, `${monthText(settings.month)}の合計`),
        h('div', { class: 'amt' }, yen.format(sum.pay)),
        h('div', { class: 'sub' }, `${sum.n}勤務 ／ ${fmtDur(sum.total)}（深夜 ${fmtDur(sum.night)}）`)),
    ];
    if (!items.length) nodes.push(h('div', { class: 'empty' }, 'この月の記録はありません'));
    for (const a of items) {
      nodes.push(h('div', { class: 'card' },
        h('h3', {}, a.w.name),
        h('dl', { class: 'rows' },
          h('dt', {}, '勤務回数'), h('dd', {}, `${a.n}回`),
          h('dt', {}, '労働時間'), h('dd', {}, fmtDur(a.total)),
          h('dt', {}, 'うち深夜（22〜5時）'), h('dd', {}, fmtDur(a.night)),
          h('dt', {}, '基本給'), h('dd', {}, yen.format(a.base)),
          h('dt', {}, '深夜割増'), h('dd', {}, yen.format(a.prem)),
          h('dt', { class: 'sumrow' }, '小計'), h('dd', { class: 'sumrow' }, yen.format(a.pay)))));
    }
    nodes.push(h('p', { class: 'note' }, '※ 日をまたぐ勤務は、開始した日の月に計上されます。'));
    box.replaceChildren(...nodes);
  }

  // ---------- 勤務の登録・編集 ----------
  function resetShiftForm() {
    editShift = null;
    $('shiftTitle').textContent = '勤務を記録';
    $('fSave').textContent = '記録する';
    $('fCancel').hidden = true;
    $('fMsg').textContent = '';
  }
  function startEditShift(id) {
    const s = db.shifts.find((x) => x.id === id && !x.deleted);
    if (!s) return;
    editShift = id;
    tab = 'log';
    render();
    $('fWp').value = s.wp; $('fDate').value = s.date;
    $('fSH').value = String(s.sh); $('fSM').value = String(s.sm);
    $('fEH').value = String(s.eh); $('fEM').value = String(s.em);
    $('shiftTitle').textContent = '勤務を編集';
    $('fSave').textContent = '更新する';
    $('fCancel').hidden = false;
    renderPreview();
    $('shiftForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function deleteShift(id) {
    if (!confirm('この勤務記録を削除しますか？')) return;
    const s = db.shifts.find((x) => x.id === id);
    if (s) { s.deleted = true; s.updatedAt = Date.now(); }
    if (editShift === id) resetShiftForm();
    commit();
  }
  function submitShift(ev) {
    ev.preventDefault();
    const f = readForm();
    const msg = $('fMsg');
    msg.textContent = '';
    if (!wpById(f.wp)) { msg.textContent = '職場を選んでください。'; return; }
    if (!validDate(f.date)) { msg.textContent = '日付を入力してください。'; return; }
    if (f.sh * 60 + f.sm === f.eh * 60 + f.em) { msg.textContent = '開始と終了が同じ時刻です。'; return; }
    const rec = { id: editShift || uid(), ...f, updatedAt: Date.now(), deleted: false };
    if (editShift) db.shifts = db.shifts.map((x) => (x.id === editShift ? rec : x));
    else db.shifts.push(rec);
    settings.month = f.date.slice(0, 7);
    saveSettings();
    resetShiftForm();
    commit();
  }

  // ---------- 職場の登録・編集 ----------
  function resetWpForm() {
    editWp = null;
    $('wpTitle').textContent = '職場を登録';
    $('wSave').textContent = '登録する';
    $('wCancel').hidden = true;
    $('wpForm').reset();
    $('wRate').value = '25';
    $('wMsg').textContent = '';
  }
  function startEditWp(id) {
    const w = wpById(id);
    if (!w) return;
    editWp = id;
    $('wName').value = w.name; $('wWage').value = String(w.wage); $('wRate').value = String(w.rate);
    $('wpTitle').textContent = '職場を編集';
    $('wSave').textContent = '更新する';
    $('wCancel').hidden = false;
    $('wpForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function deleteWp(id) {
    const w = wpById(id);
    if (!w) return;
    const n = activeShifts().filter((s) => s.wp === id).length;
    if (!confirm(`「${w.name}」を削除しますか？\n関連する勤務記録${n}件も削除されます。`)) return;
    const now = Date.now();
    w.deleted = true; w.updatedAt = now;
    for (const s of db.shifts) if (s.wp === id && !s.deleted) { s.deleted = true; s.updatedAt = now; }
    if (editWp === id) resetWpForm();
    commit();
  }
  function submitWp(ev) {
    ev.preventDefault();
    const name = $('wName').value.trim().slice(0, 40);
    const wage = Number($('wWage').value);
    const rate = Number($('wRate').value);
    const msg = $('wMsg');
    msg.textContent = '';
    if (!name) { msg.textContent = '職場名を入力してください。'; return; }
    if ($('wWage').value === '' || !isNum(wage, 0, 1e6)) { msg.textContent = '時給は 0〜1,000,000 の数値で入力してください。'; return; }
    if ($('wRate').value === '' || !isNum(rate, 0, 300)) { msg.textContent = '深夜割増率は 0〜300 の数値で入力してください。'; return; }
    const rec = { id: editWp || uid(), name, wage, rate, updatedAt: Date.now(), deleted: false };
    if (editWp) db.workplaces = db.workplaces.map((x) => (x.id === editWp ? rec : x));
    else db.workplaces.push(rec);
    resetWpForm();
    commit();
  }

  // ---------- 暗号化（AES-GCM / PBKDF2） ----------
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  function b64e(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  const b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  async function deriveKey(p, salt, iter) {
    const km = await crypto.subtle.importKey('raw', enc.encode(p), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  async function seal(doc) {
    const payload = { workplaces: doc.workplaces, shifts: doc.shifts };
    if (!pass) return JSON.stringify({ app: 'salary', v: 2, enc: false, data: payload });
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(pass, salt, PBKDF2_ITER);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(payload))));
    return JSON.stringify({ app: 'salary', v: 2, enc: 'AES-GCM-PBKDF2', iter: PBKDF2_ITER, salt: b64e(salt), iv: b64e(iv), ct: b64e(ct) });
  }

  async function open(text) {
    if (typeof text !== 'string' || text.length > MAX_TEXT) throw new AppErr('データが大きすぎます。');
    let j;
    try { j = JSON.parse(text); } catch { throw new AppErr('データ形式が正しくありません。'); }
    if (!j || j.app !== 'salary') throw new AppErr('このアプリのデータではありません。');
    if (!j.enc) return { doc: cleanDoc(j.data), encrypted: false };
    if (!pass) throw new AppErr('暗号化されたデータです。パスフレーズを入力してください。', 'pass');
    try {
      if (!isInt(j.iter, 100000, 2000000)) throw new Error('iter');
      const salt = b64d(j.salt), iv = b64d(j.iv), ct = b64d(j.ct);
      if (salt.length !== 16 || iv.length !== 12) throw new Error('len');
      const key = await deriveKey(pass, salt, j.iter);
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
      return { doc: cleanDoc(JSON.parse(dec.decode(plain))), encrypted: true };
    } catch {
      throw new AppErr('パスフレーズが違うか、データが壊れています。', 'pass');
    }
  }

  // ---------- Google ドライブ同期 ----------
  let token = null;
  let tokenExp = 0;
  let tokenClient = null;
  let tokenClientFor = '';
  let pending = null;
  let busy = false;
  let syncTimer = null;
  let status = { msg: '', kind: '' };

  function setStatus(msg, kind = '') { status = { msg, kind }; renderSyncUi(); }
  function renderSyncUi() {
    const el = $('syncStatus');
    el.textContent = status.msg;
    el.className = `status ${status.kind}`.trim();
    $('driveBtn').textContent = settings.linked ? '今すぐ同期' : 'Googleドライブと同期';
    $('driveBtn').disabled = busy;
    $('driveOff').disabled = !settings.linked && !token;
    if (document.activeElement !== $('clientId')) $('clientId').value = settings.clientId;
  }

  function loadGis() {
    return new Promise((resolve, reject) => {
      if (window.google && google.accounts && google.accounts.oauth2) { resolve(); return; }
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new AppErr('Google の認証ライブラリを読み込めませんでした。通信環境を確認してください。'));
      document.head.append(s);
    });
  }

  async function getToken() {
    if (token && Date.now() < tokenExp) return;
    token = null;
    if (!CLIENT_ID_RE.test(settings.clientId)) throw new AppErr('先に OAuth クライアントID を入力してください（手順は README 参照）。');
    await loadGis();
    if (!tokenClient || tokenClientFor !== settings.clientId) {
      tokenClientFor = settings.clientId;
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: settings.clientId,
        scope: SCOPE,
        callback: (r) => {
          const p = pending; pending = null;
          if (!p) return;
          if (r && r.access_token && typeof r.access_token === 'string') {
            token = r.access_token;
            tokenExp = Date.now() + Math.max(60, (Number(r.expires_in) || 3600) - 60) * 1000;
            p.resolve();
          } else p.reject(new AppErr('Google の認証に失敗しました。'));
        },
        error_callback: (e) => {
          const p = pending; pending = null;
          if (p) p.reject(new AppErr(e && e.type === 'popup_failed_to_open' ? 'ログイン画面を開けませんでした。ポップアップを許可してください。' : 'ログインがキャンセルされました。'));
        },
      });
    }
    await new Promise((resolve, reject) => {
      pending = { resolve, reject };
      tokenClient.requestAccessToken({});
    });
  }

  async function drive(path, opts = {}) {
    const r = await fetch(`https://www.googleapis.com/${path}`, {
      ...opts,
      headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` },
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      credentials: 'omit',
    });
    if (r.status === 401 || r.status === 403) { token = null; throw new AppErr('認証の期限が切れたか、権限がありません。もう一度「今すぐ同期」を押してください。'); }
    if (!r.ok) throw new AppErr(`Google ドライブとの通信に失敗しました（${r.status}）。`);
    return r;
  }

  async function findFile() {
    const q = encodeURIComponent(`name='${FILE_NAME}' and trashed=false`);
    const r = await drive(`drive/v3/files?spaces=appDataFolder&q=${q}&orderBy=createdTime&pageSize=5&fields=files(id)`);
    const j = await r.json();
    const f = arr(j.files)[0];
    return f && typeof f.id === 'string' && /^[\w-]+$/.test(f.id) ? f.id : null;
  }

  async function upload(fileId, text) {
    if (fileId) {
      await drive(`upload/drive/v3/files/${fileId}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: text });
      return;
    }
    const boundary = `b${uid().replace(/-/g, '')}`;
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: FILE_NAME, parents: ['appDataFolder'] })}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${text}\r\n--${boundary}--`;
    await drive('upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
  }

  async function sync() {
    if (busy) return;
    busy = true;
    setStatus('同期中…');
    try {
      await getToken();
      const id = await findFile();
      let remote = null;
      let remoteEnc = false;
      if (id) {
        const o = await open(await (await drive(`drive/v3/files/${id}?alt=media`)).text());
        remote = o.doc; remoteEnc = o.encrypted;
      }
      const merged = mergeDocs(db, remote);
      db = merged;
      persist();
      if (!remote || canon(remote) !== canon(merged) || remoteEnc !== !!pass) {
        await upload(id, await seal(merged));
      }
      settings.linked = true;
      saveSettings();
      render();
      setStatus(`同期しました（${new Date().toLocaleTimeString('ja-JP', { hour12: !settings.h24 })}）${pass ? ' 🔒暗号化あり' : ' ※暗号化なし'}`, 'ok');
    } catch (e) {
      setStatus(e instanceof AppErr ? e.message : '同期に失敗しました。時間をおいて再度お試しください。', 'err');
    } finally {
      busy = false;
      renderSyncUi();
    }
  }

  function scheduleSync() {
    if (!settings.linked) return;
    if (!token || Date.now() >= tokenExp) { setStatus('未同期の変更があります。「今すぐ同期」を押してください。', 'warn'); return; }
    clearTimeout(syncTimer);
    syncTimer = setTimeout(sync, 2000);
  }

  function disconnect() {
    try { if (token && window.google && google.accounts) google.accounts.oauth2.revoke(token, () => {}); } catch { /* noop */ }
    token = null; tokenExp = 0; tokenClient = null; tokenClientFor = '';
    settings.linked = false;
    saveSettings();
    clearTimeout(syncTimer);
    setStatus('連携を解除しました。Drive 上のデータはそのまま残っています。');
  }

  // ---------- バックアップ ----------
  async function exportFile() {
    const m = $('bMsg');
    m.className = 'msg';
    try {
      const text = await seal(db);
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const d = new Date();
      const a = h('a', { href: url, download: `salary-backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json` });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      m.className = 'msg ok';
      m.textContent = pass ? '暗号化して書き出しました。' : '書き出しました（暗号化なし）。保管場所にご注意ください。';
    } catch { m.textContent = '書き出しに失敗しました。'; }
  }

  async function importFile(file) {
    const m = $('bMsg');
    m.className = 'msg';
    m.textContent = '';
    if (!file) return;
    try {
      if (file.size > MAX_TEXT) throw new AppErr('ファイルが大きすぎます。');
      const { doc } = await open(await file.text());
      db = mergeDocs(db, doc);
      commit();
      m.className = 'msg ok';
      m.textContent = `読み込みました（職場 ${doc.workplaces.filter((x) => !x.deleted).length}件・勤務 ${doc.shifts.filter((x) => !x.deleted).length}件）。`;
    } catch (e) {
      m.textContent = e instanceof AppErr ? e.message : '読み込みに失敗しました。';
    } finally {
      $('importFile').value = '';
    }
  }

  function wipe() {
    if (!confirm('この端末に保存されている全データと設定を削除します。よろしいですか？\n（Drive 上のデータは削除されません）')) return;
    disconnect();
    store.del(DATA_KEY); store.del(SET_KEY);
    db = { workplaces: [], shifts: [] };
    settings = loadSettings();
    pass = ''; $('pass').value = '';
    resetShiftForm(); resetWpForm();
    render();
    setStatus('この端末のデータを削除しました。');
  }

  // ---------- イベント ----------
  function bind() {
    for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => { tab = b.dataset.tab; render(); });
    $('h24').addEventListener('change', (e) => { settings.h24 = e.target.checked; saveSettings(); render(); });
    $('themeBtn').addEventListener('click', () => {
      const order = ['auto', 'light', 'dark'];
      settings.theme = order[(order.indexOf(settings.theme) + 1) % 3];
      saveSettings(); applyTheme();
    });
    const shiftMonth = (d) => {
      const [y, m] = settings.month.split('-').map(Number);
      const dt = new Date(y, m - 1 + d, 1);
      settings.month = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}`;
      saveSettings(); render();
    };
    $('prevM').addEventListener('click', () => shiftMonth(-1));
    $('nextM').addEventListener('click', () => shiftMonth(1));

    $('shiftForm').addEventListener('submit', submitShift);
    for (const id of ['fWp', 'fSH', 'fSM', 'fEH', 'fEM']) $(id).addEventListener('change', renderPreview);
    $('fCancel').addEventListener('click', () => { resetShiftForm(); renderPreview(); });
    $('wpForm').addEventListener('submit', submitWp);
    $('wCancel').addEventListener('click', resetWpForm);

    $('clientId').addEventListener('change', (e) => {
      const v = e.target.value.trim();
      if (v && !CLIENT_ID_RE.test(v)) { setStatus('クライアントIDの形式が正しくありません（…apps.googleusercontent.com）。', 'err'); return; }
      settings.clientId = v; saveSettings();
      setStatus(v ? 'クライアントIDを保存しました。' : '');
    });
    $('pass').addEventListener('input', (e) => { pass = e.target.value; });
    $('driveBtn').addEventListener('click', () => {
      const v = $('clientId').value.trim();
      if (v && CLIENT_ID_RE.test(v)) { settings.clientId = v; saveSettings(); }
      sync();
    });
    $('driveOff').addEventListener('click', disconnect);
    $('exportBtn').addEventListener('click', exportFile);
    $('importFile').addEventListener('change', (e) => importFile(e.target.files[0]));
    $('wipeBtn').addEventListener('click', wipe);

    window.addEventListener('storage', (e) => {
      if (e.key === DATA_KEY) { db = loadData(); render(); }
      if (e.key === SET_KEY) { settings = loadSettings(); render(); }
    });
  }

  // ---------- 初期化 ----------
  const today = new Date();
  $('fDate').value = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  bind();
  render();
  if (settings.linked) setStatus('連携中です。「今すぐ同期」で最新の状態にできます。');
})();
