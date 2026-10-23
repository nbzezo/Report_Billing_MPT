'use strict';

const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const root = path.join(__dirname, '..');
const dbPath = path.join(root, 'data', 'calls.sqlite3');
const fromDay = process.argv[2];
const toDay = process.argv[3];
const refreshDay = process.argv[4] || toDay;
if (!fromDay || !toDay) {
  console.error('Usage: node scripts/benchmark_incremental.js <from-day> <to-day> [refresh-day]');
  process.exit(2);
}
const db = new DatabaseSync(dbPath, { readOnly: true });
const profile = db.prepare(
  'SELECT profile_id FROM call_records WHERE start_stamp>=? AND start_stamp<=? GROUP BY profile_id ORDER BY COUNT(*) DESC LIMIT 1'
).get(`${fromDay} 00:00:00`, `${toDay} 23:59:59`);
db.close();
if (!profile) throw new Error('No matching calls');

const child = spawn(process.execPath, ['--max-old-space-size=4096', path.join(root, 'analytics-worker.js'), root], {
  stdio: ['pipe', 'pipe', 'inherit']
});
const nonce = process.pid + '-' + Date.now();
let buffer = '';
const pending = new Map();
child.stdout.on('data', chunk => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf('\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    const value = JSON.parse(line);
    const item = pending.get(value.id);
    if (item) { pending.delete(value.id); item(value); }
  }
});
function request(id, revision, refresh, optimized) {
  const params = { profile_id:profile.profile_id, from_day:fromDay, to_day:toDay };
  const cubeParams = { startDate:fromDay, endDate:toDay, startTime:'00:00', endTime:'23:59', account:'all' };
  if (optimized) cubeParams.sections=['common','overview'];
  const message = { id, op:'bundle', dbPath, params, cubeParams, previewLimit:5000,
    datasetBaseKey:'incremental-benchmark-' + nonce,
    datasetKey:'incremental-benchmark-' + nonce + '-' + revision };
  if (refresh) { message.refreshFrom=refreshDay; message.refreshTo=refreshDay; }
  return new Promise((resolve, reject) => {
    const started = performance.now();
    pending.set(id, value => value.error ? reject(new Error(value.error)) : resolve(performance.now()-started));
    child.stdin.write(JSON.stringify(message)+'\n');
  });
}
(async()=>{
  const previousFullRefreshMs = await request(1, 'cold', false, false);
  const optimizedRefreshMs = await request(2, 'updated', true, true);
  console.log(JSON.stringify({fromDay,toDay,refreshDay,previousFullRefreshMs,optimizedRefreshMs,
    improvementPct:100-(optimizedRefreshMs/previousFullRefreshMs*100)},null,2));
  child.kill();
})().catch(error=>{ console.error(error); child.kill(); process.exitCode=1; });
