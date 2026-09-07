// Chạy:  node --test tests/
// Kiểm tra dashboard-core.js (logic thuần dùng chung trang + worker).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const core = require(path.join(ROOT, 'dashboard-core.js'));

test('classifyCall theo thứ tự ưu tiên nghiệp vụ', () => {
  assert.equal(core.classifyCall({ hangup_cause: 'NO_ROUTE_DESTINATION', billsec: 5 }), 'Fail'); // Fail cause đè cả billsec
  assert.equal(core.classifyCall({ hangup_cause: 'NORMAL_CLEARING', billsec: 30 }), 'Connected');
  assert.equal(core.classifyCall({ hangup_cause: 'ORIGINATOR_CANCEL', billsec: 0, duration: 0 }), 'Cancelled');
  assert.equal(core.classifyCall({ hangup_cause: 'USER_BUSY', billsec: 0, duration: 0 }), 'No Answer');
  assert.equal(core.classifyCall({ hangup_cause: 'NORMAL_CLEARING', billsec: 0, duration: 4 }), 'No Answer');
  assert.equal(core.classifyCall({ hangup_cause: 'NORMAL_CLEARING', billsec: 0, duration: 0 }), 'Fail');
});

test('normalizeCallRecord — mẫu cũ snake_case', () => {
  const rec = core.normalizeCallRecord({
    account_id: '548', caller_id_number: '0916', destination_number: '84288',
    direction: 'Inbound', start_stamp: '2026-09-03 06:21:01', answer_stamp: '1970-01-01 08:00:00',
    end_stamp: '2026-09-03 06:21:41', duration: 40, billsec: 12,
    hangup_cause: 'NORMAL_CLEARING', uuid: 'u-1', telco: 'VIETTEL', calltype: 'External'
  });
  assert.equal(rec.start_stamp, '2026-09-03 06:21:01');
  assert.equal(rec.billsec, 12);
  assert.equal(rec.telco, 'Viettel');
  assert.equal(rec.uuid, 'u-1');
});

test('normalizeCallRecord — mẫu mới Title Case + M/D/YYYY + số có phẩy', () => {
  const rec = core.normalizeCallRecord({
    Account: '548', Caller: '0916', Destination: '84288', 'Call type': 'Outbound',
    'Start time': '9/3/2026 6:21', 'End time': '9/3/2026 6:21', Duration: '95',
    Billsec: '1,234', Telco: 'MOBI', 'Hangup Cause': 'NORMAL_CLEARING'
  });
  assert.equal(rec.direction, 'Outbound');
  assert.equal(rec.billsec, 1234);
  assert.equal(rec.telco, 'MobiFone');
  assert.equal(rec.start_stamp, '2026-09-03 06:21:00');
  // end bị làm tròn tới phút -> tái tạo end = start + duration(95s)
  assert.equal(rec.end_stamp, '2026-09-03 06:22:35');
  assert.ok(String(rec.uuid).startsWith('gen-'), 'thiếu uuid -> sinh khoá ổn định');
});

test('enrichData precompute + accountNameMap truyền vào', () => {
  const [row] = core.enrichData(
    core.normalizeCallRecords([{
      account_id: '351', caller_id_number: '0987654321',
      start_stamp: '2026-09-03 08:00:00', end_stamp: '2026-09-03 08:01:00',
      duration: 60, billsec: 55, hangup_cause: 'NORMAL_CLEARING', uuid: 'u-2'
    }]),
    { '351': 'VCLASS BOT' }
  );
  assert.equal(row.account_name, 'VCLASS BOT');
  assert.equal(row.connType, 'Connected');
  assert.equal(row.date, '2026-09-03');
  assert.equal(row.hour, '08');
  assert.equal(typeof row.start_ts, 'number');
});

test('filterData theo ngày/giờ/account', () => {
  const rows = core.enrichData(core.normalizeCallRecords([
    { account_id: 'A', start_stamp: '2026-09-03 08:30:00', end_stamp: '2026-09-03 08:31:00', duration: 60, billsec: 10, uuid: 'a' },
    { account_id: 'B', start_stamp: '2026-09-03 23:30:00', end_stamp: '2026-09-03 23:31:00', duration: 60, billsec: 10, uuid: 'b' },
    { account_id: 'A', start_stamp: '2026-09-04 08:30:00', end_stamp: '2026-09-04 08:31:00', duration: 60, billsec: 10, uuid: 'c' }
  ]), {});
  assert.equal(core.filterData(rows, '2026-09-03', '2026-09-03', 'all', '00:00', '23:59').length, 2);
  assert.equal(core.filterData(rows, '2026-09-03', '2026-09-03', 'all', '00:00', '12:00').length, 1);
  assert.equal(core.filterData(rows, '2026-09-03', '2026-09-04', ['A'], '00:00', '23:59').length, 2);
});

