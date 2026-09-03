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
