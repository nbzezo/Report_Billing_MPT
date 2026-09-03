'use strict';
/* ==========================================================================
   dashboard-core.js — logic thuần (không DOM) dùng chung giữa:
     - trang V2_0_Call_Dashboard_MPT.html  (nạp qua <script src>)
     - Web Worker dashboard-csv-worker.js   (nạp qua importScripts)
     - Node  (tests/cube.test.mjs — nạp qua require, nhờ block export cuối file)

   Ở đây CHỈ được có: chuẩn hoá schema, phân loại cuộc gọi, enrich/filter/dedup,
   các hàm tổng hợp thuần (rows -> data). KHÔNG document / localStorage / Plotly.
   Mọi tham số cấu hình (ngưỡng, top-N, scope…) phải truyền vào, không đọc DOM.
   ========================================================================== */
(function (root) {

// ---------- Ngày giờ local ----------
function localISODate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function localISODateTime(value) {
  const d = value instanceof Date ? value : new Date(value);
  return `${localISODate(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

// ---------- Retry helpers ----------
function retryTimestamp(row) {
  const value = row && row.start_ts !== undefined ? Number(row.start_ts) : Date.parse(String((row && row.start_stamp) || '').replace(' ', 'T'));
  return Number.isFinite(value) ? value : null;
}
function retryDelayBucket(minutes) {
  if (minutes <= 1) return '0–1 phút';
  if (minutes <= 3) return '1–3 phút';
  if (minutes <= 5) return '3–5 phút';
  if (minutes <= 15) return '5–15 phút';
  if (minutes <= 30) return '15–30 phút';
  return '30–60 phút';
}

// ---------- Prefix nhà mạng ----------
function mapPrefix(caller) {
  const s = String(caller || '').trim();
  if (s.length < 2) return 'Other';
  const p2 = s.slice(0, 2);
  const p3 = s.length >= 3 ? s.slice(0, 3) : '';
  const p4 = s.length >= 4 ? s.slice(0, 4) : '';

  // Cố Định
  if (p4 === '8424' || p2 === '24' || p3 === '024') return '_024';
  if (p4 === '8428' || p2 === '28' || p3 === '028') return '_028';

  // GTell
  if (p3 === '099' || p2 === '99') return '_099';
  if (p3 === '059' || p2 === '59') return '_059';

  // Vietnammobile
  if (p3 === '092' || p2 === '92') return '_092';
  if (p3 === '058' || p2 === '58') return '_058';

  const viettel2 = new Set(['32', '33', '34', '35', '36', '37', '38', '39', '86', '96', '97', '98']);
  const vinaphone2 = new Set(['81', '82', '83', '84', '85', '88', '91', '94']);
  const mobifone2 = new Set(['70', '76', '77', '78', '79', '89', '90', '93']);

  const viettel3 = new Set(['032', '033', '034', '035', '036', '037', '038', '039', '086', '096', '097', '098']);
  const vinaphone3 = new Set(['081', '082', '083', '084', '085', '088', '091', '094']);
  const mobifone3 = new Set(['070', '076', '077', '078', '079', '089', '090', '093']);

  if (viettel2.has(p2) || viettel3.has(p3)) return 'vbn_vt';
  if (vinaphone2.has(p2) || vinaphone3.has(p3)) return 'vbn_vina';
  if (mobifone2.has(p2) || mobifone3.has(p3)) return 'vbn_mobi';

  return 'Other';
}

// ---------- Phân loại cuộc gọi ----------
// Fail hangup causes (business rule override)
const Fail_Hangup_cause = new Set([
  "NO_ROUTE_DESTINATION",
  "UNALLOCATED_NUMBER",
  "INVALID_NUMBER_FORMAT",
  "DESTINATION_OUT_OF_ORDER",
  "NORMAL_TEMPORARY_FAILURE",
  "NETWORK_OUT_OF_ORDER",
  "SWITCH_CONGESTION",
  "CONGESTION",
  "RECOVERY_ON_TIMER_EXPIRE",
  "MANDATORY_IE_MISSING",
  "INCOMPATIBLE_DESTINATION",
  "BEARERCAPABILITY_NOTAVAIL",
  "SERVICE_NOT_IMPLEMENTED",
  "FACILITY_NOT_IMPLEMENTED",
  "MEDIA_TIMEOUT",
  "MEDIA_ERROR",
  "INTERWORKING",
  "CALL_BLOCKED",
  "OUTGOING_CALL_BARRED",
  "INCOMING_CALL_BARRED",
  "REQUESTED_CHAN_UNAVAIL",
  "UNKNOWN",
  "UNSPECIFIED",
  "CRASH",
  "SYSTEM_SHUTDOWN"
]);

/* Thuê bao CÓ phản hồi nhưng cuộc gọi không thành — không phải lỗi mạng. */
const NoAnswer_Hangup_cause = new Set([
  "NO_USER_RESPONSE",
  "NO_ANSWER",
  "USER_BUSY",
  "CALL_REJECTED",
  "USER_NOT_REGISTERED",
  "SUBSCRIBER_ABSENT",
  "NORMAL_UNSPECIFIED"
]);

/* Cuộc gọi do PHÍA MÌNH chủ động huỷ trước khi thuê bao kịp trả lời. */
const Cancelled_Hangup_cause = new Set([
  "ORIGINATOR_CANCEL",
  "LOSE_RACE",
  "MANAGER_REQUEST",
  "BLIND_TRANSFER"
]);

/** Đã nghe máy hay chưa — chỉ cần billsec > 0. */
function isConnectedStrict(rec) {
  return Number(rec && rec.billsec || 0) > 0;
}
/** Thứ tự hiển thị chuẩn của các nhóm phân loại — dùng chung cho mọi biểu đồ. */
const CONN_TYPES = ['Fail', 'No Answer', 'Cancelled', 'Connected'];
function emptyConnCounts() {
  return { Fail: 0, 'No Answer': 0, Cancelled: 0, Connected: 0, Unknown: 0 };
}

/**
 * Phân loại cuộc gọi. Thứ tự ưu tiên: khai thác hết thông tin trực tiếp
 * (hangup_cause, billsec) rồi mới suy đoán từ duration.
 */
function classifyCall(rec) {
  const duration = Number(rec.duration || 0);
  const billsec = Number(rec.billsec || 0);
  const hangup = (rec.hangup_cause || "").toString().trim().toUpperCase();

  if (Fail_Hangup_cause.has(hangup)) return "Fail";
  if (billsec > 0) return "Connected";
  if (Cancelled_Hangup_cause.has(hangup)) return "Cancelled";
  if (NoAnswer_Hangup_cause.has(hangup)) return "No Answer";
  if (duration > 0) return "No Answer";
  if (duration === 0) return "Fail";
  return "Unknown";
}
function dateKey(ts) { if (!ts) return 'Unknown'; return String(ts).slice(0, 10); }

// ---------- Telco ----------
function normalizeTelcoName(raw) {
  const v = String(raw || '').trim();
  if (!v) return 'Unknown';
  const key = v.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
  const map = {
    'vina': 'VinaPhone', 'vinaphone': 'VinaPhone', 'vnpt': 'VinaPhone', 'vinaphon': 'VinaPhone',
    'viettel': 'Viettel', 'vt': 'Viettel',
    'mobi': 'MobiFone', 'mobifone': 'MobiFone', 'mobiphone': 'MobiFone', 'mphone': 'MobiFone',
    'vietnamobile': 'Vietnamobile', 'vietnammobile': 'Vietnamobile', 'vnmobile': 'Vietnamobile', 'vnmobi': 'Vietnamobile',
    'gmobile': 'Gmobile', 'beeline': 'Gmobile', 'gtel': 'Gmobile',
    'fixed': 'Cố định', 'landline': 'Cố định', 'pstn': 'Cố định',
    'itel': 'Itel', 'wintel': 'Wintel', 'reddi': 'Reddi', 'vnsky': 'VNSKY', 'local': 'Cố định'
  };
  return map[key] || v;
}
function getTelco(r) {
  const prefer = ['telco'];
  const candidates = [' telco', 'Telco', 'TELCO', 'dest_telco', 'dst_telco', 'telco_dest', 'telcol', 'telco_operator', 'operator', 'carrier'];
  for (const k of prefer) {
    if (r && Object.prototype.hasOwnProperty.call(r, k)) { const v = String(r[k] ?? '').trim(); if (v) return normalizeTelcoName(v); }
  }
  for (const k of candidates) {
    if (r && Object.prototype.hasOwnProperty.call(r, k)) { const v = String(r[k] ?? '').trim(); if (v) return normalizeTelcoName(v); }
  }
  if (r) {
    for (const k of Object.keys(r)) {
      const kl = String(k).toLowerCase().trim();
      if (kl === 'telco' || kl === 'telcol' || kl === 'dest_telco' || kl === 'dst_telco' || kl.includes('telco')) {
        const v = String(r[k] ?? '').trim(); if (v) return normalizeTelcoName(v);
      }
    }
  }
  return 'Unknown';
}

function isLikelyPhoneNumber(x) {
  const s = String(x || '').trim();
  if (!s) return false;
  if (!/^\d+$/.test(s)) return false;
  return (s.length >= 9 && s.length <= 12);
}

/* ==========================================================================
   [SECTION] SCHEMA NORMALIZATION — chuẩn hoá bản ghi thô (CSV/JSON, mẫu cũ &
   mẫu mới) về schema nội bộ snake_case.
   ========================================================================== */
function normalizeHeaderKey(key) {
  return String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

const CSV_HEADER_ALIASES = {
  accountid: 'account_id', account: 'account_id', tenant: 'account_id',
  accountname: 'account_name',
  calleridnumber: 'caller_id_number', caller: 'caller_id_number',
  callernumber: 'caller_id_number', callerid: 'caller_id_number',
  fromnumber: 'caller_id_number', outnumber: 'caller_id_number',
  destinationnumber: 'destination_number', destination: 'destination_number',
  destnumber: 'destination_number', called: 'destination_number', tonumber: 'destination_number',
  ani: 'ani',
  uuid: 'uuid', calluuid: 'uuid', callid: 'uuid',
  startstamp: 'start_stamp', starttime: 'start_stamp', calldate: 'start_stamp',
  answerstamp: 'answer_stamp', answertime: 'answer_stamp',
  endstamp: 'end_stamp', endtime: 'end_stamp',
  duration: 'duration', callduration: 'duration',
  billsec: 'billsec', billsecs: 'billsec', billseconds: 'billsec',
  hangupcause: 'hangup_cause', cause: 'hangup_cause',
  statuscode: 'status_code', sipcode: 'status_code',
  telco: 'telco', carrier: 'telco', operator: 'telco',
  direction: 'direction',
  calltype: 'calltype',
  mos: 'mos',
  quality: 'quality_pct', qualitypercent: 'quality_pct',
  jitterminms: 'jitter_min', jittermin: 'jitter_min',
  jittermaxms: 'jitter_max', jittermax: 'jitter_max',
  jitterlossrate: 'jitter_loss_rate',
  packetcount: 'packet_count', skippacketcount: 'skip_packet_count',
  rtcppacketcount: 'rtcp_packet_count',
  rtcprttms: 'rtcp_rtt', rtcprtt: 'rtcp_rtt'
};

const NUMERIC_FIELDS = ['duration', 'billsec', 'status_code', 'mos', 'quality_pct',
  'jitter_min', 'jitter_max', 'jitter_loss_rate', 'packet_count', 'skip_packet_count',
  'rtcp_packet_count', 'rtcp_rtt'];

function toNumberLoose(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const s = String(v).trim().replace(/^"|"$/g, '').replace(/,/g, '');
  if (s === '') return null;
  const n = Number(s);
  return isFinite(n) ? n : null;
}

function pad2(n) { return String(n).padStart(2, '0'); }

/**
 * Đưa timestamp về "YYYY-MM-DD HH:mm:ss". Trả {value, hasSeconds}.
 */
function normalizeTimestamp(raw) {
  const s = String(raw === null || raw === undefined ? '' : raw).trim().replace(/^"|"$/g, '');
  if (!s) return { value: '', hasSeconds: false };

  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    return {
      value: `${m[1]}-${pad2(+m[2])}-${pad2(+m[3])} ${pad2(+m[4])}:${m[5]}:${m[6] || '00'}`,
      hasSeconds: m[6] !== undefined
    };
  }
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return { value: `${m[1]}-${pad2(+m[2])}-${pad2(+m[3])} 00:00:00`, hasSeconds: false };

  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/);
  if (m) {
    let month = +m[1], day = +m[2];
    if (month > 12 && day <= 12) { month = +m[2]; day = +m[1]; }
    let h = m[4] !== undefined ? +m[4] : 0;
    const ap = (m[7] || '').toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    return {
      value: `${m[3]}-${pad2(month)}-${pad2(day)} ${pad2(h)}:${m[5] || '00'}:${m[6] || '00'}`,
      hasSeconds: m[6] !== undefined
    };
  }

  const t = Date.parse(s);
  if (!isNaN(t)) return { value: localISODateTime(new Date(t)), hasSeconds: true };
  return { value: s, hasSeconds: /\d{1,2}:\d{2}:\d{2}/.test(s) };
}

/** Cộng thêm giây vào timestamp dạng "YYYY-MM-DD HH:mm:ss". */
function addSecondsToStamp(stamp, seconds) {
  const m = String(stamp || '').match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return stamp;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  d.setSeconds(d.getSeconds() + Math.max(0, Math.round(seconds || 0)));
  return localISODateTime(d);
}

/** FNV-1a 32-bit — sinh uuid ổn định cho file không có cột uuid. */
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function createNormalizeContext() { return { sigCount: Object.create(null) }; }

function normalizeCallRecord(raw, ctx) {
  if (!raw || typeof raw !== 'object') return null;
  ctx = ctx || createNormalizeContext();

  const out = {};
  for (const key of Object.keys(raw)) {
    if (key === '__source_file') { out.__source_file = raw[key]; continue; }
    const mapped = CSV_HEADER_ALIASES[normalizeHeaderKey(key)];
    if (mapped) {
      const cur = out[mapped];
      if (cur === undefined || cur === null || cur === '') out[mapped] = raw[key];
    } else {
      out[key] = raw[key];
    }
  }

  if ((out.direction === undefined || out.direction === '') && out.calltype !== undefined) {
    out.direction = out.calltype;
  }

  for (const f of NUMERIC_FIELDS) {
    if (out[f] === undefined) continue;
    const n = toNumberLoose(out[f]);
    out[f] = (n === null && (f === 'duration' || f === 'billsec')) ? 0 : n;
  }
  if (out.duration === undefined) out.duration = 0;
  if (out.billsec === undefined) out.billsec = 0;

  const st = normalizeTimestamp(out.start_stamp);
  const en = normalizeTimestamp(out.end_stamp);
  out.start_stamp = st.value;
  out.end_stamp = en.value;
  out.answer_stamp = normalizeTimestamp(out.answer_stamp).value;

  if (!st.hasSeconds && !en.hasSeconds && st.value && Number(out.duration) > 0) {
    out.end_stamp_raw = en.value;
    out.end_stamp = addSecondsToStamp(st.value, Number(out.duration));
    out.__end_derived = true;
  }

  out.telco = normalizeTelcoName(out.telco);

  if (!String(out.uuid === undefined || out.uuid === null ? '' : out.uuid).trim()) {
    const sig = [out.account_id, out.caller_id_number, out.destination_number,
    out.start_stamp, out.end_stamp, out.duration, out.billsec, out.hangup_cause].join('|');
    const seq = (ctx.sigCount[sig] = (ctx.sigCount[sig] || 0) + 1);
    out.uuid = 'gen-' + hash32(sig) + '-' + seq;
    out.__uuid_generated = true;
  }

  return out;
}

function normalizeCallRecords(rows) {
  const ctx = createNormalizeContext();
  const out = [];
  for (const r of (rows || [])) {
    const rec = normalizeCallRecord(r, ctx);
    if (rec) out.push(rec);
  }
  return out;
}

// ---------- Enrich / filter / dedup ----------
/**
 * @param {Array} arr             bản ghi đã normalize
 * @param {Object} accountNameMap map id -> tên hiển thị (worker truyền vào; trang truyền accountNameMap toàn cục)
 */
function enrichData(arr, accountNameMap) {
  const nameMap = accountNameMap || {};
  return arr.map(r => {
    const acc = (r.account_id === undefined || r.account_id === null) ? 'Unknown' : String(r.account_id);
    const mappedName = (r.account_name && String(r.account_name).trim())
      || nameMap[acc]
      || acc;

    const start_ts = (() => { const v = String(r.start_stamp || ''); const t = Date.parse(v.replace(' ', 'T')); return isNaN(t) ? null : t; })();
    const end_ts = (() => { const v = String(r.end_stamp || ''); if (!v) return null; const t = Date.parse(v.replace(' ', 'T')); return isNaN(t) ? null : t; })();

    return {
      ...r,
      account_id: acc,
      account_name: mappedName,
      prefix: mapPrefix(r.caller_id_number),
      connType: classifyCall(r),
      date: dateKey(r.start_stamp),
      hour: (r.start_stamp || '').slice(11, 13),
      start_ts,
      end_ts
    };
  });
}

// ===== Performance helpers: aggregate cache + downsample =====
const __aggCache = new WeakMap(); // rows[] -> Map(key -> value)
function __getAgg(rows, key, computeFn) {
  if (!rows) return computeFn();
  let m = __aggCache.get(rows);
  if (!m) {
    m = new Map();
    __aggCache.set(rows, m);
  }
  if (m.has(key)) return m.get(key);
  const v = computeFn();
  m.set(key, v);
  return v;
}
function __getAggIfPresent(rows, key) {
  const m = rows ? __aggCache.get(rows) : null;
  return (m && m.has(key)) ? m.get(key) : null;
}
/** Downsample chuỗi thời gian đơn điệu: giữ max trong mỗi bucket. */
function downsampleSeriesMax(x, y, maxPoints = 1500) {
  const n = (x && x.length) ? x.length : 0;
  if (n <= maxPoints) return { x, y };
  const step = Math.ceil(n / maxPoints);
  const outX = [];
  const outY = [];
  for (let i = 0; i < n; i += step) {
    const end = Math.min(n, i + step);
    let max = -Infinity;
    let maxIdx = i;
    for (let j = i; j < end; j++) {
      const v = y[j];
      if (v > max) { max = v; maxIdx = j; }
    }
    outX.push(x[maxIdx]);
    outY.push(max);
  }
  return { x: outX, y: outY };
}

function filterData(rows, startDate, endDate, account, startTime, endTime) {
  const st = (startTime && String(startTime).trim()) ? String(startTime).trim() : '00:00';
  const et = (endTime && String(endTime).trim()) ? String(endTime).trim() : '23:59';

  const sMs = Date.parse(startDate + 'T' + st + ':00');
  const eMs = Date.parse(endDate + 'T' + et + ':59');

  return rows.filter(r => {
    let t = (r.start_ts !== undefined) ? r.start_ts : null;
    if (t === undefined || t === null) {
      const v = String(r.start_stamp || '');
      const x = Date.parse(v.replace(' ', 'T'));
      t = isNaN(x) ? null : x;
      r.start_ts = t;
    }
    if (t === null) return false;
    if (t < sMs || t > eMs) return false;

    if (account && account !== 'all') {
      if (Array.isArray(account)) {
        if (account.length > 0 && !account.includes(String(r.account_id))) return false;
      } else {
        if (String(r.account_id) !== String(account)) return false;
      }
    }
    return true;
  });
}

// ---------- Utils: Deduplicate by UUID ----------
function dedupByUUID(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return { rows: [], removed: 0, kept: 0 };
  const seen = new Set(); const out = []; let removed = 0;
  for (const r of rows) {
    const key = String(r.uuid || r.UUID || r.Uuid || '').trim();
    if (!key) { out.push(r); continue; }
    if (seen.has(key)) { removed++; continue; }
    seen.add(key); out.push(r);
  }
  return { rows: out, removed, kept: out.length };
}

// ---------- Cum tong hop 'overview' (Milestone 1c) ----------
function computeCallCounts(rows){
  const counts = emptyConnCounts();
  (rows||[]).forEach(r=>{
    const ct = r.connType || classifyCall(r);
    counts[ct] = (counts[ct]||0) + 1;
  });
  return counts;
}

function computeASRExcludingFail(rowsOrCounts){
  const counts = Array.isArray(rowsOrCounts) ? computeCallCounts(rowsOrCounts) : (rowsOrCounts||{});
  const connected = counts.Connected || 0;
  const noAnswer = counts['No Answer'] || 0;
  return (connected + noAnswer) ? +(connected/(connected+noAnswer)*100).toFixed(2) : 0;
}

function computeConnectRate(rowsOrCounts){
  const counts = Array.isArray(rowsOrCounts) ? computeCallCounts(rowsOrCounts) : (rowsOrCounts||{});
  const total = (counts.Fail||0) + (counts['No Answer']||0) + (counts.Cancelled||0)
              + (counts.Connected||0) + (counts.Unknown||0);
  return total ? +((counts.Connected||0)/total*100).toFixed(2) : 0;
}

function computeBillsecMetrics(rows, shortThreshold=10){
  let totalBillsec = 0, connectedBillsec = 0, connected = 0, shortCalls = 0;
  (rows||[]).forEach(r=>{
    const bs = Number(r.billsec||0);
    totalBillsec += bs;
    if(isConnectedStrict(r)){
      connected++;
      connectedBillsec += bs;
      if(bs < shortThreshold) shortCalls++;
    }
  });
  return {
    totalBillsec,
    totalMinutes: +(totalBillsec/60).toFixed(2),
    avgBillsecConnected: connected ? +(connectedBillsec/connected).toFixed(2) : 0,
    shortCallRate: connected ? +(shortCalls/connected*100).toFixed(2) : 0,
    shortCalls,
    connected
  };
}

function computeDestinationQualityMetrics(rows){
  const dns = (rows||[]).map(r=>String(r.destination_number||'').trim()).filter(Boolean);
  const total = (rows||[]).length;
  const unique = new Set(dns).size;
  const invalid = dns.reduce((s,dn)=> s + (!isLikelyPhoneNumber(dn) ? 1 : 0), 0);
  const repeatedRows = dns.length - unique;
  return {
    total,
    destinationCount: dns.length,
    uniqueDestination: unique,
    repeatedDestinationRows: repeatedRows,
    repeatedDestinationRate: dns.length ? +(repeatedRows/dns.length*100).toFixed(2) : 0,
    invalidDestination: invalid,
    invalidDestinationRate: dns.length ? +(invalid/dns.length*100).toFixed(2) : 0
  };
}

function computeRequiredColumnHealth(rows){
  const required = ['account_id','caller_id_number','destination_number','start_stamp','end_stamp','duration','billsec','hangup_cause','uuid'];
  const list = rows || [];
  const n = list.length;
  const present = Object.create(null), filled = Object.create(null);
  required.forEach(c=>{ present[c]=0; filled[c]=0; });

  let billsecPositive = 0, durationPositive = 0;
  for(const r of list){
    for(const c of required){
      if(!(c in r)) continue;
      present[c]++;
      const v = r[c];
      if(v!==null && v!==undefined && String(v).trim()!=='') filled[c]++;
    }
    if(Number(r.billsec||0) > 0)  billsecPositive++;
    if(Number(r.duration||0) > 0) durationPositive++;
  }

  const missing = required.filter(c=> present[c]===0);
  const sparse  = required.filter(c=> present[c]>0 && n>0 && filled[c] < n*0.8)
                          .map(c=> `${c} (${Math.round(100*(n-filled[c])/n)}% trống)`);
  const critical = [];
  if(n>0 && billsecPositive===0 && !missing.includes('billsec'))
    critical.push('Toàn bộ billsec = 0 → không cuộc nào được tính là Connected. Kiểm tra lại nguồn xuất dữ liệu.');
  if(n>0 && durationPositive===0 && !missing.includes('duration'))
    critical.push('Toàn bộ duration = 0 → mọi cuộc không xác định được nguyên nhân sẽ rơi về Fail.');

  return {required, missing, sparse, critical, rows:n, billsecPositive, durationPositive};
}

function computeTimeAnomalyMetrics(rows){
  let endBeforeStart = 0, durationLessThanBillsec = 0, answer1970WithBillsec = 0;
  (rows||[]).forEach(r=>{
    const s = r.start_ts ?? Date.parse(String(r.start_stamp||'').replace(' ','T'));
    const e = r.end_ts ?? Date.parse(String(r.end_stamp||'').replace(' ','T'));
    if(isFinite(s) && isFinite(e) && e < s) endBeforeStart++;
    if(Number(r.duration||0) < Number(r.billsec||0)) durationLessThanBillsec++;
    // Mẫu cũ dùng epoch 1970 cho "chưa nghe"; mẫu mới để trống -> tính cả 2 kiểu
    const ans = String(r.answer_stamp||'').trim();
    if((ans==='' || ans.startsWith('1970-01-01')) && Number(r.billsec||0)>0) answer1970WithBillsec++;
  });
  return {endBeforeStart, durationLessThanBillsec, answer1970WithBillsec};
}

function aggregateOverview(rows){
  return __getAgg(rows, 'aggregateOverview', ()=>{ const counts=computeCallCounts(rows);
    const total = counts.Fail + counts['No Answer'] + counts.Cancelled + counts.Connected + counts.Unknown;
    const pct={Fail:0,NoAnswer:0,Cancelled:0,Connected:0};
    if(total>0){
      pct.Fail      = +(counts.Fail/total*100).toFixed(2);
      pct.NoAnswer  = +(counts['No Answer']/total*100).toFixed(2);
      pct.Cancelled = +(counts.Cancelled/total*100).toFixed(2);
      pct.Connected = +(counts.Connected/total*100).toFixed(2);
    } const billsecMetrics = computeBillsecMetrics(rows); const answerRate = computeASRExcludingFail(counts); const connectRate = computeConnectRate(counts); const destinationQuality = computeDestinationQualityMetrics(rows); return {counts,pct,totalMinutes: billsecMetrics.totalMinutes,totalCalls:total,answerRate,connectRate,billsecMetrics,destinationQuality}; 
  });
}

function aggByPrefix(rows){
  return __getAgg(rows, 'aggByPrefix', ()=>{ 
	const out={}; 
	rows.forEach(r=>{ 
		const p=r.prefix||'Other'; 
			if (p === 'Other') return; // bỏ trường hợp Other khỏi kết quả
		out[p]=out[p]||{Fail:0,'No Answer':0,Cancelled:0,Connected:0,total:0};
		out[p][r.connType]=(out[p][r.connType]||0)+1; out[p].total++;
		}); 
	return out; 
	
  });
}

function minutesPerDay(rows){
  return __getAgg(rows, 'minutesPerDay', ()=>{ const map={}; rows.forEach(r=>{ const d=r.date||'Unknown'; map[d]=(map[d]||0)+Number(r.billsec||0); }); const dates=Object.keys(map).sort(); return {dates,minutes:dates.map(d=>+(map[d]/60).toFixed(2))}; 
  });
}

// ---------- buildCube: dựng dữ liệu tổng hợp gọn cho dashboard ----------
// Milestone 1c: mới phủ phần 'overview' + renderCommon. Các tab khác bổ sung sau.
// params: {startDate,endDate,account,startTime,endTime} (account: 'all' | mảng id)
function buildCube(enrichedRows, params) {
  params = params || {};
  const rows = filterData(
    enrichedRows,
    params.startDate, params.endDate,
    params.account || 'all',
    params.startTime, params.endTime
  );
  const dates = rows.map(r => r.date).filter(d => d && d !== 'Unknown').sort();
  return {
    meta: {
      rows: rows.length,
      accounts: new Set(rows.map(r => String(r.account_id || 'Unknown'))).size,
      dateMin: dates.length ? dates[0] : null,
      dateMax: dates.length ? dates[dates.length - 1] : null
    },
    overview: aggregateOverview(rows),
    byPrefix: aggByPrefix(rows),
    minutesPerDay: minutesPerDay(rows),
    columnHealth: computeRequiredColumnHealth(rows),
    timeAnomaly: computeTimeAnomalyMetrics(rows)
  };
}


// ---------- Cum tong hop cac tab (Milestone 1c-ii-A) ----------
function computeRetryPattern(rows,windowMinutes=5,scope='account'){
  const windowMs=windowMinutes*60*1000;
  const grouped=new Map();
  let eligibleFailures=0;
  (rows||[]).forEach(row=>{
    const destination=String(row.destination_number||row.out_number||'').trim();
    const ts=retryTimestamp(row);
    if(!destination || ts===null) return;
    const account=String(row.account_id||'Unknown');
    const call={
      ts,destination,account,
      accountName:String(row.account_name||account),
      outcome:String(row.connType||'Unknown'),
      telco:String(row.telco||'Unknown'),
      prefix:String(row.prefix||'Other')
    };
    const key=scope==='account' ? `${account}\u0000${destination}` : destination;
    if(!grouped.has(key)) grouped.set(key,[]);
    grouped.get(key).push(call);
    if(call.outcome==='Fail'||call.outcome==='No Answer'||call.outcome==='Cancelled') eligibleFailures++;
  });

  const events=[];
  grouped.forEach((calls,key)=>{
    calls.sort((a,b)=>a.ts-b.ts);
    let retryAttempt=0;
    let chainIndex=0;
    for(let i=1;i<calls.length;i++){
      const previous=calls[i-1],current=calls[i];
      const gapMs=current.ts-previous.ts;
      const qualifies=(previous.outcome==='Fail'||previous.outcome==='No Answer'||previous.outcome==='Cancelled')
        && gapMs>0 && gapMs<=windowMs;
      if(!qualifies){ retryAttempt=0; continue; }
      if(retryAttempt===0) chainIndex++;
      retryAttempt++;
      const date=new Date(current.ts);
      events.push({
        account:current.account,accountName:current.accountName,destination:current.destination,
        outcome:current.outcome,connected:current.outcome==='Connected',
        ts:current.ts,
        delayMinutes:gapMs/60000,delayBucket:retryDelayBucket(gapMs/60000),
        attempt:retryAttempt,chain:`${key}\u0000${chainIndex}`,
        date:typeof localISODate==='function'?localISODate(date):date.toISOString().slice(0,10),
        hour:`${String(date.getHours()).padStart(2,'0')}:00`,
        telco:current.telco,prefix:current.prefix
      });
    }
  });

  const accountMap=new Map();
  events.forEach(event=>{
    if(!accountMap.has(event.account)) accountMap.set(event.account,{
      acc:event.account,name:event.accountName,retries:0,retryConnected:0,retry2Plus:0,
      destinations:new Set(),chains:new Set(),chainFinals:new Map()
    });
    const item=accountMap.get(event.account);
    item.retries++;
    if(event.connected) item.retryConnected++;
    if(event.attempt>=2) item.retry2Plus++;
    item.destinations.add(event.destination);
    item.chains.add(event.chain);
    item.chainFinals.set(event.chain,event.connected);
  });
  const accArr=Array.from(accountMap.values()).map(item=>({
    acc:item.acc,name:item.name,retries:item.retries,retryConnected:item.retryConnected,
    retryASR:item.retries?+(item.retryConnected*100/item.retries).toFixed(2):0,
    uniqueDestinations:item.destinations.size,chains:item.chains.size,
    successfulChains:Array.from(item.chainFinals.values()).filter(Boolean).length,
    chainASR:item.chains.size?+(Array.from(item.chainFinals.values()).filter(Boolean).length*100/item.chains.size).toFixed(2):0,
    retry2Plus:item.retry2Plus
  })).sort((a,b)=>b.retries-a.retries||b.retryASR-a.retryASR);

  const totalRetries=events.length;
  const retryConnected=events.filter(event=>event.connected).length;
  const chainFinals=new Map();
  events.forEach(event=>chainFinals.set(event.chain,event.connected));
  const successfulChains=Array.from(chainFinals.values()).filter(Boolean).length;
  return {
    totalRetries,retryConnected,
    retryASR:totalRetries?+(retryConnected*100/totalRetries).toFixed(2):0,
    retryRate:eligibleFailures?+(totalRetries*100/eligibleFailures).toFixed(2):0,
    eligibleFailures,
    uniqueDestinations:new Set(events.map(event=>event.destination)).size,
    chains:chainFinals.size,successfulChains,
    chainASR:chainFinals.size?+(successfulChains*100/chainFinals.size).toFixed(2):0,
    events,accArr
  };
}

function retryAggregate(events,keyFn){
  const map=new Map();
  events.forEach(event=>{
    const key=String(keyFn(event));
    if(!map.has(key)) map.set(key,{key,retries:0,connected:0});
    const item=map.get(key);
    item.retries++;
    if(event.connected) item.connected++;
  });
  return Array.from(map.values()).map(item=>({...item,asr:item.retries?+(item.connected*100/item.retries).toFixed(2):0}));
}

function computeAccountKPIs(rows){
  const map = {};
  (rows||[]).forEach(r=>{
    const acc = String(r.account_id||'Unknown');
    if(!map[acc]) map[acc] = {acc, label: (r.account_name && String(r.account_name).trim()) || (typeof accountNameMap!=='undefined' ? accountNameMap[acc] : acc) || acc,
                              total:0, connected:0, noans:0, fail:0, minutes:0};
    const m = map[acc];
    m.total++;
    if(r.connType==='Connected') m.connected++;
    else if(r.connType==='No Answer') m.noans++;
    else if(r.connType==='Fail') m.fail++;
    m.minutes += Number(r.billsec||0)/60;
  });
  const arr = Object.values(map).map(m=>{
    const asr = (m.connected + m.noans) === 0 ? 0 : (m.connected/(m.connected+m.noans)*100);
    const failPct = m.total===0 ? 0 : (m.fail/m.total*100);
    return {...m, asr, failPct, minutes:+m.minutes.toFixed(2)};
  });
  return arr;
}

function computeTopDest(rows){
  const map = {};
  (rows||[]).forEach(r=>{
    const dn = String(r.destination_number || r.out_number || '').trim();
    if(!dn) return;
    if(!map[dn]) map[dn] = {dn, total:0, connected:0, noans:0, fail:0};
    const m = map[dn];
    m.total++;
    if(r.connType==='Connected') m.connected++;
    else if(r.connType==='No Answer') m.noans++;
    else if(r.connType==='Fail') m.fail++;
  });
  const arr = Object.values(map).map(m=>{
    const failPct = m.total===0 ? 0 : (m.fail/m.total*100);
    return {...m, failPct:+failPct.toFixed(2)};
  });
  return arr;
}

function aggDestTelcoShare(rows){
  const map = {}; let total=0;
  rows.forEach(r=>{ const tel = String(r.telco||'Unknown'); map[tel]=(map[tel]||0)+1; total++; });
  const arr = Object.keys(map).map(t=> ({tel:t, count:map[t]}));
  arr.sort((a,b)=> b.count - a.count);
  return {data:arr, total};
}

function aggTelcoConnBreakdown(rows){
  const map = {}; // telco -> {Connected, 'No Answer', Fail, total}
  (rows||[]).forEach(r=>{
    const tel = String(r.telco||'Unknown');
    const ct = r.connType || 'Unknown';
    if(!map[tel]) map[tel] = {Connected:0, 'No Answer':0, Cancelled:0, Fail:0, Unknown:0, total:0};
    if(map[tel][ct] === undefined) map[tel][ct] = 0;
    map[tel][ct]++;
    map[tel].total++;
  });
  const arr = Object.keys(map).map(t=>{
    const d = map[t];
    const total = d.total || 0;
    const pct = (v)=> total>0 ? +(v/total*100).toFixed(2) : 0;
    return {
      tel: t,
      con: d.Connected||0, noans: d['No Answer']||0, canc: d.Cancelled||0, fail: d.Fail||0, unk: d.Unknown||0, total,
      counts: d,
      conPct: pct(d.Connected||0), noansPct: pct(d['No Answer']||0), cancPct: pct(d.Cancelled||0),
      failPct: pct(d.Fail||0), unkPct: pct(d.Unknown||0)
    };
  });
  arr.sort((a,b)=> b.conPct - a.conPct);
  return arr;
}

function weekdayIndex(dateStr){ const d=new Date(dateStr+'T00:00:00'); if(isNaN(d)) return null; // 0=Sun..6=Sat
  return (d.getDay()); }

function computeTimeHeatmap(rows){
  // 7 (Sun..Sat) x 24 hours
  const z = Array.from({length:7}, ()=> Array(24).fill(0));
  rows.forEach(r=>{
    const wd = weekdayIndex(r.date);
    const h = parseInt(r.hour||'0',10);
    if(wd!=null && h>=0 && h<=23) z[wd][h] += Number(isConnectedStrict(r) ? 1 : 0); // count connected attempts
  });
  return z;
}

function computeAnswerRateByAccountPerDay(rows){
  const map = {}; // {date:{acc:{con,no}}}
  rows.forEach(r=>{
    const d = r.date;
    const acc = String(r.account_id||'Unknown');
    if(!map[d]) map[d] = {};
    if(!map[d][acc]) map[d][acc] = {con:0,no:0};
    if(r.connType==='Connected') map[d][acc].con++;
    if(r.connType==='No Answer') map[d][acc].no++;
  });
  const dates = Object.keys(map).sort();
  const accSet = new Set();
  dates.forEach(d=> Object.keys(map[d]).forEach(a=> accSet.add(a)));
  const accounts = Array.from(accSet);
  const series = accounts.map(acc=>{
    const y = dates.map(d=>{
      const obj = map[d][acc];
      if(!obj) return null;
      const tot = obj.con + obj.no;
      return tot===0 ? null : +(obj.con / tot * 100).toFixed(2);
    });
    // label
    const row = rows.find(r=> String(r.account_id)===acc );
    const label = (row && row.account_name && String(row.account_name).trim()) || acc;
    return {name:String(label), x:dates, y};
  });
  return {series};
}

function computeGoldenHours(rows){
  const cells = Array.from({length:7}, ()=> Array.from({length:24}, ()=>({tot:0, con:0})));
  (rows||[]).forEach(r=>{
    const wd = weekdayIndex(r.date);
    const h = parseInt(r.hour||'0',10);
    if(wd==null || isNaN(h) || h<0 || h>23) return;
    cells[wd][h].tot += 1;
    if(isConnectedStrict(r)) cells[wd][h].con += 1;
  });
  const zRate = cells.map(row=> row.map(c=> c.tot? +(100*c.con/c.tot).toFixed(2) : null));
  const zTot  = cells.map(row=> row.map(c=> c.tot));
  const zCon  = cells.map(row=> row.map(c=> c.con));
  return {cells, zRate, zTot, zCon};
}

function computeDailyPrefixStats(rows){
  const out={}; // key: date|prefix
  (rows||[]).forEach(r=>{
    const d=r.date; const p=r.prefix||'Other';
    if(!d || !p || p==='Other') return;
    const k=d+'|'+p;
    if(!out[k]) out[k]={date:d,prefix:p,tot:0,con:0};
    out[k].tot+=1; if(isConnectedStrict(r)) out[k].con+=1;
  });
  return Object.values(out);
}

function computeAgentPerf(rows){
  return __getAgg(rows, 'computeAgentPerf', ()=>{
  const out={};
  (rows||[]).forEach(r=>{
    const id=String(r.account_id||'unknown');
    if(!out[id]) out[id]={id, tot:0, con:0, noans:0, canc:0, fail:0, unknown:0, billsec:0, conBillsec:0, conCnt:0, shortCalls:0};
    out[id].tot+=1;
    const ct = r.connType;
    if(ct==='Connected') out[id].con+=1;
    else if(ct==='No Answer') out[id].noans+=1;
    else if(ct==='Cancelled') out[id].canc+=1;
    else if(ct==='Fail') out[id].fail+=1;
    else out[id].unknown+=1;
    const bs=Number(r.billsec)||0;
    out[id].billsec += bs;
    if(ct==='Connected'){
      out[id].conBillsec += bs;
      out[id].conCnt += 1;
      if(bs < 10) out[id].shortCalls += 1;
    }
  });
  return Object.values(out).map(a=>{
    const rate = a.tot? a.con/a.tot : 0;
    const asr = (a.con+a.noans) ? a.con/(a.con+a.noans) : 0;
    const avgCon = a.conCnt? a.conBillsec/a.conCnt : 0;
    const shortRate = a.conCnt ? a.shortCalls/a.conCnt : 0;
    return {...a, rate, asr, minutes: a.billsec/60, avgCon, shortRate};
  });

  });
}

function computeCallbackStats(rows){
  const byDn={};
  (rows||[]).forEach(r=>{
    const dn=String(r.destination_number||'');
    if(!dn) return;
    if(!byDn[dn]) byDn[dn]={dn, tot:0, con:0, firstConnectAttempt:null, seen:0};
    byDn[dn].tot += 1;
    if(isConnectedStrict(r)) byDn[dn].con += 1;
  });

  // first connect attempt: sort per dn by time
  const byDnRows={};
  (rows||[]).forEach(r=>{
    const dn=String(r.destination_number||'');
    if(!dn) return;
    byDnRows[dn]=byDnRows[dn]||[];
    byDnRows[dn].push(r);
  });
  Object.keys(byDnRows).forEach(dn=>{
    const arr = byDnRows[dn].slice().sort((a,b)=> (a.start_stamp||'').localeCompare(b.start_stamp||''));
    let attempt=0; let first=null;
    for(const r of arr){
      attempt++;
      if(isConnectedStrict(r)){ first=attempt; break; }
    }
    if(byDn[dn]) byDn[dn].firstConnectAttempt = first; // null if never connected
  });

  return Object.values(byDn);
}

// ==========================================================================
// Xuất ra: gán vào global (self trong worker, window/globalThis trong trang)
// + module.exports cho Node test.
// ==========================================================================
const __exports = {
  localISODate, localISODateTime,
  retryTimestamp, retryDelayBucket,
  mapPrefix,
  Fail_Hangup_cause, NoAnswer_Hangup_cause, Cancelled_Hangup_cause,
  isConnectedStrict, CONN_TYPES, emptyConnCounts,
  classifyCall, dateKey,
  normalizeTelcoName, getTelco, isLikelyPhoneNumber,
  normalizeHeaderKey, CSV_HEADER_ALIASES, NUMERIC_FIELDS, toNumberLoose, pad2,
  normalizeTimestamp, addSecondsToStamp, hash32,
  createNormalizeContext, normalizeCallRecord, normalizeCallRecords,
  enrichData, filterData, dedupByUUID,
  __aggCache, __getAgg, __getAggIfPresent, downsampleSeriesMax,
  computeCallCounts, computeASRExcludingFail, computeConnectRate, computeBillsecMetrics, computeDestinationQualityMetrics, computeRequiredColumnHealth, computeTimeAnomalyMetrics, aggregateOverview, aggByPrefix, minutesPerDay,
  computeRetryPattern, retryAggregate, computeAccountKPIs, computeTopDest, aggDestTelcoShare, aggTelcoConnBreakdown, weekdayIndex, computeTimeHeatmap, computeAnswerRateByAccountPerDay, computeGoldenHours, computeDailyPrefixStats, computeAgentPerf, computeCallbackStats,
  buildCube
};
for (const k in __exports) { if (!(k in root)) root[k] = __exports[k]; }
if (typeof module !== 'undefined' && module.exports) module.exports = __exports;

})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