test('dedupByUUID', () => {
  const r = core.dedupByUUID([{ uuid: 'x' }, { uuid: 'x' }, { uuid: 'y' }, { uuid: '' }]);
  assert.equal(r.kept, 3);
  assert.equal(r.removed, 1);
});

test('buildCube — overview trên dữ liệu mẫu 2 định dạng', () => {
  const raw = core.normalizeCallRecords([
    // mẫu cũ
    { account_id: '351', caller_id_number: '0987654321', destination_number: '0912000001',
      start_stamp: '2026-09-03 08:00:00', end_stamp: '2026-09-03 08:02:00',
      duration: 120, billsec: 90, hangup_cause: 'NORMAL_CLEARING', uuid: 'c1', telco: 'VIETTEL' },
    { account_id: '351', caller_id_number: '0333000000', destination_number: '0912000002',
      start_stamp: '2026-09-03 09:30:00', end_stamp: '2026-09-03 09:30:00',
      duration: 0, billsec: 0, hangup_cause: 'USER_BUSY', uuid: 'c2', telco: 'VIETTEL' },
    // mẫu mới
    { Account: '351', Caller: '0912345678', Destination: '0912000003', 'Call type': 'Outbound',
      'Start time': '9/3/2026 10:15', 'End time': '9/3/2026 10:15', Duration: '45',
      Billsec: '30', 'Hangup Cause': 'NORMAL_CLEARING' },
    // ngoài ngày lọc -> phải bị loại
    { account_id: '351', caller_id_number: '0987000000', start_stamp: '2026-09-04 08:00:00',
      end_stamp: '2026-09-04 08:01:00', duration: 60, billsec: 60, hangup_cause: 'NORMAL_CLEARING', uuid: 'c4' }
  ]);
  const enriched = core.enrichData(raw, { '351': 'VCLASS BOT' });
  const cube = core.buildCube(enriched, {
    startDate: '2026-09-03', endDate: '2026-09-03', account: 'all',
    startTime: '00:00', endTime: '23:59'
  });

  assert.equal(cube.meta.rows, 3, 'lọc bỏ cuộc ngày 04');
  assert.equal(cube.meta.dateMin, '2026-09-03');
  assert.equal(cube.overview.totalCalls, 3);
  assert.deepEqual(cube.overview.counts,
    { Fail: 0, 'No Answer': 1, Cancelled: 0, Connected: 2, Unknown: 0 });
  assert.equal(cube.overview.answerRate, +(2 / 3 * 100).toFixed(2)); // ASR = Connected/(Connected+NoAnswer)
  assert.equal(cube.overview.billsecMetrics.totalBillsec, 120);      // 90 + 0 + 30
  assert.equal(cube.minutesPerDay.dates[0], '2026-09-03');
  assert.equal(cube.minutesPerDay.minutes[0], +(120 / 60).toFixed(2));
  assert.ok(cube.byPrefix && typeof cube.byPrefix === 'object');
  assert.ok(cube.columnHealth && Array.isArray(cube.columnHealth.required));
  assert.ok(cube.timeAnomaly && typeof cube.timeAnomaly.endBeforeStart === 'number');
});

