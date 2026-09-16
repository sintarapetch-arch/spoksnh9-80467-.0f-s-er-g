// PTS Sales — หน้าเว็บ (GitHub Pages)
// ตั้งค่าลิงก์ API ที่ไฟล์ config.js
// ไฟล์นี้เป็นโค้ดสาธารณะ ห้ามใส่รหัสผ่าน คีย์ หรือข้อมูลลูกค้าใดๆ ลงในนี้
//
// ===========================================================================
// สถาปัตยกรรม (แบบเดียวกับ PKT APP)
//
// แบบเดิม  ทุกครั้งที่กดปุ่ม -> ล้างหน้าจอ -> ยิงคำขอ -> รอ Apps Script 1-3 วินาที -> ค่อยวาด
//          เปิดแอปหนึ่งครั้งกด 5 หน้า = รอเน็ต 5 รอบ
//
// แบบใหม่  โหลด "snapshot" (ข้อมูลทั้งระบบ) ครั้งเดียวตอนเปิดแอป เก็บไว้ในเครื่อง
//          แล้ววาดทุกหน้าจากข้อมูลก้อนนั้น การกดเปลี่ยนหน้า/ค้นหา/กรอง จึงเกิดขึ้นทันที
//          ไม่แตะเน็ตเลย
//
//          ความสดของข้อมูลดูแลด้วยตัวนับ revision: ถาม ?ping=1 เป็นระยะ ซึ่งฝั่งเซิร์ฟเวอร์
//          อ่านแค่ตัวเลขตัวเดียวโดยไม่เปิด Spreadsheet จึงเบามาก และจะโหลด snapshot ใหม่
//          ก็ต่อเมื่อตัวเลขนั้นเปลี่ยนจริง (แปลว่ามีคนแก้ข้อมูลจากเครื่องอื่น)
//
//          snapshot ล่าสุดถูกเก็บไว้ใน localStorage ด้วย เปิดแอปครั้งต่อไปจึงเห็นข้อมูล
//          ทันทีตั้งแต่วินาทีแรก แล้วค่อยอัปเดตให้สดอยู่เบื้องหลัง
// ===========================================================================

/* ---------------------------------------------------------------------------
 * 1. ค่าคงที่ + เครื่องมือช่วย
 * ------------------------------------------------------------------------- */
const TOKEN_KEY = 'pts_token', NAME_KEY = 'pts_name', SNAP_KEY = 'pts_snapshot_v2', ORDER_KEY = 'pts_status_order';

const SYNC_FAST_MS = 5000;      // ช่วงที่เพิ่งมีการใช้งาน
const SYNC_SLOW_MS = 15000;     // เงียบไปสักพัก
const SYNC_IDLE_MS = 45000;     // เปิดทิ้งไว้ทั้งวัน
const SYNC_SAFETY_MS = 180000;  // โหลดใหม่ทั้งก้อนทุก 3 นาที เผื่อตัวนับเพี้ยน
const POST_TIMEOUT_MS = 40000;  // อัปโหลดไฟล์ใช้เวลานาน
const PING_TIMEOUT_MS = 8000;
const CACHE_MAX_CHARS = 3000000;

const $ = s => document.querySelector(s);
const esc = v => String(v == null ? '' : v).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
const pad2 = n => String(n).padStart(2, '0');

/**
 * 12 สถานะมาตรฐานของระบบ เรียงตามลำดับงาน — หน้าแอปใช้รายการนี้เป็นหลัก
 * แล้วเติมสถานะที่หลังบ้านส่งมาเพิ่ม (ถ้ามี) ต่อท้าย จึงแสดงครบแม้ Apps Script ยังเป็นเวอร์ชันเก่า
 * (ต้องตรงกับ APP.STATUS ใน Config.gs)
 */
const STATUS_ORDER = [
  'ขอใบเสนอราคา', 'ต้องเข้าสำรวจหน้างาน', 'สำรวจหน้างานแล้ว', 'ต้องขอข้อมูลเพิ่มเติม', 'ระหว่างจัดทำใบเสนอราคา',
  'ส่งใบเสนอราคาแล้ว', 'ต้องติดตาม', 'ขอคู่เทียบ', 'ระหว่างพิจารณา', 'ส่งตั้งงบปีหน้า',
  'อนุมัติ/ได้งาน', 'ไม่อนุมัติ/ไม่ได้งาน'
];
const CLOSED_ORDER = ['อนุมัติ/ได้งาน', 'ไม่อนุมัติ/ไม่ได้งาน'];
const mergeList = (base, extra) => base.concat((extra || []).filter(x => base.indexOf(x) === -1));

/** ตัดค่าวันที่ให้เหลือ yyyy-MM-dd ไม่ว่าจะรับมาเป็นข้อความหรือ Date */
function dOnly(value) {
  if (!value) return '';
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const d = new Date(text);
  return isNaN(d.getTime()) ? '' : d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
const todayStr = () => dOnly(new Date());
function daysBetween(from, to) {
  const a = dOnly(from), b = dOnly(to);
  if (!a || !b) return null;
  return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);
}
const daysSince = v => daysBetween(v, new Date());

const fmtDate = v => { const d = dOnly(v); return d ? new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium' }).format(new Date(d + 'T00:00:00')) : '-'; };
const fmtDateTime = v => { if (!v) return '-'; const d = new Date(v); return isNaN(d.getTime()) ? '-' : new Intl.DateTimeFormat('th-TH', { dateStyle: 'short', timeStyle: 'short' }).format(d); };
const fmtMoney = v => { const n = Number(String(v).replace(/,/g, '')); return isFinite(n) && String(v).trim() !== '' ? new Intl.NumberFormat('th-TH').format(n) : '-'; };
const nowLocalInput = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

const svg = body => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
const I = {
  dash: svg('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>'),
  list: svg('<line x1="9" y1="6" x2="21" y2="6"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="9" y1="18" x2="21" y2="18"/><circle cx="4.5" cy="6" r="1.2"/><circle cx="4.5" cy="12" r="1.2"/><circle cx="4.5" cy="18" r="1.2"/>'),
  plus: svg('<circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>'),
  users: svg('<path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9.5" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/>'),
  back: svg('<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>'),
  refresh: svg('<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>'),
  logout: svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>'),
  trash: svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>'),
  clip: svg('<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>'),
  edit: svg('<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/>'),
  note: svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
  swap: svg('<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>'),
  ban: svg('<circle cx="12" cy="12" r="9"/><line x1="5.6" y1="5.6" x2="18.4" y2="18.4"/>'),
  close: svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  history: svg('<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/><polyline points="12 7 12 12 15 14"/>'),
  up: svg('<polyline points="18 15 12 9 6 15"/>'),
  down: svg('<polyline points="6 9 12 15 18 9"/>'),
  ext: svg('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>')
};

/* ---------------------------------------------------------------------------
 * 2. ข้อมูลในเครื่อง — ทุกหน้าจอวาดจากตรงนี้ ไม่ใช่จากคำขอใหม่
 * ------------------------------------------------------------------------- */
const S = {
  ready: false,
  view: { name: 'dashboard', params: {} },
  user: null,
  mine: true,
  rev: null,
  lastSyncAt: null,
  lastError: null,
  syncing: false,

  customers: [], opportunities: [], activities: [], attachments: [],
  owners: [], workTypes: [], closeReasons: [],
  statuses: STATUS_ORDER.slice(), closedStatus: CLOSED_ORDER.slice(), pendingQuoteStatus: [],
  master: null,          // รายการตั้งค่า (รวมที่ซ่อน) จากหลังบ้านรุ่นใหม่ — ใช้ในหน้า "ตั้งค่า"
  editableLists: false,  // true = หลังบ้านรุ่นที่แก้รายการจากในแอปได้
  priorities: [], categories: [], activityTypes: [],
  wonStatus: '', voidStatus: '', quoteSentStatus: '',
  sla: { warn: 7, overdue: 15 },

  filter: { query: '', status: '', owner: '', priority: '' },
  arrange: false,   // โหมดลากจัดเรียงการ์ดสถานะในหน้าภาพรวม
  customerQuery: '',

  repaintPending: false,
  rows: [],
  byId: new Map(),
  actsBy: new Map(),
  filesBy: new Map(),
  signature: null
};

const token = () => { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } };
const setAuth = (t, n) => { try { localStorage.setItem(TOKEN_KEY, t); localStorage.setItem(NAME_KEY, n); } catch (e) {} };
const clearAuth = () => { try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(NAME_KEY); localStorage.removeItem(SNAP_KEY); } catch (e) {} };
const myName = () => (S.user && (S.user.Name || S.user.Email)) || '';
const isClosed = s => S.closedStatus.indexOf(s) !== -1;
const isPendingQuote = s => S.pendingQuoteStatus.indexOf(s) !== -1;

const STATUS_TONE = {
  'ขอใบเสนอราคา': 'blue',
  'ต้องเข้าสำรวจหน้างาน': 'amber',
  'สำรวจหน้างานแล้ว': 'indigo',
  'ต้องขอข้อมูลเพิ่มเติม': 'orange',
  'ระหว่างจัดทำใบเสนอราคา': 'violet',
  'ส่งใบเสนอราคาแล้ว': 'cyan',
  'ต้องติดตาม': 'yellow',
  'ขอคู่เทียบ': 'pink',
  'ระหว่างพิจารณา': 'teal',
  'ส่งตั้งงบปีหน้า': 'lime',
  'อนุมัติ/ได้งาน': 'green',
  'ไม่อนุมัติ/ไม่ได้งาน': 'red'
};
const tone = status => STATUS_TONE[String(status).trim()] || 'slate';

/**
 * สร้างดัชนีใหม่หลังข้อมูลเปลี่ยน
 *
 * งานที่เคยให้เซิร์ฟเวอร์ทำ (ต่อข้อมูลลูกค้าเข้ากับงานขาย, นับอายุใบเสนอราคา,
 * จัดกลุ่มกิจกรรม/ไฟล์แนบตามงาน) ย้ายมาทำที่นี่ครั้งเดียว
 * แล้วทุกหน้าจอก็หยิบไปใช้ได้ทันทีโดยไม่ต้องคำนวณซ้ำ
 */
