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

test('UI_LABELS bao phủ mọi trạng thái cuộc gọi', () => {
  assert.equal(Object.isFrozen(core.UI_LABELS), true);
  for (const value of ['Connected', 'No Answer', 'Cancelled', 'Fail', 'Unknown']) {
    assert.ok(core.statusLabel(value).trim(), value);
  }
  assert.equal(core.statusLabel('No Answer'), 'Không nghe');
  assert.equal(core.statusLabel('Unknown'), 'Không rõ');
});

test('classifyCall theo thứ tự ưu tiên nghiệp vụ', () => {
  assert.equal(core.classifyCall({ hangup_cause: 'NO_ROUTE_DESTINATION', billsec: 5 }), 'Fail'); // Fail cause đè cả billsec
  assert.equal(core.classifyCall({ hangup_cause: 'NORMAL_CLEARING', billsec: 30 }), 'Connected');
  assert.equal(core.classifyCall({ hangup_cause: 'ORIGINATOR_CANCEL', billsec: 0, duration: 0 }), 'Cancelled');
  assert.equal(core.classifyCall({ hangup_cause: 'USER_BUSY', billsec: 0, duration: 0 }), 'No Answer');
  assert.equal(core.classifyCall({ hangup_cause: 'NORMAL_CLEARING', billsec: 0, duration: 4 }), 'No Answer');
  assert.equal(core.classifyCall({ hangup_cause: 'NORMAL_CLEARING', billsec: 0, duration: 0 }), 'Fail');
});

test('chuỗi ASR theo Account giữ ID ổn định khi gán màu biểu đồ', () => {
  const rows = [
    { date:'2026-10-12', account_id:'351', account_name:'VCLASS BOT', connType:'Connected' },
    { date:'2026-10-12', account_id:'548', account_name:'Sales', connType:'No Answer' }
  ];
  const series = core.computeAnswerRateByAccountPerDay(rows).series;
  assert.deepEqual(series.map(({acc,name})=>({acc,name})), [
    {acc:'351',name:'VCLASS BOT'}, {acc:'548',name:'Sales'}
  ]);
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
  assert.equal(cube.overview.connectRateExcludingFail, +(2 / 3 * 100).toFixed(2));
  assert.equal(cube.overview.billsecMetrics.totalBillsec, 120);      // 90 + 0 + 30
  assert.equal(cube.minutesPerDay.dates[0], '2026-09-03');
  assert.equal(cube.minutesPerDay.minutes[0], +(120 / 60).toFixed(2));
  assert.ok(cube.byPrefix && typeof cube.byPrefix === 'object');
  assert.ok(cube.columnHealth && Array.isArray(cube.columnHealth.required));
  assert.ok(cube.timeAnomaly && typeof cube.timeAnomaly.endBeforeStart === 'number');
  assert.equal(cube.operationalAlerts.scope.mode, 'full');
  assert.equal(cube.operationalAlerts.scope.rows, 3);
});

test('ASR hợp lệ và Kết nối loại Fail dùng hai mẫu số khác nhau', () => {
  const counts={Fail:2,'No Answer':3,Cancelled:4,Connected:5,Unknown:1};
  assert.equal(core.computeASRExcludingFail(counts), 62.5);          // 5/(5+3)
  assert.equal(core.computeConnectRateExcludingFail(counts), 38.46); // 5/(15-2)
  assert.equal(core.computeConnectRate(counts), 33.33);             // 5/15
});

test('resolveDateRangePreset dùng metadata toàn bộ thay vì mẫu 50k dòng đầu', () => {
  assert.deepEqual(core.resolveDateRangePreset('all','2026-09-14','2026-09-20'),
    {startDate:'2026-09-14',endDate:'2026-09-20'});
  assert.deepEqual(core.resolveDateRangePreset('latest','2026-09-14','2026-09-20'),
    {startDate:'2026-09-20',endDate:'2026-09-20'});
  assert.deepEqual(core.resolveDateRangePreset(7,'2026-09-14','2026-09-20'),
    {startDate:'2026-09-14',endDate:'2026-09-20'});
  assert.deepEqual(core.resolveDateRangePreset(30,'2026-09-14','2026-09-20'),
    {startDate:'2026-09-14',endDate:'2026-09-20'});
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
    'answerRateByAccountPerDay', 'agentPerf', 'gatewayByAccount', 'gatewayHangupCause', 'gatewayFailTimeline', 'operationalAlerts',
    'gatewayBlockReconcile', 'callbackStats', 'retryPattern', 'concurrency', 'billing']) {
    assert.ok(k in cube, `thiếu cube.${k}`);
  }
  // gateway trên toàn bộ dòng (không có gwIndex -> mọi cuộc vào nhóm '(chưa map)')
  assert.equal(cube.gatewayByAccount.coverage.total, 3);
  assert.equal(cube.gatewayByAccount.coverage.matched, 0);
  assert.deepEqual(cube.gatewayFailTimeline.series, []);   // chưa map gateway -> không series
  assert.deepEqual(cube.gatewayBlockReconcile, []);
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