test('buildCube — phủ đủ các nhóm biểu đồ 5 tab', () => {
  const raw = core.normalizeCallRecords([
    { account_id: 'A', caller_id_number: '0912345678', destination_number: '0900000001',
      start_stamp: '2026-09-03 08:00:00', end_stamp: '2026-09-03 08:03:00',
      duration: 180, billsec: 150, hangup_cause: 'NORMAL_CLEARING', uuid: '1', telco: 'VIETTEL' },
    { account_id: 'A', caller_id_number: '0333000000', destination_number: '0900000001',
      start_stamp: '2026-09-03 08:01:00', end_stamp: '2026-09-03 08:01:00',
      duration: 0, billsec: 0, hangup_cause: 'USER_BUSY', uuid: '2', telco: 'MOBI' },
    { account_id: 'B', caller_id_number: '0777000000', destination_number: '0900000002',
      start_stamp: '2026-09-03 09:00:00', end_stamp: '2026-09-03 09:05:00',
      duration: 300, billsec: 280, hangup_cause: 'NORMAL_CLEARING', uuid: '3', telco: 'VINA' }
  ]);
  const cube = core.buildCube(core.enrichData(raw, {}), {
    startDate: '2026-09-03', endDate: '2026-09-03', account: 'all',
    startTime: '00:00', endTime: '23:59',
    billing: { firstBlock: 6, nextBlock: 1, rate: 1000, roundStep: 0, onlyConnected: true, groupBy: 'day' }
  });

  for (const k of ['overview', 'byPrefix', 'minutesPerDay', 'accountKPIs', 'topDest',
    'destTelcoShare', 'telcoConnBreakdown', 'dailyPrefixStats', 'timeHeatmap', 'goldenHours',
    'answerRateByAccountPerDay', 'agentPerf', 'callbackStats', 'retryPattern', 'concurrency', 'billing']) {
    assert.ok(k in cube, `thiếu cube.${k}`);
  }
  assert.equal(cube.timeHeatmap.length, 7);
  assert.equal(cube.timeHeatmap[0].length, 24);
  assert.equal(cube.goldenHours.zRate.length, 7);
  assert.equal(cube.concurrency.all.systemPeak, 1); // 2 cuộc connected không chồng nhau
  assert.ok(Array.isArray(cube.concurrency.byTelco.keys));
  assert.equal(cube.concurrency.ccuByTelco.stats.length, 2); // {stats, meta} — structured-clone-safe
  assert.ok(cube.concurrency.ccuByTelco.meta && 'systemPeak' in cube.concurrency.ccuByTelco.meta);
  assert.equal(cube.billing.totals.billedSec, 430); // 150 + 280
  assert.equal(cube.agentPerf.length, 2);
  assert.equal(cube.accountKPIs.length, 2);
});

test('buildCube — không có billing config -> billing null', () => {
  const cube = core.buildCube(core.enrichData(core.normalizeCallRecords([
    { account_id: 'A', caller_id_number: '09', start_stamp: '2026-09-03 08:00:00', end_stamp: '2026-09-03 08:01:00', duration: 60, billsec: 20, hangup_cause: 'NORMAL_CLEARING', uuid: 'a' }
  ]), {}), { startDate: '2026-09-03', endDate: '2026-09-03', account: 'all', startTime: '00:00', endTime: '23:59' });
  assert.equal(cube.billing, null);
  assert.equal(cube.meta.filterSpanSec, 86400);
});

test('buildCube — account filter (mảng id)', () => {
  const enriched = core.enrichData(core.normalizeCallRecords([
    { account_id: 'A', caller_id_number: '09', start_stamp: '2026-09-03 08:00:00', end_stamp: '2026-09-03 08:01:00', duration: 60, billsec: 20, hangup_cause: 'NORMAL_CLEARING', uuid: 'a' },
    { account_id: 'B', caller_id_number: '09', start_stamp: '2026-09-03 08:00:00', end_stamp: '2026-09-03 08:01:00', duration: 60, billsec: 20, hangup_cause: 'NORMAL_CLEARING', uuid: 'b' }
  ]), {});
  const cube = core.buildCube(enriched, {
    startDate: '2026-09-03', endDate: '2026-09-03', account: ['A'], startTime: '00:00', endTime: '23:59'
  });
  assert.equal(cube.meta.rows, 1);
  assert.equal(cube.meta.accounts, 1);
});

test('dashboard-core.js không tham chiếu DOM', () => {
  const raw = require('node:fs').readFileSync(path.join(ROOT, 'dashboard-core.js'), 'utf8');
  // Bỏ comment để không bắt nhầm phần mô tả.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const bad of ['document.', 'localStorage.', 'getElementById', 'Plotly.', 'window.']) {
    assert.ok(!src.includes(bad), `dashboard-core.js chứa "${bad}" — phải giữ thuần logic`);
  }
});

// ===== CID lifecycle (Block/Reactive tu routing/reports) =====

const E = (cid, telco, ts, kind, routing = 'R1', actor = '') =>
  ({ cid, telco, ts, kind, routing, actor });

test('buildCidTimeline — ghep block/reactive thanh khoang bi khoa', () => {
  const tl = core.buildCidTimeline([
    E('0901', 'VT', '2026-09-01 10:00:00', 'block'),
    E('0901', 'VT', '2026-09-01 14:00:00', 'reactive'),
  ], { windowEnd: Date.parse('2026-09-02T00:00:00') });
  assert.equal(tl.intervals.length, 1);
  const iv = tl.intervals[0];
  assert.equal(iv.recovered, true);
  assert.equal(iv.censored, false);
  assert.equal(iv.durationMin, 240);
  assert.equal(iv.presumedDead, false);
  assert.equal(iv.lateRecovery, false);
});