function reindex() {
  const custById = new Map(S.customers.map(c => [c.Customer_ID, c]));
  S.rows = S.opportunities.map(o => Object.assign({}, o, {
    Customer: custById.get(o.Customer_ID) || {},
    Quote_Age_Days: isPendingQuote(o.Status) ? daysSince(o.Request_Date) : null
  }));
  S.byId = new Map(S.rows.map(o => [o.Opportunity_ID, o]));

  S.actsBy = new Map();
  S.activities.forEach(a => {
    const list = S.actsBy.get(a.Opportunity_ID) || [];
    list.push(a);
    S.actsBy.set(a.Opportunity_ID, list);
  });

  S.filesBy = new Map();
  S.attachments.forEach(a => {
    const list = S.filesBy.get(a.Opportunity_ID) || [];
    list.push(a);
    S.filesBy.set(a.Opportunity_ID, list);
  });
}

/** ลายเซ็นของข้อมูลปัจจุบัน ใช้เทียบว่า snapshot ที่เพิ่งได้มาต่างจากที่มีอยู่จริงไหม */
function computeSignature() {
  return JSON.stringify([S.opportunities, S.customers, S.activities, S.attachments]);
}

/** วาง snapshot ที่ได้มาลงในเครื่อง คืนค่า true ถ้าข้อมูลต่างจากเดิมจริง */
function applySnapshot(data) {
  if (!data) return false;
  S.user = data.user || S.user;
  S.rev = typeof data.rev === 'undefined' ? S.rev : data.rev;
  ['customers', 'opportunities', 'activities', 'attachments', 'owners', 'workTypes', 'closeReasons',
    'statuses', 'closedStatus', 'pendingQuoteStatus', 'priorities', 'categories', 'activityTypes'
  ].forEach(k => { if (Array.isArray(data[k])) S[k] = data[k]; });
  ['wonStatus', 'voidStatus', 'quoteSentStatus'].forEach(k => { if (data[k]) S[k] = data[k]; });
  S.editableLists = !!data.editableLists;
  if (data.master && typeof data.master === 'object') S.master = data.master;
  // หลังบ้านรุ่นใหม่: รายชื่อสถานะมาจาก Master_Data ที่ผู้ใช้จัดเอง ใช้ตามนั้นเลย
  // หลังบ้านรุ่นเก่า: ยึด 12 สถานะมาตรฐานเป็นหลัก แล้วต่อท้ายด้วยของที่ส่งมาเพิ่ม
  if (!S.editableLists) S.statuses = mergeList(STATUS_ORDER, S.statuses);
  S.closedStatus = mergeList(CLOSED_ORDER, S.closedStatus);
  if (data.sla) S.sla = data.sla;

  const signature = computeSignature();
  const changed = signature !== S.signature;
  S.signature = signature;

  reindex();
  return changed;
}

function snapshotForCache() {
  return {
    rev: S.rev, user: S.user,
    customers: S.customers, opportunities: S.opportunities, activities: S.activities, attachments: S.attachments,
    owners: S.owners, workTypes: S.workTypes, closeReasons: S.closeReasons,
    statuses: S.statuses, closedStatus: S.closedStatus, pendingQuoteStatus: S.pendingQuoteStatus,
    priorities: S.priorities, categories: S.categories, activityTypes: S.activityTypes,
    wonStatus: S.wonStatus, voidStatus: S.voidStatus, quoteSentStatus: S.quoteSentStatus, sla: S.sla,
    master: S.master, editableLists: S.editableLists
  };
}

/** เก็บ snapshot ไว้ในเครื่อง เพื่อให้เปิดแอปครั้งหน้าเห็นข้อมูลทันทีโดยไม่ต้องรอเน็ต */
function saveCache() {
  try {
    const text = JSON.stringify(snapshotForCache());
    if (text.length > CACHE_MAX_CHARS) return;   // ใหญ่เกินไป ปล่อยให้โหลดใหม่ดีกว่า
    localStorage.setItem(SNAP_KEY, text);
  } catch (e) { /* โหมดส่วนตัว หรือพื้นที่เต็ม — ไม่ใช่เรื่องคอขาดบาดตาย */ }
}

function readCache() {
  try {
    const text = localStorage.getItem(SNAP_KEY);
    return text ? JSON.parse(text) : null;
  } catch (e) { return null; }
}

/* ---------------------------------------------------------------------------
 * 3. การคุยกับเซิร์ฟเวอร์
 *
 * เขียนข้อมูล/ดึง snapshot -> POST (token อยู่ใน body ไม่ติดไปกับ URL)
 * เช็คว่ามีอะไรเปลี่ยนไหม   -> GET ?ping=1 ตอบแค่ตัวเลข ไม่ต้องใช้ token
 * ------------------------------------------------------------------------- */
function withTimeout(url, options, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, Object.assign({}, options, { signal: ctrl.signal })).finally(() => clearTimeout(timer));
}

async function post(action, data) {
  if (!window.API_URL) return { success: false, message: 'ยังไม่ได้ตั้งค่า API_URL ในไฟล์ config.js' };
  try {
    const res = await withTimeout(window.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: action, data: data === undefined ? null : data, token: token() }),
      redirect: 'follow'
    }, POST_TIMEOUT_MS);
    const out = JSON.parse(await res.text());
    if (out && out.authError) { clearAuth(); renderLogin(out.message); return { success: false, message: out.message, handled: true }; }
    if (out && typeof out.rev !== 'undefined') S.rev = out.rev;
    return out;
  } catch (err) {
    const timedOut = err && err.name === 'AbortError';
    return { success: false, message: timedOut ? 'เซิร์ฟเวอร์ตอบช้าผิดปกติ ลองใหม่อีกครั้ง' : 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่' };
  }
}

/**
 * ถามเลข revision ล่าสุด — คืน null ถ้าถามไม่สำเร็จ
 *
 * ลอง fetch ก่อนเพราะเร็วที่สุด ถ้าไม่ผ่าน (Safari บนมือถือมีปัญหากับ redirect
 * ของ Apps Script อยู่บ่อยครั้ง) ค่อยถอยไปใช้ JSONP ซึ่งไม่ติดข้อจำกัด CORS
 */
async function pingRev() {
  if (!window.API_URL) return null;
  const url = window.API_URL + (window.API_URL.indexOf('?') === -1 ? '?' : '&') + 'ping=1&_ts=' + Date.now();
  try {
    const res = await withTimeout(url, { method: 'GET', redirect: 'follow', cache: 'no-store' }, PING_TIMEOUT_MS);
    const out = JSON.parse(await res.text());
    if (out && typeof out.rev !== 'undefined') return Number(out.rev);
  } catch (err) { /* ลองทางสำรองต่อ */ }
  const viaJsonp = await jsonpPing();
  return viaJsonp && typeof viaJsonp.rev !== 'undefined' ? Number(viaJsonp.rev) : null;
}

function jsonpPing() {
  return new Promise(resolve => {
    const name = 'pts_cb_' + Math.round(1e9 * Math.random());
    const script = document.createElement('script');
    let settled = false, timer = null;

    const done = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { delete window[name]; } catch (e) { window[name] = undefined; }
      if (script.parentNode) script.parentNode.removeChild(script);
      resolve(value);
    };

    window[name] = json => done(json || null);
    script.src = window.API_URL + (window.API_URL.indexOf('?') === -1 ? '?' : '&') + 'ping=1&callback=' + name + '&_ts=' + Date.now();
    script.async = true;
    script.onerror = () => done(null);
    (document.head || document.documentElement).appendChild(script);
    timer = setTimeout(() => done(null), PING_TIMEOUT_MS);
  });
}

/* ---------------------------------------------------------------------------
 * 4. ตัวซิงก์เบื้องหลัง
 *
 * ยิ่งเงียบยิ่งถามห่างขึ้น เครื่องที่เปิดทิ้งไว้ทั้งวันจะได้ไม่กินโควตา Apps Script
 * ------------------------------------------------------------------------- */
let syncTimer = null, quietPolls = 0, lastFullFetch = 0, lastLocalWrite = 0;

function syncInterval() {
  if (quietPolls < 12) return SYNC_FAST_MS;
  if (quietPolls < 40) return SYNC_SLOW_MS;
  return SYNC_IDLE_MS;
}

function scheduleSync(ms) { clearTimeout(syncTimer); syncTimer = setTimeout(runSyncTick, ms); }

/** ผู้ใช้เพิ่งทำอะไรสักอย่าง — กลับไปถามถี่ๆ อีกครั้ง */
function markActivity() { quietPolls = 0; scheduleSync(SYNC_FAST_MS); }

async function runSyncTick() {
  if (!token() || document.hidden) { scheduleSync(syncInterval()); return; }
  try {
    const rev = await pingRev();
    const changed = rev !== null && S.rev !== null && rev !== S.rev;
    const overdue = Date.now() - lastFullFetch > SYNC_SAFETY_MS;

    // ถ้า ping ใช้ไม่ได้ (เช่นยังไม่ได้ Deploy หลังบ้านเวอร์ชันใหม่) ห้ามถอยไปโหลด
    // ข้อมูลทั้งก้อนทุกๆ 5 วินาที เพราะจะกินโควตา Apps Script จนหมดวัน
    // ให้ค่อยๆ ถามห่างออกไป แล้วอาศัยการโหลดรอบใหญ่ตามกำหนดแทน
    if (changed || overdue) {
      quietPolls = 0;
      await refresh({ silent: true });
    } else if (rev === null) {
      quietPolls++;
      S.lastError = null;
      renderSync();
    } else {
      quietPolls++;
      S.lastError = null;
      S.lastSyncAt = new Date();
      renderSync();
    }
  } catch (err) { /* ตานี้พลาด ตาหน้าค่อยว่ากัน */ }
  scheduleSync(syncInterval());
}

function startSync() {
  lastFullFetch = Date.now();
  scheduleSync(SYNC_FAST_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) markActivity(); });
  window.addEventListener('focus', markActivity);
  window.addEventListener('online', markActivity);
}

