'use strict';

// Long-lived analytics process. It reads SQLite directly and returns compact
// JSON results, so the browser never has to receive/parse the full CDR CSV.
const readline = require('node:readline');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const root = process.argv[2] || process.cwd();
const core = require(path.join(root, 'dashboard-core.js'));
// Một dataset đầy đủ có thể gần một triệu dòng; giữ đúng dataset gần nhất để
// không nhân đôi heap khi người dùng đổi profile/phạm vi.
const DATASET_CACHE_LIMIT = 1;
const datasets = new Map();
const BUNDLE_CACHE_VERSION = 2;
const BUNDLE_CACHE_LIMIT = 8;
const bundleCacheDir = path.join(root, '.cache', 'analytics-bundles');

function bundleCachePath(message, cap) {
  const sourceVersion = [__filename, path.join(root, 'dashboard-core.js')]
    .map(file => fs.statSync(file).mtimeMs);
  const signature = JSON.stringify([
    BUNDLE_CACHE_VERSION, sourceVersion, message.dbPath, message.datasetKey,
    message.params || {}, message.cubeParams || {}, cap
  ]);
  const digest = crypto.createHash('sha256').update(signature).digest('hex');
  return path.join(bundleCacheDir, digest + '.json');
}

function readBundleCache(file) {
  try {
    const result = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!result || !result.cube || !result.meta || !Array.isArray(result.rows)) return null;
    const now = new Date();
    fs.utimesSync(file, now, now);
    return result;
  } catch (_) { return null; }
}

function writeBundleCache(file, result) {
  try {
    fs.mkdirSync(bundleCacheDir, { recursive: true });
    const temp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(result));
    fs.renameSync(temp, file);
    const files = fs.readdirSync(bundleCacheDir)
      .filter(name => name.endsWith('.json'))
      .map(name => ({ name, time: fs.statSync(path.join(bundleCacheDir, name)).mtimeMs }))
      .sort((a, b) => b.time - a.time);
    for (const entry of files.slice(BUNDLE_CACHE_LIMIT)) {
      fs.unlinkSync(path.join(bundleCacheDir, entry.name));
    }
  } catch (_) { /* cache is optional */ }
}
const DIRECTION_FILTERS = {
  '1': ['outbound', 'external'],
  outbound: ['outbound', 'external'],
  external: ['outbound', 'external'],
  '2': ['inbound', 'internal'],
  inbound: ['inbound', 'internal'],
  internal: ['inbound', 'internal']
};

const COLUMNS = [
  'uuid', 'account_id', 'account_name', 'caller_id_number',
  'destination_number', 'ani', 'direction', 'calltype', 'start_stamp',
  'answer_stamp', 'end_stamp', 'duration', 'billsec', 'hangup_cause',
  'status_code', 'telco', 'mos', 'quality_pct', 'jitter_min',
  'jitter_max', 'jitter_loss_rate', 'packet_count', 'skip_packet_count',
  'rtcp_packet_count', 'rtcp_rtt', 'gateway'
];

function whereOf(params) {
  const p = params || {};
  const clauses = ['profile_id=?', 'start_stamp>=?', 'start_stamp<=?'];
  const values = [String(p.profile_id || ''), `${p.from_day || ''} 00:00:00`, `${p.to_day || ''} 23:59:59`];
  const accounts = String(p.account_id || '').split(',').filter(x => x && x !== '0');
  if (accounts.length) {
    clauses.push(`account_id IN (${accounts.map(() => '?').join(',')})`);
    values.push(...accounts);
  }
  const normalized = {
    ...p,
    calltype: ({'1': 'Unknown', '2': 'Local', '3': 'External'})[String(p.calltype || '')] || p.calltype
  };
  for (const [name, column] of [
    ['caller_number', 'caller_id_number'], ['dest_number', 'destination_number'],
    ['outbound', 'direction'], ['hangupcause', 'hangup_cause'],
    ['calltype', 'calltype'], ['telco', 'telco']
  ]) {
    const value = String(normalized[name] || '');
    if (!value || value === '0') continue;
    const directionValues = name === 'outbound'
      ? DIRECTION_FILTERS[value.trim().toLowerCase()]
      : null;
    if (directionValues) {
      clauses.push(`LOWER(TRIM(direction)) IN (${directionValues.map(() => '?').join(',')})`);
      values.push(...directionValues);
    } else {
      clauses.push(`${column}=?`);
      values.push(value);
    }
  }
  return { sql: clauses.join(' AND '), values };
}

function gatewayIndex(db, profileId) {
  const index = {};
  const rows = db.prepare(
    'SELECT cid,routing_name,gateway,telco_status_json FROM gateway_cids WHERE profile_id=?'
  ).all(String(profileId || ''));
  for (const row of rows) {
    let status = {};
    try { status = JSON.parse(row.telco_status_json || '{}'); } catch (_) {}
    index[String(row.cid)] = {
      routing_name: row.routing_name || '', gateway: row.gateway || '', telco_status: status
    };
  }
  return index;
}