test('buildCidTimeline — khoa o cap (CID x routing x telco), khong phai cap CID', () => {
  // cung mot so: VT chan, MB van song -> phai la 2 khoa doc lap
  const tl = core.buildCidTimeline([
    E('0901', 'VT', '2026-09-01 10:00:00', 'block'),
    E('0901', 'MB', '2026-09-01 11:00:00', 'block'),
    E('0901', 'MB', '2026-09-01 11:30:00', 'reactive'),
  ], { windowEnd: Date.parse('2026-09-01T12:00:00') });
  assert.equal(tl.intervals.length, 2);
  const vt = tl.intervals.find(i => i.telco === 'VT');
  const mb = tl.intervals.find(i => i.telco === 'MB');
  assert.equal(vt.recovered, false);   // VT con bi khoa
  assert.equal(mb.recovered, true);    // MB da mo lai
});

test('buildCidTimeline — quy tac 24h: presumedDead vs lateRecovery tach bach', () => {
  const end = Date.parse('2026-09-05T00:00:00');
  const tl = core.buildCidTimeline([
    // chua reactive va da qua 24h -> "chet" theo quy tac
    E('0901', 'VT', '2026-09-01 00:00:00', 'block'),
    // reactive muon hon 24h -> van hoi phuc, KHONG duoc dem la chet
    E('0902', 'VT', '2026-09-01 00:00:00', 'block'),
    E('0902', 'VT', '2026-09-02 06:00:00', 'reactive'),
  ], { windowEnd: end });
  const a = tl.intervals.find(i => i.cid === '0901');
  const b = tl.intervals.find(i => i.cid === '0902');
  assert.equal(a.presumedDead, true);
  assert.equal(a.lateRecovery, false);
  assert.equal(b.presumedDead, false);
  assert.equal(b.lateRecovery, true);   // 30h > 24h nhung da recovered

  const m = core.computeBlockMttr(tl);
  assert.equal(m.presumedDead, 1);
  assert.equal(m.lateRecovery, 1);
  assert.equal(m.recovered, 1);
  assert.equal(m.stillBlocked, 1);
});

test('buildCidTimeline — block lap khi dang mo thi giu moc dau; reactive mo coi la orphan', () => {
  const tl = core.buildCidTimeline([
    E('0901', 'VT', '2026-09-01 10:00:00', 'block'),
    E('0901', 'VT', '2026-09-01 11:00:00', 'block'),   // lap -> bo qua
    E('0901', 'VT', '2026-09-01 12:00:00', 'reactive'),
    E('0902', 'VT', '2026-09-01 12:00:00', 'reactive'), // block xay ra truoc cua so
  ], { windowEnd: Date.parse('2026-09-01T13:00:00') });
  assert.equal(tl.intervals.length, 1);
  assert.equal(tl.intervals[0].durationMin, 120);       // tu 10:00 chu khong phai 11:00
  assert.equal(tl.orphanReactive, 1);
});

test('buildCidTimeline — block va reactive cung giay: block dung truoc, khong sinh khoang am', () => {
  const tl = core.buildCidTimeline([
    E('0901', 'VT', '2026-09-01 10:00:00', 'reactive'),
    E('0901', 'VT', '2026-09-01 10:00:00', 'block'),
  ], { windowEnd: Date.parse('2026-09-01T11:00:00') });
  assert.equal(tl.intervals.length, 1);
  assert.equal(tl.intervals[0].durationMin, 0);
  assert.ok(tl.intervals[0].durationMin >= 0);
});

test('computeCidDutyCycle — nhieu routing dung chung CID thi HOP NHAT, khong cong don', () => {
  const start = Date.parse('2026-09-01T00:00:00');
  const end = Date.parse('2026-09-01T10:00:00');   // cua so 10h
  const tl = core.buildCidTimeline([
    // hai routing khoa cung mot so, khoang chong nhau 09:00-10:00
    E('0901', 'VT', '2026-09-01 00:00:00', 'block', 'R1'),
    E('0901', 'VT', '2026-09-01 02:00:00', 'reactive', 'R1'),
    E('0901', 'VT', '2026-09-01 01:00:00', 'block', 'R2'),
    E('0901', 'VT', '2026-09-01 03:00:00', 'reactive', 'R2'),
  ], { windowEnd: end });
  const duty = core.computeCidDutyCycle(tl, { windowStart: start, windowEnd: end });
  assert.equal(duty.length, 1);
  // hop nhat [0h,2h] va [1h,3h] = [0h,3h] = 3h khoa / 10h -> uptime 70%
  assert.equal(Math.round(duty[0].blockedHours), 3);
  assert.equal(Math.round(duty[0].uptimePct), 70);
  assert.equal(duty[0].blockCount, 2);
  assert.deepEqual(duty[0].routings, ['R1', 'R2']);
});

