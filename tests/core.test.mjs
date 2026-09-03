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

test('dashboard-core.js không tham chiếu DOM', () => {
  const raw = require('node:fs').readFileSync(path.join(ROOT, 'dashboard-core.js'), 'utf8');
  // Bỏ comment để không bắt nhầm phần mô tả.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const bad of ['document.', 'localStorage.', 'getElementById', 'Plotly.', 'window.']) {
    assert.ok(!src.includes(bad), `dashboard-core.js chứa "${bad}" — phải giữ thuần logic`);
  }
});