function datasetMeta(rows) {
  let dateMin = '', dateMax = '';
  const accounts = new Set(), telcos = new Set();
  for (const row of rows) {
    const day = String(row.start_stamp || '').slice(0, 10);
    if (day && (!dateMin || day < dateMin)) dateMin = day;
    if (day && day > dateMax) dateMax = day;
    if (row.account_id !== undefined && row.account_id !== null) accounts.add(String(row.account_id));
    if (row.telco) telcos.add(String(row.telco));
  }
  return {
    count: rows.length, dateMin: dateMin || null, dateMax: dateMax || null,
    accountIds: Array.from(accounts).sort(), telcos: Array.from(telcos).sort()
  };
}

function loadDataset(message) {
  const key = String(message.datasetKey || '');
  if (datasets.has(key)) {
    const hit = datasets.get(key);
    datasets.delete(key);
    datasets.set(key, hit);
    return hit;
  }
  const db = new DatabaseSync(message.dbPath, { readOnly: true });
  try {
    const where = whereOf(message.params);
    const sql = `SELECT ${COLUMNS.join(',')} FROM call_records WHERE ${where.sql} ORDER BY start_stamp`;
    const raw = db.prepare(sql).all(...where.values);
    // CallStore already stores canonical columns, numeric values, timestamps and
    // UUIDs. Rebuild a uniform V8 object shape for fast analytics, but skip the
    // general CSV normalization pass. Telco names still use the shared rule.
    const makeRow = core.makeRowFactory(COLUMNS);
    const normalized = raw.map(row => {
      const out = makeRow(COLUMNS.map(column => row[column]));
      out.telco = core.normalizeTelcoName(out.telco);
      return out;
    });
    const rows = core.enrichData(normalized, {}, gatewayIndex(db, message.params.profile_id));
    const dataset = { rows, meta: datasetMeta(rows), billing: new Map(), cubes: new Map() };
    datasets.set(key, dataset);
    while (datasets.size > DATASET_CACHE_LIMIT) datasets.delete(datasets.keys().next().value);
    return dataset;
  } finally {
    db.close();
  }
}

function billingOf(dataset, cfg) {
  const key = JSON.stringify(cfg || {});
  if (dataset.billing.has(key)) return dataset.billing.get(key);
  const rows = core.billingRows(dataset.rows, cfg || {});
  const value = {
    report: core.computeBilling(rows, cfg || {}), rowCount: rows.length,
    forecast: core.computeBillingForecast(dataset.rows, cfg || {})
  };
  dataset.billing.set(key, value);
  while (dataset.billing.size > 4) dataset.billing.delete(dataset.billing.keys().next().value);
  return value;
}

function cubeOf(dataset, params) {
  const key = JSON.stringify(params || {});
  if (dataset.cubes.has(key)) return dataset.cubes.get(key);
  const value = core.slimCubeForTransfer(core.buildCube(dataset.rows, params || {}));
  dataset.cubes.set(key, value);
  while (dataset.cubes.size > 4) dataset.cubes.delete(dataset.cubes.keys().next().value);
  return value;
}

function previewRows(rows, cap) {
  if (rows.length <= cap) return rows;
  if (cap === 1) return [rows[0]];
  const sample = new Array(cap);
  for (let i = 0; i < cap; i++) {
    sample[i] = rows[Math.floor(i * (rows.length - 1) / (cap - 1))];
  }
  return sample;
}

function handle(message) {
  if (message.op === 'invalidate') { datasets.clear(); return { ok: true }; }
  if (message.op === 'bundle') {
    const cap = Math.max(1, Math.min(Number(message.previewLimit || 50000), 50000));
    const cacheFile = bundleCachePath(message, cap);
    const cached = readBundleCache(cacheFile);
    if (cached) return cached;
    const dataset = loadDataset(message);
    const result = {
      cube: cubeOf(dataset, message.cubeParams),
      rows: previewRows(dataset.rows, cap), meta: dataset.meta
    };
    writeBundleCache(cacheFile, result);
    return result;
  }
  const dataset = loadDataset(message);
  if (message.op === 'cube') {
    return { cube: cubeOf(dataset, message.cubeParams), meta: dataset.meta };
  }
  if (message.op === 'detail') {
    return core.queryCallDetails(
      dataset.rows, message.detailParams || {}, Number(message.offset || 0), Number(message.limit || 25)
    );
  }
  if (message.op === 'billing') {
    const value = billingOf(dataset, message.cfg || {});
    const { detail, ...summary } = value.report;
    return {
      report: summary, rowCount: value.rowCount, forecast: value.forecast,
      detailCount: detail.length
    };
  }
  if (message.op === 'billingDetail') {
    const value = billingOf(dataset, message.cfg || {});
    const offset = Math.max(0, Number(message.offset || 0));
    const limit = Math.max(1, Math.min(10000, Number(message.limit || 5000)));
    return {
      rows: value.report.detail.slice(offset, offset + limit),
      total: value.report.detail.length, offset, limit
    };
  }
  throw new Error(`Unknown analytics operation: ${message.op}`);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  let id = null;
  try {
    const message = JSON.parse(line);
    id = message.id;
    process.stdout.write(JSON.stringify({ id, result: handle(message) }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ id, error: String(error && (error.stack || error.message) || error) }) + '\n');
  }
});