test('computeCidAvailability — mau so mac dinh la can duoi va phai tu khai bao', () => {
  const end = Date.parse('2026-09-01T12:00:00');
  const tl = core.buildCidTimeline([
    E('0901', 'VT', '2026-09-01 10:00:00', 'block'),
  ], { windowEnd: end });

  const a = core.computeCidAvailability(tl, { windowEnd: end });
  assert.equal(a.VT.universe, 1);                  // chi thay 1 CID trong log
  assert.equal(a.VT.universeIsLowerBound, true);   // -> phai bao la can duoi
  assert.equal(a.VT.availablePct[0], 0);           // 1/1 bi khoa = 0% kha dung

  // truyen mau so that tu CDR: 10 so dang dung -> 90% kha dung
  const b = core.computeCidAvailability(tl, { windowEnd: end, universeByTelco: { VT: 10 } });
  assert.equal(b.VT.universe, 10);
  assert.equal(b.VT.universeIsLowerBound, false);
  assert.equal(b.VT.availablePct[0], 90);
});

test('computeCidAvailability — khoang chua mo lai KHONG duoc dong o cuoi cua so', () => {
  // regression: dong censored interval tai `end` lam duong kha dung vot ve 100%
  // dung diem cuoi, mau thuan voi "dang bi khoa".
  const end = Date.parse('2026-09-01T12:00:00');
  const tl = core.buildCidTimeline([
    E('0901', 'VT', '2026-09-01 10:00:00', 'block'),
  ], { windowEnd: end });
  const a = core.computeCidAvailability(tl, { windowEnd: end, universeByTelco: { VT: 4 } });
  const last = a.VT.availablePct[a.VT.availablePct.length - 1];
  assert.equal(last, 75);            // 1/4 con bi khoa -> 75%, KHONG phai 100%
  assert.equal(a.VT.blocked[a.VT.blocked.length - 1], 1);
});

test('buildCidTimeline — reactive ghi lap theo lo khong bi dem thanh orphan', () => {
  const end = Date.parse('2026-09-01T13:00:00');
  const tl = core.buildCidTimeline([
    E('0901', 'VT', '2026-09-01 10:00:00', 'block'),
    E('0901', 'VT', '2026-09-01 12:00:00', 'reactive'),
    E('0901', 'VT', '2026-09-01 12:00:01', 'reactive'),  // lo ghi lap ~1s
  ], { windowEnd: end });
  assert.equal(tl.intervals.length, 1);
  assert.equal(tl.orphanReactive, 0);        // truoc khi sua: 1

  // reactive that su le loi (block nam truoc cua so) van phai dem la orphan
  const tl2 = core.buildCidTimeline([
    E('0902', 'VT', '2026-09-01 12:00:00', 'reactive'),
  ], { windowEnd: end });
  assert.equal(tl2.orphanReactive, 1);
});

// ===== A6: ban do Routing <-> Account =====

const CDR = (caller, account) => ({ caller_id_number: caller, account_name: account });

test('deriveRoutingAccountMap — noi qua CID dung chung, bat ca khi CID khac dinh dang', () => {
  const map = core.deriveRoutingAccountMap(
    [E('0901', 'VT', '2026-09-01 10:00:00', 'block', 'R_ALPHA'),
     E('0902', 'VT', '2026-09-01 10:00:00', 'block', 'R_ALPHA')],
    // CDR ghi dang 84... con log ghi dang 0... -> van phai khop
    [CDR('84901', 'AcmeCorp'), CDR('0902', 'AcmeCorp')],
  );
  assert.equal(map.byRouting.length, 1);
  assert.equal(map.byRouting[0].routing, 'R_ALPHA');
  assert.equal(map.byRouting[0].account, 'AcmeCorp');
  assert.equal(map.byRouting[0].sharedCids, 2);
  assert.equal(map.byRouting[0].ambiguous, false);
  assert.equal(map.stats.matchedCids, 2);
});

test('deriveRoutingAccountMap — account khong chia se CID nao = NGOAI PHAM VI, khong phai "0 block"', () => {
  const map = core.deriveRoutingAccountMap(
    [E('0901', 'VT', '2026-09-01 10:00:00', 'block', 'R_ALPHA')],
    [CDR('0901', 'CoDuoiTheoDoi'), CDR('0999', 'NgoaiPhamVi')],
  );
  assert.deepEqual(map.uncoveredAccounts, ['NgoaiPhamVi']);
  assert.equal(map.stats.accounts, 2);
  assert.equal(map.stats.coveredAccounts, 1);
});

