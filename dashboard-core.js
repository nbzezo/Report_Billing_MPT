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
  __aggCache, __getAgg, __getAggIfPresent, downsampleSeriesMax
};
for (const k in __exports) { if (!(k in root)) root[k] = __exports[k]; }
if (typeof module !== 'undefined' && module.exports) module.exports = __exports;

})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
