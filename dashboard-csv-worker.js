'use strict';
/* ==========================================================================
   dashboard-csv-worker.js — Web Worker giữ dữ liệu đã enrich, dựng cube ngoài
   luồng UI. Toàn bộ logic normalize/classify/enrich/aggregate/buildCube nằm ở
   dashboard-core.js (nạp qua importScripts).

   Giao thức: message {id, type, ...payload}; trả {id, ...} hoặc {id, error}.
     parse       {text}                       -> {rows}          (parse-only, back-compat)
     ingest      {text,isJSON,sourceLabel,nameMap} -> {meta, rows} (parse+normalize+dedup+enrich, LƯU lại)
     ingestRows  {rows,sourceLabel,nameMap}   -> {meta, rows}     (rows đã normalize sẵn)
     reenrich    {nameMap}                    -> {meta, rows}     (enrich lại từ bản deduped đã lưu)
     cube        {params}                     -> {cube}           (buildCube trên rows đã lưu)
     billing     {cfg}                        -> {report,rowCount}(tab Cước phí — bộ lọc riêng)
     page        {offset,limit,params}        -> {rows, total}    (một trang dữ liệu đã lọc — bảng chi tiết)

   Message dạng CHUỖI thuần (không object) vẫn được: coi là parse-only (giữ
   tương thích parseCSVInWorker cũ).
   ========================================================================== */

var CORE_OK = false;
try { importScripts('/dashboard-core.js'); CORE_OK = typeof buildCube === 'function'; }
catch (e) { CORE_OK = false; }

// ---- CSV parser riêng của worker (core không có parser) --------------------
function splitCSVRespectQuotes(line) {
  const out = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { current += '"'; i++; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      out.push(current);
      current = '';
    } else current += char;
  }
  out.push(current);
  return out;
}

function parseCSV(text) {
  if (!text) return [];
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(Boolean);
  if (lines.length < 2) return [];
  const header = splitCSVRespectQuotes(lines[0]).map(value => value.replace(/^"|"$/g, '').trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const columns = splitCSVRespectQuotes(lines[i]);
    if (columns.length === 1 && !columns[0].trim()) continue;
    const row = {};
    for (let j = 0; j < header.length; j++) {
      row[header[j]] = (columns[j] === undefined ? '' : columns[j]).replace(/^"|"$/g, '').replace(/""/g, '"');
    }
    rows.push(row);
  }
  return rows;
}

// ---- Trạng thái giữ trong worker -----------------------------------------
var state = { deduped: [], enriched: [], nameMap: {} };

function metaOf(deduped, enriched, removed) {
  const dates = enriched.map(r => r.date).filter(d => d && d !== 'Unknown').sort();
  const accountIds = Array.from(new Set(enriched.map(r => String(r.account_id || 'Unknown')))).sort();
  return {
    count: deduped.length,
    removed: removed || 0,
    dateMin: dates.length ? dates[0] : null,
    dateMax: dates.length ? dates[dates.length - 1] : null,
    accounts: accountIds.length,
    accountIds: accountIds
  };
}

// cap: số dòng đã enrich gửi về luồng chính (0/undefined = tất cả). Toàn bộ vẫn
// nằm trong worker để buildCube/page tính CHÍNH XÁC trên mọi dòng.
function ingestFromRows(rawRows, sourceLabel, nameMap, cap) {
  if (sourceLabel) for (const r of rawRows) r.__source_file = sourceLabel;
  const ded = dedupByUUID(rawRows);
  state.deduped = ded.rows;
  state.nameMap = nameMap || {};
  state.enriched = enrichData(state.deduped, state.nameMap);
  const meta = metaOf(state.deduped, state.enriched, ded.removed);
  const rows = (cap && state.enriched.length > cap) ? state.enriched.slice(0, cap) : state.enriched;
  return { meta: meta, rows: rows, capped: rows.length < state.enriched.length };
}

function handle(msg) {
  const { id, type } = msg;
  try {
    if (!CORE_OK && type !== 'parse') {
      self.postMessage({ id, error: 'dashboard-core.js chưa nạp được trong worker' });
      return;
    }
    if (type === 'parse') {
      self.postMessage({ id, rows: parseCSV(String(msg.text || '')) });
      return;
    }
    if (type === 'ingest') {
      let rows = msg.isJSON ? JSON.parse(String(msg.text || 'null')) : parseCSV(String(msg.text || ''));
      if (!Array.isArray(rows)) rows = [];
      rows = normalizeCallRecords(rows);
      self.postMessage({ id, ...ingestFromRows(rows, msg.sourceLabel, msg.nameMap, msg.cap) });
      return;
    }
    if (type === 'ingestRows') {
      self.postMessage({ id, ...ingestFromRows(msg.rows || [], msg.sourceLabel, msg.nameMap, msg.cap) });
      return;
    }
    if (type === 'reenrich') {
      state.nameMap = msg.nameMap || {};
      state.enriched = enrichData(state.deduped, state.nameMap);
      const meta = metaOf(state.deduped, state.enriched, 0);
      const rows = (msg.cap && state.enriched.length > msg.cap) ? state.enriched.slice(0, msg.cap) : state.enriched;
      self.postMessage({ id, meta: meta, rows: rows, capped: rows.length < state.enriched.length });
      return;
    }
    if (type === 'cube') {
      self.postMessage({ id, cube: buildCube(state.enriched, msg.params || {}) });
      return;
    }
    if (type === 'billing') {
      const cfg = msg.cfg || {};
      const rows = billingRows(state.enriched, cfg);
      self.postMessage({ id, report: computeBilling(rows, cfg), rowCount: rows.length });
      return;
    }
    if (type === 'page') {
      const p = msg.params || {};
      const filtered = filterData(state.enriched, p.startDate, p.endDate, p.account || 'all', p.startTime, p.endTime);
      const off = Math.max(0, msg.offset | 0);
      const lim = Math.max(1, msg.limit | 0);
      self.postMessage({ id, rows: filtered.slice(off, off + lim), total: filtered.length });
      return;
    }
    self.postMessage({ id, error: 'type không hỗ trợ: ' + type });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
}

self.addEventListener('error', function (e) {
  try { self.postMessage({ __workerError: (e && e.message) || String(e), where: (e && e.filename ? e.filename + ':' + e.lineno : '') }); } catch (_) {}
});
self.addEventListener('unhandledrejection', function (e) {
  const r = e && e.reason;
  try { self.postMessage({ __workerError: (r && (r.stack || r.message)) || String(r), where: 'unhandledrejection' }); } catch (_) {}
});

self.onmessage = function (event) {
  const d = event.data;
  if (typeof d === 'string') { self.postMessage(parseCSV(d)); return; } // back-compat parseCSVInWorker
  handle(d || {});
};