test('deriveRoutingAccountMap — routing dinh vao nhieu account thi phai bao nhap nhang', () => {
  const map = core.deriveRoutingAccountMap(
    [E('0901', 'VT', '2026-09-01 10:00:00', 'block', 'R_MIX'),
     E('0902', 'VT', '2026-09-01 10:00:00', 'block', 'R_MIX')],
    [CDR('0901', 'AccA'), CDR('0902', 'AccB')],   // 50/50 -> duoi nguong 0.6
  );
  const r = map.byRouting[0];
  assert.equal(r.ambiguous, true);
  assert.equal(r.candidates.length, 2);
  assert.equal(r.share, 0.5);
});

test('deriveRoutingAccountMap — khong co CDR thi khong bia ra anh xa nao', () => {
  const map = core.deriveRoutingAccountMap(
    [E('0901', 'VT', '2026-09-01 10:00:00', 'block', 'R_ALPHA')], []);
  assert.equal(map.byRouting.length, 0);
  assert.deepEqual(map.unmatchedRoutings, ['R_ALPHA']);
  assert.equal(map.stats.matchedCids, 0);
});

test('deriveRoutingAccountMap — ten routing co dau cach khong lam vo phep gom nhom', () => {
  // Du lieu that co "HNI_Duoc Thai Minh_VBN". Ghep khoa bang chuoi roi split
  // se cat ten thanh manh -> phai dung Map long.
  const R = 'HNI_Duoc Thai Minh_VBN';
  const map = core.deriveRoutingAccountMap(
    [E('0901', 'VT', '2026-09-01 10:00:00', 'block', R),
     E('0902', 'VT', '2026-09-01 10:00:00', 'block', R)],
    [CDR('0901', 'Duoc Thai Minh'), CDR('0902', 'Duoc Thai Minh')],
  );
  assert.equal(map.byRouting.length, 1);
  assert.equal(map.byRouting[0].routing, R);              // nguyen ven, khong bi cat
  assert.equal(map.byRouting[0].account, 'Duoc Thai Minh'); // account co dau cach cung vay
  assert.equal(map.byRouting[0].sharedCids, 2);
  assert.equal(map.byRouting[0].ambiguous, false);
});

// ===== A6 (noi bang ten) + B1 =====

test('telcoBlockCode — quy ca 3 he ky hieu ve ma cua log block', () => {
  assert.equal(core.telcoBlockCode('Viettel'), 'VT');   // CDR ban cu
  assert.equal(core.telcoBlockCode('VIETTEL'), 'VT');   // CDR ban moi
  assert.equal(core.telcoBlockCode('Mobi'), 'MB');
  assert.equal(core.telcoBlockCode('Vina'), 'VN');
  assert.equal(core.telcoBlockCode('Vietnammobile'), 'OT');  // gop vao OT
  assert.equal(core.telcoBlockCode('FIXED'), 'OT');
  assert.equal(core.telcoBlockCode(''), '');            // khong doan bua
});

test('buildCidCoverage — tach "0 block that su" khoi "khong quan sat duoc"', () => {
  const cov = core.buildCidCoverage({
    routings: [{ id: '1', name: 'R_CO_BLOCK' }, { id: '2', name: 'R_SACH' },
               { id: '3', name: 'R_KHONG_CO_ACCOUNT' }],
    accounts: [{ id: 'a1', name: 'R_CO_BLOCK' }, { id: 'a2', name: 'R_SACH' },
               { id: 'a3', name: 'ACC_KHONG_CO_ROUTING' }],
    events: [E('0901', 'VT', '2026-09-01 10:00:00', 'block', 'R_CO_BLOCK')],
  });
  assert.deepEqual(cov.observedWithBlocks.map(x => x.name), ['R_CO_BLOCK']);
  assert.deepEqual(cov.observedClean.map(x => x.name), ['R_SACH']);          // 0 block THAT
  assert.deepEqual(cov.unobservable.map(x => x.name), ['ACC_KHONG_CO_ROUTING']); // khong thay
  assert.deepEqual(cov.routingWithoutAccount.map(x => x.name), ['R_KHONG_CO_ACCOUNT']);
  assert.equal(cov.observedWithBlocks[0].cids, 1);
});

test('buildCidCoverage — routing co su kien nhung khong co trong dropdown thi phai bao', () => {
  const cov = core.buildCidCoverage({
    routings: [], accounts: [],
    events: [E('0901', 'VT', '2026-09-01 10:00:00', 'block', 'R_LA')],
  });
  assert.deepEqual(cov.stats.eventRoutingsNotListed, ['R_LA']);
});