test('buildCidTimeline — ba trang thai: binh thuong / do >24h / chet >48h', () => {
  const end = Date.parse('2026-09-08T00:00:00');
  const tl = core.buildCidTimeline([
    // A: chua reactive, da qua 48h -> CHET (va dĩ nhien cung dang do)
    E('0901', 'VT', '2026-09-01 00:00:00', 'block'),
    // B: chua reactive, moi qua 24h chua toi 48h -> DO nhung CHUA chet
    E('0902', 'VT', '2026-09-06 12:00:00', 'block'),
    // C: chua reactive, moi 6h -> chua do
    E('0903', 'VT', '2026-09-07 18:00:00', 'block'),
    // D: quay lai sau 30h -> da tung do nhung KHONG duoc dem la chet
    E('0904', 'VT', '2026-09-01 00:00:00', 'block'),
    E('0904', 'VT', '2026-09-02 06:00:00', 'reactive'),
    // E: quay lai sau 60h -> muon hon ca moc chet
    E('0905', 'VT', '2026-09-01 00:00:00', 'block'),
    E('0905', 'VT', '2026-09-03 12:00:00', 'reactive'),
  ], { windowEnd: end });
  const pick = cid => tl.intervals.find(iv => iv.cid === cid);

  assert.equal(pick('0901').presumedDead, true);
  assert.equal(pick('0901').atRisk, true);          // chet thi cung nam trong nhom do
  assert.equal(pick('0902').atRisk, true);
  assert.equal(pick('0902').presumedDead, false);   // chua toi 48h
  assert.equal(pick('0903').atRisk, false);
  assert.equal(pick('0904').recoveredAfterWarn, true);
  assert.equal(pick('0904').lateRecovery, false);   // 30h: qua moc do, chua qua moc chet
  assert.equal(pick('0905').lateRecovery, true);    // 60h: qua ca moc chet

  const m = core.computeBlockMttr(tl);
  assert.equal(m.warnAfterMin, 1440);
  assert.equal(m.deadAfterMin, 2880);
  assert.equal(m.presumedDead, 1);
  assert.equal(m.atRisk, 2);                        // 0901 + 0902
  assert.equal(m.atRiskNotDead, 1);                 // rieng 0902 con cuu duoc
  assert.equal(m.recoveredAfterWarn, 2);            // 0904 + 0905
  assert.equal(m.lateRecovery, 1);                  // rieng 0905
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

test('filterCidScope — bộ lọc account chỉ giữ routing và sự kiện tương ứng', () => {
  const scoped = core.filterCidScope({
    selectedAccountIds: ['a1', 'a2', 'a3'],
    accounts: [
      { id: 'a1', name: 'ROUTE_BY_NAME' },
      { id: 'a2', name: 'Account mapped' },
      { id: 'a3', name: 'Chưa map' },
    ],
    routings: [
      { id: 'r1', name: 'ROUTE_BY_NAME' },
      { id: 'r2', name: 'ROUTE_BY_ID' },
      { id: 'r9', name: 'ROUTE_OTHER' },
    ],
    mappingRows: [{ account_id: 'a2', routing_id: 'r2', routing_name: 'ROUTE_BY_ID' }],
    events: [
      E('0901', 'VT', '2026-09-01 10:00:00', 'block', 'ROUTE_BY_NAME'),
      E('0902', 'VT', '2026-09-01 10:00:00', 'block', 'ROUTE_BY_ID'),
      E('0909', 'VT', '2026-09-01 10:00:00', 'block', 'ROUTE_OTHER'),
    ],
  });
  assert.equal(scoped.filtered, true);
  assert.deepEqual(scoped.routings.map(r => r.id), ['r1', 'r2']);
  assert.deepEqual(scoped.events.map(e => e.routing), ['ROUTE_BY_NAME', 'ROUTE_BY_ID']);
  assert.deepEqual(scoped.unmappedAccounts.map(a => a.id), ['a3']);
});

test('filterCidScope — không chọn account nghĩa là xem toàn bộ routing', () => {
  const events = [E('0901', 'VT', '2026-09-01 10:00:00', 'block', 'R1')];
  const scoped = core.filterCidScope({ selectedAccountIds: [], accounts: [],
    routings: [{ id: '1', name: 'R1' }], events });
  assert.equal(scoped.filtered, false);
  assert.equal(scoped.events, events);
  assert.equal(scoped.routings.length, 1);
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
  assert.equal(res.hitCount, 0);         // khoa VT khong anh huong cuoc goi MB
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

// ===== Dot 4: tai vs rui ro, chi bao som =====

const callAt = (caller, stamp, billsec, dest) => ({
  caller_id_number: caller, telco: 'Viettel', start_stamp: stamp, billsec,
  destination_number: dest || '0912000001',
  hangup_cause: billsec ? 'NORMAL_CLEARING' : 'NO_USER_RESPONSE',
});

test('computeLoadVsBlockRisk — loai ngay ma CID DANG bi khoa san', () => {
  const end = Date.parse('2026-09-10T00:00:00');
  const tl = core.buildCidTimeline([
    E('0902', 'VT', '2026-09-01 08:00:00', 'block'),   // khong mo lai -> chet
  ], { windowEnd: end });
  // 0902 van bi quay so trong luc dang khoa -> khong duoc tinh la quan sat
  const rows = core.enrichData(core.normalizeCallRecords([
    callAt('0902', '2026-09-02 09:00:00', 0),
    callAt('0902', '2026-09-03 09:00:00', 0),
  ]), {});
  const r = core.computeLoadVsBlockRisk(tl, rows, { windowEnd: end });
  assert.equal(r.observations, 0);
  assert.equal(r.excludedAlreadyBlocked, 2);
});

test('computeLoadVsBlockRisk — bo ngay khong du horizon de khong dem thieu ca bi khoa', () => {
  const end = Date.parse('2026-09-02T00:00:00');
  const tl = core.buildCidTimeline([], { windowEnd: end });
  const rows = core.enrichData(core.normalizeCallRecords([
    callAt('0901', '2026-09-01 20:00:00', 10),   // chi con 4h den cuoi cua so
  ]), {});
  const r = core.computeLoadVsBlockRisk(tl, rows, { windowEnd: end, horizonHours: 24 });
  assert.equal(r.observations, 0);
  assert.equal(r.excludedNoRoom, 1);
});

test('computeLoadVsBlockRisk — eligibleOnly loai CID chua tung bi khoa (bay thanh phan mau)', () => {
  const end = Date.parse('2026-09-10T00:00:00');
  const tl = core.buildCidTimeline([
    E('0902', 'VT', '2026-09-03 08:00:00', 'block'),
    E('0902', 'VT', '2026-09-03 12:00:00', 'reactive'),
  ], { windowEnd: end });
  const rows = core.enrichData(core.normalizeCallRecords([
    callAt('0901', '2026-09-01 09:00:00', 10),   // chua bao gio bi khoa
    callAt('0902', '2026-09-02 09:00:00', 10),   // co trong log block
  ]), {});

  const all = core.computeLoadVsBlockRisk(tl, rows, { windowEnd: end });
  assert.equal(all.observations, 2);
  assert.equal(all.excludedNeverBlocked, 0);

  const elig = core.computeLoadVsBlockRisk(tl, rows, { windowEnd: end, eligibleOnly: true });
  assert.equal(elig.observations, 1);           // chi con 0902
  assert.equal(elig.excludedNeverBlocked, 1);
  assert.equal(elig.eligibleOnly, true);
});

test('computeBlockPrecursors — khong du tach bach thi hasSignal phai la false', () => {
  const end = Date.parse('2026-09-10T00:00:00');
  const tl = core.buildCidTimeline([
    E('0901', 'VT', '2026-09-05 12:00:00', 'block'),
  ], { windowEnd: end });
  // luu luong deu nhau truoc va sau -> khong co gi phan biet
  const raw = [];
  for(let d = 1; d <= 8; d++)
    for(let h = 0; h < 6; h++)
      raw.push(callAt('0901', `2026-09-0${d} 0${h}:00:00`, 20, '09120000' + h));
  const r = core.computeBlockPrecursors(tl, core.enrichData(core.normalizeCallRecords(raw), {}),
                                        { windowHours: 24, minCases: 1 });
  assert.ok(r.cases >= 1);
  assert.equal(r.hasSignal, false);            // khong duoc bao co tin hieu
  assert.deepEqual(r.signalMetrics, []);
});

test('computeBlockPrecursors — cua so doi chung khong duoc lay tu luc dang bi khoa', () => {
  const end = Date.parse('2026-09-10T00:00:00');
  const tl = core.buildCidTimeline([
    E('0901', 'VT', '2026-09-02 00:00:00', 'block'),   // chet han tu 02/09
  ], { windowEnd: end });
  const raw = [];
  for(let d = 1; d <= 9; d++) raw.push(callAt('0901', `2026-09-0${d} 10:00:00`, 0));
  const r = core.computeBlockPrecursors(tl, core.enrichData(core.normalizeCallRecords(raw), {}),
                                        { windowHours: 24 });
  // moi thoi diem tu 02/09 tro di deu nam trong khoang bi khoa -> khong control nao
  assert.equal(r.controls, 0);
});

test('computeBlockPrecursors — "mau qua nho" phai tach khoi "da do, khong thay gi"', () => {
  // Bug that: gop hai ket luan lam mot sinh ra cau "khong chi so nao dat nguong"
  // ngay ben canh mot bang day chi so vuot nguong.
  const end = Date.parse('2026-09-10T00:00:00');
  const tl = core.buildCidTimeline([
    E('0901', 'VT', '2026-09-05 12:00:00', 'block'),
    E('0901', 'VT', '2026-09-05 18:00:00', 'reactive'),
  ], { windowEnd: end });
  const raw = [];
  // truoc block: khong ket noi cuoc nao
  for(let h = 0; h < 20; h++) raw.push(callAt('0901', `2026-09-05 ${String(h % 12).padStart(2,'0')}:30:00`, 0));
  // doi chung: ket noi tot NHUNG PHAI DAO DONG giua cac ngay — neu moi cua so
  // giong het nhau thi do lech chuan = 0, pooled SD = 0 va d = 0 cho tat ca.
  for(let d = 1; d <= 4; d++)
    for(let h = 0; h < 20; h++)
      raw.push(callAt('0901', `2026-09-0${d} ${String(h % 12).padStart(2,'0')}:30:00`,
                      h < 12 + d ? 40 + d * 5 : 0));
  const rows = core.enrichData(core.normalizeCallRecords(raw), {});

  const r = core.computeBlockPrecursors(tl, rows, { windowHours: 24, minCases: 30 });
  assert.ok(r.cases < 30);
  assert.equal(r.insufficientSample, true);
  assert.equal(r.hasSignal, false);
  // co chi so vuot nguong -> khong duoc noi "khong chi so nao dat nguong"
  assert.ok(r.metrics.some(m => m.absD >= 0.5),
    'fixture phai sinh it nhat mot chi so manh de bat duoc mau thuan');

  // du mau thi moi duoc ket luan
  const r2 = core.computeBlockPrecursors(tl, rows, { windowHours: 24, minCases: 1 });
  assert.equal(r2.insufficientSample, false);
  assert.equal(r2.hasSignal, true);
});

// ===== Nguyen tac don / kep truoc khi khoa =====

test('computeBlockSignalPatterns — nguong lay tu PHAN VI DOI CHUNG, khong dat tay', () => {
  const end = Date.parse('2026-09-20T00:00:00');
  const tl = core.buildCidTimeline([
    E('0901', 'VT', '2026-09-10 12:00:00', 'block'),
    E('0901', 'VT', '2026-09-10 18:00:00', 'reactive'),
  ], { windowEnd: end });
  const raw = [];
  // doi chung: 2 cuoc/gio, ket noi 30s
  for(let d = 1; d <= 9; d++)
    for(let h = 0; h < 12; h++)
      raw.push(callAt('0901', `2026-09-0${d} ${String(h).padStart(2,'0')}:00:00`, 30));
  // truoc block: quay so day dac hon han
  for(let m = 0; m < 40; m++)
    raw.push(callAt('0901', `2026-09-10 ${String(6 + Math.floor(m/10)).padStart(2,'0')}:${String((m%10)*6).padStart(2,'0')}:00`, 30));
  const rows = core.enrichData(core.normalizeCallRecords(raw), {});

  const r = core.computeBlockSignalPatterns(tl, rows, { windowHours: 6, minCases: 1 });
  assert.ok(r.cases >= 1 && r.controls >= 1);
  assert.ok(r.thresholds.callsPerHourHi > 0, 'ngưỡng tần suất phải suy từ dữ liệu');
  assert.equal(r.thresholds.hiPercentile, 80);
  assert.equal(r.thresholds.loPercentile, 20);
  // tong phan bo phai bang 100%
  const sum = r.distribution.reduce((s, d) => s + d.casePct, 0);
  assert.ok(Math.abs(sum - 100) < 0.001);
});

test('computeBlockSignalPatterns — bao ngay khi nguong thoi luong bi suy bien ve 0', () => {
  const end = Date.parse('2026-09-20T00:00:00');
  const tl = core.buildCidTimeline([
    E('0901', 'VT', '2026-09-10 12:00:00', 'block'),
  ], { windowEnd: end });
  const raw = [];
  // phan lon cua so doi chung KHONG noi duoc cuoc nao -> p20 cua avgBillsec = 0
  for(let d = 1; d <= 9; d++)
    for(let h = 0; h < 12; h++)
      raw.push(callAt('0901', `2026-09-0${d} ${String(h).padStart(2,'0')}:00:00`, 0));
  // phai co cuoc trong 6h ngay truoc block, khong thi khong sinh case nao
  for(let h = 6; h < 12; h++) raw.push(callAt('0901', `2026-09-10 ${String(h).padStart(2,'0')}:00:00`, 0));
  const rows = core.enrichData(core.normalizeCallRecords(raw), {});
  const r = core.computeBlockSignalPatterns(tl, rows, { windowHours: 6, minCases: 1 });
  assert.equal(r.thresholds.avgBillsecLo, 0);
  assert.equal(r.thresholds.durationDegenerate, true);
});

test('computeBlockSignalPatterns — luon tinh song song doi chung de co lift', () => {
  const end = Date.parse('2026-09-20T00:00:00');
  const tl = core.buildCidTimeline([
    E('0901', 'VT', '2026-09-10 12:00:00', 'block'),
  ], { windowEnd: end });
  const raw = [];
  for(let d = 1; d <= 9; d++)
    for(let h = 0; h < 12; h++) raw.push(callAt('0901', `2026-09-0${d} ${String(h).padStart(2,'0')}:00:00`, 30));
  const rows = core.enrichData(core.normalizeCallRecords(raw), {});
  const r = core.computeBlockSignalPatterns(tl, rows, { windowHours: 6, minCases: 1 });
  // moi dong phai co ca hai phia; khong co doi chung thi % truoc khoa vo nghia
  r.distribution.forEach(d=>{
    assert.equal(typeof d.casePct, 'number');
    assert.equal(typeof d.controlPct, 'number');
  });
  assert.ok(r.combos.every(c => typeof c.controlPct === 'number'));
});

test('computeBlockSignalPatterns — thieu case hoac control thi bao insufficientSample', () => {
  const end = Date.parse('2026-09-20T00:00:00');
  const tl = core.buildCidTimeline([], { windowEnd: end });   // khong co block nao
  const rows = core.enrichData(core.normalizeCallRecords([
    callAt('0901', '2026-09-10 10:00:00', 30),
  ]), {});
  const r = core.computeBlockSignalPatterns(tl, rows, { windowHours: 6 });
  assert.equal(r.cases, 0);
  assert.equal(r.insufficientSample, true);
  assert.deepEqual(r.distribution, []);
});

test('computeRoutingLeaks — khong dung mang `hits` nua, chi giu so lieu', () => {
  // Tren du lieu that mang do len toi 74.339 phan tu / 19,2 MB ma giao dien
  // khong hien thi phan tu nao.
  const end = Date.parse('2026-09-03T00:00:00');
  const tl = core.buildCidTimeline([
    E('0902', 'VT', '2026-09-01 10:00:00', 'block'),
  ], { windowEnd: end });
  const rows = core.enrichData(core.normalizeCallRecords([
    { caller_id_number: '0902', telco: 'Viettel', start_stamp: '2026-09-01 11:00:00',
      billsec: 0, hangup_cause: 'NO_USER_RESPONSE' },
    { caller_id_number: '0902', telco: 'Viettel', start_stamp: '2026-09-01 12:00:00',
      billsec: 0, hangup_cause: 'NO_USER_RESPONSE' },
  ]), {});

  const r = core.computeRoutingLeaks(tl, rows, { windowEnd: end });
  assert.equal(r.hitCount, 2);
  assert.equal(r.hits, undefined);        // khong con tra ve mang day du
  assert.deepEqual(r.sample, []);         // mac dinh khong giu mau nao

  // van lay duoc vai dong vi du khi can soi
  const r2 = core.computeRoutingLeaks(tl, rows, { windowEnd: end, sampleLimit: 1 });
  assert.equal(r2.sample.length, 1);
  assert.equal(r2.sample[0].cid, '0902');
});

test('computeDeadNumberLoss — dung lai nen tu leaks, khong quet lai CDR', () => {
  const end = Date.parse('2026-09-03T00:00:00');
  const tl = core.buildCidTimeline([
    E('0902', 'VT', '2026-09-01 10:00:00', 'block'),
  ], { windowEnd: end });
  const call = (caller, stamp, billsec) => ({
    caller_id_number: caller, telco: 'Viettel', start_stamp: stamp, billsec,
    hangup_cause: billsec ? 'NORMAL_CLEARING' : 'NO_USER_RESPONSE',
  });
  const rows = [];
  for(let i = 0; i < 10; i++) rows.push(call('0901', '2026-09-01 08:0' + i + ':00', i < 5 ? 60 : 0));
  for(let i = 0; i < 4; i++)  rows.push(call('0902', '2026-09-01 11:0' + i + ':00', 0));
  const enriched = core.enrichData(core.normalizeCallRecords(rows), {});

  const auto = core.computeDeadNumberLoss(tl, enriched, { windowEnd: end, minBaseCalls: 5 });
  const leaks = core.computeRoutingLeaks(tl, enriched, { windowEnd: end });
  const reused = core.computeDeadNumberLoss(tl, enriched, { windowEnd: end, minBaseCalls: 5, leaks });

  // truyen leaks vao hay de tu tinh deu phai ra y het nhau
  assert.deepEqual(reused, auto);
  assert.equal(auto.baseCalls, 10);
  assert.equal(auto.baseConnectRate, 50);
  assert.equal(auto.baseAvgBillsec, 60);
  assert.equal(auto.lostConnections, 2);
});

test('buildPrecursorWindows — dung mot lan, dung chung cho ca hai phep phan tich', () => {
  const end = Date.parse('2026-09-20T00:00:00');
  const tl = core.buildCidTimeline([
    E('0901', 'VT', '2026-09-10 12:00:00', 'block'),
    E('0901', 'VT', '2026-09-10 18:00:00', 'reactive'),
  ], { windowEnd: end });
  const raw = [];
  for(let d = 1; d <= 9; d++)
    for(let h = 0; h < 12; h++) raw.push(callAt('0901', `2026-09-0${d} ${String(h).padStart(2,'0')}:00:00`, 30));
  for(let h = 6; h < 12; h++) raw.push(callAt('0901', `2026-09-10 ${String(h).padStart(2,'0')}:00:00`, 30));
  const rows = core.enrichData(core.normalizeCallRecords(raw), {});
  const opts = { windowHours: 6, windowEnd: end, minCases: 1 };

  const windows = core.buildPrecursorWindows(tl, rows, opts);
  assert.ok(windows.caseWindows.length >= 1);
  assert.ok(windows.controlWindows.length >= 1);

  // ket qua phai y het du dung cua so truyen vao hay de tu dung
  const a1 = core.computeBlockPrecursors(tl, rows, opts);
  const a2 = core.computeBlockPrecursors(tl, rows, { ...opts, windows });
  assert.deepEqual(a2, a1);
  const b1 = core.computeBlockSignalPatterns(tl, rows, opts);
  const b2 = core.computeBlockSignalPatterns(tl, rows, { ...opts, windows });
  assert.deepEqual(b2, b1);
});

// ===== Ngay hoat dong + tin hieu theo tung account =====

test('countActiveDays — ngay lich khac ngay CO luu luong', () => {
  const raw = [];
  // 3 ngay binh thuong 100 cuoc/ngay
  for(const d of ['01','02','03'])
    for(let i = 0; i < 100; i++) raw.push(callAt('0901', `2026-09-${d} 10:${String(i%60).padStart(2,'0')}:00`, 20));
  // 1 ngay gan nhu chet (2 cuoc)
  raw.push(callAt('0901', '2026-09-04 10:00:00', 20));
  raw.push(callAt('0901', '2026-09-04 10:01:00', 20));
  const rows = core.enrichData(core.normalizeCallRecords(raw), {});

  const a = core.countActiveDays(rows);
  assert.equal(a.calendarDays, 4);
  assert.equal(a.activeDays, 3);              // ngay 04 khong tinh
  assert.deepEqual(a.deadDays, ['2026-09-04']);
});

test('computeSignalsByAccount — tach theo account, gop lai co the lam loang tin hieu', () => {
  const end = Date.parse('2026-09-20T00:00:00');
  const tl = core.buildCidTimeline([
    E('0901', 'VT', '2026-09-10 12:00:00', 'block'),
    E('0901', 'VT', '2026-09-10 18:00:00', 'reactive'),
    E('0902', 'VT', '2026-09-10 12:00:00', 'block'),
    E('0902', 'VT', '2026-09-10 18:00:00', 'reactive'),
  ], { windowEnd: end });

  const mk = (caller, acc, stamp, billsec) => ({
    caller_id_number: caller, account_name: acc, telco: 'Viettel',
    start_stamp: stamp, billsec, destination_number: '09120000' + (billsec % 9),
    hangup_cause: billsec ? 'NORMAL_CLEARING' : 'NO_USER_RESPONSE',
  });
  const raw = [];
  for(let d = 1; d <= 9; d++)
    for(let h = 0; h < 12; h++){
      raw.push(mk('0901', 'AccA', `2026-09-0${d} ${String(h).padStart(2,'0')}:00:00`, 30));
      raw.push(mk('0902', 'AccB', `2026-09-0${d} ${String(h).padStart(2,'0')}:00:00`, 30));
    }
  for(let h = 6; h < 12; h++){
    raw.push(mk('0901', 'AccA', `2026-09-10 ${String(h).padStart(2,'0')}:00:00`, 30));
    raw.push(mk('0902', 'AccB', `2026-09-10 ${String(h).padStart(2,'0')}:00:00`, 30));
  }
  const rows = core.enrichData(core.normalizeCallRecords(raw), {});

  const r = core.computeSignalsByAccount(tl, rows, { windowHours: 6, windowEnd: end, minCases: 1 });
  assert.equal(r.accounts.length, 2);
  assert.deepEqual(r.accounts.map(a => a.account).sort(), ['AccA', 'AccB']);
  r.accounts.forEach(a=>{
    assert.ok(a.calls > 0);
    assert.ok(a.activeDays > 0);
    assert.equal(typeof a.hasSignal, 'boolean');
    // moi account phai duoc do rieng, khong dung lai ket qua cua nhau
    assert.ok(a.cases >= 1);
  });
});

test('computeSignalsByAccount — account khong co ten thi gom vao Unknown, khong bi mat', () => {
  const end = Date.parse('2026-09-20T00:00:00');
  const tl = core.buildCidTimeline([E('0901', 'VT', '2026-09-10 12:00:00', 'block')], { windowEnd: end });
  const rows = core.enrichData(core.normalizeCallRecords([
    { caller_id_number: '0901', telco: 'Viettel', start_stamp: '2026-09-10 10:00:00', billsec: 10 },
  ]), {});
  const r = core.computeSignalsByAccount(tl, rows, { windowHours: 6, windowEnd: end });
  assert.equal(r.accounts.length, 1);
  assert.ok(r.accounts[0].account);   // co nhan, khong phai chuoi rong
});

test('downsampleSeriesMin — giu day, khong che mat dot tut', () => {
  const x = [], y = [];
  for(let i = 0; i < 100; i++){ x.push(i); y.push(100); }
  y[37] = 5;                                  // mot dot tut duy nhat
  const d = core.downsampleSeriesMin(x, y, 10);
  assert.ok(d.x.length <= 10);
  assert.equal(Math.min(...d.y), 5, 'dot tut phai con lai sau khi rut gon');
  assert.ok(d.x.includes(37), 'phai giu dung moc thoi gian cua day');

  // duoi nguong thi tra ve nguyen ban
  const small = core.downsampleSeriesMin([1,2,3], [9,8,7], 10);
  assert.deepEqual(small, { x:[1,2,3], y:[9,8,7] });
});

test('downsampleSeriesMax van giu dinh — hai ham khong lan nhau', () => {
  const x = [], y = [];
  for(let i = 0; i < 100; i++){ x.push(i); y.push(50); }
  y[37] = 5; y[62] = 95;
  assert.equal(Math.min(...core.downsampleSeriesMin(x, y, 10).y), 5);
  assert.equal(Math.max(...core.downsampleSeriesMax(x, y, 10).y), 95);
});

test('CID lifecycle nâng cao — survival, tái khóa và biến động kho', () => {
  const end = Date.parse('2026-09-10T00:00:00');
  const tl = core.buildCidTimeline([
    E('0901','VT','2026-09-01 00:00:00','block'),
    E('0901','VT','2026-09-01 02:00:00','reactive'),
    E('0901','VT','2026-09-01 05:00:00','block'),
    E('0901','VT','2026-09-01 06:00:00','reactive'),
    E('0902','MB','2026-09-02 00:00:00','block'),
  ], {windowEnd:end});
  const survival = core.computeCidRecoverySurvival(tl,[1,3,48]);
  assert.equal(survival.series[0].name,'Tất cả');
  assert.equal(survival.series[0].total,3);
  assert.ok(survival.series[0].unrecoveredPct[0] >= survival.series[0].unrecoveredPct[1]);

  const reblock = core.computeCidReblockStats(tl,[1,6,24]);
  const all = reblock.rows.find(r=>r.name==='Tất cả');
  assert.equal(all.recovered,2);
  assert.equal(all.windows.find(w=>w.hour===6).reblocked,1);

  const trend = core.computeCidInventoryTrend(tl,{windowStart:Date.parse('2026-09-01T00:00:00'),windowEnd:end});
  assert.ok(trend.length>=9);
  assert.equal(trend[0].blocks,2);
  assert.ok(trend.some(d=>d.crossed48h===1));
});

test('CID lifecycle nâng cao — hàng đợi hành động và so sánh dimension', () => {
  const end = Date.parse('2026-09-10T00:00:00');
  const tl = core.buildCidTimeline([
    E('0901','VT','2026-09-01 00:00:00','block'),
    E('0902','MB','2026-09-08 00:00:00','block'),
  ], {windowEnd:end});
  const rows = core.enrichData(core.normalizeCallRecords([
    {account_id:'A1',caller_id_number:'0901',destination_number:'d1',start_stamp:'2026-09-03 00:00:00',billsec:0,duration:0,hangup_cause:'NO_ROUTE_DESTINATION',uuid:'q1'},
    {account_id:'A1',caller_id_number:'0901',destination_number:'d2',start_stamp:'2026-09-04 00:00:00',billsec:20,duration:30,hangup_cause:'NORMAL_CLEARING',uuid:'q2'},
    {account_id:'A2',caller_id_number:'0902',destination_number:'d3',start_stamp:'2026-09-09 00:00:00',billsec:0,duration:0,hangup_cause:'NO_ROUTE_DESTINATION',uuid:'q3'},
  ]),{}, {'0901':{gateway:'GW1'},'0902':{gateway:'GW2'}});
  const queue = core.computeCidActionQueue(tl,rows);
  assert.equal(queue.length,2);
  assert.equal(queue[0].cid,'0901');
  assert.equal(queue[0].priority,'Khẩn cấp');
  assert.equal(queue[0].gateway,'GW1');
  const gateways = core.computeCidDimensionComparison(tl,rows,'gateway');
  assert.deepEqual(gateways.map(x=>x.name).sort(),['GW1','GW2']);
  assert.equal(gateways.find(x=>x.name==='GW1').stillBlockedPct,100);
});

test('enrichData — gắn gateway/routing_name từ gatewayCidIndex (join qua caller_id_number)', () => {
  const raw = core.normalizeCallRecords([
    { account_id: '548', caller_id_number: '0994345507', destination_number: '0900000001',
      start_stamp: '2026-09-03 08:00:00', end_stamp: '2026-09-03 08:01:00',
      duration: 60, billsec: 40, hangup_cause: 'NORMAL_CLEARING', uuid: 'g1' },
    // 84-prefix trong CDR phải khớp CID dạng 0... trong index
    { account_id: '548', caller_id_number: '842888820733', destination_number: '0900000002',
      start_stamp: '2026-09-03 08:02:00', end_stamp: '2026-09-03 08:02:00',
      duration: 0, billsec: 0, hangup_cause: 'NO_ROUTE_DESTINATION', uuid: 'g2' },
    // CID không có trong index -> gateway rỗng
    { account_id: '548', caller_id_number: '0900999999', destination_number: '0900000003',
      start_stamp: '2026-09-03 08:03:00', end_stamp: '2026-09-03 08:03:30',
      duration: 30, billsec: 20, hangup_cause: 'NORMAL_CLEARING', uuid: 'g3' }
  ]);
  const gwIndex = {
    '0994345507': { account_id: '548', routing_id: '6151', routing_name: 'SIP_MTC_AUTOCALL', gateway: 'GIP2_new', telco_status: { viettel: 'PAUSE' } },
    '02888820733': { account_id: '548', routing_id: '6151', routing_name: 'SIP_MTC_AUTOCALL', gateway: 'Digi_bk', telco_status: {} }
  };
  const enriched = core.enrichData(raw, {}, gwIndex);
  assert.equal(enriched[0].gateway, 'GIP2_new');
  assert.equal(enriched[0].routing_name, 'SIP_MTC_AUTOCALL');
  assert.deepEqual(enriched[0].gw_telco_status, { viettel: 'PAUSE' });
  assert.equal(enriched[1].gateway, 'Digi_bk');       // 84... -> 0... join
  assert.equal(enriched[2].gateway, '');              // ngoài index
  // không truyền index -> không có gateway, không vỡ
  assert.equal(core.enrichData(raw, {})[0].gateway, '');
});

test('computeGatewayByAccount — gộp account×gateway + độ phủ', () => {
  const raw = core.normalizeCallRecords([
    { account_id: '548', caller_id_number: '0994345507', destination_number: '0900000001',
      start_stamp: '2026-09-03 08:00:00', end_stamp: '2026-09-03 08:01:00', duration: 60, billsec: 60, hangup_cause: 'NORMAL_CLEARING', uuid: 'a1' },
    { account_id: '548', caller_id_number: '0994345507', destination_number: '0900000002',
      start_stamp: '2026-09-03 08:01:00', end_stamp: '2026-09-03 08:01:00', duration: 0, billsec: 0, hangup_cause: 'NO_ROUTE_DESTINATION', uuid: 'a2' },
    { account_id: '548', caller_id_number: '0994999999', destination_number: '0900000003',
      start_stamp: '2026-09-03 08:02:00', end_stamp: '2026-09-03 08:02:30', duration: 30, billsec: 20, hangup_cause: 'NORMAL_CLEARING', uuid: 'a3' }
  ]);
  const gwIndex = { '0994345507': { account_id: '548', routing_name: 'SIP_MTC_AUTOCALL', gateway: 'GIP2_new', telco_status: {} } };
  const res = core.computeGatewayByAccount(core.enrichData(raw, {}, gwIndex));
  assert.equal(res.coverage.total, 3);
  assert.equal(res.coverage.matched, 2);
  assert.equal(res.coverage.pct, 66.67);
  const gip = res.rows.find(r => r.gateway === 'GIP2_new');
  assert.equal(gip.total, 2);
  assert.equal(gip.connected, 1);
  assert.equal(gip.fail, 1);
  assert.equal(gip.failPct, 50);
  assert.equal(gip.connectRate, 50);
  assert.equal(gip.connectExclFailRate, 100);
  const unmapped = res.rows.find(r => r.gateway === '(chưa map)');
  assert.equal(unmapped.total, 1);
  assert.equal(unmapped.mapped, false);
});

test('computeGatewayFail — gộp toàn bộ account theo gateway, xếp Fail% giảm dần', () => {
  const raw = core.normalizeCallRecords([
    // GIP2_new: 2 account, 4 cuộc, 3 fail -> 75%
    { account_id:'548', caller_id_number:'0994345507', destination_number:'d1', start_stamp:'2026-09-03 08:00:00', end_stamp:'2026-09-03 08:00:00', duration:0, billsec:0, hangup_cause:'NO_ROUTE_DESTINATION', uuid:'x1' },
    { account_id:'548', caller_id_number:'0994345507', destination_number:'d2', start_stamp:'2026-09-03 08:01:00', end_stamp:'2026-09-03 08:01:00', duration:0, billsec:0, hangup_cause:'NO_ROUTE_DESTINATION', uuid:'x2' },
    { account_id:'514', caller_id_number:'0994345507', destination_number:'d3', start_stamp:'2026-09-03 08:02:00', end_stamp:'2026-09-03 08:02:00', duration:0, billsec:0, hangup_cause:'NO_ROUTE_DESTINATION', uuid:'x3' },
    { account_id:'514', caller_id_number:'0994345507', destination_number:'d4', start_stamp:'2026-09-03 08:03:00', end_stamp:'2026-09-03 08:03:40', duration:40, billsec:30, hangup_cause:'NORMAL_CLEARING', uuid:'x4' },
    // Digi_bk: 1 account, 2 cuộc, 0 fail -> 0%
    { account_id:'548', caller_id_number:'02888820733', destination_number:'d5', start_stamp:'2026-09-03 08:04:00', end_stamp:'2026-09-03 08:04:30', duration:30, billsec:20, hangup_cause:'NORMAL_CLEARING', uuid:'x5' },
    { account_id:'548', caller_id_number:'02888820733', destination_number:'d6', start_stamp:'2026-09-03 08:05:00', end_stamp:'2026-09-03 08:05:00', duration:12, billsec:0, hangup_cause:'ORIGINATOR_CANCEL', uuid:'x6' },
    // chưa map -> không tính
    { account_id:'999', caller_id_number:'0900999999', destination_number:'d7', start_stamp:'2026-09-03 08:06:00', end_stamp:'2026-09-03 08:06:00', duration:0, billsec:0, hangup_cause:'NO_ROUTE_DESTINATION', uuid:'x7' }
  ]);
  const gwIndex = {
    '0994345507': { gateway:'GIP2_new', routing_name:'R1', telco_status:{} },
    '02888820733': { gateway:'Digi_bk', routing_name:'R2', telco_status:{} }
  };
  const res = core.computeGatewayFail(core.enrichData(raw, {}, gwIndex));
  assert.equal(res.coverage.total, 7);
  assert.equal(res.coverage.matched, 6);
  assert.deepEqual(res.rows.map(r => r.gateway), ['GIP2_new', 'Digi_bk']);  // Fail% giảm dần
  const gip = res.rows[0];
  assert.equal(gip.accountCount, 2);
  assert.equal(gip.total, 4);
  assert.equal(gip.fail, 3);
  assert.equal(gip.failPct, 75);
  assert.equal(gip.connectRate, 25);
  assert.equal(gip.connectExclFailRate, 100);
  assert.equal(res.rows[1].failPct, 0);
  assert.equal(res.rows[1].connectExclFailRate, 50);
  assert.equal(res.rows[1].accountCount, 1);
});

test('computeGatewayHangupCause — thống kê hangup_cause theo từng gateway', () => {
  const raw = core.normalizeCallRecords([
    { account_id:'548', caller_id_number:'0994345507', destination_number:'d1', start_stamp:'2026-09-03 08:00:00', end_stamp:'2026-09-03 08:00:00', duration:0, billsec:0, hangup_cause:'NO_ROUTE_DESTINATION', uuid:'h1' },
    { account_id:'548', caller_id_number:'0994345507', destination_number:'d2', start_stamp:'2026-09-03 08:01:00', end_stamp:'2026-09-03 08:01:00', duration:0, billsec:0, hangup_cause:'NO_ROUTE_DESTINATION', uuid:'h2' },
    { account_id:'548', caller_id_number:'0994345507', destination_number:'d3', start_stamp:'2026-09-03 08:02:00', end_stamp:'2026-09-03 08:03:00', duration:60, billsec:50, hangup_cause:'NORMAL_CLEARING', uuid:'h3' },
    { account_id:'548', caller_id_number:'02888820733', destination_number:'d4', start_stamp:'2026-09-03 08:04:00', end_stamp:'2026-09-03 08:04:20', duration:20, billsec:0, hangup_cause:'ORIGINATOR_CANCEL', uuid:'h4' },
    { account_id:'999', caller_id_number:'0900999999', destination_number:'d5', start_stamp:'2026-09-03 08:05:00', end_stamp:'2026-09-03 08:05:00', duration:0, billsec:0, hangup_cause:'NO_ROUTE_DESTINATION', uuid:'h5' }
  ]);
  const gwIndex = {
    '0994345507': { gateway:'GIP2_new', routing_name:'R1', telco_status:{} },
    '02888820733': { gateway:'Digi_bk', routing_name:'R2', telco_status:{} }
  };
  const res = core.computeGatewayHangupCause(core.enrichData(raw, {}, gwIndex));
  assert.equal(res.coverage.total, 5);
  assert.equal(res.coverage.matched, 4);
  const route = res.rows.find(r => r.gateway === 'GIP2_new' && r.hangup_cause === 'NO_ROUTE_DESTINATION');
  assert.equal(route.total, 2);
  assert.equal(route.gatewayTotal, 3);
  assert.equal(route.sharePct, 66.67);
  assert.equal(route.fail, 2);
  assert.equal(route.failSharePct, 66.67);
  assert.equal(route.failPct, 100);
  const normal = res.rows.find(r => r.gateway === 'GIP2_new' && r.hangup_cause === 'NORMAL_CLEARING');
  assert.equal(normal.connected, 1);
  const cancel = res.rows.find(r => r.gateway === 'Digi_bk' && r.hangup_cause === 'ORIGINATOR_CANCEL');
  assert.equal(cancel.cancelled, 1);
});

test('excelCellMatch — lọc cột kiểu Excel (chữ / toán tử số / khoảng)', () => {
  // chữ: chứa chuỗi, không phân biệt hoa/thường
  assert.equal(core.excelCellMatch('HNI_IMAP_VBN', 'imap', false), true);
  assert.equal(core.excelCellMatch('HNI_IMAP_VBN', 'xyz', false), false);
  assert.equal(core.excelCellMatch('bất kỳ', '', false), true);          // rỗng -> qua hết
  // số: toán tử
  assert.equal(core.excelCellMatch(13.88, '>10', true), true);
  assert.equal(core.excelCellMatch(13.88, '>20', true), false);
  assert.equal(core.excelCellMatch(80, '>=80', true), true);
  assert.equal(core.excelCellMatch(50, '<50', true), false);
  assert.equal(core.excelCellMatch(0, '=0', true), true);
  // số: khoảng a-b (kể cả đảo cận)
  assert.equal(core.excelCellMatch(15, '10-20', true), true);
  assert.equal(core.excelCellMatch(25, '10-20', true), false);
  assert.equal(core.excelCellMatch(15, '20-10', true), true);
  // số: không toán tử -> so chuỗi trên giá trị hiển thị
  assert.equal(core.excelCellMatch(13.88, '13', true), true);
  // rowPassesColFilters: AND nhiều cột
  const row = { gateway:'GIP2_new', failPct: 42, total: 500 };
  const num = new Set(['failPct','total']);
  assert.equal(core.rowPassesColFilters(row, { gateway:'gip', failPct:'>40' }, num), true);
  assert.equal(core.rowPassesColFilters(row, { gateway:'gip', failPct:'>50' }, num), false);
  assert.equal(core.rowPassesColFilters(row, {}, num), true);
});

test('computeGatewayFailTimeline — Fail% theo gateway × bucket, đứt đoạn khi rỗng', () => {
  const gwIndex = {
    '0994345507': { gateway: 'GIP2_new', routing_name: 'R', telco_status: {} },
    '02888820733': { gateway: 'Digi_bk', routing_name: 'R', telco_status: {} }
  };
  const mk = (cid, ts, hc, uuid) => ({ account_id:'548', caller_id_number:cid, destination_number:'0900000001',
    start_stamp: ts, end_stamp: ts, duration: hc==='NORMAL_CLEARING'?30:0, billsec: hc==='NORMAL_CLEARING'?20:0,
    hangup_cause: hc, uuid });
  const raw = core.normalizeCallRecords([
    mk('0994345507', '2026-09-05 09:00:00', 'NORMAL_CLEARING', 't1'),
    mk('0994345507', '2026-09-05 09:10:00', 'NO_ROUTE_DESTINATION', 't2'),  // cùng bucket 09:00
    mk('0994345507', '2026-09-05 10:05:00', 'NO_ROUTE_DESTINATION', 't3'),  // bucket 10:00
    mk('02888820733', '2026-09-05 09:20:00', 'NORMAL_CLEARING', 't4'),      // Digi_bk bucket 09:00
    { account_id:'548', caller_id_number:'0900999999', destination_number:'0900000001',
      start_stamp:'2026-09-05 09:30:00', end_stamp:'2026-09-05 09:30:00', duration:0, billsec:0,
      hangup_cause:'NO_ROUTE_DESTINATION', uuid:'t5' }  // chưa map -> bỏ
  ]);
  const tl = core.computeGatewayFailTimeline(core.enrichData(raw, {}, gwIndex), 30);
  assert.equal(tl.bucketMin, 30);
  assert.equal(tl.buckets.length, 2);   // gộp 30 phút: {09:00, 10:00}
  const gip = tl.series.find(s => s.gateway === 'GIP2_new');
  const digi = tl.series.find(s => s.gateway === 'Digi_bk');
  // bucket đầu (09:00): GIP có 2 cuộc, 1 fail -> 50
  assert.equal(gip.failPct[0], 50);
  // bucket có 10:05 cho GIP -> 100; Digi không có cuộc -> null (đứt đoạn)
  const idx10 = tl.buckets.findIndex(b => new Date(b).getHours() === 10);
  assert.equal(gip.failPct[idx10], 100);
  assert.equal(digi.failPct[idx10], null);
});

test('computeGatewayBlockReconcile — đối chiếu PAUSE/ON với Fail thực tế', () => {
  const gwIndex = {
    // CID này khai PAUSE cho Viettel
    '0994345507': { gateway: 'GIP2_new', routing_name: 'R', telco_status: { viettel:'PAUSE', mobi:'ON', vina:'ON', other:'ON' } },
    // CID này khai ON hết
    '02888820733': { gateway: 'Digi_bk', routing_name: 'R', telco_status: { viettel:'ON', mobi:'ON', vina:'ON', other:'ON' } }
  };
  const mk = (cid, telco, hc, uuid) => ({ account_id:'548', caller_id_number:cid, destination_number:'0900000001',
    start_stamp:'2026-09-05 09:00:00', end_stamp:'2026-09-05 09:00:00',
    duration: hc==='NORMAL_CLEARING'?30:0, billsec: hc==='NORMAL_CLEARING'?20:0, hangup_cause:hc, uuid, telco });
  const raw = core.normalizeCallRecords([
    mk('0994345507', 'VIETTEL', 'NO_ROUTE_DESTINATION', 'r1'),   // PAUSE + Fail -> khớp
    mk('0994345507', 'VIETTEL', 'NO_ROUTE_DESTINATION', 'r2'),   // PAUSE + Fail
    mk('0994345507', 'VIETTEL', 'NORMAL_CLEARING', 'r3'),        // PAUSE + Connected (1/3 = 33% >=20 -> "export có thể cũ")
    mk('02888820733', 'VIETTEL', 'NO_ROUTE_DESTINATION', 'r4'),  // ON + Fail
    mk('02888820733', 'VIETTEL', 'NO_ROUTE_DESTINATION', 'r5'),  // ON + Fail (2/2 = 100% >=50 -> "nghi bị chặn")
  ]);
  const rec = core.computeGatewayBlockReconcile(core.enrichData(raw, {}, gwIndex));
  const pause = rec.find(m => m.gateway === 'GIP2_new' && m.telco === 'viettel');
  assert.equal(pause.declared, 'PAUSE');
  assert.equal(pause.total, 3);
  assert.equal(pause.fail, 2);
  assert.equal(pause.connPct, 33.33);
  assert.match(pause.verdict, /export có thể cũ/);
  const on = rec.find(m => m.gateway === 'Digi_bk' && m.telco === 'viettel');
  assert.equal(on.declared, 'ON');
  assert.equal(on.failPct, 100);
  assert.match(on.verdict, /nghi bị chặn/);
});

test('buildLlmContext — chỉ giữ trường liên quan tab, cắt top-N mảng lớn', () => {
  const bigTopDest = Array.from({ length: 50 }, (_, i) => ({ dn: `09${i}`, total: i, con: 0, fail: i }));
  const bigEvents = Array.from({ length: 100 }, (_, i) => ({ id: i }));
  const cube = {
    meta: { rows: 10 },
    overview: { connectRate: 50 },
    byPrefix: { _090: { total: 1 } },
    topDest: bigTopDest,
    retryPattern: { events: bigEvents, accArr: [] },
    gatewayFail: { some: 'thing' } // chỉ thuộc tab advanced
  };
  const quality = core.buildLlmContext(cube, 'quality');
  assert.ok(quality.meta && quality.overview && quality.topDest);
  assert.equal(quality.topDest.length, 20);
  // Sắp giảm dần theo total — CID có total lớn nhất (49) phải đứng đầu.
  assert.equal(quality.topDest[0].total, 49);
  assert.equal(quality.gatewayFail, undefined); // không thuộc tab quality

  const time = core.buildLlmContext(cube, 'time');
  assert.equal(time.retryPattern.events.length, 20);
  assert.equal(time.retryPattern.eventsTotalCount, 100);
  assert.equal(time.topDest, undefined); // topDest không thuộc tab time

  assert.equal(core.buildLlmContext(null, 'overview'), null);
});

test('buildLlmContext — rút gọn chuỗi đồng thời và giữ dưới trần kích thước', () => {
  const n = 20000;
  const base = Date.UTC(2026, 8, 22, 1, 0, 0);
  const times = Array.from({ length: n }, (_, i) => base + i * 30000);
  const y = times.map((_, i) => (i === 12345 ? 99 : i % 7));
  const series = { all: { times, xISO: times.map(t => core.localISODateTime ? core.localISODateTime(t) : null),
    keys: ['A', 'B'], series: { A: { y }, B: { y: y.map(v => v ? 1 : 0) } }, totalY: y,
    peaks: { A: 99, B: 1 }, peakAt: { A: times[12345], B: times[1] }, systemPeak: 99, systemPeakAt: times[12345] } };
  const cube = {
    meta: { rows: n }, overview: { totalCalls: n },
    concurrency: series,
    nested: { deep: { values: Array.from({ length: 5000 }, (_, i) => i) } },
    huge: Array.from({ length: 40 }, (_, i) => ({ id: i, blob: 'x'.repeat(1900) })).reduce((o, v) => { o['k' + v.id] = v; return o; }, {})
  };
  cube.huge2 = JSON.parse(JSON.stringify(cube.huge)); cube.huge3 = JSON.parse(JSON.stringify(cube.huge));
  for (let i = 0; i < 6; i++) cube['wide' + i] = JSON.parse(JSON.stringify(cube.huge));
  const out = core.buildLlmContext(cube, '__all__', {});
  const text = JSON.stringify(out);
  assert.ok(text.length <= 400000 + 2000, `context ${text.length} ký tự`);
  const c = out.concurrency.all;
  assert.equal(c.times, undefined);
  assert.equal(c.systemPeak, 99);
  assert.equal(Math.max(...c.peakTimeline.points.map(p => p.peak)), 99);
  assert.equal(c.peakByHourOfDay.length, 24);
  assert.equal(out.nested.deep.values._numericSeries, 5000);
  assert.equal(out.nested.deep.values.max, 4999);
  assert.ok(out._omittedDomains && Object.keys(out._omittedDomains).length > 0);
  assert.equal(out.meta.rows, n);
});

test('buildLlmContext — extra gộp thêm vào context (vd dữ liệu CID rời cube)', () => {
  const out = core.buildLlmContext({ meta: {} }, 'cid', { cidSummary: { locked: 3 } });
  assert.deepEqual(out.cidSummary, { locked: 3 });
});

test('buildLlmContext — chế độ AI toàn DB đọc mọi miền nhưng vẫn là cube đã lọc', () => {
  const cube = {
    meta: { rows: 7 }, overview: { totalCalls: 7 },
    gatewayFail: [{ gateway: 'GW1', total: 7 }],
    billing: { total: 1000 }
  };
  const out = core.buildLlmContext(cube, '__all__', { activeTab: 'overview' });
  assert.equal(out._contextMode, 'all-filtered-database-domains');
  assert.equal(out.meta.rows, 7);
  assert.equal(out.gatewayFail[0].gateway, 'GW1');
  assert.equal(out.billing.total, 1000);
  assert.equal(out.activeTab, 'overview');
});

test('filterCallDetails — kết hợp status + account_id + gateway key + ngày/giờ', () => {
  const raw = [
    { account_id: 'A1', caller_id_number: '0901', destination_number: 'd1', start_stamp: '2026-09-03 08:00:00', duration: 0, billsec: 0, hangup_cause: 'NO_ROUTE_DESTINATION', uuid: 'd1' },
    { account_id: 'A1', caller_id_number: '0901', destination_number: 'd2', start_stamp: '2026-09-03 08:30:00', duration: 30, billsec: 20, hangup_cause: 'NORMAL_CLEARING', uuid: 'd2' },
    { account_id: 'A2', caller_id_number: '0902', destination_number: 'd3', start_stamp: '2026-09-03 09:00:00', duration: 30, billsec: 20, hangup_cause: 'NORMAL_CLEARING', uuid: 'd3' },
    { account_id: 'A2', caller_id_number: '0903', destination_number: 'd4', start_stamp: '2026-09-04 09:00:00', duration: 0, billsec: 0, hangup_cause: 'NO_ROUTE_DESTINATION', uuid: 'd4' }
  ];
  const rows = core.enrichData(core.normalizeCallRecords(raw), { A1: '<same>', A2: '<same>' }, {
    '0901': { gateway: 'GW-1' }, '0902': { gateway: 'GW-2' }
  });
  const params = { startDate: '2026-09-03', endDate: '2026-09-03', startTime: '08:15', endTime: '09:15', accountIds: ['A2'], statuses: ['Connected'], gatewayKey: 'GW-2' };
  const result = core.queryCallDetails(rows, params, 0, 25);
  assert.equal(result.total, 1);
  assert.equal(result.rows[0].uuid, 'd3');
  assert.equal(result.rows[0].account_name, '<same>');
});

test('queryCallDetails — gateway chưa map, zero result và phân trang', () => {
  const rows = core.enrichData(core.normalizeCallRecords([
    { account_id: 'A', caller_id_number: '0901', start_stamp: '2026-09-03 08:00:00', duration: 0, billsec: 0, hangup_cause: 'NO_ROUTE_DESTINATION', uuid: 'p1' },
    { account_id: 'A', caller_id_number: '0902', start_stamp: '2026-09-03 08:01:00', duration: 0, billsec: 0, hangup_cause: 'NO_ROUTE_DESTINATION', uuid: 'p2' },
    { account_id: 'A', caller_id_number: '0903', start_stamp: '2026-09-03 08:02:00', duration: 0, billsec: 0, hangup_cause: 'NO_ROUTE_DESTINATION', uuid: 'p3' }
  ]), { A: 'A' }, { '0901': { gateway: 'GW-X' } });
  const base = { startDate: '2026-09-03', endDate: '2026-09-03', accountIds: ['A'], statuses: ['Fail'] };
  const page = core.queryCallDetails(rows, { ...base, gatewayKey: '(chưa map)' }, 1, 1);
  assert.equal(page.total, 2);
  assert.equal(page.rows.length, 1);
  assert.equal(page.rows[0].uuid, 'p3');
  assert.equal(core.queryCallDetails(rows, { ...base, gatewayKey: 'missing' }, 0, 25).total, 0);
});

// ---- Hiệu năng nạp dữ liệu lớn: phải cho KẾT QUẢ Y HỆT cách làm cũ ----

test('makeRowFactory — đúng khoá/thứ tự/giá trị, cột trùng tên lấy giá trị sau', () => {
  const make = core.makeRowFactory(['a', 'b', 'a', 'c d']);
  const row = make(['1', '2', '3']);
  assert.deepEqual(Object.keys(row), ['a', 'b', 'c d']);
  assert.deepEqual(row, { a: '3', b: '2', 'c d': undefined });
  assert.strictEqual(core.makeRowFactory(['a', 'b', 'a', 'c d']), make);  // dùng lại
  assert.deepEqual(core.makeRowFactory(['__proto__', 'x'])(['1', '2']).x, '2');
});

test('normalizeCallRecord — cột alias trùng đích: giá trị không rỗng đầu tiên thắng', () => {
  const [row] = core.normalizeCallRecords([{ Caller: '', caller_id_number: '0901', Start: 'x', 'Start time': '2026-09-23 10:00:05' }]);
  assert.equal(row.caller_id_number, '0901');
  assert.equal(row.start_stamp, '2026-09-23 10:00:05');
  assert.equal(row.Start, 'x');
});

test('stampToMs = Date.parse cho cả khuôn chuẩn và khuôn lạ', () => {
  for (const s of ['2026-09-23 10:00:59', '2026-09-23 00:00:00', '2026-02-29 10:00:00', '2026-09-23 10:00', '', 'rác'])
    assert.equal(String(core.stampToMs(s)), String(Date.parse(s.replace(' ', 'T'))), s);
});

test('computeCallbackStats — lần nối đầu theo thứ tự sort ổn định cũ (cùng giây, khuôn lạ)', () => {
  const reference = rows => {
    const byDn = {};
    rows.forEach(r => { const dn = String(r.destination_number || ''); if (!dn) return; (byDn[dn] = byDn[dn] || []).push(r); });
    const out = {};
    for (const dn in byDn) {
      const arr = byDn[dn].slice().sort((a, b) => (a.start_stamp || '').localeCompare(b.start_stamp || ''));
      const i = arr.findIndex(r => Number(r.billsec || 0) > 0);
      out[dn] = i < 0 ? null : i + 1;
    }
    return out;
  };
  const rows = [
    { destination_number: 'A', start_stamp: '2026-09-23 10:00:05', billsec: 5 },
    { destination_number: 'A', start_stamp: '2026-09-23 10:00:01', billsec: 0 },
    { destination_number: 'A', start_stamp: '2026-09-23 10:00:05', billsec: 0 },
    { destination_number: 'B', start_stamp: '2026-09-23 09:00:00', billsec: 0 },
    { destination_number: 'B', start_stamp: '', billsec: 3 },
    { destination_number: 'C', start_stamp: '23/09/2026 10:00', billsec: 0 },
    { destination_number: 'C', start_stamp: '2026-09-23 10:00:00', billsec: 2 },
    { destination_number: 'D', start_stamp: '2026-09-23 10:00:00', billsec: 0 }
  ];
  const got = Object.fromEntries(core.computeCallbackStats(rows).map(s => [s.dn, s.firstConnectAttempt]));
  assert.deepEqual(got, reference(rows));
});

test('slimCubeForTransfer — giữ đúng phần UI vẽ, bỏ phần theo từng số/mốc', () => {
  const topDest = Array.from({ length: 3000 }, (_, i) => ({ dn: 'd' + i, total: i % 7, connected: 0, noans: 0, fail: i % 5, failPct: (i % 5) * 10 }));
  const slim = core.slimTopDest(topDest);
  assert.ok(slim.length < topDest.length);
  const ui = data => {
    const byCalls = data.slice().sort((a, b) => b.total - a.total).slice(0, 10);
    const byFail = data.filter(x => x.total >= 5).sort((a, b) => b.failPct - a.failPct).slice(0, 10);
    const set = new Set([...byCalls, ...byFail].map(x => x.dn));
    return data.filter(x => set.has(x.dn)).map(x => x.dn);
  };
  assert.deepEqual(ui(slim), ui(topDest));

  const cb = core.slimCallbackStats([{ dn: 'a', tot: 3, con: 1, firstConnectAttempt: 2 }, { dn: 'b', tot: 5, con: 0, firstConnectAttempt: null }, { dn: 'c', tot: 3, con: 1, firstConnectAttempt: 2 }]);
  assert.deepEqual(cb.firstAttemptHist, [[2, 2]]);
  assert.deepEqual(cb.top.map(x => x.dn), ['b', 'a', 'c']);
  assert.strictEqual(core.slimCallbackStats(cb), cb);  // gọi lại không đổi

  const n = 10000, times = Array.from({ length: n }, (_, i) => i * 1000);
  const totalY = times.map((_, i) => (i * 7919) % 97);
  const c = { times, xISO: times.map(String), totalY, keys: ['x'], series: { x: { y: totalY.slice() } }, systemPeak: 96 };
  const s = core.slimConcurrency(c);
  assert.equal(s.fullPoints, n);
  assert.deepEqual(core.downsampleSeriesMax(c.xISO, c.totalY, 1800), { x: s.xISO, y: s.totalY });
  assert.deepEqual(s.series.x.y, s.totalY);
});

// ---------- Dự đoán cước cuối tháng ----------
function fcRow(stamp, billsec, extra){
  return { start_stamp: stamp, billsec, account_id: '1', telco: 'VIETTEL', ...(extra||{}) };
}
const FC_CFG = { firstBlock: 6, nextBlock: 1, rate: 60, roundStep: 0, onlyConnected: true, endDate: '2026-09-24' };

test('computeBillingForecast — theo thứ trong tuần, ngày cuối chưa hết ngày', () => {
  const rows = [];
  // 01/08 -> 23/09: mỗi ngày 1 cuộc 10h; Chủ nhật 60s, ngày khác 120s; thêm 1 cuộc 20h = 60s.
  for (let d = new Date('2026-08-01T00:00:00'); d <= new Date('2026-09-23T00:00:00'); d.setDate(d.getDate() + 1)) {
    const iso = core.localISODate(d);
    rows.push(fcRow(`${iso} 10:00:00`, d.getDay() === 0 ? 60 : 120));
    rows.push(fcRow(`${iso} 20:00:00`, 60));
  }
  rows.push(fcRow('2026-09-24 10:00:00', 120)); // 24/09 (T5): CDR dừng lúc 10h
  rows.push(fcRow('2026-09-24 11:00:00', 0));   // chưa kết nối -> không tính
  rows.push(fcRow('2026-09-24 12:00:00', 30, { account_id: '2' })); // account khác
  const fc = core.computeBillingForecast(rows, { ...FC_CFG, account: '1' });
  assert.equal(fc.status, 'ok');
  assert.equal(fc.lastDate, '2026-09-24');
  assert.equal(fc.lastHour, 12);            // giờ cuối xét trên toàn bộ CDR
  assert.equal(fc.partialLastDay, true);
  assert.equal(fc.missingMonthStart, false);
  assert.equal(fc.historyDays, 28);         // 27/08 -> 23/09
  // Thực tế: 01..23/09 có 3 CN (06,13,20): 3*120 + 20*180 = 3960; + 24/09: 120
  assert.equal(fc.actualSec, 4080);
  // Phần còn lại 24/09 từ 13h: TB các T5 trước = 60s (cuộc 20h)
  assert.equal(fc.remainder.mid, 60);
  // 25..30/09: 1 CN (27) = 120, 5 ngày khác = 900
  assert.equal(fc.days.length, 6);
  assert.equal(fc.days.find(d => d.date === '2026-09-27').mid, 120);
  assert.equal(fc.forecastSec.mid, 4080 + 60 + 1020);
  assert.equal(fc.forecastCost.mid, (4080 + 60 + 1020) / 60 * 60);
  assert.ok(fc.forecastSec.low <= fc.forecastSec.mid && fc.forecastSec.mid <= fc.forecastSec.high);
});

test('computeBillingForecast — thiếu dữ liệu đầu tháng, fallback 7 ngày, tháng đã đủ', () => {
  const rows = [];
  for (let day = 20; day <= 24; day++) rows.push(fcRow(`2026-09-${day} 23:30:00`, 60));
  const fc = core.computeBillingForecast(rows, FC_CFG);
  assert.equal(fc.missingMonthStart, true);
  assert.equal(fc.firstCovered, '2026-09-20');
  assert.equal(fc.partialLastDay, false);
  assert.ok(fc.days.every(d => d.fallback)); // mỗi thứ có < 2 mẫu
  assert.equal(fc.days[0].mid, 60);

  const done = core.computeBillingForecast([fcRow('2026-02-28 23:10:00', 60)], { ...FC_CFG, endDate: '2026-02-10' });
  assert.equal(done.complete, true);
  assert.equal(done.forecastSec.mid, 60);

  assert.equal(core.computeBillingForecast([], FC_CFG).status, 'no-data');
});