/** ดึง snapshot ใหม่ทั้งก้อน */
async function refresh(options) {
  options = options || {};
  if (S.syncing) return false;
  S.syncing = true;
  renderSync();

  const out = await post('getSnapshot');
  S.syncing = false;
  lastFullFetch = Date.now();

  if (!out.success) {
    if (out.handled) return false;
    S.lastError = out.message;
    if (!S.ready) return renderFatal(out.message), false;
    renderSync();
    if (!options.silent) toast(out.message);
    return false;
  }

  S.lastError = null;
  S.lastSyncAt = new Date();

  const before = S.opportunities.length;
  const changed = applySnapshot(out.data);
  saveCache();

  if (!S.ready) { S.ready = true; render(); return true; }
  if (!changed) { renderSync(); return true; }

  repaint();

  // แจ้งเฉพาะตอนที่จำนวนงานเปลี่ยนจริง และไม่ใช่ผลจากการบันทึกของเราเอง
  const diff = S.opportunities.length - before;
  if (options.silent && diff !== 0 && Date.now() - lastLocalWrite > 8000) {
    toast(diff > 0 ? 'มีงานขายใหม่ ' + diff + ' รายการจากเครื่องอื่น' : 'มีการลบงานขาย ' + Math.abs(diff) + ' รายการจากเครื่องอื่น', 'info');
  }
  return true;
}

/**
 * วาดหน้าจอใหม่หลังข้อมูลเปลี่ยนเบื้องหลัง — แต่ต้องไม่ไปทับสิ่งที่ผู้ใช้กำลังทำอยู่
 *
 * ถ้ากำลังกรอกฟอร์ม เปิดหน้าต่างซ้อน หรือพิมพ์อยู่ในช่องใดช่องหนึ่ง
 * จะพักการวาดไว้ก่อน แล้วค่อยวาดตอนที่ผู้ใช้เปลี่ยนหน้าเอง
 */
function repaint() {
  const el = document.activeElement;
  const typing = el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
  if ($('#modal') || S.view.name === 'rfq' || typing) {
    S.repaintPending = true;
    renderSync();
    return;
  }
  S.repaintPending = false;
  render();
}

/**
 * เอาผลลัพธ์ที่เพิ่งบันทึกมาวางในข้อมูลของเครื่องทันที
 * หน้าจอจึงอัปเดตให้เห็นผลเดี๋ยวนั้น โดยไม่ต้องเสียเวลาโหลด snapshot ใหม่อีกรอบ
 */
function applyWrite(out) {
  const d = (out && out.data) || {};
  lastLocalWrite = Date.now();

  if (d.opportunity && d.opportunity.Opportunity_ID) {
    const i = S.opportunities.findIndex(o => o.Opportunity_ID === d.opportunity.Opportunity_ID);
    if (i === -1) S.opportunities.unshift(d.opportunity); else S.opportunities[i] = Object.assign({}, S.opportunities[i], d.opportunity);
    const owner = String(d.opportunity.Owner || '').trim();
    if (owner && S.owners.indexOf(owner) === -1) S.owners.push(owner);
  }
  if (d.customer && d.customer.Customer_ID) {
    const i = S.customers.findIndex(c => c.Customer_ID === d.customer.Customer_ID);
    if (i === -1) S.customers.push(d.customer); else S.customers[i] = Object.assign({}, S.customers[i], d.customer);
    S.customers.sort((a, b) => String(a.Company_Name).localeCompare(String(b.Company_Name)));
  }
  if (d.master && typeof d.master === 'object') {
    S.master = d.master;
    if (Array.isArray(d.statuses)) S.statuses = d.statuses;
    if (Array.isArray(d.workTypes)) S.workTypes = d.workTypes;
    if (Array.isArray(d.closeReasons)) S.closeReasons = d.closeReasons;
    S.closedStatus = mergeList(CLOSED_ORDER, S.closedStatus);
  }
  if (d.activity && d.activity.Activity_ID) S.activities.unshift(d.activity);
  if (Array.isArray(d.attachments)) d.attachments.slice().reverse().forEach(a => S.attachments.unshift(a));
  else if (d.Attachment_ID) S.attachments = S.attachments.filter(a => a.Attachment_ID !== d.Attachment_ID);

  // อัปเดตลายเซ็นให้ตรงกับข้อมูลที่เพิ่งแก้ การซิงก์รอบหน้าจะได้ไม่เข้าใจผิด
  // ว่ามีคนอื่นมาแก้ แล้วเด้งข้อความแจ้งเตือนที่ไม่จริงขึ้นมา
  S.signature = computeSignature();
  reindex();
  saveCache();
  markActivity();
}

/* ---------------------------------------------------------------------------
 * 5. ส่วนแสดงผล
 * ------------------------------------------------------------------------- */
let toastTimer = null;
function toast(message, kind) {
  const el = $('#toast');
  el.textContent = message;
  el.className = 'toast ' + (kind === 'ok' ? 'is-ok' : kind === 'info' ? 'is-info' : 'is-bad');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3400);
}

function go(name, params) {
  S.view = { name: name, params: params || {} };
  window.scrollTo({ top: 0 });
  render();
  markActivity();
}

function render() {
  if (!S.ready) return;
  S.repaintPending = false;
  const v = S.view;
  if (v.name === 'opportunities') viewList();
  else if (v.name === 'detail') viewDetail(v.params.id);
  else if (v.name === 'rfq') viewRfq(v.params.opp || {});
  else if (v.name === 'customers') viewCustomers();
  else if (v.name === 'settings') viewSettings();
  else viewDashboard();
  renderNav();
}

function renderNav() {
  const active = S.view.name === 'detail' ? 'opportunities' : S.view.name;
  const items = [['dashboard', I.dash, 'ภาพรวม'], ['opportunities', I.list, 'งานขาย'], ['rfq', I.plus, 'ขอราคา'], ['customers', I.users, 'ลูกค้า']];
  const nav = $('#nav');
  nav.hidden = false;
  nav.innerHTML = items.map(n => `<button type="button" onclick="go('${n[0]}')" class="${active === n[0] ? 'is-active' : ''}">${n[1]}<span>${n[2]}</span></button>`).join('');
}

/** แถบบนสุด — มีปุ่มรีเฟรชเอง และป้ายบอกว่าข้อมูลบนจอสดแค่ไหน */
function header(title, sub, back) {
  return `<header class="hdr">
    <div class="hdr-top">
      ${back ? `<button type="button" class="hdr-btn hdr-btn-icon" onclick="${back}" aria-label="ย้อนกลับ">${I.back}</button>`
             : `<img src="logo-mark.png" alt="" class="hdr-logo" width="38" height="38">`}
      <div class="grow">
        <h1>${esc(title)}</h1>
        ${sub ? `<div class="hdr-sub" id="hdrSub">${esc(sub)}</div>` : ''}
      </div>
      <button type="button" class="hdr-btn hdr-btn-icon" onclick="go('settings')" aria-label="ตั้งค่า">${I.gear}</button>
      <button type="button" class="hdr-btn hdr-btn-icon" onclick="manualRefresh()" aria-label="โหลดข้อมูลใหม่">${I.refresh}</button>
      <button type="button" class="hdr-btn" onclick="logout()">${I.logout}<span>ออก</span></button>
    </div>
    <div id="syncPill">${syncPill()}</div>
  </header>`;
}

function syncPill() {
  const cls = S.syncing ? 'is-busy' : S.lastError ? 'is-down' : '';
  let text;
  if (S.syncing) text = 'กำลังอัปเดตข้อมูล…';
  else if (S.lastError) text = 'ออฟไลน์ · แสดงข้อมูลที่บันทึกไว้ในเครื่อง';
  else if (S.lastSyncAt) text = 'ข้อมูลล่าสุด ' + pad2(S.lastSyncAt.getHours()) + ':' + pad2(S.lastSyncAt.getMinutes()) + ' · ' + esc(myName());
  else text = esc(myName());
  return `<span class="sync ${cls}"><span class="sync-dot"></span>${text}</span>`;
}

/** อัปเดตเฉพาะป้ายสถานะ ไม่ต้องวาดทั้งหน้าใหม่ */
function renderSync() {
  const el = $('#syncPill');
  if (el) el.innerHTML = syncPill();
}

async function manualRefresh() {
  markActivity();
  const ok = await refresh({});
  if (ok) toast('ข้อมูลเป็นปัจจุบันแล้ว', 'ok');
}

/**
 * เปิดแอปครั้งแรกแล้วโหลดข้อมูลไม่สำเร็จ และยังไม่มีข้อมูลเก่าในเครื่องให้แสดง
 *
 * ส่วนใหญ่เป็นแค่เน็ตหลุดชั่วคราว ปุ่มหลักจึงเป็น "ลองใหม่" ไม่ใช่การออกจากระบบ
 * (การออกจากระบบจะลบข้อมูลในเครื่องทิ้ง ซึ่งไม่ได้ช่วยอะไรเลยเวลาเน็ตมีปัญหา)
 */
function renderFatal(message) {
  $('#nav').hidden = true;
  $('#app').innerHTML = `<div class="page"><div class="card stack">
    <h1>โหลดข้อมูลไม่สำเร็จ</h1>
    <p class="meta">${esc(message)}</p>
    <button class="btn btn-primary btn-block" onclick="retryBoot()">${I.refresh}ลองใหม่</button>
    <button class="btn btn-soft btn-block" onclick="logout()">เข้าสู่ระบบใหม่</button>
  </div></div>`;
}

async function retryBoot() {
  renderSkeleton();
  await refresh({});
}

/* --------------------------------------------------------------- เข้าสู่ระบบ */
let LOGIN_PW = '', LOGIN_NAMES = [];