test('computeRoutingLeaks — tach khoang da mo lai (vo hai) khoi chua mo lai (lang phi)', () => {
  const end = Date.parse('2026-09-03T00:00:00');
  const tl = core.buildCidTimeline([
    // 0901: block roi mo lai -> khoang DA DONG
    E('0901', 'VT', '2026-09-01 10:00:00', 'block'),
    E('0901', 'VT', '2026-09-01 12:00:00', 'reactive'),
    // 0902: block va khong bao gio mo lai -> CENSORED
    E('0902', 'VT', '2026-09-01 10:00:00', 'block'),
  ], { windowEnd: end });

  const call = (caller, stamp, billsec) => ({
    caller_id_number: caller, telco: 'Viettel', start_stamp: stamp,
    billsec, hangup_cause: billsec ? 'NORMAL_CLEARING' : 'NO_USER_RESPONSE',
  });
  const rows = core.enrichData(core.normalizeCallRecords([
    call('0901', '2026-09-01 11:00:00', 20),   // trong khoang da dong, ket noi
    call('0902', '2026-09-01 11:00:00', 0),    // trong khoang censored, khong ket noi
    call('0902', '2026-09-01 13:00:00', 0),    // van trong censored
    call('0901', '2026-09-01 20:00:00', 30),   // ngoai khoang (da mo lai luc 12h)
  ]), {});

  const res = core.computeRoutingLeaks(tl, rows, { windowEnd: end });
  assert.equal(res.checked, 4);
  assert.equal(res.inClosed.calls, 1);
  assert.equal(res.inClosed.connectRate, 100);
  assert.equal(res.inCensored.calls, 2);
  assert.equal(res.inCensored.connectRate, 0);
  assert.equal(res.wastedCalls, 2);            // chi dem nhom censored
  assert.equal(res.outside.calls, 1);
});

test('computeRoutingLeaks — CID dang bi VT chan van goi MB thi khong tinh la trung khoang', () => {
  const end = Date.parse('2026-09-02T00:00:00');
  const tl = core.buildCidTimeline([
    E('0901', 'VT', '2026-09-01 10:00:00', 'block'),
  ], { windowEnd: end });
  const rows = core.enrichData(core.normalizeCallRecords([
    { caller_id_number: '0901', telco: 'Mobi', start_stamp: '2026-09-01 11:00:00',
      billsec: 20, hangup_cause: 'NORMAL_CLEARING' },
  ]), {});
  const res = core.computeRoutingLeaks(tl, rows, { windowEnd: end });
  assert.equal(res.hits.length, 0);      // khoa VT khong anh huong cuoc goi MB
  assert.equal(res.outside.calls, 1);
});

test('timeline va CDR phai parse gio trong CUNG mot he — khong duoc lech mui gio', () => {
  // Log block ghi "2026-09-01 10:00:00" (gio dia phuong, khong co offset) va CDR
  // cung vay. Neu mot ben parse UTC con ben kia local thi lech 7 tieng va moi
  // cuoc goi se roi nham nhom ma khong bao loi gi.
  const end = Date.parse('2026-09-02T00:00:00');
  const tl = core.buildCidTimeline([
    E('0901', 'VT', '2026-09-01 10:00:00', 'block'),
    E('0901', 'VT', '2026-09-01 14:00:00', 'reactive'),
  ], { windowEnd: end });

  const rows = core.enrichData(core.normalizeCallRecords([
    { caller_id_number: '0901', telco: 'Viettel', start_stamp: '2026-09-01 12:00:00',
      billsec: 10, hangup_cause: 'NORMAL_CLEARING' },
  ]), {});
  // moc cua CDR va cua timeline phai cung he quy chieu
  assert.equal(rows[0].start_ts, core.parseEventTs('2026-09-01 12:00:00'));

  const res = core.computeRoutingLeaks(tl, rows, { windowEnd: end });
  assert.equal(res.inClosed.calls, 1);   // 12:00 nam giua 10:00 va 14:00
  assert.equal(res.outside.calls, 0);
});

// ===== Dot 3: ap luc chan, dot can quet, ton that =====

test('computeBlockPressure — chi dem block, khong dem reactive', () => {
  const pr = core.computeBlockPressure([
    E('0901', 'VT', '2026-09-01 10:00:00', 'block'),
    E('0901', 'VT', '2026-09-01 12:00:00', 'reactive'),   // khong duoc dem
    E('0902', 'MB', '2026-09-01 11:00:00', 'block'),
    E('0903', 'VT', '2026-09-02 10:00:00', 'block'),
  ], { days: ['2026-09-01', '2026-09-02'] });
  assert.deepEqual(pr.total, [2, 1]);
  assert.deepEqual(pr.byTelco.VT, [1, 1]);
  assert.deepEqual(pr.byTelco.MB, [1, 0]);
  assert.equal(pr.peakDay, '2026-09-01');
});

