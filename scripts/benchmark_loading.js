'use strict';

const { performance } = require('node:perf_hooks');
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const core = require('../dashboard-core.js');

const db = new DatabaseSync(path.join(__dirname, '..', 'data', 'calls.sqlite3'), { readOnly: true });
const fromDay = process.argv[2];
const toDay = process.argv[3];
if (!fromDay || !toDay) {
  console.error('Usage: node scripts/benchmark_loading.js <from-day> <exclusive-to-day> [preview-limit]');
  process.exit(2);
}
const previewLimit = Number(process.argv[4] || 50000);
const profile = db.prepare('SELECT profile_id FROM call_records WHERE start_stamp>=? AND start_stamp<? GROUP BY profile_id ORDER BY COUNT(*) DESC LIMIT 1').get(fromDay, toDay);
if (!profile) throw new Error('No matching calls');
const columns = ['uuid','account_id','account_name','caller_id_number','destination_number','ani','direction','calltype','start_stamp','answer_stamp','end_stamp','duration','billsec','hangup_cause','status_code','telco','mos','quality_pct','jitter_min','jitter_max','jitter_loss_rate','packet_count','skip_packet_count','rtcp_packet_count','rtcp_rtt','gateway'];
const timings = {};
let t = performance.now();
const raw = db.prepare(`SELECT ${columns.join(',')} FROM call_records WHERE profile_id=? AND start_stamp>=? AND start_stamp<? ORDER BY start_stamp`).all(profile.profile_id, fromDay, toDay);
timings.sqliteMs = performance.now() - t;
t = performance.now();
const make = core.makeRowFactory(columns);
const normalized = raw.map(row => {
  const out = make(columns.map(column => row[column]));
  out.telco = core.normalizeTelcoName(out.telco);
  return out;
});
timings.normalizeMs = performance.now() - t;
t = performance.now();
const enriched = core.enrichData(normalized, {}, {});
timings.enrichMs = performance.now() - t;
t = performance.now();
const cube = core.slimCubeForTransfer(core.buildCube(enriched, {startDate:fromDay,endDate:toDay,account:'all',startTime:'00:00',endTime:'23:59'}));
timings.cubeMs = performance.now() - t;
t = performance.now();
const payload = JSON.stringify({cube, rows:enriched.slice(0, previewLimit)});
timings.serializeMs = performance.now() - t;
timings.totalMs = Object.values(timings).reduce((a,b) => a+b, 0);
console.log(JSON.stringify({count: raw.length, payloadMB: +(Buffer.byteLength(payload)/1048576).toFixed(2), timings}, null, 2));
db.close();