function renderLogin(message, names) {
  S.ready = false;
  $('#nav').hidden = true;
  $('#app').innerHTML = `<div class="auth"><form class="card stack" onsubmit="submitLogin(event)">
    <div>
      <img src="logo-full.jpg" alt="PAKORN Technical Supply" class="auth-logo">
      <h1 style="text-align:center">PTS Sales</h1>
      <p class="meta" style="text-align:center">ระบบติดตามงานขาย</p>
    </div>
    ${message ? `<p class="auth-err">${esc(message)}</p>` : ''}
    ${names
      ? `<label><span class="label">คุณคือใคร *</span>
          <input name="name" class="field" required autofocus autocomplete="name" minlength="2" maxlength="60"
                 placeholder="พิมพ์ชื่อของคุณ" list="dl-login-name">
          <datalist id="dl-login-name">${names.map(n => `<option value="${esc(n)}"></option>`).join('')}</datalist>
        </label>
        <p class="hint">ใช้ชื่อเดิมทุกครั้ง ระบบจะได้รวมงานของคุณไว้ที่เดียวกันในหน้า “งานของฉัน”</p>`
      : `<label><span class="label">รหัสผ่านของทีม *</span><input name="password" type="password" class="field" required autocomplete="current-password" autofocus></label>`}
    <button class="btn btn-primary btn-block">${names ? 'เข้าใช้งาน' : 'ถัดไป'}</button>
    <p class="hint" style="text-align:center">ระบบจะจำอุปกรณ์นี้ไว้ 30 วัน</p>
  </form></div>`;
}

async function submitLogin(e) {
  e.preventDefault();
  lockForm(e, true, 'กำลังตรวจสอบ…');
  const f = Object.fromEntries(new FormData(e.target));
  const atNameStep = f.name !== undefined;
  if (f.password !== undefined) LOGIN_PW = f.password;

  const r = await post('login', { password: LOGIN_PW, name: f.name || '' });
  if (!r.success) {
    // พลาดตอนกรอกชื่อ ให้อยู่หน้าเดิม จะได้ไม่ต้องกลับไปกรอกรหัสผ่านของทีมใหม่ทั้งที่กรอกถูกแล้ว
    if (atNameStep) return renderLogin(r.message, LOGIN_NAMES);
    LOGIN_PW = '';
    return renderLogin(r.message);
  }
  if (r.data && r.data.needName) {
    LOGIN_NAMES = r.data.names || [];
    return renderLogin('', LOGIN_NAMES);
  }
  setAuth(r.data.token, r.data.name);
  LOGIN_PW = '';
  LOGIN_NAMES = [];
  boot();
}

function logout() {
  if (!confirm('ออกจากระบบ?')) return;
  clearAuth();
  location.reload();
}

function lockForm(e, on, text) {
  const b = e.target.querySelector('button:not([type="button"])');
  if (!b) return;
  if (on) {
    if (!b.dataset.label) b.dataset.label = b.textContent;
    b.textContent = text || 'กำลังบันทึก…';
    b.disabled = true;
  } else {
    b.textContent = b.dataset.label || b.textContent;
    b.disabled = false;
  }
}

/* ------------------------------------------------------------------ ชิ้นส่วน */
function ageBadge(o) {
  const n = o.Quote_Age_Days;
  if (n === null || n === undefined || n === '') return '';
  if (n < S.sla.warn) return '';
  return `<span class="badge ${n >= S.sla.overdue ? 'tone-red' : 'tone-amber'}">รอเสนอราคา ${n} วัน</span>`;
}

function oppCard(o) {
  return `<button type="button" onclick="go('detail',{id:'${esc(o.Opportunity_ID)}'})" class="card card-btn stack-sm">
    <div class="row-between" style="align-items:flex-start">
      <strong class="grow">${esc(o.Project_Name)}</strong>
      <span style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex:none">
        <span class="badge tone-${tone(o.Status)}">${esc(o.Status)}</span>${ageBadge(o)}
      </span>
    </div>
    <div class="meta-strong truncate">${esc(o.Customer.Company_Name || '')}</div>
    <div class="meta">${esc(o.Opportunity_ID)} · ${esc(o.Owner)} · ติดตาม ${fmtDate(o.Next_Action_Date)}</div>
  </button>`;
}

function oppSection(title, items, empty, kind) {
  const cls = kind === 'danger' ? 'is-danger' : kind === 'warn' ? 'is-warn' : '';
  const countCls = kind === 'danger' ? 'is-danger' : kind === 'warn' ? 'is-warn' : '';
  return `<section class="stack">
    <h2 class="section-title ${items.length ? cls : ''}">${esc(title)}${items.length ? `<span class="count ${countCls}">${items.length}</span>` : ''}</h2>
    ${items.length ? items.map(oppCard).join('') : `<div class="empty">${esc(empty)}</div>`}
  </section>`;
}

function inputField(name, label, value, type, required) {
  let v = value == null ? '' : value;
  if (type === 'date') v = dOnly(v);
  if (type === 'datetime-local') v = String(v).slice(0, 16);
  return `<label><span class="label">${label}${required ? ' *' : ''}</span><input name="${name}" type="${type || 'text'}" value="${esc(v)}" class="field" ${required ? 'required' : ''}></label>`;
}