test('computeBlockPressure — MA7 de null khi chua du 7 ngay', () => {
  const days = Array.from({ length: 9 }, (_, i) => `2026-09-0${i + 1}`);
  const ev = days.map((d, i) => E('090' + i, 'VT', d + ' 10:00:00', 'block'));
  const pr = core.computeBlockPressure(ev, { days });
  // 6 diem dau phai la null, khong duoc chia cho so ngay it hon
  assert.deepEqual(pr.ma7.slice(0, 6), [null, null, null, null, null, null]);
  assert.equal(pr.ma7[6], 1);
});

test('computeBlockBursts — bat cum dong, bo qua nen thua thot', () => {
  const ev = [];
  // nen: moi lat 1 su kien, rai deu
  for (let i = 0; i < 40; i++) ev.push(E('09' + i, 'VT', `2026-09-01 ${String(i % 24).padStart(2, '0')}:03:00`, 'block'));
  // dot can quet: 12 CID bi khoa trong cung 1 lat 5 phut
  for (let i = 0; i < 12; i++) ev.push(E('088' + i, 'MB', '2026-09-02 09:31:0' + (i % 10), 'block'));

  const r = core.computeBlockBursts(ev, { bucketMinutes: 5, minCount: 8 });
  assert.equal(r.bursts.length, 1);
  assert.equal(r.bursts[0].blocks, 12);
  assert.equal(r.bursts[0].cids, 12);
  assert.deepEqual(r.bursts[0].telcos, [{ telco: 'MB', count: 12 }]);
});

test('computeBlockBursts — noi ro nguong den tu san tuyet doi khi MAD=0', () => {
  // phan bo lech (hau het lat co 1 su kien) -> MAD=0 -> nguong thong ke sup do
  const ev = Array.from({ length: 30 }, (_, i) =>
    E('09' + i, 'VT', `2026-09-01 ${String(i).padStart(2, '0')}:00:00`, 'block'));
  const r = core.computeBlockBursts(ev, { bucketMinutes: 5, minCount: 8 });
  assert.equal(r.mad, 0);
  assert.equal(r.thresholdSource, 'floor');   // phai bao, khong duoc im lang
  assert.equal(r.threshold, 8);
});

test('computeDeadNumberLoss — ton that la KET NOI mat, suy tu nen quan sat duoc', () => {
  const end = Date.parse('2026-09-03T00:00:00');
  const tl = core.buildCidTimeline([
    E('0902', 'VT', '2026-09-01 10:00:00', 'block'),   // khong bao gio mo lai
  ], { windowEnd: end });

  const call = (caller, stamp, billsec) => ({
    caller_id_number: caller, telco: 'Viettel', start_stamp: stamp, billsec,
    hangup_cause: billsec ? 'NORMAL_CLEARING' : 'NO_USER_RESPONSE',
  });
  const rows = [];
  // nen: 10 cuoc ngoai khoang khoa, 5 ket noi, moi cuoc 60s -> 50% & 60s
  for (let i = 0; i < 10; i++) rows.push(call('0901', '2026-09-01 08:0' + i + ':00', i < 5 ? 60 : 0));
  // 4 cuoc bam vao so da chet, khong cuoc nao ket noi
  for (let i = 0; i < 4; i++) rows.push(call('0902', '2026-09-01 11:0' + i + ':00', 0));

  const loss = core.computeDeadNumberLoss(tl, core.enrichData(core.normalizeCallRecords(rows), {}),
                                          { minBaseCalls: 5 });
  assert.equal(loss.wastedCalls, 4);
  assert.equal(loss.baseCalls, 10);
  assert.equal(loss.baseConnectRate, 50);
  assert.equal(loss.baseAvgBillsec, 60);
  assert.equal(loss.lostConnections, 2);      // 4 luot x 50%
  assert.equal(loss.lostMinutes, 2);          // 2 ket noi x 60s
  assert.equal(loss.reliable, true);
});

test('computeDeadNumberLoss — thieu mau nen thi phai bao khong dang tin', () => {
  const end = Date.parse('2026-09-03T00:00:00');
  const tl = core.buildCidTimeline([E('0902', 'VT', '2026-09-01 10:00:00', 'block')], { windowEnd: end });
  const rows = core.enrichData(core.normalizeCallRecords([
    { caller_id_number: '0902', telco: 'Viettel', start_stamp: '2026-09-01 11:00:00',
      billsec: 0, hangup_cause: 'NO_USER_RESPONSE' },
  ]), {});
  const loss = core.computeDeadNumberLoss(tl, rows);
  assert.equal(loss.wastedCalls, 1);
  assert.equal(loss.baseCalls, 0);
  assert.equal(loss.reliable, false);         // khong co nen -> khong duoc tin
});
