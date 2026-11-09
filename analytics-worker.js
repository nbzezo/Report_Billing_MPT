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

// Derive SQL's lookup groups from the shared classifier, not a second cause list.
function classificationSql() {
  const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
  const causes = new Set(['CALL_REJECTED', ...core.Fail_Hangup_cause, ...core.NonSystemFailure_Hangup_cause,
    ...core.NoAnswer_Hangup_cause, ...core.Cancelled_Hangup_cause]);
  // Evaluate normalization once per row, even when the cause is unknown.
  const whitespace = 'char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)';
  const branches = Array.from(causes, cause => {
    const zero = core.classifyCall({hangup_cause:cause,duration:0,billsec:0});
    const answered = core.classifyCall({hangup_cause:cause,duration:0,billsec:1});
    const result = zero === answered ? quote(zero)
      : `CASE WHEN COALESCE(billsec,0)>0 THEN ${quote(answered)} ELSE ${quote(zero)} END`;
    return `WHEN ${quote(cause)} THEN ${result}`;
  });
  return `CASE UPPER(TRIM(COALESCE(hangup_cause,''),${whitespace})) ${branches.join(' ')} ELSE CASE ` +
    `WHEN COALESCE(billsec,0)>0 THEN ${quote(core.classifyCall({billsec:1}))} ` +
    `WHEN COALESCE(duration,0)>0 THEN ${quote(core.classifyCall({duration:1}))} ` +
    `WHEN COALESCE(duration,0)=0 THEN ${quote(core.classifyCall({duration:0}))} ELSE ${quote(core.classifyCall({duration:-1}))} END END`;
}
const CLASSIFICATION_SQL = classificationSql();

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
    } else if (['hangupcause', 'calltype', 'telco'].includes(name)) {
      clauses.push(`LOWER(TRIM(${column}))=?`);
      values.push(value.trim().toLowerCase());
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

function readDailyStats(db, params) {
  // These dimensions cannot answer number/cause/type filters; use raw rows there.
  if (['caller_number','dest_number','hangupcause','calltype'].some(k => params[k] && params[k] !== '0')) return null;
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='daily_stats_state'").get()) return null;
  const ready = db.prepare(
    "SELECT 1 FROM daily_stats_state s WHERE profile_id=? AND revision=COALESCE((SELECT revision FROM data_revisions WHERE profile_id=s.profile_id),0)"
  ).get(String(params.profile_id || ''));
  if (!ready) return null;
  const clauses = ['profile_id=?','day>=?','day<=?'];
  const values = [String(params.profile_id || ''), params.from_day || '', params.to_day || ''];
  const accounts = String(params.account_id || '').split(',').filter(x => x && x !== '0');
  if (accounts.length) {
    clauses.push(`account_id IN (${accounts.map(() => '?').join(',')})`);
    values.push(...accounts);
  }
  if (params.telco && params.telco !== '0') {
    clauses.push('LOWER(TRIM(telco))=?'); values.push(String(params.telco).trim().toLowerCase());
  }
  if (params.outbound && params.outbound !== '0') {
    const directions = DIRECTION_FILTERS[String(params.outbound).trim().toLowerCase()] || [String(params.outbound).trim().toLowerCase()];
    clauses.push(`LOWER(TRIM(direction)) IN (${directions.map(() => '?').join(',')})`);
    values.push(...directions);
  }
  return db.prepare(`SELECT day AS date,day||' 00:00:00' AS start_stamp,account_id,direction,total_billsec AS billsec FROM call_daily_stats WHERE ${clauses.join(' AND ')}`).all(...values);
}

function queryDetails(message) {
  const p = message.detailParams || {};
  if (p.gatewayKey !== undefined && p.gatewayKey !== null) return null;
  const db = new DatabaseSync(message.dbPath, { readOnly: true });
  try {
    db.exec('BEGIN');
    const where = whereOf(message.params);
    for (const [field, op, suffix] of [['startDate','>=',' 00:00:00'],['endDate','<=',' 23:59:59']]) {
      if (p[field]) { where.sql += ` AND start_stamp${op}?`; where.values.push(String(p[field]) + suffix); }
    }
    const start = String(p.startTime || '00:00').trim() + ':00';
    const end = String(p.endTime || '23:59').trim() + ':59';
    if (start !== '00:00:00' || end !== '23:59:59') {
      where.sql += ` AND (substr(start_stamp,12,8)>=? ${start <= end ? 'AND' : 'OR'} substr(start_stamp,12,8)<=?)`;
      where.values.push(start, end);
    }
    const account = p.accountIds || p.account || 'all';
    const accounts = Array.isArray(account) ? account.map(String) : account && account !== 'all' ? [String(account)] : [];
    if (accounts.length) {
      where.sql += ` AND account_id IN (${accounts.map(() => '?').join(',')})`;
      where.values.push(...accounts);
    }
    const statuses = Array.isArray(p.statuses) ? p.statuses.map(String).filter(Boolean) : p.status ? [String(p.status)] : [];
    if (statuses.length) {
      where.sql += ` AND (${CLASSIFICATION_SQL}) IN (${statuses.map(() => '?').join(',')})`;
      where.values.push(...statuses);
    }
    const total = db.prepare(`SELECT COUNT(*) AS n FROM call_records WHERE ${where.sql}`).get(...where.values).n;
    const offset = Math.max(0, Number(message.offset) || 0);
    const limit = Math.max(1, Number(message.limit) || 50);
    const raw = db.prepare(`SELECT ${COLUMNS.join(',')} FROM call_records WHERE ${where.sql} ORDER BY start_stamp LIMIT ? OFFSET ?`).all(...where.values, limit, offset);
    const make = core.makeRowFactory(COLUMNS);
    const normalized = raw.map(row => {
      const out = make(COLUMNS.map(c => row[c]));
      out.telco = core.normalizeTelcoName(out.telco);
      return out;
    });
    return { rows:core.enrichData(normalized, {}, gatewayIndex(db, message.params.profile_id)), total, offset, limit };
  } finally { db.close(); }
}

function loadDataset(message) {
  const revisionKey = String(message.datasetKey || '');
  const key = String(message.datasetBaseKey || revisionKey);
  if (datasets.has(key) && datasets.get(key).revisionKey === revisionKey) {
    const hit = datasets.get(key);
    datasets.delete(key);
    datasets.set(key, hit);
    return hit;
  }
  const db = new DatabaseSync(message.dbPath, { readOnly: true });
  try {
    db.exec('BEGIN');
    const where = whereOf(message.params);
    const previous = datasets.get(key);
    const refreshFrom = String(message.refreshFrom || '');
    const refreshTo = String(message.refreshTo || '');
    const canPatch = previous && refreshFrom && refreshTo;
    const patchClause = canPatch ? ' AND start_stamp>=? AND start_stamp<=?' : '';
    const sql = `SELECT ${COLUMNS.join(',')} FROM call_records WHERE ${where.sql}${patchClause} ORDER BY start_stamp`;
    const values = canPatch
      ? where.values.concat(`${refreshFrom} 00:00:00`, `${refreshTo} 23:59:59`)
      : where.values;
    const statement = db.prepare(sql);
    const returnsArrays = typeof statement.setReturnArrays === 'function';
    if (returnsArrays) statement.setReturnArrays(true);
    const raw = statement.all(...values);
    // CallStore already stores canonical columns, numeric values, timestamps and
    // UUIDs. Rebuild a uniform V8 object shape for fast analytics, but skip the
    // general CSV normalization pass. Telco names still use the shared rule.
    const makeRow = core.makeRowFactory(COLUMNS);
    const normalized = raw.map(row => {
      const out = makeRow(returnsArrays ? row : COLUMNS.map(column => row[column]));
      out.telco = core.normalizeTelcoName(out.telco);
      return out;
    });
    const freshRows = core.enrichData(normalized, {}, gatewayIndex(db, message.params.profile_id));
    let rows = freshRows;
    if (canPatch) {
      const fromStamp = `${refreshFrom} 00:00:00`;
      const toStamp = `${refreshTo} 23:59:59`;
      // Both the cached dataset and the patch query are already ordered. Split
      // once and splice the refreshed interval in place; sorting hundreds of
      // thousands of unchanged rows made a one-day refresh needlessly costly.
      const before = [], after = [];
      for (const row of previous.rows) {
        if (row.start_stamp < fromStamp) before.push(row);
        else if (row.start_stamp > toStamp) after.push(row);
      }
      rows = before.concat(freshRows, after);
    }
    const dailyStats = readDailyStats(db, message.params);
    const dataset = { rows, dailyStats, meta: datasetMeta(rows), billing: new Map(), cubes: new Map(), revisionKey };
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
  const p = params || {};
  const aggregates = {};
  if (dataset.dailyStats && (!p.startTime || p.startTime === '00:00') && (!p.endTime || p.endTime === '23:59')) {
    const daily = core.filterData(dataset.dailyStats, p.startDate, p.endDate, p.account || 'all', '00:00', '23:59');
    aggregates.minutesPerDay = core.minutesPerDay(daily);
  }
  const value = core.slimCubeForTransfer(core.buildCube(dataset.rows, p, aggregates));
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
  if (message.op === 'detail') {
    const result = queryDetails(message);
    if (result) return result;
  }
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
