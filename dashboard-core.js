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
// Tập đầu số dựng MỘT lần (trước đây dựng 6 Set mới cho mỗi dòng — ~1 triệu lần).
const PREFIX_VIETTEL2 = new Set(['32', '33', '34', '35', '36', '37', '38', '39', '86', '96', '97', '98']);
const PREFIX_VINA2 = new Set(['81', '82', '83', '84', '85', '88', '91', '94']);
const PREFIX_MOBI2 = new Set(['70', '76', '77', '78', '79', '89', '90', '93']);
const PREFIX_VIETTEL3 = new Set(['032', '033', '034', '035', '036', '037', '038', '039', '086', '096', '097', '098']);
const PREFIX_VINA3 = new Set(['081', '082', '083', '084', '085', '088', '091', '094']);
const PREFIX_MOBI3 = new Set(['070', '076', '077', '078', '079', '089', '090', '093']);
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

  if (PREFIX_VIETTEL2.has(p2) || PREFIX_VIETTEL3.has(p3)) return 'vbn_vt';
  if (PREFIX_VINA2.has(p2) || PREFIX_VINA3.has(p3)) return 'vbn_vina';
  if (PREFIX_MOBI2.has(p2) || PREFIX_MOBI3.has(p3)) return 'vbn_mobi';

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
const TELCO_NAME_MAP = {
  'vina': 'VinaPhone', 'vinaphone': 'VinaPhone', 'vnpt': 'VinaPhone', 'vinaphon': 'VinaPhone',
  'viettel': 'Viettel', 'vt': 'Viettel',
  'mobi': 'MobiFone', 'mobifone': 'MobiFone', 'mobiphone': 'MobiFone', 'mphone': 'MobiFone',
  'vietnamobile': 'Vietnamobile', 'vietnammobile': 'Vietnamobile', 'vnmobile': 'Vietnamobile', 'vnmobi': 'Vietnamobile',
  'gmobile': 'Gmobile', 'beeline': 'Gmobile', 'gtel': 'Gmobile',
  'fixed': 'Cố định', 'landline': 'Cố định', 'pstn': 'Cố định',
  'itel': 'Itel', 'wintel': 'Wintel', 'reddi': 'Reddi', 'vnsky': 'VNSKY', 'local': 'Cố định'
};
// Chỉ vài chục giá trị telco khác nhau cho cả triệu dòng -> nhớ kết quả.
const __telcoNameMemo = new Map();
function normalizeTelcoName(raw) {
  const v = String(raw || '').trim();
  if (!v) return 'Unknown';
  let out = __telcoNameMemo.get(v);
  if (out !== undefined) return out;
  const key = v.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
  out = TELCO_NAME_MAP[key] || v;
  if (__telcoNameMemo.size > 5000) __telcoNameMemo.clear();
  __telcoNameMemo.set(v, out);
  return out;
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
  let s = String(v).trim();
  // Chỉ chạy regex khi thật sự có " hoặc dấu phẩy (số từ DB không có).
  if (s.indexOf('"') !== -1 || s.indexOf(',') !== -1) s = s.replace(/^"|"$/g, '').replace(/,/g, '');
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
  // Đường nhanh: đã đúng "YYYY-MM-DD HH:mm:ss" (mọi dữ liệu từ DB) -> nhánh
  // regex đầu tiên bên dưới cũng trả nguyên chuỗi này.
  if (isCanonicalStamp(s)) return { value: s, hasSeconds: true };

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

/** Đúng khuôn "YYYY-MM-DD HH:mm:ss" (kiểm tra theo ký tự, không regex). */
function isCanonicalStamp(s) {
  if (s.length !== 19 || s.charCodeAt(4) !== 45 || s.charCodeAt(7) !== 45 || s.charCodeAt(10) !== 32 ||
      s.charCodeAt(13) !== 58 || s.charCodeAt(16) !== 58) return false;
  for (const i of CANONICAL_STAMP_DIGITS) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}
const CANONICAL_STAMP_DIGITS = [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18];

/**
 * = a.localeCompare(b) cho start_stamp. Hai chuỗi cùng khuôn chuẩn chỉ khác
 * nhau ở chữ số tại cùng vị trí nên thứ tự collation trùng thứ tự mã ký tự ->
 * so sánh thường (nhanh). Khuôn khác -> Intl.Collator (= localeCompare theo ECMA-402).
 */
const __stampCollator = (typeof Intl !== 'undefined' && Intl.Collator) ? new Intl.Collator() : null;
function __stampCompare(a, b) {
  if (a === b) return 0;
  if (isCanonicalStamp(a) && isCanonicalStamp(b)) return a < b ? -1 : 1;
  return __stampCollator ? __stampCollator.compare(a, b) : a.localeCompare(b);
}

/**
 * = Date.parse(stamp.replace(' ', 'T')) (giờ địa phương) nhưng nhanh: nhớ mốc
 * đầu mỗi PHÚT rồi cộng giây (đổi giờ DST chỉ xảy ra ở ranh giới giờ nên
 * cộng giây trong một phút luôn đúng). Khuôn khác -> Date.parse như cũ.
 */
const __minuteMsMemo = new Map();
function stampToMs(value) {
  const v = String(value || '');
  if (isCanonicalStamp(v)) {
    const sec = (v.charCodeAt(17) - 48) * 10 + (v.charCodeAt(18) - 48);
    const hour = (v.charCodeAt(11) - 48) * 10 + (v.charCodeAt(12) - 48);
    if (sec < 60 && hour < 24) {
      const minuteKey = v.slice(0, 16);
      let base = __minuteMsMemo.get(minuteKey);
      if (base === undefined) {
        base = Date.parse(minuteKey.replace(' ', 'T') + ':00');
        if (__minuteMsMemo.size > 200000) __minuteMsMemo.clear();
        __minuteMsMemo.set(minuteKey, base);
      }
      if (!isNaN(base)) return base + sec * 1000;
    }
  }
  return Date.parse(v.replace(' ', 'T'));
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

const __headerAliasMemo = new Map();

/**
 * Hàm dựng object có sẵn đúng các khoá `keys` (theo thứ tự), giá trị lấy từ
 * mảng `values` (thiếu -> undefined).
 *
 * Vì sao: dựng object bằng `o[tenCot] = v` quá 12 khoá làm V8 chuyển object sang
 * chế độ "từ điển" (bảng băm) -> mọi lần đọc thuộc tính và `{...r}` về sau đều
 * chậm; với 1 triệu dòng đó là phần lớn thời gian nạp dữ liệu. Object literal
 * với khoá cố định giữ chế độ nhanh. Mỗi bộ khoá chỉ sinh hàm một lần.
 */
const __rowFactoryMemo = new Map();
function makeRowFactory(keys) {
  const sig = keys.join(String.fromCharCode(1));
  let make = __rowFactoryMemo.get(sig);
  if (make) return make;
  const plain = values => {
    const o = {};
    for (let i = 0; i < keys.length; i++) o[keys[i]] = values ? values[i] : undefined;
    return o;
  };
  make = plain;
  if (keys.length <= 120 && keys.indexOf('__proto__') === -1) {
    try {
      make = new Function('v', 'v = v || []; return {' +
        keys.map((k, i) => JSON.stringify(k) + ': v[' + i + ']').join(', ') + '};');
    } catch (_) { make = plain; }  // CSP chặn eval -> vẫn đúng, chỉ chậm hơn
  }
  if (__rowFactoryMemo.size > 200) __rowFactoryMemo.clear();
  __rowFactoryMemo.set(sig, make);
  return make;
}

// Kế hoạch chuẩn hoá cho MỘT bộ tên cột (mọi dòng CSV giống nhau): khoá đích
// của từng cột + thứ tự khoá đầu ra đúng như khi gán lần lượt.
function __normalizePlan(keys, ctx) {
  const last = ctx.plan;
  if (last && last.keys.length === keys.length) {
    let same = true;
    for (let i = 0; i < keys.length; i++) if (last.keys[i] !== keys[i]) { same = false; break; }
    if (same) return last;
  }
  const targets = [], isAlias = [], outKeys = [], seen = new Set();
  for (const key of keys) {
    let mapped = null;
    if (key !== '__source_file') {
      mapped = __headerAliasMemo.get(key);
      if (mapped === undefined) {
        mapped = CSV_HEADER_ALIASES[normalizeHeaderKey(key)] || null;
        if (__headerAliasMemo.size > 5000) __headerAliasMemo.clear();
        __headerAliasMemo.set(key, mapped);
      }
    }
    const target = mapped || key;
    targets.push(target);
    isAlias.push(!!mapped);
    if (!seen.has(target)) { seen.add(target); outKeys.push(target); }
  }
  ctx.plan = { keys: keys.slice(), targets, isAlias, make: makeRowFactory(outKeys) };
  return ctx.plan;
}

function createNormalizeContext() { return { sigCount: Object.create(null), plan: null }; }

function normalizeCallRecord(raw, ctx) {
  if (!raw || typeof raw !== 'object') return null;
  ctx = ctx || createNormalizeContext();

  // Tên cột giống nhau ở mọi dòng -> dùng lại kế hoạch + object dựng sẵn khoá
  // (giữ chế độ thuộc tính nhanh của V8, xem makeRowFactory).
  const keys = Object.keys(raw);
  const plan = __normalizePlan(keys, ctx);
  const out = plan.make();
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const target = plan.targets[i];
    if (plan.isAlias[i]) {
      const cur = out[target];
      if (cur === undefined || cur === null || cur === '') out[target] = raw[key];
    } else {
      out[target] = raw[key];
    }
  }

  if (out.direction === undefined || out.direction === '') {
    const calltypeDirection = ({ outbound: 'Outbound', out: 'Outbound', inbound: 'Inbound', in: 'Inbound' })[
      String(out.calltype || '').trim().toLowerCase()
    ];
    if (calltypeDirection) out.direction = calltypeDirection;
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
 * @param {Array}  arr             bản ghi đã normalize
 * @param {Object} accountNameMap  map id -> tên hiển thị (worker truyền vào; trang truyền accountNameMap toàn cục)
 * @param {Object} gatewayCidIndex map CID (đã normalizeCidNational) -> {gateway, routing_name, telco_status, ...}
 *                                 Nguồn: /api/gateway-cids (suy 1 lần từ MPT routing/exportCid). Không có -> bỏ qua.
 */
function enrichData(arr, accountNameMap, gatewayCidIndex) {
  const nameMap = accountNameMap || {};
  const gwIndex = (gatewayCidIndex && typeof gatewayCidIndex === 'object') ? gatewayCidIndex : null;
  return arr.map(r => {
    const acc = (r.account_id === undefined || r.account_id === null) ? 'Unknown' : String(r.account_id);
    const mappedName = (r.account_name && String(r.account_name).trim())
      || nameMap[acc]
      || acc;

    const start_ts = (() => { const t = stampToMs(r.start_stamp); return isNaN(t) ? null : t; })();
    const end_ts = (() => { const v = String(r.end_stamp || ''); if (!v) return null; const t = stampToMs(v); return isNaN(t) ? null : t; })();

    const gw = gwIndex ? gwIndex[normalizeCidNational(r.caller_id_number)] : null;

    return {
      ...r,
      account_id: acc,
      account_name: mappedName,
      prefix: mapPrefix(r.caller_id_number),
      connType: classifyCall(r),
      date: dateKey(r.start_stamp),
      hour: (r.start_stamp || '').slice(11, 13),
      start_ts,
      end_ts,
      gateway: gw ? String(gw.gateway || '') : '',
      routing_name: gw ? String(gw.routing_name || '') : '',
      gw_telco_status: gw ? (gw.telco_status || null) : null
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

/**
 * Như `downsampleSeriesMax` nhưng giữ giá trị NHỎ NHẤT mỗi nhóm.
 *
 * Với đường "% kho số khả dụng", giữ max sẽ che mất chính các đợt tụt — thứ duy
 * nhất đáng nhìn trên biểu đồ đó. Giữ min thì không bao giờ giấu một đợt gián
 * đoạn đi.
 */
function downsampleSeriesMin(x, y, maxPoints = 1500) {
  const n = (x && x.length) ? x.length : 0;
  if (n <= maxPoints) return { x, y };
  const step = Math.ceil(n / maxPoints);
  const outX = [], outY = [];
  for (let i = 0; i < n; i += step) {
    const end = Math.min(n, i + step);
    let min = Infinity, minIdx = i;
    for (let j = i; j < end; j++) {
      const v = y[j];
      if (v < min) { min = v; minIdx = j; }
    }
    outX.push(x[minIdx]);
    outY.push(min);
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

/**
 * Lọc dữ liệu cho bảng drilldown. Bộ lọc ngày/giờ/account dùng cùng
 * filterData với dashboard; status và gateway dùng key gốc đã enrich, không
 * dùng tên hiển thị nên account trùng tên vẫn tách được.
 */
function filterCallDetails(rows, params) {
  const p = params || {};
  const statuses = Array.isArray(p.statuses)
    ? p.statuses.map(String).filter(Boolean)
    : (p.status ? [String(p.status)] : []);
  const account = p.accountIds || p.account || 'all';
  const gateway = p.gatewayKey === undefined || p.gatewayKey === null
    ? null : String(p.gatewayKey);
  return filterData(
    Array.isArray(rows) ? rows : [],
    p.startDate, p.endDate, account, p.startTime, p.endTime
  ).filter(r => {
    const status = String(r.connType || classifyCall(r));
    if (statuses.length && !statuses.includes(status)) return false;
    if (gateway !== null) {
      const key = String(r.gateway || '(chưa map)');
      if (key !== gateway) return false;
    }
    return true;
  });
}

function queryCallDetails(rows, params, offset, limit) {
  const filtered = filterCallDetails(rows, params);
  const off = Math.max(0, Number(offset) || 0);
  const lim = Math.max(1, Number(limit) || 50);
  return { rows: filtered.slice(off, off + lim), total: filtered.length, offset: off, limit: lim };
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

// Connected / (Tổng - Fail). Chỉ số này khác ASR hợp lệ bên trên:
// mẫu số vẫn giữ No Answer, Cancelled và Unknown, chỉ loại đúng Fail.
function computeConnectRateExcludingFail(rowsOrCounts){
  const counts = Array.isArray(rowsOrCounts) ? computeCallCounts(rowsOrCounts) : (rowsOrCounts||{});
  const total = (counts.Fail||0) + (counts['No Answer']||0) + (counts.Cancelled||0)
              + (counts.Connected||0) + (counts.Unknown||0);
  const denominator = total - (counts.Fail||0);
  return denominator ? +((counts.Connected||0)/denominator*100).toFixed(2) : 0;
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
      if(v!==null && v!==undefined && (typeof v==='number' || String(v).trim()!=='')) filled[c]++;
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
    } const billsecMetrics = computeBillsecMetrics(rows); const answerRate = computeASRExcludingFail(counts); const connectRate = computeConnectRate(counts); const connectRateExcludingFail = computeConnectRateExcludingFail(counts); const destinationQuality = computeDestinationQualityMetrics(rows); return {counts,pct,totalMinutes: billsecMetrics.totalMinutes,totalCalls:total,answerRate,connectRate,connectRateExcludingFail,billsecMetrics,destinationQuality};
  });
}

// Các cảnh báo vận hành phải được tính trong worker trên TOÀN BỘ tập đã lọc.
// UI chỉ render cấu trúc gọn này, tránh vô tình tính lại trên MAIN_ROW_CAP dòng đầu.
function computeOperationalAlerts(rows){
  const list = rows || [];
  const total = list.length;
  const connected = list.reduce((s,r)=> s + (isConnectedStrict(r) ? 1 : 0), 0);
  const overallRate = total ? connected/total : 0;
  const dns = list.map(r=>String(r.destination_number||'').trim()).filter(Boolean);
  const invalid = dns.reduce((s,dn)=>s + (!isLikelyPhoneNumber(dn) ? 1 : 0), 0);
  const invalidRatio = dns.length ? invalid/dns.length : 0;
  const stats = computeDailyPrefixStats(list);
  const dates = Array.from(new Set(stats.map(s=>s.date))).sort();
  const lastDate = dates[dates.length-1];
  const prevDates = dates.slice(Math.max(0,dates.length-8),-1);
  const byPrefix = {};
  stats.forEach(s=>{ (byPrefix[s.prefix]||(byPrefix[s.prefix]={}))[s.date]=s; });
  const drops=[];
  Object.keys(byPrefix).forEach(prefix=>{
    const last=byPrefix[prefix][lastDate];
    if(!last || last.tot<50) return;
    const baseRates=prevDates.map(d=>byPrefix[prefix][d]).filter(Boolean).map(s=>s.con/s.tot);
    if(!baseRates.length) return;
    const base=baseRates.reduce((a,b)=>a+b,0)/baseRates.length;
    const diffPp=(last.con/last.tot-base)*100;
    if(diffPp<=-10) drops.push({p:prefix,diffPp,lastTot:last.tot});
  });
  drops.sort((a,b)=>a.diffPp-b.diffPp);

  const hourly={};
  list.forEach(r=>{
    const h=r.hour||String(r.start_stamp||'').slice(11,13)||'Unknown';
    if(!hourly[h]) hourly[h]={hour:h,total:0,failNoAnswer:0};
    hourly[h].total++;
    if(r.connType==='Fail'||r.connType==='No Answer'||r.connType==='Cancelled') hourly[h].failNoAnswer++;
  });
  const issueCount=list.reduce((s,r)=>s+((r.connType==='Fail'||r.connType==='No Answer'||r.connType==='Cancelled')?1:0),0);
  const overallIssueRate=total?issueCount/total:0;
  const hourAnomalies=Object.values(hourly).filter(h=>h.total>=50)
    .map(h=>({...h,rate:h.failNoAnswer/h.total,diffPp:(h.failNoAnswer/h.total-overallIssueRate)*100}))
    .filter(h=>h.diffPp>=10).sort((a,b)=>b.diffPp-a.diffPp);
  const items=[];
  const health=computeRequiredColumnHealth(list);
  (health.critical||[]).forEach(msg=>items.push({level:'red',title:'Dữ liệu đầu vào hỏng',desc:msg}));
  if(health.missing.length) items.push({level:'red',title:'Thiếu cột bắt buộc',desc:health.missing.join(', ')});
  else if(health.sparse.length) items.push({level:'yellow',title:'Cột thiếu dữ liệu',desc:health.sparse.join(', ')});
  items.push({level:overallRate<0.25?'red':overallRate<0.35?'yellow':'green',title:'Tỷ lệ kết nối tổng',
    desc:`Connect rate: ${(100*overallRate).toFixed(2)}% (${connected}/${total})`});
  items.push(invalidRatio>0.05
    ? {level:invalidRatio>0.12?'red':'yellow',title:'Data có dấu hiệu kém',desc:`Tỷ lệ destination_number không hợp lệ: ${(100*invalidRatio).toFixed(2)}%`}
    : {level:'green',title:'Chất lượng định dạng số đích',desc:`Tỷ lệ số không hợp lệ: ${(100*invalidRatio).toFixed(2)}%`});
  items.push(drops.length
    ? {level:'red',title:'Đầu số tụt mạnh so với baseline',desc:`Top: ${drops.slice(0,3).map(d=>`${d.p} (${d.diffPp.toFixed(1)}pp, n=${d.lastTot})`).join(', ')}`}
    : {level:'green',title:'Biến động đầu số',desc:'Không phát hiện đầu số tụt mạnh theo rule (≥50 cuộc/ngày & tụt ≥10pp).'});
  items.push(hourAnomalies.length
    ? {level:'yellow',title:'Fail/No Answer tăng bất thường theo giờ',desc:`Top khung giờ: ${hourAnomalies.slice(0,3).map(h=>`${h.hour}h (${(100*h.rate).toFixed(1)}%, n=${h.total})`).join(', ')}. Rule: volume ≥50 và cao hơn baseline ≥10pp.`}
    : {level:'green',title:'Fail/No Answer theo giờ',desc:'Không phát hiện khung giờ đủ volume có tỷ lệ Fail/No Answer tăng bất thường.'});
  return {items,scope:{mode:'full',rows:total,dateMin:dates[0]||null,dateMax:lastDate||null}};
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
  const ccuScope = params.ccuScope === 'occupied' ? 'occupied' : 'answered';
  const filterSpanSec = filterWindowSec(params);
  const retry = params.retry || {};
  return {
    meta: {
      rows: rows.length,
      accounts: new Set(rows.map(r => String(r.account_id || 'Unknown'))).size,
      dateMin: dates.length ? dates[0] : null,
      dateMax: dates.length ? dates[dates.length - 1] : null,
      ccuScope,
      filterSpanSec
    },
    // --- Tổng quan / renderCommon ---
    overview: aggregateOverview(rows),
    byPrefix: aggByPrefix(rows),
    minutesPerDay: minutesPerDay(rows),
    columnHealth: computeRequiredColumnHealth(rows),
    timeAnomaly: computeTimeAnomalyMetrics(rows),
    operationalAlerts: computeOperationalAlerts(rows),
    accountKPIs: computeAccountKPIs(rows),
    topDest: computeTopDest(rows),
    // --- Chất lượng ---
    destTelcoShare: aggDestTelcoShare(rows),
    telcoConnBreakdown: aggTelcoConnBreakdown(rows),
    dailyPrefixStats: computeDailyPrefixStats(rows),
    // --- Thời gian ---
    timeHeatmap: computeTimeHeatmap(rows),
    goldenHours: computeGoldenHours(rows),
    answerRateByAccountPerDay: computeAnswerRateByAccountPerDay(rows),
    // --- Nâng cao ---
    agentPerf: computeAgentPerf(rows),
    gatewayByAccount: computeGatewayByAccount(rows),
    gatewayFail: computeGatewayFail(rows),
    gatewayHangupCause: computeGatewayHangupCause(rows),
    gatewayFailTimeline: computeGatewayFailTimeline(rows, 30),
    gatewayBlockReconcile: computeGatewayBlockReconcile(rows),
    callbackStats: computeCallbackStats(rows),
    retryPattern: computeRetryPattern(rows, retry.windowMinutes || 5, retry.scope || 'account'),
    concurrency: (() => {
      const byTelco = __computeConcurrency(rows, getTelco, ccuScope);
      return {
        all: __computeConcurrency(rows, () => 'Tất cả', ccuScope),
        byTelco,
        ccuByTelco: computeCcuByTelco(rows, { scope: ccuScope, filterSpanSec, byTelco })
      };
    })(),
    // --- Cước phí (chỉ khi có cấu hình billing) ---
    billing: params.billing ? computeBilling(rows, params.billing) : null
  };
}

/* ==========================================================================
   [SECTION] SLIM CUBE — bản cube gửi từ worker sang luồng chính.

   buildCube giữ đầy đủ (test/LLM/fallback dùng), nhưng vài nhánh có 1 phần tử
   cho MỖI số đích hoặc MỖI mốc thời gian: 1 triệu cuộc -> ~158 MB phải
   structured-clone sang UI trong khi UI chỉ vẽ top-N / ~2000 điểm. Các hàm
   dưới đây giữ ĐÚNG phần UI dùng, nên bảng/biểu đồ ra kết quả như cũ.
   ========================================================================== */
const SLIM_TOP_KEEP = 500;          // UI vẽ top 10 (topDest) / top 30 (callback)
const SLIM_TOP_DEST_MIN_CALLS = 5;  // = minCallsForFail của renderTopDestTable
const SLIM_CONCURRENCY_POINTS = 1800;   // = downsampleSeriesMax(…, 1800) của plotConcurrentCalls

/**
 * Chỉ số của n phần tử có key LỚN nhất, bằng nhau thì dòng trước đứng trước —
 * đúng kết quả của sort ổn định `(a,b)=>key(b)-key(a)` rồi slice(0,n) mà
 * renderTopDestTable/renderCallbackTopTable làm, nhưng không sort cả triệu
 * phần tử: tìm ngưỡng bằng sort mảng số rồi chỉ sort nhóm ứng viên.
 */
function __stableTopIdx(arr, key, n, keep) {
  const vals = [];
  for (let i = 0; i < arr.length; i++) if (!keep || keep(arr[i])) vals.push(key(arr[i]));
  if (!vals.length || n <= 0) return [];
  const sorted = Float64Array.from(vals).sort();
  const t = sorted[Math.max(0, sorted.length - n)];
  const above = [], at = [];
  for (let i = 0; i < arr.length; i++) {
    if (keep && !keep(arr[i])) continue;
    const k = key(arr[i]);
    if (k > t) above.push(i); else if (k === t) at.push(i);
  }
  const idx = above.concat(at.slice(0, Math.max(0, n - above.length)));
  idx.sort((a, b) => key(arr[b]) - key(arr[a]) || a - b);
  return idx.slice(0, n);
}

function slimTopDest(arr) {
  if (!Array.isArray(arr) || arr.length <= SLIM_TOP_KEEP * 2) return arr;
  const keep = new Set(__stableTopIdx(arr, x => x.total, SLIM_TOP_KEEP));
  // Như renderTopDestTable: chỉ số có >= minCallsForFail cuộc, xếp theo failPct.
  __stableTopIdx(arr, x => x.failPct, SLIM_TOP_KEEP, x => x.total >= SLIM_TOP_DEST_MIN_CALLS)
    .forEach(i => keep.add(i));
  // Giữ thứ tự gốc của mảng đầy đủ.
  return arr.filter((_, i) => keep.has(i));
}

/**
 * callbackStats (mảng mỗi số đích 1 dòng) -> {slim, total, top, firstAttemptHist}.
 * `top` = SLIM_TOP_KEEP số gọi nhiều nhất (đã sắp theo tot giảm dần, ổn định);
 * `firstAttemptHist` = [[số lần gọi tới khi nối, số đích], ...] cho histogram.
 * Gọi lại trên bản đã slim thì trả nguyên (UI gọi cả cho kết quả fallback).
 */
function slimCallbackStats(stats) {
  if (!Array.isArray(stats)) return stats || { slim: true, total: 0, top: [], firstAttemptHist: [] };
  const hist = new Map();
  for (const s of stats) {
    if (s.firstConnectAttempt == null) continue;
    hist.set(s.firstConnectAttempt, (hist.get(s.firstConnectAttempt) || 0) + 1);
  }
  return {
    slim: true,
    total: stats.length,
    top: __stableTopIdx(stats, x => x.tot, SLIM_TOP_KEEP).map(i => stats[i]),
    firstAttemptHist: Array.from(hist.entries()).sort((a, b) => a[0] - b[0])
  };
}

/**
 * Rút chuỗi đồng thời về ~maxPoints mốc: mỗi nhóm giữ mốc có TỔNG cao nhất
 * (như downsampleSeriesMax UI vẫn làm), và lấy giá trị từng nhà mạng tại CÙNG
 * mốc đó để vùng xếp chồng vẫn khớp tổng. peaks/systemPeak... giữ nguyên.
 */
function slimConcurrency(c, maxPoints) {
  maxPoints = maxPoints || SLIM_CONCURRENCY_POINTS;
  if (!c || !Array.isArray(c.times) || c.times.length <= maxPoints) return c;
  const n = c.times.length;
  const step = Math.ceil(n / maxPoints);
  const idx = [];
  for (let i = 0; i < n; i += step) {
    const end = Math.min(n, i + step);
    let best = i;
    for (let j = i; j < end; j++) if (c.totalY[j] > c.totalY[best]) best = j;
    idx.push(best);
  }
  const series = Object.create(null);
  for (const k of (c.keys || [])) {
    const y = (c.series[k] && c.series[k].y) || [];
    series[k] = { y: idx.map(i => y[i]) };
  }
  return Object.assign({}, c, {
    times: idx.map(i => c.times[i]),
    xISO: idx.map(i => c.xISO[i]),
    totalY: idx.map(i => c.totalY[i]),
    series,
    fullPoints: n
  });
}

function slimCubeForTransfer(cube) {
  if (!cube) return cube;
  const out = Object.assign({}, cube);
  out.topDest = slimTopDest(cube.topDest);
  out.callbackStats = slimCallbackStats(cube.callbackStats);
  if (cube.concurrency) {
    out.concurrency = Object.assign({}, cube.concurrency, {
      all: slimConcurrency(cube.concurrency.all),
      byTelco: slimConcurrency(cube.concurrency.byTelco)
    });
  }
  return out;
}

// Cube dung cho render UI co the lon (topDest/retryPattern.events co the hang
// nghin dong - moi CID/moi retry event 1 dong). buildLlmContext() cat xuong
// JSON du nho de gui LLM: chi giu cac truong lien quan toi dung 1 tab, cat
// top-N cho mang lon theo tong so giam dan. KHONG gui CDR tho - chi goi ham
// nay tren cube da tong hop (dung nguyen tac skill telecom-cid-risk-optimizer
// muc 1.1: code tinh, LLM chi doc).
const LLM_CONTEXT_TAB_FIELDS = {
  overview: ['meta', 'overview', 'byPrefix', 'minutesPerDay'],
  quality: ['meta', 'overview', 'byPrefix', 'destTelcoShare', 'telcoConnBreakdown', 'dailyPrefixStats', 'topDest'],
  time: ['meta', 'overview', 'timeHeatmap', 'goldenHours', 'answerRateByAccountPerDay', 'concurrency', 'retryPattern'],
  advanced: ['meta', 'overview', 'accountKPIs', 'agentPerf', 'gatewayByAccount', 'gatewayFail', 'gatewayHangupCause', 'gatewayBlockReconcile', 'columnHealth', 'timeAnomaly'],
  cid: ['meta', 'overview'],
  billing: ['meta', 'overview', 'billing']
};
const LLM_CONTEXT_TOP_N = 20;
// Trần kích thước JSON ngữ cảnh (~125K token). Vượt trần thì bỏ dần các miền
// lớn nhất — tránh lỗi "input token count exceeds" của model (vd Gemini 1M).
const LLM_CONTEXT_MAX_CHARS = 400000;
const LLM_CONTEXT_MAX_KEYS = 200;
const LLM_CONTEXT_MAX_DEPTH = 8;

// Chuỗi đồng thời có 1 điểm cho MỖI mốc bắt đầu/kết thúc cuộc gọi (155K cuộc
// → ~35K điểm × mỗi nhà mạng ≈ 3.5MB JSON). Gửi LLM bản rút gọn: đỉnh theo
// giờ-trong-ngày + dòng thời gian đỉnh theo giờ (hoặc theo ngày nếu dài).
function llmSummarizeConcurrency(c) {
  if (!c || !Array.isArray(c.times) || !Array.isArray(c.totalY)) return c;
  const keys = Array.isArray(c.keys) ? c.keys : [];
  const series = c.series || {};
  const byHour = new Map();
  const byHourOfDay = Array.from({ length: 24 }, (_, h) => ({ hour: h, peak: 0 }));
  for (let i = 0; i < c.times.length; i++) {
    const iso = String((c.xISO && c.xISO[i]) || localISODateTime(c.times[i]) || '');
    const tot = c.totalY[i] || 0;
    const hod = Number(iso.slice(11, 13));
    if (hod >= 0 && hod < 24 && tot > byHourOfDay[hod].peak) byHourOfDay[hod].peak = tot;
    const slot = iso.slice(0, 13);
    let point = byHour.get(slot);
    if (!point) { point = { t: slot + ':00', peak: 0, byKey: {} }; byHour.set(slot, point); }
    if (tot > point.peak) point.peak = tot;
    if (keys.length > 1) {
      for (const k of keys) {
        const v = (series[k] && series[k].y && series[k].y[i]) || 0;
        if (v > (point.byKey[k] || 0)) point.byKey[k] = v;
      }
    }
  }
  let points = Array.from(byHour.values());
  let granularity = 'hour';
  if (points.length > 48) {  // > 2 ngày: gộp theo ngày (mảng > 50 phần tử sẽ bị cắt)
    const byDay = new Map();
    for (const p of points) {
      const day = p.t.slice(0, 10);
      let d = byDay.get(day);
      if (!d) { d = { t: day, peak: 0, byKey: {} }; byDay.set(day, d); }
      if (p.peak > d.peak) d.peak = p.peak;
      for (const k in p.byKey) if (p.byKey[k] > (d.byKey[k] || 0)) d.byKey[k] = p.byKey[k];
    }
    points = Array.from(byDay.values());
    granularity = 'day';
  }
  points.forEach(p => { if (!Object.keys(p.byKey).length) delete p.byKey; });
  const peakAtISO = {};
  for (const k in (c.peakAt || {})) peakAtISO[k] = c.peakAt[k] == null ? null : localISODateTime(c.peakAt[k]);
  return {
    keys, peaks: c.peaks, peakAtISO,
    systemPeak: c.systemPeak,
    systemPeakAtISO: c.systemPeakAt == null ? null : localISODateTime(c.systemPeakAt),
    atSystemPeak: c.atSystemPeak, erlangSec: c.erlangSec, totalErlangSec: c.totalErlangSec,
    observedSpanSec: c.observedSpanSec, calls: c.calls, scope: c.scope,
    peakByHourOfDay: byHourOfDay,
    peakTimeline: { granularity, points: points.slice(-50), totalPoints: points.length },
    _note: `Đã rút gọn từ ${c.times.length} mốc thay đổi thành đỉnh theo ${granularity === 'day' ? 'ngày' : 'giờ'}` +
      (points.length > 50 ? ` (chỉ giữ 50 ${granularity === 'day' ? 'ngày' : 'giờ'} gần nhất).` : '.')
  };
}

// Cắt đệ quy các mảng/đối tượng lồng nhau quá lớn mà llmTrimCubeField không
// nhìn thấy (mảng số dài → thống kê min/max/avg; mảng object → 50 phần tử đầu).
function llmCompactValue(value, depth) {
  if (value == null || typeof value !== 'object') {
    return (typeof value === 'string' && value.length > 2000) ? value.slice(0, 2000) + '…' : value;
  }
  if (depth > LLM_CONTEXT_MAX_DEPTH) return '[đã lược bớt: lồng quá sâu]';
  if (Array.isArray(value)) {
    if (value.length > 50 && value.every(v => typeof v === 'number' || v == null)) {
      const nums = value.filter(v => typeof v === 'number' && isFinite(v));
      let min = Infinity, max = -Infinity, sum = 0;
      for (const v of nums) { if (v < min) min = v; if (v > max) max = v; sum += v; }
      return { _numericSeries: value.length, min: nums.length ? min : null, max: nums.length ? max : null,
               avg: nums.length ? +(sum / nums.length).toFixed(3) : null };
    }
    return value.slice(0, 50).map(v => llmCompactValue(v, depth + 1));
  }
  const keys = Object.keys(value);
  const out = {};
  keys.slice(0, LLM_CONTEXT_MAX_KEYS).forEach(k => { out[k] = llmCompactValue(value[k], depth + 1); });
  if (keys.length > LLM_CONTEXT_MAX_KEYS) out._omittedKeys = keys.length - LLM_CONTEXT_MAX_KEYS;
  return out;
}

function llmTrimCubeField(key, value) {
  if (key === 'concurrency' && value && typeof value === 'object') {
    const out = {};
    for (const k in value) out[k] = llmSummarizeConcurrency(value[k]);
    return out;
  }
  if (key === 'topDest' && Array.isArray(value)) {
    return value.slice()
      .sort((a, b) => (b.total || 0) - (a.total || 0))
      .slice(0, LLM_CONTEXT_TOP_N);
  }
  if (key === 'retryPattern' && value && Array.isArray(value.events)) {
    return Object.assign({}, value, {
      events: value.events.slice(0, LLM_CONTEXT_TOP_N),
      eventsTotalCount: value.events.length
    });
  }
  if (Array.isArray(value) && value.length > 50) {
    return value.slice(0, 50);
  }
  return value;
}

function buildLlmContext(cube, tabKey, extra) {
  if (!cube) return null;
  // '__all__' exposes every analytical domain computed from the complete
  // filtered row set. It deliberately does not expose rows outside that set.
  const fields = tabKey === '__all__'
    ? Object.keys(cube)
    : (LLM_CONTEXT_TAB_FIELDS[tabKey] || Object.keys(cube));
  const out = {};
  const coverage = {};
  for (const key of fields) {
    if (!(key in cube) || cube[key] == null) continue;
    out[key] = llmCompactValue(llmTrimCubeField(key, cube[key]), 0);
    if (Array.isArray(cube[key]) && cube[key].length > 50) {
      coverage[key] = { total: cube[key].length, included: out[key].length };
    }
  }
  if (extra && typeof extra === 'object') Object.assign(out, extra);
  // Chốt trần kích thước: bỏ miền lớn nhất (trừ meta/overview) tới khi vừa.
  const sizes = Object.keys(out)
    .filter(key => key !== 'meta' && key !== 'overview')
    .map(key => [key, (JSON.stringify(out[key]) || '').length])
    .sort((a, b) => b[1] - a[1]);
  let totalChars = (JSON.stringify(out) || '').length;
  const omitted = {};
  for (const [key, chars] of sizes) {
    if (totalChars <= LLM_CONTEXT_MAX_CHARS) break;
    out[key] = { _omitted: true, reason: 'Quá lớn để gửi kèm câu hỏi AI' };
    omitted[key] = chars;
    totalChars -= chars;
  }
  out._contextMode = tabKey === '__all__' ? 'all-filtered-database-domains' : `tab:${tabKey}`;
  out._availableDomains = fields.filter(key => key in cube && cube[key] != null);
  if (Object.keys(coverage).length) out._arrayCoverage = coverage;
  if (Object.keys(omitted).length) out._omittedDomains = omitted;
  return out;
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
    const nonFail = m.total - m.fail;
    const connectRateExcludingFail = nonFail===0 ? 0 : (m.connected/nonFail*100);
    const failPct = m.total===0 ? 0 : (m.fail/m.total*100);
    return {...m, asr, connectRateExcludingFail:+connectRateExcludingFail.toFixed(2), failPct, minutes:+m.minutes.toFixed(2)};
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
    // Literal cùng thứ tự khoá như {...m, failPct} nhưng không phải copy động.
    return {dn:m.dn, total:m.total, connected:m.connected, noans:m.noans, fail:m.fail, failPct:+failPct.toFixed(2)};
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

// Cả triệu dòng chỉ có vài chục ngày -> nhớ kết quả theo chuỗi ngày.
const __weekdayMemo = new Map();
function weekdayIndex(dateStr){
  const key = String(dateStr);
  if(__weekdayMemo.has(key)) return __weekdayMemo.get(key);
  const d=new Date(dateStr+'T00:00:00');
  const out = isNaN(d) ? null : d.getDay(); // 0=Sun..6=Sat
  if(__weekdayMemo.size > 10000) __weekdayMemo.clear();
  __weekdayMemo.set(key, out);
  return out;
}

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
  // Dòng ĐẦU TIÊN của mỗi String(account_id) — thay cho rows.find() lặp lại cả
  // triệu dòng cho từng account khi lấy nhãn.
  const firstRowByAcc = new Map();
  rows.forEach(r=>{
    const idKey = String(r.account_id);
    if(!firstRowByAcc.has(idKey)) firstRowByAcc.set(idKey, r);
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
    const row = firstRowByAcc.get(acc);
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
    const connectExclFailRate = (a.tot-a.fail) ? a.con/(a.tot-a.fail) : 0;
    const avgCon = a.conCnt? a.conBillsec/a.conCnt : 0;
    const shortRate = a.conCnt ? a.shortCalls/a.conCnt : 0;
    return {...a, rate, asr, connectExclFailRate, minutes: a.billsec/60, avgCon, shortRate};
  });

  });
}

/**
 * So khớp một ô với biểu thức lọc kiểu Excel:
 *   - chữ: chứa chuỗi, không phân biệt hoa/thường
 *   - số (isNumeric): toán tử `>`,`>=`,`<`,`<=`,`=` hoặc khoảng `a-b`;
 *     không có toán tử thì so chuỗi trên giá trị (gõ `13` khớp `13.88`).
 * Dùng cho bộ lọc từng cột của bảng (vd Gateway theo account).
 */
function excelCellMatch(rawValue, expr, isNumeric){
  expr = String(expr == null ? '' : expr).trim();
  if(!expr) return true;
  if(isNumeric){
    const num = Number(rawValue);
    const op = expr.match(/^(>=|<=|>|<|=)\s*(-?\d[\d.]*)$/);
    if(op && Number.isFinite(num)){
      const t = Number(op[2]);
      if(op[1] === '>')  return num >  t;
      if(op[1] === '>=') return num >= t;
      if(op[1] === '<')  return num <  t;
      if(op[1] === '<=') return num <= t;
      return num === t;
    }
    const rng = expr.match(/^(-?\d[\d.]*)\s*-\s*(-?\d[\d.]*)$/);
    if(rng && Number.isFinite(num)){
      const lo = Number(rng[1]), hi = Number(rng[2]);
      return num >= Math.min(lo, hi) && num <= Math.max(lo, hi);
    }
  }
  return String(rawValue == null ? '' : rawValue).toLowerCase().indexOf(expr.toLowerCase()) !== -1;
}
/** row có qua tất cả bộ lọc cột không. filters = {col: expr}; numericCols = Set. */
function rowPassesColFilters(row, filters, numericCols){
  numericCols = numericCols || new Set();
  return Object.keys(filters || {}).every(col =>
    excelCellMatch(row ? row[col] : '', filters[col], numericCols.has(col)));
}

/**
 * Gộp cuộc gọi theo (account_id × gateway). `gateway` do enrichData gắn từ
 * gatewayCidIndex (join qua caller_id_number). Dòng chưa map CID -> gateway ''
 * gom vào nhóm '(chưa map)' để thấy ngay độ phủ.
 */
function computeGatewayByAccount(rows){
  return __getAgg(rows, 'computeGatewayByAccount', ()=>{
    const map = {};
    let total = 0, matched = 0;
    (rows||[]).forEach(r=>{
      total++;
      const acc = String(r.account_id || 'Unknown');
      const gwRaw = String(r.gateway || '');
      if(gwRaw) matched++;
      const gw = gwRaw || '(chưa map)';
      const key = acc + ' ' + gw;
      let m = map[key];
      if(!m) m = map[key] = { account_id: acc, account_name: String(r.account_name || acc),
        gateway: gw, routing_name: String(r.routing_name || ''), mapped: !!gwRaw,
        total:0, connected:0, noans:0, cancelled:0, fail:0, unknown:0, billsec:0 };
      m.total++;
      const ct = r.connType || classifyCall(r);
      if(ct==='Connected'){ m.connected++; m.billsec += Number(r.billsec||0); }
      else if(ct==='No Answer') m.noans++;
      else if(ct==='Cancelled') m.cancelled++;
      else if(ct==='Fail') m.fail++;
      else m.unknown++;
    });
    const rows_ = Object.values(map).map(m=>({
      ...m,
      minutes: +(m.billsec/60).toFixed(2),
      connectRate: m.total ? +(m.connected/m.total*100).toFixed(2) : 0,
      asr: (m.connected+m.noans) ? +(m.connected/(m.connected+m.noans)*100).toFixed(2) : 0,
      connectExclFailRate: (m.total-m.fail) ? +(m.connected/(m.total-m.fail)*100).toFixed(2) : 0,
      failPct: m.total ? +(m.fail/m.total*100).toFixed(2) : 0
    })).sort((a,b)=> String(a.account_id).localeCompare(String(b.account_id)) || (b.total - a.total));
    return { rows: rows_, coverage: { total, matched, pct: total ? +(matched/total*100).toFixed(2) : 0 } };
  });
}

/**
 * Fail % theo GATEWAY, gộp toàn bộ account trong phạm vi lọc (đối trọng với
 * computeGatewayByAccount vốn tách theo account). Chỉ tính cuộc đã map gateway.
 * accountCount = số account khác nhau chảy qua gateway đó.
 */
function computeGatewayFail(rows){
  return __getAgg(rows, 'computeGatewayFail', ()=>{
    const map = {};
    let total = 0, matched = 0;
    (rows||[]).forEach(r=>{
      total++;
      const gw = String(r.gateway || '');
      if(!gw) return;
      matched++;
      let m = map[gw];
      if(!m) m = map[gw] = { gateway: gw, accounts: new Set(),
        total:0, connected:0, noans:0, cancelled:0, fail:0, unknown:0, billsec:0 };
      m.accounts.add(String(r.account_id || 'Unknown'));
      m.total++;
      const ct = r.connType || classifyCall(r);
      if(ct==='Connected'){ m.connected++; m.billsec += Number(r.billsec||0); }
      else if(ct==='No Answer') m.noans++;
      else if(ct==='Cancelled') m.cancelled++;
      else if(ct==='Fail') m.fail++;
      else m.unknown++;
    });
    const rows_ = Object.values(map).map(m=>({
      gateway: m.gateway,
      accountCount: m.accounts.size,
      total: m.total, connected: m.connected, noans: m.noans,
      cancelled: m.cancelled, fail: m.fail,
      minutes: +(m.billsec/60).toFixed(2),
      connectRate: m.total ? +(m.connected/m.total*100).toFixed(2) : 0,
      asr: (m.connected+m.noans) ? +(m.connected/(m.connected+m.noans)*100).toFixed(2) : 0,
      connectExclFailRate: (m.total-m.fail) ? +(m.connected/(m.total-m.fail)*100).toFixed(2) : 0,
      failPct: m.total ? +(m.fail/m.total*100).toFixed(2) : 0
    })).sort((a,b)=> b.failPct - a.failPct || b.total - a.total);
    return { rows: rows_, coverage: { total, matched, pct: total ? +(matched/total*100).toFixed(2) : 0 } };
  });
}

/**
 * Thống kê hangup_cause theo từng gateway đã map. Tách nguyên nhân trong phạm
 * vi từng gateway để soi nhanh gateway nào đang fail vì routing/network hay vì
 * nhóm thuê bao không phản hồi.
 */
function computeGatewayHangupCause(rows){
  return __getAgg(rows, 'computeGatewayHangupCause', ()=>{
    const byGateway = {};
    const byCause = {};
    let total = 0, matched = 0;
    (rows||[]).forEach(r=>{
      total++;
      const gw = String(r.gateway || '');
      if(!gw) return;
      matched++;
      byGateway[gw] = (byGateway[gw] || 0) + 1;
      const cause = String(r.hangup_cause || 'UNKNOWN').trim().toUpperCase() || 'UNKNOWN';
      const key = gw + '\u0000' + cause;
      let m = byCause[key];
      if(!m) m = byCause[key] = { gateway: gw, hangup_cause: cause,
        total:0, connected:0, noans:0, cancelled:0, fail:0, unknown:0 };
      m.total++;
      const ct = r.connType || classifyCall(r);
      if(ct==='Connected') m.connected++;
      else if(ct==='No Answer') m.noans++;
      else if(ct==='Cancelled') m.cancelled++;
      else if(ct==='Fail') m.fail++;
      else m.unknown++;
    });
    const rows_ = Object.values(byCause).map(m=>({
      ...m,
      gatewayTotal: byGateway[m.gateway] || m.total,
      sharePct: byGateway[m.gateway] ? +(m.total/byGateway[m.gateway]*100).toFixed(2) : 0,
      // Mức đóng góp của nguyên nhân này vào tổng Fail trên lưu lượng Gateway.
      // Khác failPct (Fail / Attempt của riêng cause, thường chỉ 0% hoặc 100%).
      failSharePct: byGateway[m.gateway] ? +(m.fail/byGateway[m.gateway]*100).toFixed(2) : 0,
      failPct: m.total ? +(m.fail/m.total*100).toFixed(2) : 0,
      connectRate: m.total ? +(m.connected/m.total*100).toFixed(2) : 0
    })).sort((a,b)=> String(a.gateway).localeCompare(String(b.gateway))
      || b.total - a.total
      || String(a.hangup_cause).localeCompare(String(b.hangup_cause)));
    return { rows: rows_, coverage: { total, matched, pct: total ? +(matched/total*100).toFixed(2) : 0 } };
  });
}

/**
 * Fail % theo (gateway × bucket thời gian). Chỉ tính cuộc đã map gateway.
 * Trả buckets (epoch ms) + series mỗi gateway; failPct để null ở bucket rỗng
 * để đường biểu đồ đứt đoạn thay vì tụt về 0.
 */
function computeGatewayFailTimeline(rows, bucketMin){
  bucketMin = bucketMin || 30;
  const bucketMs = bucketMin * 60000;
  const byGw = {};
  (rows||[]).forEach(r=>{
    const gw = r.gateway || '';
    if(!gw) return;
    const ts = (r.start_ts != null && Number.isFinite(Number(r.start_ts)))
      ? Number(r.start_ts)
      : Date.parse(String(r.start_stamp||'').replace(' ','T'));
    if(!Number.isFinite(ts)) return;
    const b = Math.floor(ts / bucketMs) * bucketMs;
    const m = byGw[gw] || (byGw[gw] = new Map());
    let cell = m.get(b);
    if(!cell){ cell = { total:0, fail:0 }; m.set(b, cell); }
    cell.total++;
    if((r.connType || classifyCall(r)) === 'Fail') cell.fail++;
  });
  const allBuckets = new Set();
  Object.values(byGw).forEach(m=> m.forEach((_, b)=> allBuckets.add(b)));
  const buckets = Array.from(allBuckets).sort((a,b)=> a-b);
  const series = Object.keys(byGw).sort().map(gw=>{
    const m = byGw[gw];
    return {
      gateway: gw,
      total:  buckets.map(b=> (m.get(b)||{}).total || 0),
      fail:   buckets.map(b=> (m.get(b)||{}).fail  || 0),
      failPct: buckets.map(b=>{ const c = m.get(b); return (c && c.total) ? +(c.fail/c.total*100).toFixed(2) : null; })
    };
  });
  return { bucketMin, buckets, series };
}

/**
 * Đối chiếu trạng thái chặn telco khai trong export (gw_telco_status: ON/PAUSE
 * theo viettel/mobi/vina/other) với Fail thực tế của cuộc gọi tới telco đó.
 * Gộp theo (gateway × nhóm telco × trạng thái khai) — PAUSE và ON là hai dòng
 * riêng vì các CID cùng gateway có thể khác trạng thái.
 */
const _GW_TELCO_KEY = { VT:'viettel', MB:'mobi', VN:'vina', OT:'other', '':'other' };
function computeGatewayBlockReconcile(rows){
  const map = {};
  (rows||[]).forEach(r=>{
    const gw = r.gateway || '';
    const stt = r.gw_telco_status;
    if(!gw || !stt || typeof stt !== 'object') return;
    const tkey = _GW_TELCO_KEY[telcoBlockCode(getTelco(r))] || 'other';
    const declared = String(stt[tkey] || '').toUpperCase();
    if(declared !== 'ON' && declared !== 'PAUSE') return;
    const k = gw + ' ' + tkey + ' ' + declared;
    let m = map[k];
    if(!m) m = map[k] = { gateway: gw, telco: tkey, declared, total:0, fail:0, connected:0, noans:0 };
    m.total++;
    const ct = r.connType || classifyCall(r);
    if(ct === 'Fail') m.fail++;
    else if(ct === 'Connected') m.connected++;
    else if(ct === 'No Answer') m.noans++;
  });
  return Object.values(map).map(m=>{
    const failPct = m.total ? +(m.fail/m.total*100).toFixed(2) : 0;
    const connPct = m.total ? +(m.connected/m.total*100).toFixed(2) : 0;
    let verdict;
    if(m.declared === 'PAUSE' && connPct >= 20) verdict = 'PAUSE nhưng vẫn kết nối nhiều — export có thể cũ';
    else if(m.declared === 'PAUSE') verdict = 'Khớp: đang chặn, gần như không kết nối';
    else if(m.declared === 'ON' && failPct >= 50) verdict = 'ON nhưng Fail cao — nghi bị chặn chưa ghi nhận';
    else verdict = 'Khớp: mở, kết nối bình thường';
    return { ...m, failPct, connPct, verdict };
  }).sort((a,b)=> String(a.gateway).localeCompare(String(b.gateway))
    || String(a.telco).localeCompare(String(b.telco))
    || a.declared.localeCompare(b.declared));
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

  // Lần gọi thứ mấy thì nối được lần đầu = vị trí (1-based) của cuộc nối sớm
  // nhất theo start_stamp. Trước đây gom mảng + sort cho từng số; nay chỉ tìm
  // cuộc nối sớm nhất rồi đếm số cuộc đứng trước nó theo ĐÚNG thứ tự sort ổn
  // định cũ (so start_stamp, bằng nhau thì theo thứ tự dòng).
  const list = rows || [];
  const firstConn = new Map();   // dn -> {stamp, idx}
  for(let i=0;i<list.length;i++){
    const r=list[i];
    const dn=String(r.destination_number||'');
    if(!dn || !isConnectedStrict(r)) continue;
    const stamp=r.start_stamp||'';
    const cur=firstConn.get(dn);
    if(!cur || __stampCompare(stamp, cur.stamp) < 0) firstConn.set(dn, {stamp, idx:i});
  }
  const before = new Map();      // dn -> số cuộc đứng trước cuộc nối sớm nhất
  for(let i=0;i<list.length;i++){
    const r=list[i];
    const dn=String(r.destination_number||'');
    const fc=dn ? firstConn.get(dn) : null;
    if(!fc) continue;
    const c=__stampCompare(r.start_stamp||'', fc.stamp);
    if(c < 0 || (c === 0 && i < fc.idx)) before.set(dn, (before.get(dn)||0) + 1);
  }
  for(const [dn, fc] of firstConn){
    if(byDn[dn]) byDn[dn].firstConnectAttempt = (before.get(dn)||0) + 1;
  }

  return Object.values(byDn);
}

// ---------- Billing + CCU engine (Milestone 1c-ii-B) ----------

// Do dai khoang thoi gian dang loc (giay) — mirror cua currentFilterWindowSec() trong trang.
function filterWindowSec(params) {
  if (!params || !params.startDate || !params.endDate) return null;
  const s = Date.parse(`${params.startDate}T${params.startTime || '00:00'}:00`);
  const e = Date.parse(`${params.endDate}T${params.endTime || '23:59'}:59`) + 1000;
  return (isFinite(s) && isFinite(e) && e > s) ? (e - s) / 1000 : null;
}

// Giải khoảng chọn nhanh từ metadata TOÀN BỘ dữ liệu, không suy từ mẫu dòng
// đang giữ ở main thread. preset: all | latest | 7 | 30 (hoặc số ngày).
function resolveDateRangePreset(preset, dateMin, dateMax){
  const min=String(dateMin||''), max=String(dateMax||'');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(min) || !/^\d{4}-\d{2}-\d{2}$/.test(max)) return null;
  if(preset==='all') return {startDate:min,endDate:max};
  const days=preset==='latest'?1:Math.max(1,parseInt(preset,10)||1);
  const d=new Date(max+'T00:00:00');
  d.setDate(d.getDate()-(days-1));
  const calculated=localISODate(d);
  return {startDate:calculated<min?min:calculated,endDate:max};
}

function billedSecondsOf(billsec, firstBlock, nextBlock, chargeZero){
  const b = Math.max(0, Math.floor(Number(billsec)||0));
  const fb = Math.max(1, Math.floor(firstBlock||6));
  const nb = Math.max(1, Math.floor(nextBlock||1));
  if(b <= 0) return chargeZero ? fb : 0;
  if(b <= fb) return fb;
  return fb + Math.ceil((b - fb) / nb) * nb;
}

function roundMoney(v, step){
  const s = Number(step)||0;
  const n = Number(v)||0;
  if(s <= 0) return n;
  return Math.round(n / s) * s;
}

// Lọc rows theo cấu hình tab Cước phí (khoảng ngày/giờ riêng + 1 account + 1 telco).
function billingRows(rows, cfg){
  const src = rows || [];
  if(!src.length) return [];
  const sMs = Date.parse(`${cfg.startDate}T${cfg.startTime}:00`);
  const eMs = Date.parse(`${cfg.endDate}T${cfg.endTime}:59`);
  const hasRange = isFinite(sMs) && isFinite(eMs);
  return src.filter(r=>{
    if(hasRange){
      let t = (r.start_ts!==undefined && r.start_ts!==null) ? r.start_ts : Date.parse(String(r.start_stamp||'').replace(' ','T'));
      if(!isFinite(t)) return false;
      if(t < sMs || t > eMs) return false;
    }
    if(cfg.account && String(r.account_id)!==cfg.account) return false;
    if(cfg.telco && String(r.telco)!==cfg.telco) return false;
    return true;
  });
}

function billingPeriodKey(r, groupBy){
  const s = String(r.start_stamp||'');
  if(groupBy==='hour')  return s.slice(0,13).replace(' ','T').replace('T',' ') + 'h';
  if(groupBy==='month') return s.slice(0,7);
  return s.slice(0,10);
}

function computeBilling(rows, cfg){
  const empty = ()=>({calls:0, billedCalls:0, rawSec:0, billedSec:0});
  const byPeriod = new Map(), byAccount = new Map(), byTelco = new Map();
  const totals = empty();
  const detail = [];

  for(const r of (rows||[])){
    const raw = Math.max(0, Math.floor(Number(r.billsec)||0));
    if(cfg.onlyConnected && raw <= 0){
      // vẫn đếm số cuộc để biết tỉ lệ, nhưng không cộng cước
      totals.calls++;
      const pk = billingPeriodKey(r, cfg.groupBy);
      if(!byPeriod.has(pk)) byPeriod.set(pk, empty());
      byPeriod.get(pk).calls++;
      const ak = String(r.account_id||'Unknown');
      if(!byAccount.has(ak)) byAccount.set(ak, empty());
      byAccount.get(ak).calls++;
      const tk = String(r.telco||'Unknown');
      if(!byTelco.has(tk)) byTelco.set(tk, empty());
      byTelco.get(tk).calls++;
      continue;
    }

    const billed = billedSecondsOf(raw, cfg.firstBlock, cfg.nextBlock, !cfg.onlyConnected);
    const add = (m, k)=>{
      if(!m.has(k)) m.set(k, empty());
      const o = m.get(k);
      o.calls++; if(billed>0) o.billedCalls++;
      o.rawSec += raw; o.billedSec += billed;
    };
    totals.calls++; if(billed>0) totals.billedCalls++;
    totals.rawSec += raw; totals.billedSec += billed;
    add(byPeriod,  billingPeriodKey(r, cfg.groupBy));
    add(byAccount, String(r.account_id||'Unknown'));
    add(byTelco,   String(r.telco||'Unknown'));

    detail.push({
      start_stamp: r.start_stamp, account_id: r.account_id,
      caller_id_number: r.caller_id_number, destination_number: r.destination_number,
      telco: r.telco, hangup_cause: r.hangup_cause, connType: r.connType,
      duration: r.duration, billsec: raw, billed_sec: billed,
      billed_min: +(billed/60).toFixed(4),
      // Lưu ý: cột cost là cước của riêng cuộc này (đã làm tròn tiền);
      // tổng cước của kỳ được tính từ tổng giây nên có thể lệch vài đồng so với tổng cột này.
      cost: roundMoney(billed/60*cfg.rate, cfg.roundStep)
    });
  }

  const finish = (o)=>({
    ...o,
    diffSec: o.billedSec - o.rawSec,
    minutes: +(o.billedSec/60).toFixed(2),
    cost: roundMoney(o.billedSec/60*cfg.rate, cfg.roundStep)
  });
  const toSorted = (m, byCost)=> Array.from(m.entries())
    .map(([k,v])=>({key:k, ...finish(v)}))
    .sort((a,b)=> byCost ? (b.billedSec-a.billedSec) : String(a.key).localeCompare(String(b.key)));

  return {
    periods: toSorted(byPeriod, false),
    accounts: toSorted(byAccount, true),
    telcos: toSorted(byTelco, true),
    totals: finish(totals),
    detail
  };
}

// Bách phân vị (nội suy tuyến tính) của mảng số đã sắp xếp tăng dần.
function __quantileSorted(sorted, q){
  const n = sorted.length;
  if(!n) return 0;
  if(n === 1) return sorted[0];
  const pos = (n - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Dự đoán cước cuối tháng theo thứ trong tuần.
 *   Dự đoán = Cước thực tế (ngày 1 → D)
 *           + Phần còn lại của ngày D (nếu CDR dừng trước 23h: TB giờ h+1..23 các ngày cùng thứ)
 *           + Σ ước tính ngày D+1..cuối tháng (TB cùng thứ trong 28 ngày trước D;
 *             < 2 mẫu cùng thứ -> TB mọi ngày trong 7 ngày gần nhất)
 *   Khoảng thấp – cao: thay trung bình bằng P20 / P80 của cùng các mẫu.
 * Tính trên giây tính cước (billedSec) rồi mới quy ra tiền -> khớp tổng thành tiền.
 * Tháng dự đoán = tháng của cfg.endDate (không có thì tháng của dữ liệu mới nhất).
 * D, "ngày có dữ liệu" và giờ cuối được xác định trên TOÀN BỘ CDR (không theo
 * account/telco) để account ít gọi không bị hiểu nhầm là dữ liệu tải thiếu.
 */
function computeBillingForecast(rows, cfg, opts){
  const o = opts || {};
  const Q_LOW = o.qLow ?? 0.2, Q_HIGH = o.qHigh ?? 0.8;
  const LOOKBACK = o.lookbackDays ?? 28, FALLBACK = o.fallbackDays ?? 7, MIN_SAMPLES = o.minSamples ?? 2;
  const PARTIAL_BEFORE_HOUR = o.partialBeforeHour ?? 23;
  const src = rows || [];
  const addDays = (iso, n)=>{ const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return localISODate(d); };

  let month = /^\d{4}-\d{2}/.test(String(cfg.endDate||'')) ? String(cfg.endDate).slice(0,7) : '';
  if(!month){
    let max = '';
    for(const r of src){ const d = String(r.start_stamp||'').slice(0,10); if(d > max) max = d; }
    month = max.slice(0,7);
  }
  if(!/^\d{4}-\d{2}$/.test(month)) return {status:'no-data', month:''};
  const [yy, mm] = month.split('-').map(Number);
  const daysInMonth = new Date(yy, mm, 0).getDate();
  const monthStart = month + '-01';
  const monthEnd = month + '-' + String(daysInMonth).padStart(2,'0');
  const windowStart = addDays(monthStart, -(LOOKBACK + 2));

  const covered = new Set();          // ngày có CDR (toàn bộ, không lọc)
  const daySec = new Map();           // ngày -> giây tính cước (đã lọc account/telco)
  const hourSec = new Map();          // ngày -> Float64Array(24)
  let lastStamp = '';                 // cuộc gọi muộn nhất trong tháng (toàn bộ)
  const chargeZero = !cfg.onlyConnected;
  for(const r of src){
    const s = String(r.start_stamp||'');
    const d = s.slice(0,10);
    if(d < windowStart || d > monthEnd) continue;
    covered.add(d);
    if(d >= monthStart && s > lastStamp) lastStamp = s;
    if(cfg.account && String(r.account_id)!==cfg.account) continue;
    if(cfg.telco && String(r.telco)!==cfg.telco) continue;
    const billed = billedSecondsOf(r.billsec, cfg.firstBlock, cfg.nextBlock, chargeZero);
    if(!billed) continue;
    daySec.set(d, (daySec.get(d)||0) + billed);
    let h = hourSec.get(d);
    if(!h){ h = new Float64Array(24); hourSec.set(d, h); }
    const hr = parseInt(s.slice(11,13), 10);
    if(hr >= 0 && hr < 24) h[hr] += billed;
  }
  if(!lastStamp) return {status:'no-data', month, daysInMonth};

  const lastDate = lastStamp.slice(0,10);
  const lastHour = parseInt(lastStamp.slice(11,13), 10) || 0;
  const partialLastDay = lastHour < PARTIAL_BEFORE_HOUR;
  let firstCovered = '';
  for(const d of covered) if(d >= monthStart && (!firstCovered || d < firstCovered)) firstCovered = d;
  const missingMonthStart = firstCovered > monthStart;

  // Mẫu lịch sử: ngày có CDR trong LOOKBACK ngày kết thúc tại D (bỏ D nếu D chưa hết ngày).
  const histEnd = partialLastDay ? addDays(lastDate, -1) : lastDate;
  const histStart = addDays(histEnd, -(LOOKBACK - 1));
  const recentStart = addDays(histEnd, -(FALLBACK - 1));
  const history = [];
  for(let d = histStart; d <= histEnd; d = addDays(d, 1)){
    if(covered.has(d)) history.push({date:d, wd:weekdayIndex(d), sec:daySec.get(d)||0});
  }
  const samplesFor = (wd)=>{
    const same = history.filter(h=>h.wd===wd);
    if(same.length >= MIN_SAMPLES) return {list:same, fallback:false};
    return {list:history.filter(h=>h.date >= recentStart), fallback:true};
  };
  const stats = (vals)=>{
    const sorted = vals.slice().sort((a,b)=>a-b);
    const mean = sorted.length ? sorted.reduce((a,b)=>a+b,0) / sorted.length : 0;
    return {mid:mean, low:__quantileSorted(sorted, Q_LOW), high:__quantileSorted(sorted, Q_HIGH), n:sorted.length};
  };

  let actualSec = 0;
  for(const [d, v] of daySec) if(d >= monthStart && d <= lastDate) actualSec += v;

  let remainder = null;
  if(partialLastDay){
    const wd = weekdayIndex(lastDate);
    const sm = samplesFor(wd);
    const vals = sm.list.map(h=>{
      const arr = hourSec.get(h.date);
      let t = 0; if(arr) for(let i = lastHour + 1; i < 24; i++) t += arr[i];
      return t;
    });
    remainder = {date:lastDate, weekday:wd, fromHour:lastHour + 1, fallback:sm.fallback, ...stats(vals)};
  }

  const days = [];
  for(let d = addDays(lastDate, 1); d <= monthEnd; d = addDays(d, 1)){
    const wd = weekdayIndex(d);
    const sm = samplesFor(wd);
    days.push({date:d, weekday:wd, fallback:sm.fallback, ...stats(sm.list.map(h=>h.sec))});
  }

  const sumOf = k => days.reduce((a,x)=>a + x[k], 0) + (remainder ? remainder[k] : 0);
  const secs = {mid:actualSec + sumOf('mid'), low:actualSec + sumOf('low'), high:actualSec + sumOf('high')};
  const money = sec => roundMoney(sec/60*cfg.rate, cfg.roundStep);
  const status = !history.length ? 'no-history' : 'ok';
  return {
    status, month, daysInMonth, monthStart, monthEnd,
    lastStamp, lastDate, lastHour, partialLastDay,
    firstCovered, missingMonthStart,
    historyDays: history.length, histStart, histEnd,
    remainingDays: days.length,
    complete: !days.length && !partialLastDay,
    actualSec, actualCost: money(actualSec),
    remainder, days,
    forecastSec: secs,
    forecastCost: {mid:money(secs.mid), low:money(secs.low), high:money(secs.high)}
  };
}

function __ccuIntervals(rows, scope){
  const list = []; let derivedEnd = 0;
  const keep = (scope==='occupied')
    ? (r=> Number(r.duration||0) > 0 || Number(r.billsec||0) > 0)
    : isConnectedStrict;
  for(const r of (rows||[])){
    if(!keep(r)) continue;

    let s = (r.start_ts!==undefined && r.start_ts!==null) ? Number(r.start_ts)
          : Date.parse(String(r.start_stamp||'').replace(' ','T'));
    if(!isFinite(s)) continue;

    let e = (r.end_ts!==undefined && r.end_ts!==null) ? Number(r.end_ts)
          : Date.parse(String(r.end_stamp||'').replace(' ','T'));
    if(!isFinite(e) || e<=s){
      // Không có end dùng được -> suy từ độ dài cuộc gọi.
      const d = Number(r.duration||0) || Number(r.billsec||0);
      if(!(d>0)) continue;
      e = s + d*1000;
    }
    if(!(e>s)) continue;

    if(r.__end_derived) derivedEnd++;
    list.push({s, e, r});
  }
  return {list, derivedEnd};
}

function __computeConcurrency(rows, keyFn, scope){
  const {list, derivedEnd} = __ccuIntervals(rows, scope);
  const changes = new Map();          // ms -> [{k, d}]
  const keySet = new Set();
  const erlangSec = Object.create(null);

  for(const it of list){
    const k = String(keyFn(it.r));
    keySet.add(k);
    erlangSec[k] = (erlangSec[k]||0) + (it.e - it.s)/1000;
    if(!changes.has(it.s)) changes.set(it.s, []);
    if(!changes.has(it.e)) changes.set(it.e, []);
    changes.get(it.s).push({k, d:+1});
    changes.get(it.e).push({k, d:-1});
  }

  const keys  = Array.from(keySet).sort();
  const times = Array.from(changes.keys()).sort((a,b)=> a-b);
  const series = Object.create(null);  // key -> {y:[]}  (dùng chung trục xISO)
  const cur = Object.create(null), peaks = Object.create(null), peakAt = Object.create(null);
  keys.forEach(k=>{ series[k]={y:[]}; cur[k]=0; peaks[k]=0; peakAt[k]=null; });

  const xISO = [], totalY = [];
  let systemPeak = 0, systemPeakAt = null, systemPeakIdx = -1;

  for(let i=0;i<times.length;i++){
    const t = times[i];
    // Cộng dồn hết sự kiện tại mốc t TRƯỚC khi chốt giá trị & so peak.
    for(const ev of changes.get(t)) cur[ev.k] = (cur[ev.k]||0) + ev.d;

    xISO.push(localISODateTime(t));
    let tot = 0;
    for(const k of keys){
      const v = cur[k]||0;
      series[k].y.push(v);
      tot += v;
      if(v > peaks[k]){ peaks[k] = v; peakAt[k] = t; }
    }
    totalY.push(tot);
    if(tot > systemPeak){ systemPeak = tot; systemPeakAt = t; systemPeakIdx = i; }
  }

  // CCU của từng khoá tại ĐÚNG thời điểm hệ thống đạt đỉnh — đây mới là
  // "tỷ trọng lúc căng nhất". Cộng peak riêng lẻ của các khoá là vô nghĩa
  // vì chúng xảy ra ở những thời điểm khác nhau.
  const atSystemPeak = Object.create(null);
  keys.forEach(k=>{ atSystemPeak[k] = systemPeakIdx>=0 ? series[k].y[systemPeakIdx] : 0; });

  const totalErlangSec = keys.reduce((s,k)=> s + (erlangSec[k]||0), 0);

  return {
    times, xISO, keys, series, totalY,
    peaks, peakAt, systemPeak, systemPeakAt, atSystemPeak,
    erlangSec, totalErlangSec,
    observedSpanSec: times.length>1 ? (times[times.length-1]-times[0])/1000 : 0,
    derivedEnd, calls: list.length, scope: scope||'answered'
  };
}

function computeCcuByTelco(rows, opts){
  // opts.byTelco: kết quả __computeConcurrency(rows, getTelco, scope) đã tính
  // sẵn (buildCube) -> khỏi quét lại cả triệu cuộc lần nữa.
  const res = (opts && opts.byTelco) || __computeConcurrency(rows, getTelco, (opts && opts.scope) || 'answered');
  const filterSpan = (opts && opts.filterSpanSec != null) ? opts.filterSpanSec : null;
  const stats = res.keys.map(tel=>{
    const ys = res.series[tel].y;
    // Tích phân CCU theo thời gian = tổng thời lượng chiếm kênh của telco.
    let weightedSec = 0;
    for(let i=0;i<res.times.length-1;i++){
      weightedSec += (ys[i]||0) * (res.times[i+1]-res.times[i]) / 1000;
    }
    const at = res.peakAt[tel];
    return {
      telco: tel,
      peak: res.peaks[tel]||0,
      peakAtISO: at!=null ? localISODateTime(at) : null,
      avgFilter:   filterSpan ? weightedSec/filterSpan : null,
      avgObserved: res.observedSpanSec ? weightedSec/res.observedSpanSec : 0,
      atSystemPeak: res.atSystemPeak[tel]||0,
      atSystemPeakPct: res.systemPeak ? (res.atSystemPeak[tel]||0)*100/res.systemPeak : 0,
      loadPct: res.totalErlangSec ? (res.erlangSec[tel]||0)*100/res.totalErlangSec : 0,
      erlangSec: res.erlangSec[tel]||0
    };
  });
  stats.sort((a,b)=> b.peak - a.peak || b.loadPct - a.loadPct);
  // Trả {stats, meta} thay vì gắn .meta lên mảng — structured-clone (worker) sẽ
  // mất property phụ trên Array, nên phải để meta ở khoá riêng.
  return {
    stats,
    meta: {
      systemPeak: res.systemPeak,
      systemPeakAtISO: res.systemPeakAt!=null ? localISODateTime(res.systemPeakAt) : null,
      filterSpanSec: filterSpan,
      observedSpanSec: res.observedSpanSec,
      derivedEnd: res.derivedEnd,
      calls: res.calls
    }
  };
}

/* ==========================================================================
   [SECTION] CID LIFECYCLE — vòng đời Block/Reactive của CID.

   Nguồn: trang MPT `routing/reports` (xem scripts/routing_events.py).
   Điểm mấu chốt: MPT khoá ở cấp **(CID × Routing × nhà mạng đích)**, KHÔNG
   phải cấp CID. Một số có thể đang bị VT chặn mà vẫn gọi MB bình thường —
   mọi phép tính dưới đây đều giữ nguyên độ mịn đó.

   Ngữ nghĩa sự kiện: Block = MPT gắn cờ nghi ngờ; Reactive = tool tự mở lại.
   Quy ước vận hành có HAI mốc, không phải một:
     - quá 24h chưa Reactive -> `atRisk`      (đỏ, cần để mắt)
     - quá 48h chưa Reactive -> `presumedDead` (coi như nhà mạng đã khoá thật)
   Tách hai mốc vì đo trên dữ liệu thật, một phần đáng kể số bị đỏ vẫn quay lại
   sau đó. `lateRecovery` giữ lại phần quy tắc đếm nhầm để sai số của nó luôn
   nhìn thấy được thay vì bị làm tròn thành "chết".
   ========================================================================== */

const CID_DEAD_AFTER_MIN = 2880;  // 48h — coi như chết
const CID_WARN_AFTER_MIN = 1440;  // 24h — chuyển đỏ, chưa kết luận chết

function parseEventTs(v){
  if(v==null) return null;
  if(typeof v==='number') return isFinite(v)? v : null;
  const t = Date.parse(String(v).replace(' ','T'));
  return isNaN(t)? null : t;
}

/** Khoá trạng thái = đúng độ mịn mà MPT khoá. */
function cidStateKey(cid, routing, telco){
  return String(cid||'')+'|'+String(routing||'')+'|'+String(telco||'');
}

function __mkInterval(open, closeTs, closeActor, windowEnd, deadAfterMin, warnAfterMin){
  const recovered = closeTs != null;
  const end = recovered ? closeTs : windowEnd;
  const durationMin = Math.max(0, (end - open.blockedFrom) / 60000);
  return {
    cid: open.cid, routing: open.routing, telco: open.telco,
    blockedFrom: open.blockedFrom,
    blockedTo: recovered ? closeTs : null,
    blockActor: open.actor || '',
    reactiveActor: recovered ? (closeActor||'') : '',
    durationMin,
    recovered,
    censored: !recovered,                                   // chưa mở lại tính đến cuối cửa sổ
    atRisk: !recovered && durationMin >= warnAfterMin,       // quá 24h -> đỏ
    presumedDead: !recovered && durationMin >= deadAfterMin, // quá 48h -> coi như chết
    lateRecovery: recovered && durationMin > deadAfterMin,   // quay lại SAU mốc chết
    recoveredAfterWarn: recovered && durationMin > warnAfterMin // đã đỏ nhưng vẫn quay lại
  };
}

/**
 * Dựng chuỗi khoảng BỊ KHOÁ từ log sự kiện.
 * @param {Array} events  [{cid, routing, telco, ts, kind:'block'|'reactive', actor}]
 * @returns {{intervals:Array, orphanReactive:number, windowEnd:number}}
 */
function buildCidTimeline(events, opts){
  const o = opts || {};
  const deadAfterMin = o.deadAfterMin != null ? o.deadAfterMin : CID_DEAD_AFTER_MIN;
  const warnAfterMin = o.warnAfterMin != null ? o.warnAfterMin : CID_WARN_AFTER_MIN;
  // Ngưỡng gộp reactive ghi lặp theo lô. Đo trên 60 ngày thật: 584 cặp cách
  // nhau ≤2s, 13 cặp 3-10s, rồi đứt hẳn — nên 10s tách sạch nhiễu lô khỏi các
  // lần mở lại thật (p10 của MTTR là 1,5 giờ).
  const collapseMs = (o.collapseReactiveSec != null ? o.collapseReactiveSec : 10) * 1000;
  const byKey = new Map();
  let maxTs = 0;

  (events||[]).forEach(ev=>{
    const cid = String(ev && ev.cid || '');
    const ts = parseEventTs(ev && ev.ts);
    const kind = String(ev && ev.kind || '');
    if(!cid || ts==null || (kind!=='block' && kind!=='reactive')) return;
    if(ts > maxTs) maxTs = ts;
    const k = cidStateKey(cid, ev.routing, ev.telco);
    if(!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push({ ts, kind, actor: ev.actor||'',
                        cid, routing: ev.routing||'', telco: ev.telco||'' });
  });

  const windowEnd = o.windowEnd != null ? o.windowEnd : (maxTs || Date.now());
  const intervals = [];
  let orphanReactive = 0;

  byKey.forEach(arr=>{
    // cùng giây thì block đứng trước reactive, nếu không sẽ sinh khoảng âm
    arr.sort((a,b)=> a.ts - b.ts || (a.kind===b.kind ? 0 : (a.kind==='block' ? -1 : 1)));
    let open = null;
    let lastReactiveTs = null;
    for(const e of arr){
      if(e.kind === 'block'){
        if(!open) open = { cid:e.cid, routing:e.routing, telco:e.telco,
                           blockedFrom:e.ts, actor:e.actor };
        // block lặp khi đang mở -> bỏ qua, giữ mốc đầu tiên
        lastReactiveTs = null;
      } else {
        if(open){
          intervals.push(__mkInterval(open, e.ts, e.actor, windowEnd, deadAfterMin, warnAfterMin));
          open = null;
        } else if(lastReactiveTs != null && (e.ts - lastReactiveTs) <= collapseMs){
          // Tool ghi reactive theo lô nên cùng một lần mở lại bị ghi 2 dòng cách
          // nhau ~1s. Dòng thứ hai không phải orphan thật -> nuốt đi, nếu không
          // chỉ số chẩn đoán orphan sẽ bị thổi lên gấp mấy lần.
        } else {
          orphanReactive++;  // block xảy ra TRƯỚC cửa sổ -> không dựng lại được
        }
        lastReactiveTs = e.ts;
      }
    }
    if(open) intervals.push(__mkInterval(open, null, '', windowEnd, deadAfterMin, warnAfterMin));
  });

  intervals.sort((a,b)=> a.blockedFrom - b.blockedFrom);
  return { intervals, orphanReactive, windowEnd };
}

/** Hợp nhất các khoảng chồng nhau -> tổng thời gian bị khoá không đếm trùng. */
function mergeIntervalsMs(list){
  const arr = (list||[]).slice().sort((a,b)=> a[0]-b[0]);
  const out = [];
  for(const iv of arr){
    const last = out[out.length-1];
    if(last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else out.push([iv[0], iv[1]]);
  }
  return out;
}

/**
 * Duty cycle theo (CID × nhà mạng): sống bao nhiêu % thời gian trong cửa sổ.
 * Nhiều routing dùng chung một CID thì khoảng khoá được HỢP NHẤT, không cộng dồn.
 */
function computeCidDutyCycle(timeline, opts){
  const o = opts || {};
  const ivs = (timeline && timeline.intervals) || [];
  const end = o.windowEnd != null ? o.windowEnd : (timeline && timeline.windowEnd) || Date.now();
  const start = o.windowStart != null ? o.windowStart
    : (ivs.length ? ivs[0].blockedFrom : end);
  const span = Math.max(1, end - start);

  const byKey = new Map();
  ivs.forEach(iv=>{
    const k = iv.cid+'|'+iv.telco;
    if(!byKey.has(k)) byKey.set(k, { cid:iv.cid, telco:iv.telco, routings:new Set(),
                                     spans:[], blockCount:0, recoveredMin:[],
                                     atRisk:0, presumedDead:0, lateRecovery:0,
                                     lastBlockedFrom:0 });
    const rec = byKey.get(k);
    const from = Math.max(start, iv.blockedFrom);
    const to = Math.min(end, iv.blockedTo != null ? iv.blockedTo : end);
    if(to > from) rec.spans.push([from, to]);
    rec.routings.add(iv.routing);
    rec.blockCount += 1;
    if(iv.recovered) rec.recoveredMin.push(iv.durationMin);
    if(iv.atRisk) rec.atRisk += 1;
    if(iv.presumedDead) rec.presumedDead += 1;
    if(iv.lateRecovery) rec.lateRecovery += 1;
    if(iv.blockedFrom > rec.lastBlockedFrom) rec.lastBlockedFrom = iv.blockedFrom;
  });

  const out = [];
  byKey.forEach(rec=>{
    const merged = mergeIntervalsMs(rec.spans);
    const blockedMs = merged.reduce((s,iv)=> s + (iv[1]-iv[0]), 0);
    const mttrMin = rec.recoveredMin.length
      ? rec.recoveredMin.reduce((a,b)=>a+b,0) / rec.recoveredMin.length : null;
    out.push({
      cid: rec.cid, telco: rec.telco,
      routings: Array.from(rec.routings).sort(),
      blockCount: rec.blockCount,
      blockedHours: blockedMs/3600000,
      uptimePct: Math.max(0, 100 * (1 - blockedMs/span)),
      mttrMin,
      atRisk: rec.atRisk,
      presumedDead: rec.presumedDead,
      lateRecovery: rec.lateRecovery,
      currentlyBlocked: merged.some(iv=> iv[1] >= end),
      lastBlockedFromISO: localISODateTime(rec.lastBlockedFrom)
    });
  });
  out.sort((a,b)=> a.uptimePct - b.uptimePct || b.blockCount - a.blockCount);
  return out;
}

/**
 * Chuỗi thời gian số CID đang bị khoá, theo nhà mạng.
 *
 * CẢNH BÁO MẪU SỐ: log block chỉ chứa CID ĐÃ TỪNG bị khoá — số chưa bao giờ bị
 * khoá không xuất hiện. Nên mẫu số mặc định là CẬN DƯỚI, và tỷ lệ % tính từ nó
 * sẽ BI QUAN hơn thực tế. Truyền `universeByTelco` (đếm từ CDR — số thật sự
 * đang dùng) để có tỷ lệ đúng; khi không có, `universeIsLowerBound` = true để
 * giao diện nói rõ điều đó thay vì im lặng vẽ một con số sai.
 */
function computeCidAvailability(timeline, opts){
  const o = opts || {};
  const ivs = (timeline && timeline.intervals) || [];
  const end = o.windowEnd != null ? o.windowEnd : (timeline && timeline.windowEnd) || Date.now();
  const universeGiven = o.universeByTelco || null;

  const seen = {};      // telco -> Set(cid) thấy trong log
  const deltas = {};    // telco -> [[ts, +1|-1]]
  ivs.forEach(iv=>{
    const t = iv.telco || 'Unknown';
    (seen[t] || (seen[t] = new Set())).add(iv.cid);
    (deltas[t] || (deltas[t] = [])).push([iv.blockedFrom, 1]);
    // Khoảng CHƯA mở lại thì không phát mốc đóng: nó vẫn đang khoá tại `end`.
    // Đóng nó ở `end` sẽ kéo đường khả dụng vọt về 100% đúng điểm cuối — sai.
    if(iv.blockedTo != null) deltas[t].push([iv.blockedTo, -1]);
  });

  const series = {};
  Object.keys(deltas).forEach(t=>{
    const ds = deltas[t].sort((a,b)=> a[0]-b[0] || a[1]-b[1]);
    const universe = (universeGiven && universeGiven[t]) || seen[t].size;
    const times = [], blocked = [], availablePct = [];
    let cur = 0;
    for(let i=0;i<ds.length;i++){
      cur += ds[i][1];
      // gộp các mốc trùng thời điểm thành một điểm
      if(i+1 < ds.length && ds[i+1][0] === ds[i][0]) continue;
      times.push(ds[i][0]);
      blocked.push(cur);
      availablePct.push(universe ? Math.max(0, 100*(1 - cur/universe)) : 100);
    }
    series[t] = {
      times, blocked, availablePct,
      universe,
      universeIsLowerBound: !(universeGiven && universeGiven[t]),
      peakBlocked: blocked.length ? Math.max.apply(null, blocked) : 0
    };
  });
  return series;
}

/**
 * Chuẩn hoá CID về dạng nội địa `0...` — bản JS của `normalize_cid` bên
 * scripts/routing_events.py. Phải khớp nhau, nếu không phép nối sẽ hụt âm thầm.
 * Nguồn có 4 dạng: `02479929887`, `0916407599`, `842471060319`, `919362764`.
 */
function normalizeCidNational(raw){
  let d = String(raw == null ? '' : raw).replace(/\D/g, '');
  if(!d) return '';
  if(d.startsWith('84')) d = '0' + d.slice(2);
  else if(!d.startsWith('0')) d = '0' + d;
  return d;
}

/**
 * Suy bản đồ Routing (log block) <-> Account (CDR) qua CID dùng chung.
 *
 * Hai bên là hai namespace khác nhau (`SIP_MTC_AUTOCALL` vs `Mcredit_AutoCallTHN`)
 * nên chỉ nối được gián tiếp qua CID.
 *
 * `uncoveredAccounts` là phần QUAN TRỌNG NHẤT: account có mặt trong CDR nhưng
 * không chia sẻ CID nào với routing nào. Với chúng, "0 block" KHÔNG có nghĩa là
 * tốt — chỉ có nghĩa là ta không quan sát được. Giao diện phải nói *ngoài phạm
 * vi theo dõi*, không được vẽ chúng như số liệu 0.
 */
function deriveRoutingAccountMap(events, cdrRows, opts){
  const o = opts || {};
  const minShare = o.minShare != null ? o.minShare : 0.6;

  const cidToRoutings = new Map();
  (events||[]).forEach(ev=>{
    const cid = normalizeCidNational(ev && ev.cid);
    const routing = String(ev && ev.routing || '');
    if(!cid || !routing) return;
    if(!cidToRoutings.has(cid)) cidToRoutings.set(cid, new Set());
    cidToRoutings.get(cid).add(routing);
  });

  const cidToAccounts = new Map();
  const allAccounts = new Set();
  (cdrRows||[]).forEach(r=>{
    const cid = normalizeCidNational(r && r.caller_id_number);
    const acc = String((r && (r.account_name || r.account_id)) || '').trim();
    if(!acc) return;
    allAccounts.add(acc);
    if(!cid) return;
    if(!cidToAccounts.has(cid)) cidToAccounts.set(cid, new Set());
    cidToAccounts.get(cid).add(acc);
  });

  // Map long thay vi khoa ghep chuoi: ten routing that co chua dau cach
  // (vd "HNI_Duoc Thai Minh_VBN") nen moi ky tu phan tach deu co nguy co va cham.
  const pairCount = new Map();        // routing -> Map(account -> so CID chung)
  const routingTotal = new Map();     // routing -> tong luot khop
  const coveredAccounts = new Set();
  let matchedCids = 0;

  cidToRoutings.forEach((routings, cid)=>{
    const accounts = cidToAccounts.get(cid);
    if(!accounts) return;
    matchedCids++;
    routings.forEach(routing=>{
      if(!pairCount.has(routing)) pairCount.set(routing, new Map());
      const inner = pairCount.get(routing);
      accounts.forEach(acc=>{
        inner.set(acc, (inner.get(acc)||0) + 1);
        routingTotal.set(routing, (routingTotal.get(routing)||0) + 1);
        coveredAccounts.add(acc);
      });
    });
  });

  const byRoutingMap = new Map();
  pairCount.forEach((inner, routing)=>{
    const cands = [];
    inner.forEach((count, account)=>{
      cands.push({ account, sharedCids: count,
                   share: count / (routingTotal.get(routing) || 1) });
    });
    byRoutingMap.set(routing, cands);
  });

  const byRouting = [];
  byRoutingMap.forEach((cands, routing)=>{
    cands.sort((a,b)=> b.sharedCids - a.sharedCids);
    const top = cands[0];
    byRouting.push({
      routing,
      account: top.account,
      sharedCids: top.sharedCids,
      share: top.share,
      ambiguous: cands.length > 1 && top.share < minShare,
      candidates: cands
    });
  });
  byRouting.sort((a,b)=> b.sharedCids - a.sharedCids);

  return {
    byRouting,
    uncoveredAccounts: Array.from(allAccounts).filter(a=> !coveredAccounts.has(a)).sort(),
    unmatchedRoutings: Array.from(cidToRoutings.values()).length
      ? Array.from(new Set(Array.from(cidToRoutings.values()).flatMap(s=> Array.from(s))))
          .filter(r=> !byRoutingMap.has(r)).sort()
      : [],
    stats: {
      eventCids: cidToRoutings.size,
      cdrCids: cidToAccounts.size,
      matchedCids,
      accounts: allAccounts.size,
      coveredAccounts: coveredAccounts.size
    }
  };
}

/**
 * Mã nhà mạng đích của log block (VT/MB/VN/OT) từ tên telco trong CDR.
 *
 * Ba hệ ký hiệu phải quy về một: CDR bản cũ `Viettel/Mobi/Vina`, bản mới
 * `VIETTEL/VINA/MOBI/FIXED`, log block `VT/MB/VN/OT`. `OT` là nhóm gộp của
 * nguồn nên mọi nhà mạng còn lại (Vietnamobile, Itel, cố định...) đều về OT —
 * mất chi tiết, nhưng đó là độ mịn mà log block có.
 */
function telcoBlockCode(raw){
  const n = normalizeTelcoName(raw);
  if(n === 'Viettel') return 'VT';
  if(n === 'MobiFone') return 'MB';
  if(n === 'VinaPhone') return 'VN';
  if(n === 'Unknown') return '';
  return 'OT';
}

/**
 * Thu hẹp nguồn sự kiện CID theo bộ lọc account_id của dashboard.
 * Account và Routing là hai namespace; nối bằng tên trùng chính xác và bổ sung
 * bảng mapping account_id -> routing_id/routing_name do người dùng cấu hình.
 */
function filterCidScope(input){
  const o = input || {};
  const selectedIds = (o.selectedAccountIds || []).map(String);
  const accountsAll = o.accounts || [];
  const routingsAll = o.routings || [];
  const eventsAll = o.events || [];
  const mappingRows = o.mappingRows || [];
  if(!selectedIds.length){
    return { filtered:false, accounts:accountsAll, routings:routingsAll,
             events:eventsAll, routingNames:routingsAll.map(r=>String(r.name||'')).filter(Boolean),
             unmappedAccounts:[] };
  }

  const selected = new Set(selectedIds);
  const accounts = selectedIds.map(id=>
    accountsAll.find(a=>String(a.id)===id) || { id, name:id });
  const routingIds = new Set();
  const routingNames = new Set(accounts.map(a=>String(a.name||'')).filter(Boolean));
  const mappedAccountIds = new Set();
  mappingRows.forEach(r=>{
    const accountId = String(r && r.account_id || '');
    if(!selected.has(accountId)) return;
    if(r.routing_id) routingIds.add(String(r.routing_id));
    if(r.routing_name) routingNames.add(String(r.routing_name));
    if(r.routing_id || r.routing_name) mappedAccountIds.add(accountId);
  });
  const routings = routingsAll.filter(r=>
    routingIds.has(String(r.id||'')) || routingNames.has(String(r.name||'')));
  routings.forEach(r=>{ if(r.name) routingNames.add(String(r.name)); });
  accounts.forEach(a=>{
    if(routingsAll.some(r=>String(r.name||'')===String(a.name||'')))
      mappedAccountIds.add(String(a.id));
  });
  const events = eventsAll.filter(ev=>routingNames.has(String(ev && ev.routing || '')));
  return {
    filtered:true, accounts, routings, events, routingNames:Array.from(routingNames),
    unmappedAccounts:accounts.filter(a=>!mappedAccountIds.has(String(a.id)))
  };
}

/**
 * A6 — phủ sóng theo dõi: nối Routing (log block) với Account (danh sách của
 * profile) bằng TÊN CHÍNH XÁC.
 *
 * Đo trên dữ liệu thật: 23/23 routing có account trùng tên tuyệt đối, nên đây
 * là phép nối trực tiếp chứ không phải suy luận. `deriveRoutingAccountMap`
 * (suy qua CID dùng chung) được giữ lại làm phép đối chiếu cho phần lệch.
 *
 * Bốn nhóm, và ranh giới giữa `observedClean` với `unobservable` là điểm cốt lõi:
 *   - observedClean   : có routing, 0 sự kiện -> "0 block" là SỰ THẬT
 *   - unobservable    : không có routing nào -> "0 block" chỉ là KHÔNG THẤY
 * Gộp hai nhóm này lại là khen nhầm khách hàng mà ta không quan sát được.
 */
function buildCidCoverage(input){
  const o = input || {};
  const routings = o.routings || [];
  const accounts = o.accounts || [];
  const events = o.events || [];

  const routingByName = new Map();
  routings.forEach(r=>{ if(r && r.name) routingByName.set(String(r.name), r); });
  const accountByName = new Map();
  accounts.forEach(a=>{ if(a && a.name) accountByName.set(String(a.name), a); });

  const stat = new Map();   // routing name -> {events, cids:Set}
  events.forEach(ev=>{
    const name = String(ev && ev.routing || '');
    if(!name) return;
    if(!stat.has(name)) stat.set(name, { events:0, cids:new Set() });
    const s = stat.get(name);
    s.events += 1;
    if(ev.cid) s.cids.add(ev.cid);
  });

  const observedWithBlocks = [], observedClean = [], unobservable = [], routingWithoutAccount = [];

  accountByName.forEach((acc, name)=>{
    const routing = routingByName.get(name);
    if(!routing){ unobservable.push({ name, accountId: acc.id }); return; }
    const s = stat.get(name);
    if(s) observedWithBlocks.push({ name, accountId: acc.id, routingId: routing.id,
                                    events: s.events, cids: s.cids.size });
    else observedClean.push({ name, accountId: acc.id, routingId: routing.id });
  });
  routingByName.forEach((routing, name)=>{
    if(!accountByName.has(name)){
      const s = stat.get(name);
      routingWithoutAccount.push({ name, routingId: routing.id,
                                   events: s ? s.events : 0 });
    }
  });

  const byEvents = (a,b)=> (b.events||0) - (a.events||0) || a.name.localeCompare(b.name);
  observedWithBlocks.sort(byEvents);
  routingWithoutAccount.sort(byEvents);
  observedClean.sort((a,b)=> a.name.localeCompare(b.name));
  unobservable.sort((a,b)=> a.name.localeCompare(b.name));

  return {
    observedWithBlocks, observedClean, unobservable, routingWithoutAccount,
    stats: {
      routings: routingByName.size,
      accounts: accountByName.size,
      withBlocks: observedWithBlocks.length,
      clean: observedClean.length,
      unobservable: unobservable.length,
      // routing có sự kiện nhưng không có trong dropdown -> log và dropdown lệch nhau
      eventRoutingsNotListed: Array.from(stat.keys()).filter(n=> !routingByName.has(n)).sort()
    }
  };
}

/**
 * B1 — cuộc gọi phát sinh khi (CID × nhà mạng) đang ở trạng thái bị khoá.
 *
 * Ban đầu dựng để tự kiểm timeline ("phải bằng 0"). Dữ liệu thật cho thấy giả
 * định đó sai, và cái sai lại hữu ích — phải TÁCH hai nhóm, gộp lại là gây
 * hiểu nhầm:
 *
 *   - trong khoảng ĐÃ MỞ LẠI  : 62,3% kết nối (cao hơn cả nền 55,7%)
 *       -> Block chỉ là cờ nghi ngờ của MPT, không chặn route. Vô hại.
 *   - trong khoảng CHƯA MỞ LẠI: 0,0% kết nối trên 300 cuộc
 *       -> Số đã chết thật, mà hệ thống vẫn nã cuộc gọi vào. Đây là lãng phí.
 *
 * Chính vì hai nhóm khác nhau tối đa mà đây đồng thời là phép kiểm chứng
 * timeline: timeline sai thì chúng đã trông giống nhau.
 */
function computeRoutingLeaks(timeline, cdrRows, opts){
  const o = opts || {};
  const ivs = (timeline && timeline.intervals) || [];
  const end = o.windowEnd != null ? o.windowEnd : (timeline && timeline.windowEnd) || Date.now();

  const idx = new Map();    // cid|telcoCode -> [[from, to, routing, censored], ...]
  ivs.forEach(iv=>{
    const k = iv.cid + '|' + (iv.telco || '');
    if(!idx.has(k)) idx.set(k, []);
    idx.get(k).push([iv.blockedFrom, iv.blockedTo != null ? iv.blockedTo : end,
                     iv.routing, iv.censored]);
  });
  idx.forEach(list=> list.sort((a,b)=> a[0]-b[0]));

  // Cộng dồn tại chỗ thay vì dựng mảng `hits`: trên dữ liệu thật mảng đó lên tới
  // 74.339 phần tử / 19,2 MB mà giao diện KHÔNG hiển thị phần tử nào — panel chỉ
  // đọc số đếm và tỷ lệ. Giữ nó lại là trả giá bộ nhớ (và chi phí structured
  // clone nếu chạy trong worker) cho dữ liệu không ai xem.
  // `sampleLimit` cho phép giữ vài dòng ví dụ khi cần soi.
  const sampleLimit = o.sampleLimit != null ? o.sampleLimit : 0;
  const sample = [];
  const inClosed = { calls:0, connected:0 };
  const inCensored = { calls:0, connected:0 };
  // Nền cũng tích luỹ billsec ở đây luôn để `computeDeadNumberLoss` không phải
  // quét lại toàn bộ CDR lần nữa (đo được: quét lại tốn thêm ~1,6 giây).
  const outside = { calls:0, connected:0, billsec:0 };
  const telcoTally = new Map(), routingTally = new Map();
  let checked = 0, skipped = 0, hitCount = 0;

  (cdrRows||[]).forEach(r=>{
    const cid = normalizeCidNational(r && r.caller_id_number);
    const code = telcoBlockCode(getTelco(r));
    const ts = r && r.start_ts != null ? r.start_ts : parseEventTs(r && r.start_stamp);
    if(!cid || !code || ts == null){ skipped++; return; }
    checked++;
    const connected = isConnectedStrict(r);
    const billsec = Number(r.billsec)||0;
    const list = idx.get(cid + '|' + code);
    let found = null;
    if(list){
      for(const [from, to, routing, censored] of list){
        if(ts < from) break;      // đã sắp xếp -> các khoảng sau còn muộn hơn
        if(ts < to){ found = { from, routing, censored }; break; }
      }
    }
    if(!found){
      outside.calls++;
      if(connected){ outside.connected++; outside.billsec += billsec; }
      return;
    }
    hitCount++;
    const bucket = found.censored ? inCensored : inClosed;
    bucket.calls++;
    if(connected) bucket.connected++;
    telcoTally.set(code, (telcoTally.get(code)||0) + 1);
    routingTally.set(found.routing, (routingTally.get(found.routing)||0) + 1);
    if(sample.length < sampleLimit){
      sample.push({
        cid, telco: code, routing: found.routing, censored: found.censored,
        callTs: ts, callISO: localISODateTime(ts),
        blockedFromISO: localISODateTime(found.from),
        minutesIntoBlock: (ts - found.from)/60000,
        hangup_cause: r.hangup_cause || '', billsec, connected
      });
    }
  });

  const group = g => ({ calls: g.calls, connected: g.connected,
                        connectRate: g.calls ? 100*g.connected/g.calls : 0 });
  const tally = (m, key)=> Array.from(m, ([k,v])=> ({ [key]: k, count: v }))
    .sort((a,b)=> b.count - a.count);

  return {
    hitCount, sample, checked, skipped,
    hitRate: checked ? hitCount / checked : 0,
    // Vô hại: block đã được mở lại, cuộc gọi vẫn chạy bình thường.
    inClosed: group(inClosed),
    // Lãng phí: số đã chết theo quy tắc mà vẫn bị quay số.
    inCensored: group(inCensored),
    // Nền để so sánh — không có nó thì hai số trên không đọc được.
    outside: Object.assign(group(outside), {
      billsec: outside.billsec,
      avgBillsec: outside.connected ? outside.billsec/outside.connected : 0
    }),
    wastedCalls: inCensored.calls,
    byTelco: tally(telcoTally, 'telco'),
    byRouting: tally(routingTally, 'routing')
  };
}

/**
 * A4 — áp lực chặn theo ngày: đếm lượt Block mỗi ngày, tách theo nhà mạng, kèm
 * trung bình trượt 7 ngày.
 *
 * Chỉ đếm `block` chứ không đếm `reactive`: reactive là phản ứng của tool, gộp
 * vào sẽ làm đường áp lực nhân đôi một cách vô nghĩa.
 */
function computeBlockPressure(events, opts){
  const o = opts || {};
  const days = o.days && o.days.length ? o.days.slice() : null;
  const byDay = new Map();          // day -> Map(telco -> count)
  const telcos = new Set();

  (events||[]).forEach(ev=>{
    if(!ev || ev.kind !== 'block') return;
    const day = String(ev.ts || '').slice(0, 10);
    if(!day) return;
    const t = ev.telco || 'Unknown';
    telcos.add(t);
    if(!byDay.has(day)) byDay.set(day, new Map());
    const m = byDay.get(day);
    m.set(t, (m.get(t)||0) + 1);
  });

  const axis = days || Array.from(byDay.keys()).sort();
  const series = {};
  Array.from(telcos).sort().forEach(t=>{
    series[t] = axis.map(d=> (byDay.get(d) && byDay.get(d).get(t)) || 0);
  });
  const total = axis.map(d=>{
    const m = byDay.get(d);
    if(!m) return 0;
    let n = 0; m.forEach(v=> n += v); return n;
  });

  // Trung bình trượt 7 ngày — cửa sổ chưa đủ 7 ngày thì để null thay vì chia
  // cho số ngày ít hơn (làm đầu đường cong vọt lên một cách giả tạo).
  const ma7 = total.map((_, i)=>{
    if(i < 6) return null;
    let sum = 0;
    for(let k = i-6; k <= i; k++) sum += total[k];
    return sum/7;
  });

  const nonZero = total.filter(v=> v > 0);
  return {
    days: axis, byTelco: series, total, ma7,
    peak: total.length ? Math.max.apply(null, total) : 0,
    peakDay: total.length ? axis[total.indexOf(Math.max.apply(null, total))] : null,
    mean: nonZero.length ? nonZero.reduce((a,b)=>a+b,0)/nonZero.length : 0,
    quietDays: total.filter(v=> v === 0).length
  };
}

/**
 * A5 — phát hiện đợt càn quét: cụm Block dồn vào một khoảng ngắn.
 *
 * Nhiều CID bị khoá trong vài phút là sự cố/chính sách phía nhà mạng, KHÔNG
 * phải hành vi của từng số — phản ứng phải khác hẳn, nên phải tách ra khỏi nền.
 *
 * Ngưỡng dùng median + k·MAD thay vì trung bình + k·độ lệch chuẩn: chính các
 * đợt càn quét sẽ thổi phồng độ lệch chuẩn và tự che mất mình. MAD kháng ngoại
 * lai nên không bị vậy. Kèm sàn tuyệt đối để ngày vắng không sinh báo động giả.
 */
function computeBlockBursts(events, opts){
  const o = opts || {};
  const bucketMin = o.bucketMinutes != null ? o.bucketMinutes : 5;
  const k = o.k != null ? o.k : 6;
  const minCount = o.minCount != null ? o.minCount : 8;
  const bucketMs = bucketMin * 60000;

  const buckets = new Map();        // bucketStart -> {cids:Set, routings:Set, telcos:Map}
  (events||[]).forEach(ev=>{
    if(!ev || ev.kind !== 'block') return;
    const ts = parseEventTs(ev.ts);
    if(ts == null) return;
    const start = Math.floor(ts / bucketMs) * bucketMs;
    if(!buckets.has(start)) buckets.set(start, { cids:new Set(), routings:new Set(), telcos:new Map(), n:0 });
    const b = buckets.get(start);
    b.n += 1;
    if(ev.cid) b.cids.add(ev.cid);
    if(ev.routing) b.routings.add(ev.routing);
    const t = ev.telco || 'Unknown';
    b.telcos.set(t, (b.telcos.get(t)||0) + 1);
  });
  if(!buckets.size) return { bursts: [], threshold: 0, median: 0, mad: 0,
                             thresholdSource: 'floor', bucketMinutes: bucketMin };

  const counts = Array.from(buckets.values(), b=> b.n).sort((a,b)=> a-b);
  const med = arr => arr.length % 2 ? arr[(arr.length-1)/2]
                                    : (arr[arr.length/2 - 1] + arr[arr.length/2]) / 2;
  const median = med(counts);
  const mad = med(counts.map(v=> Math.abs(v - median)).sort((a,b)=> a-b));
  // Phân bố lệch mạnh (phần lớn lát chỉ 0-2 sự kiện) nên MAD thường bằng 0 —
  // khi đó ngưỡng thống kê sụp về median và sẽ gắn cờ mọi thứ. Sàn tuyệt đối
  // tiếp quản, và `thresholdSource` nói rõ ngưỡng đến từ đâu để người đọc không
  // tưởng đây là một ngưỡng thống kê chặt chẽ.
  const statThreshold = median + k * mad;
  const threshold = Math.max(minCount, statThreshold);
  const thresholdSource = statThreshold >= minCount ? 'mad' : 'floor';

  const bursts = [];
  buckets.forEach((b, start)=>{
    if(b.n < threshold) return;
    const telcos = Array.from(b.telcos, ([telco, count])=> ({ telco, count }))
      .sort((x,y)=> y.count - x.count);
    bursts.push({
      startTs: start, startISO: localISODateTime(start),
      bucketMinutes: bucketMin,
      blocks: b.n, cids: b.cids.size,
      routings: Array.from(b.routings).sort(),
      telcos,
      // gấp bao nhiêu lần nền — con số này mới nói được mức độ bất thường
      xMedian: median ? b.n / median : null
    });
  });
  bursts.sort((a,b)=> b.blocks - a.blocks);
  return { bursts, threshold, median, mad, thresholdSource, bucketMinutes: bucketMin };
}

/**
 * B2 — tổn thất do quay số vào CID đã chết.
 *
 * KHÔNG ước lượng theo kiểu "năng suất nền × thời gian treo". B1 cho thấy trong
 * khoảng đã mở lại không mất gì (62,3% kết nối, cao hơn cả nền), còn trong
 * khoảng chưa mở lại thì cuộc gọi VẪN được bấm — chỉ là 0% kết nối. Nên thứ mất
 * đi không phải lượt gọi mà là KẾT NỐI đáng lẽ có:
 *
 *     kết nối mất = số lượt đã bấm vào số chết × tỷ lệ kết nối nền
 *     phút mất    = kết nối mất × billsec trung bình nền
 *
 * Cả hai tham số nền đều đo từ chính tập dữ liệu đang lọc (các cuộc NGOÀI cửa
 * sổ khoá), nên đây là phép nội suy chứ không phải giả định từ bên ngoài.
 */
function computeDeadNumberLoss(timeline, cdrRows, opts){
  const o = opts || {};
  // `computeRoutingLeaks` đã phân loại xong từng cuộc và tích luỹ sẵn nhóm nền,
  // nên KHÔNG quét lại CDR ở đây. Trước đây quét lại tốn thêm ~1,6 giây trên
  // 832k dòng và cho ra đúng những con số ấy.
  const leaks = o.leaks || computeRoutingLeaks(timeline, cdrRows, o);

  const baseCalls = leaks.outside.calls;
  const baseConnectRate = baseCalls ? leaks.outside.connected / baseCalls : 0;
  const baseAvgBillsec = leaks.outside.avgBillsec || 0;
  const wastedCalls = leaks.inCensored.calls;
  const lostConnections = wastedCalls * baseConnectRate;
  const lostBillsec = lostConnections * baseAvgBillsec;

  let money = null;
  if(o.billing && o.billing.rate){
    const cfg = o.billing;
    const billedPer = billedSecondsOf(baseAvgBillsec, cfg.firstBlock, cfg.nextBlock, false);
    money = roundMoney(lostConnections * billedPer / 60 * cfg.rate, cfg.roundStep);
  }

  return {
    wastedCalls,
    wastedCallPct: leaks.checked ? 100 * wastedCalls / leaks.checked : 0,
    baseCalls, baseConnectRate: 100 * baseConnectRate, baseAvgBillsec,
    lostConnections, lostMinutes: lostBillsec / 60, money,
    // Đủ mẫu nền thì con số mới đáng tin; thiếu thì giao diện phải nói rõ.
    reliable: baseCalls >= (o.minBaseCalls != null ? o.minBaseCalls : 200) && wastedCalls > 0
  };
}

/* Chỉ mục khoảng bị khoá theo (CID × nhà mạng), đã sắp xếp — dùng chung cho
   các phép hỏi "lúc T số này có đang bị khoá không". */
function __blockIndex(timeline){
  const idx = new Map();
  ((timeline && timeline.intervals) || []).forEach(iv=>{
    const k = iv.cid + '|' + iv.telco;
    if(!idx.has(k)) idx.set(k, []);
    idx.get(k).push(iv);
  });
  idx.forEach(list=> list.sort((a,b)=> a.blockedFrom - b.blockedFrom));
  return idx;
}
function __blockedAt(list, ts, windowEnd){
  for(const iv of (list||[])){
    if(ts < iv.blockedFrom) return false;          // đã sắp xếp
    const to = iv.blockedTo != null ? iv.blockedTo : windowEnd;
    if(ts < to) return true;
  }
  return false;
}

/**
 * B3 — tải trên mỗi CID/ngày so với rủi ro bị khoá.
 *
 * Mỗi quan sát là một (CID × nhà mạng × ngày): hôm đó gọi bao nhiêu cuộc, và
 * trong `horizonHours` sau cuộc cuối cùng có bị khoá không.
 *
 * LOẠI TRỪ những ngày mà CID ĐANG bị khoá sẵn tại thời điểm cuộc gọi cuối. Số
 * đang khoá thì không thể bị khoá thêm lần nữa, nhưng vẫn phát sinh cuộc gọi
 * (B1: 300 cuộc vào số đã chết) — giữ chúng lại sẽ bơm một đống quan sát
 * "gọi nhiều mà không bị khoá" và làm mọi mức tải trông an toàn hơn thực tế.
 */
function computeLoadVsBlockRisk(timeline, cdrRows, opts){
  const o = opts || {};
  const horizonMs = (o.horizonHours != null ? o.horizonHours : 24) * 3600000;
  const edges = o.edges || [1, 5, 10, 20, 40, 80, 160];
  const windowEnd = o.windowEnd != null ? o.windowEnd
                  : (timeline && timeline.windowEnd) || Date.now();
  const idx = __blockIndex(timeline);

  const cells = new Map();   // cid|telco|day
  (cdrRows||[]).forEach(r=>{
    const cid = normalizeCidNational(r && r.caller_id_number);
    const code = telcoBlockCode(getTelco(r));
    const ts = r && r.start_ts != null ? r.start_ts : parseEventTs(r && r.start_stamp);
    if(!cid || !code || ts == null) return;
    const day = r.date || dateKey(r.start_stamp);
    const k = cid + '|' + code + '|' + day;
    if(!cells.has(k)) cells.set(k, { cid, telco: code, day, calls: 0, minutes: 0, lastTs: 0 });
    const c = cells.get(k);
    c.calls += 1;
    c.minutes += (Number(r.billsec)||0)/60;
    if(ts > c.lastTs) c.lastTs = ts;
  });

  // So sánh cùng loại: chỉ giữ CID đã từng bị khoá ít nhất một lần. Nếu không,
  // các bậc tải thấp sẽ đầy CID chưa bao giờ bị khoá và sinh ra một đường cong
  // liều-đáp-ứng ĐẸP NHƯNG GIẢ — thứ chênh lệch đo được khi đó là thành phần
  // mẫu, không phải ảnh hưởng của tải.
  const eligibleOnly = !!o.eligibleOnly;

  const obs = [];
  let excludedAlreadyBlocked = 0, excludedNoRoom = 0, excludedNeverBlocked = 0;
  cells.forEach(c=>{
    const list = idx.get(c.cid + '|' + c.telco);
    if(eligibleOnly && !list){ excludedNeverBlocked++; return; }
    if(__blockedAt(list, c.lastTs, windowEnd)){ excludedAlreadyBlocked++; return; }
    // Không đủ chỗ quan sát hết horizon -> bỏ, nếu không sẽ đếm thiếu ca bị khoá
    if(c.lastTs + horizonMs > windowEnd){ excludedNoRoom++; return; }
    let blocked = false;
    for(const iv of (list||[])){
      if(iv.blockedFrom > c.lastTs && iv.blockedFrom <= c.lastTs + horizonMs){ blocked = true; break; }
    }
    obs.push({ cid: c.cid, telco: c.telco, day: c.day, calls: c.calls,
               minutes: c.minutes, blocked });
  });

  const bounds = [];
  for(let i = 0; i < edges.length; i++){
    bounds.push([edges[i], i + 1 < edges.length ? edges[i+1] : Infinity]);
  }
  const buckets = bounds.map(([lo, hi])=>{
    const inB = obs.filter(x=> x.calls >= lo && x.calls < hi);
    const blocked = inB.filter(x=> x.blocked).length;
    return {
      label: hi === Infinity ? `${lo}+` : `${lo}–${hi-1}`,
      lo, hi, cidDays: inB.length, blocked,
      blockRate: inB.length ? 100*blocked/inB.length : null,
      medianCalls: inB.length
        ? inB.map(x=> x.calls).sort((a,b)=> a-b)[Math.floor(inB.length/2)] : null
    };
  });
  const overall = obs.length ? 100*obs.filter(x=> x.blocked).length/obs.length : 0;
  buckets.forEach(b=> b.lift = (b.blockRate != null && overall) ? b.blockRate/overall : null);

  return {
    buckets, observations: obs.length, overallBlockRate: overall,
    excludedAlreadyBlocked, excludedNoRoom, excludedNeverBlocked, eligibleOnly,
    horizonHours: horizonMs/3600000,
    // Cỡ mẫu nhỏ thì tỷ lệ theo bucket dao động rất mạnh — giao diện phải nói ra.
    minBucket: buckets.reduce((m,b)=> Math.min(m, b.cidDays || Infinity), Infinity)
  };
}

/**
 * Dựng các cửa sổ CASE (ngay trước mỗi lần Block) và CONTROL (không bị khoá,
 * không có Block theo sau) cho cùng một CID × nhà mạng. Dùng chung cho B4 và
 * cho thống kê tổ hợp tín hiệu — hai bên phải định nghĩa cửa sổ y hệt nhau,
 * nếu không thì không so sánh được với nhau.
 */
function __precursorWindows(timeline, cdrRows, o, winMs, windowEnd){
  const idx = __blockIndex(timeline);
  const byKey = new Map();
  (cdrRows||[]).forEach(r=>{
    const cid = normalizeCidNational(r && r.caller_id_number);
    const code = telcoBlockCode(getTelco(r));
    const ts = r && r.start_ts != null ? r.start_ts : parseEventTs(r && r.start_stamp);
    if(!cid || !code || ts == null) return;
    const k = cid + '|' + code;
    if(!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push({ ts, connected: isConnectedStrict(r), billsec: Number(r.billsec)||0,
                        dest: String(r.destination_number||''), cause: r.hangup_cause||'' });
  });
  byKey.forEach(list=> list.sort((a,b)=> a.ts - b.ts));

  const slice = (list, from, to)=> list.filter(c=> c.ts >= from && c.ts < to);
  const caseWindows = [], controlWindows = [];
  byKey.forEach((list, k)=>{
    const ivs = idx.get(k) || [];
    ivs.forEach(iv=>{
      const w = slice(list, iv.blockedFrom - winMs, iv.blockedFrom);
      if(w.length) caseWindows.push(w);
    });
    if(!list.length) return;
    const first = list[0].ts, last = list[list.length-1].ts;
    for(let t = first + winMs; t <= last; t += winMs){
      if(__blockedAt(ivs, t, windowEnd)) continue;
      if(ivs.some(iv=> iv.blockedFrom > t && iv.blockedFrom <= t + winMs)) continue;
      const w = slice(list, t - winMs, t);
      if(w.length) controlWindows.push(w);
    }
  });
  return { caseWindows, controlWindows };
}

/**
 * Bản công khai của `__precursorWindows` để trang dựng MỘT LẦN rồi truyền vào
 * cả `computeBlockPrecursors` lẫn `computeBlockSignalPatterns` qua `opts.windows`.
 */
function buildPrecursorWindows(timeline, cdrRows, opts){
  const o = opts || {};
  const winMs = (o.windowHours != null ? o.windowHours : 6) * 3600000;
  const windowEnd = o.windowEnd != null ? o.windowEnd
                  : (timeline && timeline.windowEnd) || Date.now();
  return __precursorWindows(timeline, cdrRows, o, winMs, windowEnd);
}

function __percentile(sorted, p){
  if(!sorted.length) return null;
  const i = Math.min(sorted.length-1, Math.max(0, Math.ceil(sorted.length*p/100) - 1));
  return sorted[i];
}

/**
 * Thống kê "nguyên tắc" ĐƠN / KÉP đi trước mỗi lần khoá số.
 *
 * Ba tín hiệu, mỗi tín hiệu bật/tắt:
 *   1. `cause`    — tỷ trọng cuộc bị thuê bao từ chối/không nghe (nhóm
 *                   NoAnswer_Hangup_cause) cao bất thường
 *   2. `duration` — thời lượng kết nối trung bình thấp bất thường
 *   3. `frequency`— tần suất quay số của chính CID đó cao bất thường
 *
 * ĐƠN = đúng 1 tín hiệu bật, KÉP = 2, BA = cả 3.
 *
 * NGƯỠNG "bất thường" lấy từ PHÂN VỊ CỦA NHÓM ĐỐI CHỨNG, không đặt tay: nếu
 * đặt tay thì con số % sau đó chỉ phản ánh lựa chọn ngưỡng của mình.
 *
 * Và luôn tính song song cho cả nhóm đối chứng: "70% lần khoá đi trước bởi tín
 * hiệu kép" chẳng nói lên gì nếu 70% cửa sổ bình thường cũng vậy. `lift` mới là
 * con số đáng đọc.
 */
function computeBlockSignalPatterns(timeline, cdrRows, opts){
  const o = opts || {};
  const winMs = (o.windowHours != null ? o.windowHours : 6) * 3600000;
  const windowEnd = o.windowEnd != null ? o.windowEnd
                  : (timeline && timeline.windowEnd) || Date.now();
  const hiPct = o.hiPercentile != null ? o.hiPercentile : 80;
  const loPct = o.loPercentile != null ? o.loPercentile : 20;
  const minCases = o.minCases != null ? o.minCases : 30;

  // Dùng lại cửa sổ đã dựng nếu người gọi truyền vào: `computeBlockPrecursors`
  // và `computeBlockSignalPatterns` cần y hệt một tập cửa sổ, dựng hai lần là
  // trả giá gấp đôi cho cùng một công việc.
  const { caseWindows, controlWindows } = o.windows
    || __precursorWindows(timeline, cdrRows, o, winMs, windowEnd);
  const winHours = winMs/3600000;

  const feat = w=>{
    const con = w.filter(c=> c.connected);
    const rejected = w.filter(c=> NoAnswer_Hangup_cause.has(String(c.cause||'').toUpperCase())).length;
    return {
      causeShare: 100*rejected/w.length,
      // Không có cuộc nào nối được thì thời lượng coi như 0 — đó là trạng thái
      // xấu nhất, không phải "thiếu dữ liệu".
      avgBillsec: con.length ? con.reduce((s,c)=> s+c.billsec, 0)/con.length : 0,
      callsPerHour: w.length/winHours
    };
  };
  const caseF = caseWindows.map(feat);
  const ctrlF = controlWindows.map(feat);
  if(!caseF.length || !ctrlF.length){
    return { windowHours: winHours, cases: caseF.length, controls: ctrlF.length,
             insufficientSample: true, minCases, thresholds: null,
             distribution: [], combos: [] };
  }

  const sortNum = a => a.slice().sort((x,y)=> x-y);
  const thresholds = {
    causeShareHi: __percentile(sortNum(ctrlF.map(f=> f.causeShare)), hiPct),
    avgBillsecLo: __percentile(sortNum(ctrlF.map(f=> f.avgBillsec)), loPct),
    callsPerHourHi: __percentile(sortNum(ctrlF.map(f=> f.callsPerHour)), hiPct),
    hiPercentile: hiPct, loPercentile: loPct
  };
  // Ngưỡng thời lượng bằng 0 nghĩa là >=loPct% cửa sổ đối chứng KHÔNG nối được
  // cuộc nào. Khi đó tín hiệu "thời lượng" không còn là "cuộc ngắn bất thường"
  // mà thành "không có cuộc nào nối được" — một thứ khác hẳn. Phải báo ra, nếu
  // không người đọc sẽ hiểu sai ý nghĩa của con số.
  thresholds.durationDegenerate = !(thresholds.avgBillsecLo > 0);
  const flagsOf = f=> ({
    cause: f.causeShare >= thresholds.causeShareHi,
    duration: f.avgBillsec <= thresholds.avgBillsecLo,
    frequency: f.callsPerHour >= thresholds.callsPerHourHi
  });
  const NAMES = { cause:'Nguyên nhân rớt', duration:'Thời lượng kết nối', frequency:'Tần suất quay số' };
  const KEYS = ['cause','duration','frequency'];

  const tallyOf = arr=>{
    const byCount = [0,0,0,0];
    const byCombo = new Map();
    arr.forEach(f=>{
      const fl = flagsOf(f);
      const on = KEYS.filter(k=> fl[k]);
      byCount[on.length] += 1;
      const key = on.length ? on.join('+') : '(không)';
      byCombo.set(key, (byCombo.get(key)||0) + 1);
    });
    return { byCount, byCombo, n: arr.length };
  };
  const C = tallyOf(caseF), K = tallyOf(ctrlF);

  const LABEL = ['Không tín hiệu nào', 'Đơn (1 tín hiệu)', 'Kép (2 tín hiệu)', 'Cả 3 tín hiệu'];
  const distribution = [0,1,2,3].map(i=>{
    const casePct = 100*C.byCount[i]/C.n, controlPct = 100*K.byCount[i]/K.n;
    return { signals: i, label: LABEL[i],
             cases: C.byCount[i], casePct,
             controls: K.byCount[i], controlPct,
             lift: controlPct ? casePct/controlPct : null };
  });

  const comboKeys = new Set([...C.byCombo.keys(), ...K.byCombo.keys()]);
  const combos = Array.from(comboKeys).map(key=>{
    const c = C.byCombo.get(key)||0, k = K.byCombo.get(key)||0;
    const casePct = 100*c/C.n, controlPct = 100*k/K.n;
    return { combo: key,
             label: key === '(không)' ? 'Không tín hiệu nào'
                                      : key.split('+').map(x=> NAMES[x]).join(' + '),
             signals: key === '(không)' ? 0 : key.split('+').length,
             cases: c, casePct, controls: k, controlPct,
             lift: controlPct ? casePct/controlPct : null };
  }).sort((a,b)=> b.casePct - a.casePct);

  return {
    windowHours: winHours, cases: C.n, controls: K.n,
    minCases, insufficientSample: C.n < minCases,
    thresholds, distribution, combos, signalNames: NAMES
  };
}

/**
 * B4 — chân dung trước khi bị khoá (NGHIÊN CỨU, không phải báo cáo bảo đảm).
 *
 * Với mỗi lần Block, đo hành vi của chính CID đó trong `windowHours` trước đó;
 * đối chứng là các cửa sổ cùng độ dài của CÙNG CID nhưng không có Block theo
 * sau. So sánh từng chỉ số.
 *
 * Kết quả hợp lệ bao gồm cả "không chỉ số nào phân biệt được" — khi đó KHÔNG
 * được dựng mô hình chấm điểm lên trên, vì nó sẽ trông rất thuyết phục mà sai.
 */
function computeBlockPrecursors(timeline, cdrRows, opts){
  const o = opts || {};
  const winMs = (o.windowHours != null ? o.windowHours : 24) * 3600000;
  const windowEnd = o.windowEnd != null ? o.windowEnd
                  : (timeline && timeline.windowEnd) || Date.now();
  const idx = __blockIndex(timeline);

  // Dùng lại cửa sổ đã dựng nếu người gọi truyền vào: `computeBlockPrecursors`
  // và `computeBlockSignalPatterns` cần y hệt một tập cửa sổ, dựng hai lần là
  // trả giá gấp đôi cho cùng một công việc.
  const { caseWindows, controlWindows } = o.windows
    || __precursorWindows(timeline, cdrRows, o, winMs, windowEnd);

  const featurize = calls=>{
    if(!calls || !calls.length) return null;
    const con = calls.filter(c=> c.connected);
    const dests = new Set(calls.map(c=> c.dest).filter(Boolean));
    const busy = calls.filter(c=> c.cause === 'USER_BUSY' || c.cause === 'CALL_REJECTED').length;
    const noAns = calls.filter(c=> c.cause === 'NO_USER_RESPONSE' || c.cause === 'NO_ANSWER').length;
    return {
      calls: calls.length,
      connectRate: 100*con.length/calls.length,
      avgBillsec: con.length ? con.reduce((s,c)=> s+c.billsec, 0)/con.length : 0,
      shortCallRate: con.length ? 100*con.filter(c=> c.billsec < 10).length/con.length : 0,
      distinctDest: dests.size,
      repeatRate: dests.size ? calls.length/dests.size : 0,
      busyRejectRate: 100*busy/calls.length,
      noAnswerRate: 100*noAns/calls.length
    };
  };
  const cases = caseWindows.map(featurize).filter(Boolean);
  const controls = controlWindows.map(featurize).filter(Boolean);

  const METRICS = ['calls','connectRate','avgBillsec','shortCallRate',
                   'distinctDest','repeatRate','busyRejectRate','noAnswerRate'];
  const mean = (arr, m)=> arr.length ? arr.reduce((s,x)=> s + x[m], 0)/arr.length : null;
  const median = (arr, m)=>{
    if(!arr.length) return null;
    const v = arr.map(x=> x[m]).sort((a,b)=> a-b);
    return v[Math.floor(v.length/2)];
  };
  const sd = (arr, m, mu)=> arr.length > 1
    ? Math.sqrt(arr.reduce((s,x)=> s + Math.pow(x[m]-mu, 2), 0)/(arr.length-1)) : 0;

  const metrics = METRICS.map(m=>{
    const cMu = mean(cases, m), kMu = mean(controls, m);
    const cSd = sd(cases, m, cMu||0), kSd = sd(controls, m, kMu||0);
    // Cohen's d gộp — đo mức tách BẰNG ĐỘ LỆCH CHUẨN, không phải bằng % chênh.
    // Chênh 50% trên một chỉ số nhiễu loạn thì vô dụng; d mới nói được điều đó.
    const pooled = Math.sqrt(((cases.length-1)*cSd*cSd + (controls.length-1)*kSd*kSd)
                             / Math.max(1, cases.length + controls.length - 2));
    const d = pooled ? (cMu - kMu)/pooled : 0;
    return { metric: m, caseMean: cMu, controlMean: kMu,
             caseMedian: median(cases, m), controlMedian: median(controls, m),
             cohensD: d, absD: Math.abs(d) };
  }).sort((a,b)=> b.absD - a.absD);

  const strong = metrics.filter(x=> x.absD >= 0.5);
  const minCases = o.minCases != null ? o.minCases : 30;
  // BA kết luận, không phải hai. "Mẫu quá nhỏ" khác hẳn "đã đo và không thấy gì":
  // gộp chúng lại sẽ sinh ra câu "không chỉ số nào đạt ngưỡng" ngay bên cạnh một
  // bảng đầy chỉ số vượt ngưỡng — mâu thuẫn ngay trên màn hình.
  const insufficientSample = cases.length < minCases;
  return {
    cases: cases.length, controls: controls.length, windowHours: winMs/3600000,
    metrics, strongest: metrics[0] || null,
    minCases, insufficientSample,
    // Ngưỡng d>=0.5 (mức "trung bình" theo quy ước Cohen) — dưới mức đó thì hai
    // phân bố chồng nhau quá nhiều để dùng làm cảnh báo.
    hasSignal: strong.length > 0 && !insufficientSample,
    signalMetrics: strong.map(x=> x.metric)
  };
}

/**
 * Đếm số ngày CÓ LƯU LƯỢNG THẬT trong tập dữ liệu.
 *
 * Ngày lịch không bằng ngày có dữ liệu: đo trên dữ liệu thật, Chủ nhật gần như
 * bằng 0 và có cả dải 5 ngày gián đoạn liên tiếp. "Lấy 5 ngày gần nhất" mà rơi
 * trúng dải đó thì gần như không còn gì để phân tích — nên phải đếm ngày hoạt
 * động, không đếm ngày lịch.
 */
function countActiveDays(cdrRows, opts){
  const o = opts || {};
  const byDay = new Map();
  (cdrRows||[]).forEach(r=>{
    const d = (r && r.date) || dateKey(r && r.start_stamp);
    if(!d || d === 'Unknown') return;
    byDay.set(d, (byDay.get(d)||0) + 1);
  });
  const days = Array.from(byDay, ([day, calls])=> ({ day, calls })).sort((a,b)=> a.day.localeCompare(b.day));
  if(!days.length) return { calendarDays: 0, activeDays: 0, deadDays: [], days: [], median: 0 };
  // Ngưỡng "ngày chết" tương đối với chính tập dữ liệu: dưới 10% ngày trung vị.
  const sorted = days.map(x=> x.calls).sort((a,b)=> a-b);
  const median = sorted[Math.floor(sorted.length/2)];
  const floor = o.minCalls != null ? o.minCalls : Math.max(1, median*0.1);
  const dead = days.filter(x=> x.calls < floor);
  return {
    calendarDays: days.length,
    activeDays: days.length - dead.length,
    deadDays: dead.map(x=> x.day),
    days, median, floor
  };
}

/**
 * B4 theo TỪNG ACCOUNT.
 *
 * Gộp nhiều account có kiểu quay số khác nhau làm loãng mất tín hiệu: đo trên
 * dữ liệu thật, gộp 2 account thì không chỉ số nào đạt |d| >= 0,5, nhưng tách
 * riêng một account thì có. Nên đây mới là cách đọc đúng, không phải bản gộp.
 */
function computeSignalsByAccount(timeline, cdrRows, opts){
  const o = opts || {};
  const groups = new Map();
  (cdrRows||[]).forEach(r=>{
    const acc = String((r && (r.account_name || r.account_id)) || 'Unknown').trim() || 'Unknown';
    if(!groups.has(acc)) groups.set(acc, []);
    groups.get(acc).push(r);
  });

  const rows = [];
  groups.forEach((accRows, account)=>{
    // Dựng cửa sổ MỘT lần rồi dùng cho cả hai phép phân tích của account này.
    const windows = buildPrecursorWindows(timeline, accRows, o);
    const shared = Object.assign({}, o, { windows });
    const pre = computeBlockPrecursors(timeline, accRows, shared);
    const sig = computeBlockSignalPatterns(timeline, accRows, shared);
    const top = pre.metrics && pre.metrics.length ? pre.metrics[0] : null;
    const enriched = (sig.combos||[])
      .filter(c=> c.signals > 0 && c.lift != null && c.casePct >= 3)
      .sort((a,b)=> b.lift - a.lift)[0] || null;
    const act = countActiveDays(accRows);
    rows.push({
      account, calls: accRows.length,
      activeDays: act.activeDays, calendarDays: act.calendarDays,
      cases: pre.cases, controls: pre.controls,
      insufficientSample: pre.insufficientSample,
      hasSignal: pre.hasSignal,
      topMetric: top ? top.metric : null,
      topD: top ? top.cohensD : null,
      signalMetrics: pre.signalMetrics || [],
      topCombo: enriched ? enriched.label : null,
      topComboLift: enriched ? enriched.lift : null,
      topComboPct: enriched ? enriched.casePct : null
    });
  });
  rows.sort((a,b)=> b.cases - a.cases);
  return { accounts: rows, windowHours: o.windowHours != null ? o.windowHours : 6,
           minCases: o.minCases != null ? o.minCases : 30 };
}

/** Phân bố thời gian hồi phục + phần sai của quy tắc 24h. */
function computeBlockMttr(timeline, opts){
  const o = opts || {};
  const deadAfterMin = o.deadAfterMin != null ? o.deadAfterMin : CID_DEAD_AFTER_MIN;
  const warnAfterMin = o.warnAfterMin != null ? o.warnAfterMin : CID_WARN_AFTER_MIN;
  const ivs = (timeline && timeline.intervals) || [];
  const rec = ivs.filter(iv=> iv.recovered).map(iv=> iv.durationMin).sort((a,b)=> a-b);
  const pct = p => rec.length ? rec[Math.min(rec.length-1, Math.max(0, Math.ceil(rec.length*p/100)-1))] : null;
  const byTelco = {};
  ivs.forEach(iv=>{
    const t = iv.telco || 'Unknown';
    const b = byTelco[t] || (byTelco[t] = { telco:t, total:0, recovered:0, atRisk:0,
                                            presumedDead:0, lateRecovery:0, sumMin:0 });
    b.total += 1;
    if(iv.recovered){ b.recovered += 1; b.sumMin += iv.durationMin; }
    if(iv.atRisk) b.atRisk += 1;
    if(iv.presumedDead) b.presumedDead += 1;
    if(iv.lateRecovery) b.lateRecovery += 1;
  });
  Object.values(byTelco).forEach(b=>{ b.mttrMin = b.recovered ? b.sumMin/b.recovered : null; });
  return {
    count: ivs.length,
    recovered: rec.length,
    stillBlocked: ivs.filter(iv=> iv.censored).length,
    // đỏ = quá 24h chưa mở lại (bao gồm cả nhóm đã quá 48h)
    atRisk: ivs.filter(iv=> iv.atRisk).length,
    // đỏ NHƯNG chưa tới mốc chết — nhóm còn cứu được
    atRiskNotDead: ivs.filter(iv=> iv.atRisk && !iv.presumedDead).length,
    presumedDead: ivs.filter(iv=> iv.presumedDead).length,
    lateRecovery: ivs.filter(iv=> iv.lateRecovery).length,
    lateRecoveryPct: rec.length ? 100*ivs.filter(iv=> iv.lateRecovery).length/rec.length : 0,
    // đã chuyển đỏ nhưng vẫn quay lại — cái giá của việc chốt cứng ở mốc 24h
    recoveredAfterWarn: ivs.filter(iv=> iv.recoveredAfterWarn).length,
    recoveredAfterWarnPct: rec.length
      ? 100*ivs.filter(iv=> iv.recoveredAfterWarn).length/rec.length : 0,
    deadAfterMin, warnAfterMin,
    p10: pct(10), p25: pct(25), p50: pct(50), p75: pct(75), p90: pct(90), p99: pct(99),
    maxMin: rec.length ? rec[rec.length-1] : null,
    byTelco: Object.values(byTelco).sort((a,b)=> b.total - a.total)
  };
}

function computeCidRecoverySurvival(timeline, thresholdsHours){
  const ivs = (timeline && timeline.intervals) || [];
  const thresholds = thresholdsHours || [1,3,6,12,24,48,72,168];
  const groups = new Map([['Tất cả', ivs]]);
  ivs.forEach(iv=>{
    const key = iv.telco || 'Unknown';
    if(!groups.has(key)) groups.set(key, []);
    groups.get(key).push(iv);
  });
  const series = [];
  groups.forEach((items,name)=>{
    const records = items.map(iv=>({time:iv.durationMin,event:!!iv.recovered})).sort((a,b)=>a.time-b.time);
    let atRisk=records.length, survival=1, pos=0;
    const values=[];
    thresholds.forEach(hour=>{
      const limit=hour*60;
      while(pos<records.length && records[pos].time<=limit){
        const time=records[pos].time;
        let recovered=0,censored=0;
        while(pos<records.length && records[pos].time===time){
          if(records[pos].event) recovered++; else censored++;
          pos++;
        }
        if(atRisk>0 && recovered) survival *= (1-recovered/atRisk);
        atRisk -= recovered+censored;
      }
      values.push(+(survival*100).toFixed(2));
    });
    series.push({name,total:items.length,thresholdsHours:thresholds.slice(),unrecoveredPct:values});
  });
  return {thresholdsHours:thresholds.slice(),series:series.sort((a,b)=>a.name==='Tất cả'?-1:b.name==='Tất cả'?1:b.total-a.total)};
}

function computeCidReblockStats(timeline, windowsHours){
  const ivs=(timeline && timeline.intervals)||[];
  const end=(timeline && timeline.windowEnd)||Date.now();
  const windows=windowsHours||[1,6,24,168];
  const byKey=new Map();
  ivs.forEach(iv=>{
    const key=cidStateKey(iv.cid,iv.routing,iv.telco);
    if(!byKey.has(key)) byKey.set(key,[]);
    byKey.get(key).push(iv);
  });
  const samples=[];
  byKey.forEach(items=>{
    items.sort((a,b)=>a.blockedFrom-b.blockedFrom);
    items.forEach((iv,index)=>{
      if(!iv.recovered) return;
      const next=items[index+1];
      samples.push({telco:iv.telco||'Unknown',recoveredAt:iv.blockedTo,
        nextDelayMin:next ? (next.blockedFrom-iv.blockedTo)/60000 : null});
    });
  });
  const summarize=(name,items)=>({
    name,recovered:items.length,
    windows:windows.map(hour=>{
      const eligible=items.filter(x=>end-x.recoveredAt>=hour*3600000);
      const reblocked=eligible.filter(x=>x.nextDelayMin!=null && x.nextDelayMin<=hour*60).length;
      return {hour,eligible:eligible.length,reblocked,ratePct:eligible.length?+(100*reblocked/eligible.length).toFixed(2):null};
    })
  });
  const groups=new Map([['Tất cả',samples]]);
  samples.forEach(s=>{ if(!groups.has(s.telco)) groups.set(s.telco,[]); groups.get(s.telco).push(s); });
  return {windowsHours:windows.slice(),rows:Array.from(groups,([name,items])=>summarize(name,items))};
}

function computeCidInventoryTrend(timeline, opts){
  const o=opts||{}, ivs=(timeline&&timeline.intervals)||[];
  if(!ivs.length) return [];
  const dayMs=86400000;
  const start=o.windowStart!=null?o.windowStart:Math.floor(ivs[0].blockedFrom/dayMs)*dayMs;
  const end=o.windowEnd!=null?o.windowEnd:(timeline.windowEnd||Date.now());
  const out=[];
  for(let day=start;day<=end;day+=dayMs){
    const dayEnd=Math.min(end,day+dayMs-1);
    const blocks=ivs.filter(iv=>iv.blockedFrom>=day&&iv.blockedFrom<=dayEnd).length;
    const recovered=ivs.filter(iv=>iv.blockedTo!=null&&iv.blockedTo>=day&&iv.blockedTo<=dayEnd).length;
    const crossed48h=ivs.filter(iv=>{
      const crossed=iv.blockedFrom+CID_DEAD_AFTER_MIN*60000;
      return iv.durationMin>=CID_DEAD_AFTER_MIN&&crossed>=day&&crossed<=dayEnd;
    }).length;
    const openKeys=new Set(ivs.filter(iv=>iv.blockedFrom<=dayEnd&&(iv.blockedTo==null||iv.blockedTo>dayEnd))
      .map(iv=>iv.cid+'|'+iv.telco));
    out.push({day:localISODate(new Date(day)),blocks,recovered,crossed48h,currentlyBlocked:openKeys.size,net:blocks-recovered});
  }
  return out;
}

function __cidCallTs(row){ return parseEventTs(row && (row.start_stamp||row.timestamp||row.date)); }
function __cidMetaByNumber(rows){
  const map=new Map();
  (rows||[]).forEach(r=>{
    const cid=normalizeCidNational(r&&r.caller_id_number);
    if(cid&&!map.has(cid)) map.set(cid,{account:String(r.account_name||r.account_id||'Unknown'),gateway:String(r.gateway||'(chưa map)')});
  });
  return map;
}

function computeCidActionQueue(timeline, rows){
  const ivs=(timeline&&timeline.intervals)||[], open=ivs.filter(iv=>!iv.recovered);
  const meta=__cidMetaByNumber(rows);
  const callsByCid=new Map();
  (rows||[]).forEach(r=>{
    const cid=normalizeCidNational(r&&r.caller_id_number), ts=__cidCallTs(r);
    if(!cid||ts==null) return;
    if(!callsByCid.has(cid)) callsByCid.set(cid,[]);
    callsByCid.get(cid).push({ts,connected:(r.connType||classifyCall(r))==='Connected'});
  });
  const baseline=(rows||[]).length?(rows||[]).filter(r=>(r.connType||classifyCall(r))==='Connected').length/(rows||[]).length:0;
  return open.map(iv=>{
    const m=meta.get(normalizeCidNational(iv.cid))||{account:'Unknown',gateway:'(chưa map)'};
    const calls=(callsByCid.get(normalizeCidNational(iv.cid))||[]).filter(x=>x.ts>=iv.blockedFrom);
    const repeats=ivs.filter(x=>x.cid===iv.cid&&x.telco===iv.telco).length;
    const ageHours=iv.durationMin/60;
    const expectedLost=Math.round(calls.length*baseline);
    const score=(iv.presumedDead?100:iv.atRisk?60:20)+Math.min(40,calls.length)+Math.min(20,(repeats-1)*5);
    return {cid:iv.cid,telco:iv.telco||'Unknown',routing:iv.routing||'',account:m.account,gateway:m.gateway,
      blockedFrom:iv.blockedFrom,blockedFromISO:localISODateTime(iv.blockedFrom),ageHours,
      callsSinceBlock:calls.length,expectedLost,reblockCount:Math.max(0,repeats-1),
      priority:iv.presumedDead||score>=120?'Khẩn cấp':score>=70?'Theo dõi':'Thấp',score};
  }).sort((a,b)=>b.score-a.score||b.ageHours-a.ageHours);
}

function computeCidDimensionComparison(timeline, rows, dimension){
  const ivs=(timeline&&timeline.intervals)||[], meta=__cidMetaByNumber(rows);
  const duty=computeCidDutyCycle(timeline);
  const groups=new Map();
  const groupForCid=cid=>{
    const m=meta.get(normalizeCidNational(cid))||{account:'Unknown',gateway:'(chưa map)'};
    return dimension==='account'?m.account:m.gateway;
  };
  const ensure=name=>{ if(!groups.has(name)) groups.set(name,{name,cids:new Set(),blocks:0,stillBlocked:0,recoveredMin:[],recovered:0,reblocked:0,uptime:[]}); return groups.get(name); };
  const byKey=new Map();
  ivs.forEach(iv=>{
    const g=ensure(groupForCid(iv.cid)); g.cids.add(iv.cid); g.blocks++;
    if(!iv.recovered) g.stillBlocked++; else g.recoveredMin.push(iv.durationMin);
    const key=cidStateKey(iv.cid,iv.routing,iv.telco);
    if(!byKey.has(key)) byKey.set(key,[]); byKey.get(key).push(iv);
  });
  byKey.forEach(items=>{
    items.sort((a,b)=>a.blockedFrom-b.blockedFrom);
    items.forEach((iv,i)=>{ if(iv.recovered){ const g=ensure(groupForCid(iv.cid)); g.recovered++; if(items[i+1]) g.reblocked++; } });
  });
  duty.forEach(d=>ensure(groupForCid(d.cid)).uptime.push(d.uptimePct));
  return Array.from(groups.values()).map(g=>{
    const sorted=g.recoveredMin.sort((a,b)=>a-b);
    return {name:g.name,cids:g.cids.size,blocks:g.blocks,stillBlocked:g.stillBlocked,
      stillBlockedPct:g.blocks?+(100*g.stillBlocked/g.blocks).toFixed(2):0,
      medianRecoveryMin:sorted.length?sorted[Math.floor(sorted.length/2)]:null,
      reblockPct:g.recovered?+(100*g.reblocked/g.recovered).toFixed(2):0,
      avgUptimePct:g.uptime.length?+(g.uptime.reduce((a,b)=>a+b,0)/g.uptime.length).toFixed(2):null};
  }).sort((a,b)=>b.stillBlockedPct-a.stillBlockedPct||b.blocks-a.blocks);
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
  enrichData, filterData, filterCallDetails, queryCallDetails, dedupByUUID,
  __aggCache, __getAgg, __getAggIfPresent, downsampleSeriesMax, downsampleSeriesMin,
  computeCallCounts, computeASRExcludingFail, computeConnectRate, computeConnectRateExcludingFail, computeBillsecMetrics, computeDestinationQualityMetrics, computeRequiredColumnHealth, computeTimeAnomalyMetrics, computeOperationalAlerts, aggregateOverview, aggByPrefix, minutesPerDay,
  computeRetryPattern, retryAggregate, computeAccountKPIs, computeTopDest, aggDestTelcoShare, aggTelcoConnBreakdown, weekdayIndex, computeTimeHeatmap, computeAnswerRateByAccountPerDay, computeGoldenHours, computeDailyPrefixStats, computeAgentPerf, computeCallbackStats, excelCellMatch, rowPassesColFilters, computeGatewayByAccount, computeGatewayFail, computeGatewayHangupCause, computeGatewayFailTimeline, computeGatewayBlockReconcile,
  billedSecondsOf, roundMoney, billingPeriodKey, billingRows, computeBilling, computeBillingForecast, resolveDateRangePreset, __ccuIntervals, __computeConcurrency, computeCcuByTelco, filterWindowSec,
  CID_DEAD_AFTER_MIN, CID_WARN_AFTER_MIN, parseEventTs, cidStateKey, buildCidTimeline, mergeIntervalsMs,
  computeCidDutyCycle, computeCidAvailability, computeBlockMttr,
  computeCidRecoverySurvival, computeCidReblockStats, computeCidInventoryTrend,
  computeCidActionQueue, computeCidDimensionComparison,
  normalizeCidNational, deriveRoutingAccountMap, telcoBlockCode, filterCidScope,
  buildCidCoverage, computeRoutingLeaks,
  computeBlockPressure, computeBlockBursts, computeDeadNumberLoss,
  computeLoadVsBlockRisk, computeBlockPrecursors,
  computeBlockSignalPatterns, buildPrecursorWindows,
  countActiveDays, computeSignalsByAccount,
  buildCube, buildLlmContext,
  makeRowFactory,
  slimTopDest, slimCallbackStats, slimConcurrency, slimCubeForTransfer,
  isCanonicalStamp, stampToMs
};
for (const k in __exports) { if (!(k in root)) root[k] = __exports[k]; }
if (typeof module !== 'undefined' && module.exports) module.exports = __exports;

})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