function selectField(name, label, options, value, required) {
  return `<label><span class="label">${label}${required ? ' *' : ''}</span><select name="${name}" class="field" ${required ? 'required' : ''}>${options.map(x => `<option value="${esc(x)}" ${x === value ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label>`;
}

/** ช่องเลือก + พิมพ์เองได้ (เลือกจากรายการเดิม หรือพิมพ์ชื่อใหม่ลงไปได้เลย) */
function comboField(name, label, options, value, required, hint) {
  const id = 'dl-' + name;
  return `<label><span class="label">${label}${required ? ' *' : ''}</span>
    <input name="${name}" list="${id}" value="${esc(value == null ? '' : value)}" class="field" ${required ? 'required' : ''} autocomplete="off" placeholder="${esc(hint || '')}">
    <datalist id="${id}">${options.filter(Boolean).map(x => `<option value="${esc(x)}"></option>`).join('')}</datalist></label>`;
}

function customerOptions(selected) {
  return `<option value="">เลือกลูกค้า</option>` + S.customers.map(c =>
    `<option value="${esc(c.Customer_ID)}" ${selected === c.Customer_ID ? 'selected' : ''}>${esc(c.Company_Name)}${c.Contact_Name ? ' — ' + esc(c.Contact_Name) : ''}</option>`).join('');
}

/* ------------------------------------------------------------------ ภาพรวม */

/**
 * คำนวณตัวเลขหน้าภาพรวมจากข้อมูลในเครื่อง
 * เดิมงานนี้เป็นคำสั่ง dashboardData ที่ฝั่งเซิร์ฟเวอร์ การสลับ "งานของฉัน/ทั้งทีม"
 * จึงต้องรอเน็ตทุกครั้ง ตอนนี้คิดเสร็จภายในไม่กี่มิลลิวินาที
 */
function dashboardStats(owner) {
  const today = todayStr();
  const rows = owner ? S.rows.filter(o => String(o.Owner) === owner) : S.rows;
  const open = rows.filter(o => !isClosed(o.Status));

  // การ์ดนับจำนวนในหน้าภาพรวม — แสดงครบทุกสถานะ รวมสถานะปิด (ได้งาน/ไม่ได้งาน) ด้วย
  const counts = {};
  S.statuses.forEach(s => counts[s] = 0);
  rows.forEach(o => { if (Object.prototype.hasOwnProperty.call(counts, o.Status)) counts[o.Status]++; });

  const pending = open.filter(o => isPendingQuote(o.Status) && o.Quote_Age_Days !== null)
    .sort((a, b) => b.Quote_Age_Days - a.Quote_Age_Days);
  const quoteOverdue = pending.filter(o => o.Quote_Age_Days >= S.sla.overdue);
  const quoteWarn = pending.filter(o => o.Quote_Age_Days >= S.sla.warn && o.Quote_Age_Days < S.sla.overdue);

  const leadDays = rows.map(o => daysBetween(o.Request_Date, o.Quotation_Sent_Date)).filter(n => n !== null && n >= 0);
  const onTime = leadDays.filter(n => n <= S.sla.warn).length;

  return {
    counts: counts,
    kpi: {
      pendingQuote: pending.length,
      quoteWarn: quoteWarn.length,
      quoteOverdue: quoteOverdue.length,
      quotedCount: leadDays.length,
      onTimeRate: leadDays.length ? Math.round(onTime * 100 / leadDays.length) : null,
      avgLeadDays: leadDays.length ? Math.round(leadDays.reduce((a, b) => a + b, 0) / leadDays.length * 10) / 10 : null
    },
    quoteOverdue: quoteOverdue,
    quoteWarn: quoteWarn,
    followUpOverdue: open.filter(o => o.Next_Action_Date && dOnly(o.Next_Action_Date) < today)
      .sort((a, b) => String(a.Next_Action_Date).localeCompare(String(b.Next_Action_Date))),
    today: open.filter(o => o.Next_Action_Date && dOnly(o.Next_Action_Date) === today),
    overdue: open.filter(o => o.Due_Date && dOnly(o.Due_Date) < today)
  };
}

function viewDashboard() {
  const owner = S.mine ? myName() : '';
  const d = dashboardStats(owner);
  const k = d.kpi;
  const rate = k.onTimeRate == null ? '—' : k.onTimeRate + '%';
  const rateTone = k.onTimeRate == null ? 't-mute' : k.onTimeRate >= 80 ? 't-ok' : k.onTimeRate >= 60 ? 't-warn' : 't-bad';

  $('#app').innerHTML = header('PTS Sales', 'ภาพรวมงานขาย') + `<div class="page">
    <div class="seg">
      <button type="button" class="${S.mine ? 'is-active' : ''}" onclick="setScope(true)">งานของฉัน</button>
      <button type="button" class="${S.mine ? '' : 'is-active'}" onclick="setScope(false)">ทั้งทีม</button>
    </div>

    <div class="row-between">
      <p class="hint" style="margin:0">${S.arrange ? 'ลากการ์ดไปวางตำแหน่งที่ต้องการ แล้วกด เสร็จ' : 'แตะการ์ดเพื่อดูรายการงานในสถานะนั้น'}</p>
      <div class="row" style="gap:6px">
        ${S.arrange ? `<button type="button" class="btn btn-soft btn-sm" onclick="resetStatusOrder()">ค่าเริ่มต้น</button>` : ''}
        <button type="button" class="btn ${S.arrange ? 'btn-primary' : 'btn-outline'} btn-sm" onclick="toggleArrange()">${S.arrange ? 'เสร็จ' : 'จัดเรียง'}</button>
      </div>
    </div>

    <div class="grid-3 ${S.arrange ? 'is-arranging' : ''}">
      ${statusOrder().map(key => `<button type="button" class="stat ${d.counts[key] ? '' : 'is-zero'}" data-status="${esc(key)}"
        ${S.arrange
          ? 'onpointerdown="startDrag(event,this)" onpointermove="moveDrag(event)" onpointerup="endDrag()" onpointercancel="endDrag()"'
          : `onclick="openStatus('${esc(key)}')"`}>
        <div class="stat-n">${d.counts[key]}</div><div class="stat-l">${esc(key)}</div></button>`).join('')}
    </div>

    <section class="card stack">
      <div>
        <h2>KPI การเสนอราคา</h2>
        <p class="hint">นับจากวันที่ลูกค้าขอราคา ถึงวันที่ส่งใบเสนอราคา · เป้าหมายภายใน ${S.sla.warn} วัน</p>
      </div>
      <div class="grid-2 grid-2-sm">
        <div><div class="kpi-n ${rateTone}">${rate}</div><div class="kpi-l">เสนอราคาทันเป้า</div></div>
        <div><div class="kpi-n">${k.avgLeadDays == null ? '—' : k.avgLeadDays + ' วัน'}</div><div class="kpi-l">เฉลี่ยที่ใช้จริง</div></div>
        <div><div class="kpi-n t-warn">${k.quoteWarn}</div><div class="kpi-l">เกิน ${S.sla.warn} วัน</div></div>
        <div><div class="kpi-n t-bad">${k.quoteOverdue}</div><div class="kpi-l">เกิน ${S.sla.overdue} วัน</div></div>
      </div>
      <p class="hint">${k.quotedCount
        ? 'คำนวณจากงานที่ส่งใบเสนอราคาแล้ว ' + k.quotedCount + ' งาน · ยังรอเสนอราคาอีก ' + k.pendingQuote + ' งาน'
        : 'ยังไม่มีงานที่บันทึกวันส่งใบเสนอราคา — ระบบจะเริ่มนับให้อัตโนมัติเมื่อเปลี่ยนสถานะเป็น “' + esc(S.quoteSentStatus) + '”'}</p>
    </section>

    ${oppSection('เกินกำหนดเสนอราคา ' + S.sla.overdue + ' วัน', d.quoteOverdue, 'ไม่มีงานเกินกำหนดเสนอราคา', 'danger')}
    ${oppSection('ใกล้ครบกำหนดเสนอราคา ' + S.sla.warn + ' วัน', d.quoteWarn, 'ไม่มีงานใกล้ครบกำหนด', 'warn')}
    ${oppSection('เลยวันติดตาม', d.followUpOverdue, 'ไม่มีงานค้างติดตาม', 'danger')}
    ${oppSection('งานที่ต้องทำวันนี้', d.today, 'ไม่มีงานติดตามวันนี้')}
    ${oppSection('งานเกินกำหนดส่ง', d.overdue, 'ไม่มีงานเกินกำหนด')}
  </div>`;
}

function setScope(mine) { S.mine = mine; viewDashboard(); }

/* ---------------------------------------------------- จัดเรียงการ์ดสถานะ
 * ผู้ใช้ลากการ์ดในหน้าภาพรวมเพื่อเรียงลำดับเอง ลำดับเก็บไว้ในเครื่อง (localStorage)
 * แยกกันแต่ละเครื่อง ไม่กระทบคนอื่นและไม่กระทบหลังบ้าน
 * สถานะใหม่ที่ยังไม่เคยจัด จะต่อท้ายตามลำดับมาตรฐาน
 * ใช้ Pointer Events (ไม่ใช้ HTML5 drag) เพราะบนมือถือ/iOS ลากได้จริง
 */
function statusOrder() {
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem(ORDER_KEY) || '[]'); } catch (e) { saved = []; }
  if (!Array.isArray(saved)) saved = [];
  const known = saved.filter(s => S.statuses.indexOf(s) !== -1);
  return known.concat(S.statuses.filter(s => known.indexOf(s) === -1));
}
function saveStatusOrder(list) { try { localStorage.setItem(ORDER_KEY, JSON.stringify(list)); } catch (e) {} }
function resetStatusOrder() { try { localStorage.removeItem(ORDER_KEY); } catch (e) {} toast('คืนลำดับมาตรฐานแล้ว', 'ok'); viewDashboard(); }
function toggleArrange() { S.arrange = !S.arrange; if (!S.arrange) toast('บันทึกลำดับการ์ดแล้ว', 'ok'); viewDashboard(); }

let drag = null;   // { el, ghost, grid, dx, dy }

function startDrag(e, el) {
  if (!S.arrange || drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
  e.preventDefault();
  const r = el.getBoundingClientRect();
  const ghost = el.cloneNode(true);
  ghost.className = 'stat stat-ghost';
  ghost.style.width = r.width + 'px';
  ghost.style.height = r.height + 'px';
  ghost.style.left = r.left + 'px';
  ghost.style.top = r.top + 'px';
  document.body.appendChild(ghost);
  el.classList.add('is-placeholder');
  drag = { el: el, ghost: ghost, grid: el.parentNode, dx: e.clientX - r.left, dy: e.clientY - r.top };
  try { el.setPointerCapture(e.pointerId); } catch (err) {}
}

function moveDrag(e) {
  if (!drag) return;
  e.preventDefault();
  drag.ghost.style.left = (e.clientX - drag.dx) + 'px';
  drag.ghost.style.top = (e.clientY - drag.dy) + 'px';
  const under = document.elementFromPoint(e.clientX, e.clientY);
  const target = under && under.closest ? under.closest('.stat') : null;
  if (!target || target === drag.el || target.parentNode !== drag.grid) return;
  const cards = Array.from(drag.grid.children);
  const from = cards.indexOf(drag.el), to = cards.indexOf(target);
  if (from < to) drag.grid.insertBefore(drag.el, target.nextSibling);
  else drag.grid.insertBefore(drag.el, target);
}

function endDrag() {
  if (!drag) return;
  drag.ghost.remove();
  drag.el.classList.remove('is-placeholder');
  saveStatusOrder(Array.from(drag.grid.children).map(c => c.dataset.status));
  drag = null;
}

function openStatus(status) {
  S.filter = { query: '', status: status, owner: S.mine ? myName() : '', priority: '' };
  go('opportunities');
}

/* ---------------------------------------------------------------- รายการงาน */
function filteredRows() {
  const f = S.filter;
  const q = String(f.query || '').trim().toLowerCase();
  return S.rows.filter(o => {
    if (f.status && o.Status !== f.status) return false;
    if (f.owner && o.Owner !== f.owner) return false;
    if (f.priority && o.Priority !== f.priority) return false;
    if (!q) return true;
    return [o.Opportunity_ID, o.Project_Name, o.Quotation_No, o.Customer.Company_Name, o.Requester_Name, o.Requester_Phone]
      .join(' ').toLowerCase().indexOf(q) !== -1;
  });
}

function viewList() {
  const f = S.filter;
  const rows = filteredRows();
  $('#app').innerHTML = header('งานขาย', rows.length + ' จาก ' + S.rows.length + ' รายการ') + `<div class="page">
    <div class="stack">
      <input id="q" class="field" value="${esc(f.query)}" placeholder="ค้นหา งาน / บริษัท / โทร / เลขที่ QT" oninput="onSearch(this.value)" autocomplete="off">
      <div class="grid-3">
        <select class="field field-sm" onchange="setFilter('status',this.value)"><option value="">ทุกสถานะ</option>${S.statuses.map(s => `<option ${f.status === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
        <select class="field field-sm" onchange="setFilter('owner',this.value)"><option value="">ทุกผู้รับผิดชอบ</option>${S.owners.map(s => `<option ${f.owner === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
        <select class="field field-sm" onchange="setFilter('priority',this.value)"><option value="">ทุกความสำคัญ</option>${S.priorities.map(s => `<option ${f.priority === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
      </div>
      ${(f.status || f.owner || f.priority || f.query) ? `<button type="button" class="btn btn-soft btn-sm" onclick="clearFilters()">ล้างตัวกรองทั้งหมด</button>` : ''}
    </div>
    <div id="rows" class="stack">${listRowsHtml(rows)}</div>
  </div>`;
}

function listRowsHtml(rows) {
  return rows.length ? rows.map(oppCard).join('') : '<div class="empty">ไม่พบงานขายที่ตรงกับเงื่อนไข</div>';
}

/** ค้นหาแบบพิมพ์ไปเห็นผลไป — วาดใหม่เฉพาะรายการ ช่องพิมพ์จึงไม่เสียโฟกัส */
function onSearch(value) {
  S.filter.query = value;
  const rows = filteredRows();
  const box = $('#rows');
  if (box) box.innerHTML = listRowsHtml(rows);
  const sub = $('#hdrSub');
  if (sub) sub.textContent = rows.length + ' จาก ' + S.rows.length + ' รายการ';
}

function setFilter(key, value) { S.filter[key] = value; viewList(); }
function clearFilters() { S.filter = { query: '', status: '', owner: '', priority: '' }; viewList(); }

/* ------------------------------------------------------------ รายละเอียดงาน */
function viewDetail(id) {
  const o = S.byId.get(id);
  if (!o) {
    $('#app').innerHTML = header('ไม่พบงานขาย', '', "go('opportunities')") +
      `<div class="page"><div class="empty">ไม่พบงานขายรหัสนี้ อาจถูกลบไปแล้ว</div></div>`;
    return;
  }
  const c = o.Customer || {};
  const acts = S.actsBy.get(id) || [];
  const files = S.filesBy.get(id) || [];

  $('#app').innerHTML = header(o.Opportunity_ID, 'รายละเอียดงานขาย', "go('opportunities')") + `<div class="page">
    <section class="card stack">
      <div class="row-between" style="align-items:flex-start">
        <div class="grow">
          <h2>${esc(o.Project_Name)}</h2>
          <p class="meta-strong">${esc(c.Company_Name || '')}</p>
        </div>
        <span style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex:none">
          <span class="badge tone-${tone(o.Status)}">${esc(o.Status)}</span>${ageBadge(o)}
        </span>
      </div>
      <div class="grid-2">
        ${detailPair('ผู้ขอราคา', o.Requester_Name || c.Contact_Name)}
        ${detailPair('แผนก', o.Requester_Department || c.Department)}
        ${detailPair('โทร', o.Requester_Phone || c.Phone)}
        ${detailPair('ผู้รับผิดชอบ', o.Owner)}
        ${detailPair('ความสำคัญ', o.Priority)}
        ${detailPair('ครบกำหนด', fmtDate(o.Due_Date))}
        ${detailPair('Next Action', o.Next_Action)}
        ${detailPair('วันที่ติดตาม', fmtDate(o.Next_Action_Date))}
      </div>
      <div class="grid-2">
        <button type="button" class="btn btn-soft" onclick="editOpp('${esc(o.Opportunity_ID)}')">${I.edit}แก้ไข</button>
        <button type="button" class="btn btn-primary" onclick="statusForm('${esc(o.Opportunity_ID)}')">${I.swap}เปลี่ยนสถานะ</button>
      </div>
      ${o.Status !== S.voidStatus ? `<button type="button" class="btn btn-danger btn-block" onclick="voidForm('${esc(o.Opportunity_ID)}')">${I.ban}ยกเลิกงาน</button>` : ''}
    </section>

    <section class="card stack-sm">
      ${detailRow('สถานที่หน้างาน', o.Site_Location)}
      ${detailRow('ประเภทงาน', o.Work_Type)}
      ${detailRow('รายละเอียด', o.Description)}
      ${detailRow('มูลค่าคาดการณ์', fmtMoney(o.Estimated_Value))}
      ${detailRow('ใบเสนอราคา', (o.Quotation_No || '-') + ' / ' + fmtMoney(o.Quotation_Amount))}
      ${o.Quotation_Sent_Date ? detailRow('วันที่ส่งใบเสนอราคา', fmtDate(o.Quotation_Sent_Date)) : ''}
      ${o.Close_Reason ? detailRow('เหตุผลปิดงาน', o.Close_Reason) : ''}
      ${o.Remark ? detailRow('หมายเหตุ', o.Remark) : ''}
    </section>

    <div class="grid-2">
      <button type="button" class="btn btn-outline" onclick="activityForm('${esc(o.Opportunity_ID)}')">${I.note}เพิ่ม Activity</button>
      <button type="button" class="btn btn-outline" onclick="uploadForm('${esc(o.Opportunity_ID)}')">${I.clip}แนบไฟล์</button>
    </div>

    <section class="stack">
      <h2 class="section-title">Timeline${acts.length ? `<span class="count">${acts.length}</span>` : ''}</h2>
      ${acts.length ? `<div class="tl">${acts.map(a => `<div class="tl-item card card-tight stack-sm">
        <div class="row-between"><b>${esc(a.Activity_Type)}</b><span class="hint">${fmtDateTime(a.Activity_Date)}</span></div>
        <p style="font-size:.88rem">${esc(a.Description)}</p>
        <div class="hint">โดย ${esc(a.Created_By || '-')}</div>
      </div>`).join('')}</div>` : '<div class="empty">ยังไม่มีกิจกรรม</div>'}
    </section>

    <section class="stack">
      <h2 class="section-title">ไฟล์แนบ${files.length ? `<span class="count">${files.length}</span>` : ''}</h2>
      ${files.length ? files.map(a => `<div class="card card-tight row">
        <a class="grow row" href="${esc(a.Drive_URL)}" target="_blank" rel="noopener" style="text-decoration:none;color:inherit;min-width:0">
          <span class="grow truncate" style="font-size:.88rem">${esc(a.File_Name)}</span>
          <span class="badge tone-slate">${esc(a.Category)}</span>
          <span style="color:var(--faint);display:flex">${I.ext}</span>
        </a>
        <button type="button" class="icon-btn" title="ลบไฟล์" onclick="removeFile('${esc(a.Attachment_ID)}','${esc(o.Opportunity_ID)}')">${I.trash}</button>
      </div>`).join('') : '<div class="empty">ยังไม่มีไฟล์แนบ</div>'}
    </section>
  </div>`;
}

const detailPair = (label, value) => `<div><div class="hint">${label}</div><div class="meta-strong">${esc(value || '-')}</div></div>`;
const detailRow = (label, value) => `<p style="font-size:.88rem"><b>${label}:</b> ${esc(value == null || value === '' ? '-' : value)}</p>`;

function editOpp(id) {
  const o = S.byId.get(id);
  if (!o) return toast('ไม่พบงานขาย');
  go('rfq', { opp: o });
}

/* --------------------------------------------------------------- ฟอร์ม RFQ */
function viewRfq(o) {
  o = o || {};
  const editing = !!o.Opportunity_ID;
  const workTypes = S.workTypes.slice();
  if (o.Work_Type && workTypes.indexOf(o.Work_Type) === -1) workTypes.push(o.Work_Type);

  $('#app').innerHTML = header(editing ? 'แก้ไขงานขาย' : 'ขอใบเสนอราคา', editing ? o.Opportunity_ID : 'สร้าง RFQ ใหม่',
      editing ? `go('detail',{id:'${esc(o.Opportunity_ID)}'})` : '') + `<form class="page" onsubmit="saveOpp(event,'${esc(o.Opportunity_ID || '')}')">
    <section class="card stack">
      <h2>ข้อมูลหลัก</h2>
      ${editing ? '' : `<button type="button" class="btn btn-outline btn-block" onclick="reuseForm()">${I.history}ดึงข้อมูลจากงานเก่ามาใช้</button>`}
      <label><span class="label">ลูกค้า *</span><select name="Customer_ID" class="field" required onchange="onCustomerPick(this.value)">${customerOptions(o.Customer_ID)}</select></label>
      <div id="reuseHint">${editing ? '' : reuseHint(o.Customer_ID)}</div>
      ${inputField('Project_Name', 'ชื่อโครงการ', o.Project_Name, 'text', true)}
      ${inputField('Site_Location', 'สถานที่หน้างาน', o.Site_Location)}
      ${selectField('Work_Type', 'ประเภทงาน', [''].concat(workTypes), o.Work_Type)}
      <label><span class="label">รายละเอียด</span><textarea name="Description" class="field" rows="3">${esc(o.Description)}</textarea></label>
    </section>

    <section class="card stack">
      <h2>เงื่อนไขและมูลค่า</h2>
      <div class="grid-2">
        ${selectField('Priority', 'ความสำคัญ', S.priorities, o.Priority || 'Normal')}
        ${inputField('Due_Date', 'ครบกำหนด', o.Due_Date, 'date')}
      </div>
      ${comboField('Owner', 'ผู้รับผิดชอบ', S.owners, o.Owner || myName(), true, 'เลือกจากรายชื่อ หรือพิมพ์ชื่อใหม่')}
      <div class="grid-2">
        ${inputField('Estimated_Value', 'มูลค่าคาดการณ์', o.Estimated_Value, 'number')}
        ${inputField('Quotation_No', 'เลขที่ใบเสนอราคา', o.Quotation_No)}
      </div>
      ${inputField('Quotation_Amount', 'มูลค่าใบเสนอราคา', o.Quotation_Amount, 'number')}
    </section>

    <section class="card stack">
      <h2>ติดตามงาน</h2>
      ${inputField('Next_Action', 'Next Action', o.Next_Action, 'text', true)}
      ${inputField('Next_Action_Date', 'วันที่ติดตาม', o.Next_Action_Date, 'date', true)}
      <label><span class="label">หมายเหตุ</span><textarea name="Remark" class="field" rows="2">${esc(o.Remark)}</textarea></label>
    </section>

    <button class="btn btn-primary btn-block">${editing ? 'บันทึกการแก้ไข' : 'สร้าง RFQ'}</button>
  </form>`;
}

/* ------------------------------------------------ ดึงข้อมูลจากงานเก่า
 * ลูกค้าเดิมมักขอราคางานคล้ายๆ เดิม (PM ปีถัดไป, ซ่อมระบบเดิม, ไซต์เดิม)
 * เลือกงานเก่าแล้วระบบเติมช่องให้ก่อน ผู้ใช้แก้เฉพาะส่วนที่ต่าง
 */
function customerJobs(customerId) {
  return customerId ? S.rows.filter(o => o.Customer_ID === customerId) : [];
}

function reuseHint(customerId) {
  const n = customerJobs(customerId).length;
  if (!n) return '';
  return `<p class="hint" style="margin:-4px 0 0">ลูกค้ารายนี้มีงานเก่า ${n} รายการ · <a href="#" onclick="reuseForm('${esc(customerId)}');return false">ดึงข้อมูลมาใช้</a></p>`;
}

function onCustomerPick(customerId) {
  const box = $('#reuseHint');
  if (box) box.innerHTML = reuseHint(customerId);
}

function reuseForm(customerId) {
  const form = document.querySelector('form.page');
  const sel = form && form.elements.Customer_ID;
  const cid = customerId || (sel ? sel.value : '');
  const cname = cid ? ((S.customers.find(c => c.Customer_ID === cid) || {}).Company_Name || '') : '';
  modal(`<div class="stack">
    ${modalHead('ดึงข้อมูลจากงานเก่า')}
    <p class="meta">${cid ? 'งานเก่าของ ' + esc(cname) : 'เลือกงานเก่าจากลูกค้ารายใดก็ได้ ระบบจะเลือกลูกค้าให้ด้วย'}</p>
    <input id="rq" class="field" placeholder="ค้นหา ชื่อโครงการ / บริษัท / เลขที่งาน" oninput="renderReuseList('${esc(cid)}', this.value)" autocomplete="off">
    <div id="rlist" class="stack-sm">${reuseListHtml(cid, '')}</div>
  </div>`);
}

function reuseListHtml(cid, query) {
  const q = String(query || '').trim().toLowerCase();
  let rows = cid ? customerJobs(cid) : S.rows;
  if (q) rows = rows.filter(o => [o.Opportunity_ID, o.Project_Name, o.Customer.Company_Name, o.Site_Location].join(' ').toLowerCase().indexOf(q) !== -1);
  rows = rows.slice(0, 40);
  if (!rows.length) return '<div class="empty">ไม่พบงานเก่า</div>';
  return rows.map(o => `<button type="button" class="card card-btn stack-sm" onclick="applyReuse('${esc(o.Opportunity_ID)}')">
    <div class="row-between" style="align-items:flex-start"><strong class="grow">${esc(o.Project_Name)}</strong><span class="badge tone-${tone(o.Status)}">${esc(o.Status)}</span></div>
    <div class="meta-strong truncate">${esc(o.Customer.Company_Name || '')}</div>
    <div class="meta">${esc(o.Opportunity_ID)} · ${esc(o.Work_Type || '-')} · ${fmtDate(o.Request_Date)}</div>
  </button>`).join('');
}

function renderReuseList(cid, query) {
  const box = $('#rlist');
  if (box) box.innerHTML = reuseListHtml(cid, query);
}

/** เติมช่องในฟอร์มจากงานเก่า — ไม่แตะผู้รับผิดชอบ วันที่ และการติดตาม เพราะเป็นของงานใหม่ */
function applyReuse(id) {
  const o = S.byId.get(id);
  const form = document.querySelector('form.page');
  if (!o || !form) return toast('ไม่พบงานเก่า');
  const set = (name, value) => { const el = form.elements[name]; if (el) el.value = value == null ? '' : value; };
  if (o.Work_Type && !Array.from(form.elements.Work_Type.options).some(x => x.value === o.Work_Type)) {
    form.elements.Work_Type.insertAdjacentHTML('beforeend', `<option value="${esc(o.Work_Type)}">${esc(o.Work_Type)}</option>`);
  }
  set('Customer_ID', o.Customer_ID);
  set('Project_Name', o.Project_Name);
  set('Site_Location', o.Site_Location);
  set('Work_Type', o.Work_Type);
  set('Description', o.Description);
  set('Priority', o.Priority || 'Normal');
  set('Estimated_Value', o.Estimated_Value);
  onCustomerPick(o.Customer_ID);
  closeModal();
  toast('ดึงข้อมูลจาก ' + o.Opportunity_ID + ' แล้ว แก้ส่วนที่ต่างได้เลย', 'ok');
  const el = form.elements.Project_Name; if (el) el.focus();
}

async function saveOpp(e, id) {
  e.preventDefault();
  lockForm(e, true);
  const raw = Object.fromEntries(new FormData(e.target));
  if (id) raw.Opportunity_ID = id;
  const r = await post('saveOpportunity', raw);
  if (!r.success) { lockForm(e, false); return toast(r.message); }
  applyWrite(r);
  toast(r.message, 'ok');
  go('detail', { id: (r.data.opportunity && r.data.opportunity.Opportunity_ID) || id });
}

/* ----------------------------------------------------------------- ตั้งค่า
 * เพิ่ม / ซ่อน / จัดลำดับ สถานะ ประเภทงาน เหตุผลปิดงาน ได้เองจากในแอป
 * ทุกอย่างเก็บใน Master_Data บน Google Sheet มีผลกับทุกคนทันที
 */
const MASTER_TYPES = [
  ['Status', 'สถานะงาน', 'เช่น รอผลประมูล'],
  ['Work_Type', 'ประเภทงาน', 'เช่น PM Chiller'],
  ['Close_Reason', 'เหตุผลปิดงาน', 'เช่น ลูกค้าเลือกเจ้าอื่น']
];

function viewSettings() {
  $('#app').innerHTML = header('ตั้งค่า', 'รายการตัวเลือกของระบบ', "go('dashboard')") + `<div class="page">
    ${!S.editableLists ? `<div class="empty">ต้องอัปเดต Apps Script เป็นรุ่นล่าสุดก่อน จึงจะแก้รายการจากในแอปได้<br><span class="hint">(อัปโหลดไฟล์ในโฟลเดอร์ apps-script แล้ว Deploy → New version)</span></div>`
    : `<p class="hint">ผู้รับผิดชอบไม่ต้องตั้งค่า — พิมพ์ชื่อใหม่ในช่องผู้รับผิดชอบได้เลยตอนสร้างงาน</p>` + MASTER_TYPES.map(t => masterSection(t[0], t[1], t[2])).join('')}
  </div>`;
}

function masterSection(type, label, hint) {
  const items = (S.master && S.master[type]) || [];
  return `<section class="card stack" id="ms-${type}">
    <h2>${esc(label)}</h2>
    <form class="row" onsubmit="addMaster(event,'${type}')">
      <input name="Name" class="field grow" placeholder="${esc(hint)}" required autocomplete="off" maxlength="60">
      <button class="btn btn-primary btn-sm">เพิ่ม</button>
    </form>
    <div class="stack-sm">${items.length ? items.map((it, i) => masterRow(type, it, i, items.length)).join('') : '<div class="empty">ยังไม่มีรายการ</div>'}</div>
  </section>`;
}

function masterRow(type, it, i, total) {
  const n = esc(it.Name);
  return `<div class="row master-row ${it.Active ? '' : 'is-hidden'}">
    <div class="grow">
      <div class="${it.Active ? 'meta-strong' : 'meta'}">${n}${it.Locked ? ' <span class="badge tone-slate">หลัก</span>' : ''}${type === 'Status' && it.Used ? ` <span class="badge tone-slate">${it.Used} งาน</span>` : ''}</div>
      ${it.Active ? '' : '<div class="hint">ซ่อนอยู่</div>'}
    </div>
    <button type="button" class="icon-btn" onclick="moveMaster('${type}','${n}',-1)" ${i === 0 ? 'disabled' : ''} aria-label="เลื่อนขึ้น">${I.up}</button>
    <button type="button" class="icon-btn" onclick="moveMaster('${type}','${n}',1)" ${i === total - 1 ? 'disabled' : ''} aria-label="เลื่อนลง">${I.down}</button>
    ${it.Locked ? '' : `<button type="button" class="btn btn-soft btn-sm" onclick="toggleMaster('${type}','${n}',${it.Active ? 'false' : 'true'})">${it.Active ? 'ซ่อน' : 'แสดง'}</button>`}
  </div>`;
}

async function addMaster(e, type) {
  e.preventDefault();
  lockForm(e, true);
  const r = await post('addMasterItem', { Type: type, Name: e.target.elements.Name.value });
  if (!r.success) { lockForm(e, false); return toast(r.message); }
  applyWrite(r);
  toast(r.message, 'ok');
  viewSettings();
}

async function toggleMaster(type, name, active) {
  const r = await post('setMasterActive', { Type: type, Name: name, Active: active });
  if (!r.success) return toast(r.message);
  applyWrite(r);
  toast(r.message, 'ok');
  viewSettings();
}

async function moveMaster(type, name, dir) {
  const names = ((S.master && S.master[type]) || []).map(x => x.Name);
  const i = names.indexOf(name), j = i + dir;
  if (i < 0 || j < 0 || j >= names.length) return;
  names.splice(i, 1); names.splice(j, 0, name);
  // ขยับบนจอก่อน ให้รู้สึกตอบสนองทันที แล้วค่อยบันทึก
  S.master[type] = names.map(n => S.master[type].find(x => x.Name === n));
  viewSettings();
  const r = await post('saveMasterOrder', { Type: type, Names: names });
  if (!r.success) { toast(r.message); await refresh({ silent: true }); return; }
  applyWrite(r);
}

/* ------------------------------------------------------------------ ลูกค้า */
function viewCustomers() {
  $('#app').innerHTML = header('ลูกค้า', S.customers.length + ' รายการ') + `<div class="page">
    <div class="stack">
      <input id="cq" class="field" value="${esc(S.customerQuery)}" placeholder="ค้นหาบริษัท / ผู้ติดต่อ / เบอร์โทร" oninput="onCustomerSearch(this.value)" autocomplete="off">
      <button type="button" class="btn btn-primary btn-block" onclick="customerForm()">${I.plus}เพิ่มลูกค้า</button>
    </div>
    <div id="clist" class="stack">${customerRowsHtml()}</div>
  </div>`;
}

function customerRowsHtml() {
  const q = String(S.customerQuery || '').trim().toLowerCase();
  const rows = q ? S.customers.filter(c => [c.Company_Name, c.Contact_Name, c.Phone, c.Email].join(' ').toLowerCase().indexOf(q) !== -1) : S.customers;
  if (!rows.length) return '<div class="empty">ไม่พบลูกค้า</div>';
  return rows.map(c => {
    const jobs = S.rows.filter(o => o.Customer_ID === c.Customer_ID).length;
    return `<button type="button" class="card card-btn stack-sm" onclick="customerForm('${esc(c.Customer_ID)}')">
      <div class="row-between"><strong class="grow truncate">${esc(c.Company_Name)}</strong>${jobs ? `<span class="badge tone-slate">${jobs} งาน</span>` : ''}</div>
      <div class="meta">${esc(c.Contact_Name || '-')} · ${esc(c.Phone || '-')}</div>
    </button>`;
  }).join('');
}

function onCustomerSearch(value) {
  S.customerQuery = value;
  const box = $('#clist');
  if (box) box.innerHTML = customerRowsHtml();
}

/* ------------------------------------------------------------------- MODAL */
function modal(html) {
  document.body.insertAdjacentHTML('beforeend', `<div id="modal" class="scrim" onclick="if(event.target===this)closeModal()"><div class="sheet">${html}</div></div>`);
}
function closeModal() {
  const m = $('#modal');
  if (m) m.remove();
  if (S.repaintPending) render();   // มีข้อมูลใหม่มาระหว่างที่หน้าต่างเปิดอยู่
}
const modalHead = title => `<div class="row-between" style="margin-bottom:14px"><h2>${esc(title)}</h2><button type="button" class="icon-btn" onclick="closeModal()">${I.close}</button></div>`;

function statusForm(id) {
  const o = S.byId.get(id);
  if (!o) return toast('ไม่พบงานขาย');
  modal(`<form class="stack" onsubmit="submitStatus(event,'${esc(id)}')">
    ${modalHead('เปลี่ยนสถานะ')}
    <p class="meta">สถานะปัจจุบัน <span class="badge tone-${tone(o.Status)}">${esc(o.Status)}</span></p>
    ${selectField('Status', 'สถานะใหม่', S.statuses, o.Status, true)}
    ${inputField('Quotation_Amount', 'มูลค่าใบเสนอราคา / Winning Amount', o.Quotation_Amount, 'number')}
    <label><span class="label">เหตุผลปิดงาน</span><select name="Close_Reason" class="field"><option value="">เลือกเหตุผล</option>${S.closeReasons.map(x => `<option>${esc(x)}</option>`).join('')}</select></label>
    <label><span class="label">หมายเหตุ</span><textarea name="Remark" class="field" rows="2"></textarea></label>
    <button class="btn btn-primary btn-block">ยืนยัน</button>
  </form>`);
}

async function submitStatus(e, id) {
  e.preventDefault();
  lockForm(e, true);
  const r = await post('changeStatus', Object.assign({ Opportunity_ID: id }, Object.fromEntries(new FormData(e.target))));
  if (!r.success) { lockForm(e, false); return toast(r.message); }
  applyWrite(r);
  closeModal();
  toast(r.message, 'ok');
  render();
}

function activityForm(id) {
  modal(`<form class="stack" onsubmit="submitActivity(event,'${esc(id)}')">
    ${modalHead('เพิ่ม Activity')}
    ${selectField('Activity_Type', 'ประเภท', S.activityTypes, 'Note', true)}
    <label><span class="label">รายละเอียด *</span><textarea name="Description" required class="field" rows="3"></textarea></label>
    ${inputField('Activity_Date', 'วันที่/เวลา', nowLocalInput(), 'datetime-local')}
    ${inputField('Next_Action', 'Next Action')}
    ${inputField('Next_Action_Date', 'วันที่ติดตาม', '', 'date')}
    <div class="fieldset stack">
      <p class="label" style="margin:0">แนบรูป/เอกสารไปพร้อมกัน (ไม่บังคับ)</p>
      ${selectField('Category', 'ประเภทไฟล์', S.categories, 'Survey')}
      <label><span class="label">เลือกไฟล์ (ไฟล์ละไม่เกิน 10 MB)</span><input name="files" type="file" multiple class="field"></label>
      <label><span class="label">หรือถ่ายรูปหน้างาน</span><input name="photos" type="file" accept="image/*" capture="environment" multiple class="field"></label>
    </div>
    <button class="btn btn-primary btn-block">บันทึก</button>
  </form>`);
}

async function submitActivity(e, id) {
  e.preventDefault();
  const form = e.target;
  const picked = [].concat(Array.from(form.files.files), Array.from(form.photos.files));
  if (picked.length > 10) return toast('แนบได้ครั้งละไม่เกิน 10 ไฟล์');
  if (picked.some(x => x.size > 10 * 1024 * 1024)) return toast('มีไฟล์ขนาดเกิน 10 MB');

  lockForm(e, true);
  const raw = Object.fromEntries(new FormData(form));
  delete raw.files; delete raw.photos; delete raw.Category;
  const r = await post('addActivity', Object.assign({ Opportunity_ID: id }, raw));
  if (!r.success) { lockForm(e, false); return toast(r.message); }
  applyWrite(r);

  if (picked.length) {
    lockForm(e, true, 'กำลังอัปโหลดไฟล์…');
    const up = await post('uploadFiles', { Opportunity_ID: id, Category: form.Category.value || 'Photo', files: await readFiles(picked) });
    if (!up.success) {
      closeModal();
      toast('บันทึกกิจกรรมแล้ว แต่แนบไฟล์ไม่สำเร็จ: ' + up.message);
      return render();
    }
    applyWrite(up);
  }
  closeModal();
  toast(r.message, 'ok');
  render();
}

const readFiles = list => Promise.all(list.map(x => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve({ name: x.name, mimeType: x.type, base64: reader.result });
  reader.onerror = reject;
  reader.readAsDataURL(x);
})));

function uploadForm(id) {
  modal(`<form class="stack" onsubmit="submitFiles(event,'${esc(id)}')">
    ${modalHead('แนบไฟล์')}
    ${selectField('Category', 'ประเภทไฟล์', S.categories, 'RFQ', true)}
    <label><span class="label">เลือกไฟล์ (ไฟล์ละไม่เกิน 10 MB)</span><input name="files" type="file" multiple class="field"></label>
    <label><span class="label">หรือถ่ายรูปหน้างาน</span><input name="photos" type="file" accept="image/*" capture="environment" multiple class="field"></label>
    <button class="btn btn-primary btn-block">อัปโหลด</button>
  </form>`);
}

async function submitFiles(e, id) {
  e.preventDefault();
  const picked = [].concat(Array.from(e.target.files.files), Array.from(e.target.photos.files));
  if (!picked.length) return toast('กรุณาเลือกไฟล์หรือถ่ายรูปอย่างน้อย 1 ไฟล์');
  if (picked.length > 10) return toast('อัปโหลดได้ครั้งละไม่เกิน 10 ไฟล์');
  if (picked.some(x => x.size > 10 * 1024 * 1024)) return toast('มีไฟล์ขนาดเกิน 10 MB');

  lockForm(e, true, 'กำลังอัปโหลด…');
  const r = await post('uploadFiles', { Opportunity_ID: id, Category: e.target.Category.value, files: await readFiles(picked) });
  if (!r.success) { lockForm(e, false); return toast(r.message); }
  applyWrite(r);
  closeModal();
  toast(r.message, 'ok');
  render();
}

function customerForm(id) {
  const c = id ? (S.customers.find(x => x.Customer_ID === id) || {}) : {};
  modal(`<form class="stack" onsubmit="saveCustomerForm(event,'${esc(id || '')}')">
    ${modalHead(id ? 'แก้ไขลูกค้า' : 'เพิ่มลูกค้า')}
    ${inputField('Company_Name', 'บริษัท', c.Company_Name, 'text', true)}
    ${inputField('Contact_Name', 'ผู้ติดต่อ', c.Contact_Name)}
    ${inputField('Department', 'แผนก', c.Department)}
    ${inputField('Phone', 'เบอร์โทรศัพท์', c.Phone, 'tel')}
    ${inputField('Email', 'Email', c.Email, 'email')}
    <label><span class="label">ที่อยู่</span><textarea name="Address" class="field" rows="2">${esc(c.Address)}</textarea></label>
    ${inputField('Map_URL', 'Google Maps URL', c.Map_URL, 'url')}
    <label><span class="label">หมายเหตุ</span><textarea name="Remark" class="field" rows="2">${esc(c.Remark)}</textarea></label>
    <button class="btn btn-primary btn-block">บันทึก</button>
  </form>`);
}

async function saveCustomerForm(e, id) {
  e.preventDefault();
  lockForm(e, true);
  const x = Object.fromEntries(new FormData(e.target));
  if (id) x.Customer_ID = id;
  const r = await post('saveCustomer', x);
  if (!r.success) { lockForm(e, false); return toast(r.message); }
  applyWrite(r);
  closeModal();
  toast(r.message, 'ok');
  render();
}

function voidForm(id) {
  modal(`<form class="stack" onsubmit="submitVoid(event,'${esc(id)}')">
    ${modalHead('ยกเลิกงาน')}
    <p class="meta">งานจะถูกปิดเป็นสถานะ “${esc(S.voidStatus)}” พร้อมบันทึกเหตุผล ไม่ถูกลบออกจากระบบ และยังค้นหาย้อนหลังได้</p>
    <label><span class="label">เหตุผลที่ยกเลิก *</span><textarea name="Reason" required class="field" rows="3"></textarea></label>
    <button class="btn btn-danger btn-block">ยืนยันยกเลิกงาน</button>
  </form>`);
}

async function submitVoid(e, id) {
  e.preventDefault();
  lockForm(e, true, 'กำลังยกเลิก…');
  const r = await post('voidOpportunity', Object.assign({ Opportunity_ID: id }, Object.fromEntries(new FormData(e.target))));
  if (!r.success) { lockForm(e, false); return toast(r.message); }
  applyWrite(r);
  closeModal();
  toast(r.message, 'ok');
  render();
}

async function removeFile(attachmentId, oppId) {
  if (!confirm('ลบไฟล์นี้หรือไม่? ไฟล์จะถูกย้ายไปถังขยะใน Drive')) return;
  const r = await post('deleteAttachment', attachmentId);
  if (!r.success) return toast(r.message);
  applyWrite(r);
  toast(r.message, 'ok');
  render();
}

/* ---------------------------------------------------------------------------
 * 6. เริ่มทำงาน
 * ------------------------------------------------------------------------- */
function renderSkeleton() {
  $('#nav').hidden = true;
  $('#app').innerHTML = header('PTS Sales', 'กำลังโหลดข้อมูล…') + `<div class="page">
    <div class="sk" style="height:46px"></div>
    <div class="grid-3">${'<div class="sk" style="height:82px"></div>'.repeat(6)}</div>
    <div class="sk" style="height:150px"></div>
    ${'<div class="sk" style="height:94px"></div>'.repeat(3)}
  </div>`;
}

function boot() {
  if (!token()) return renderLogin();

  // เปิดแอปแล้วเห็นข้อมูลทันทีจากก้อนที่เก็บไว้ในเครื่อง ไม่ต้องนั่งดูหน้าจอเปล่า
  const cached = readCache();
  if (cached) {
    applySnapshot(cached);
    S.ready = true;
    render();
  } else {
    renderSkeleton();
  }

  refresh({ silent: !!cached });
  startSync();
}

boot();
