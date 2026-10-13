import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const output = path.join(here, 'fixtures', 'sample.csv');
const columns = ['uuid', 'account_id', 'account_name', 'caller_id_number', 'destination_number', 'start_stamp', 'answer_stamp', 'end_stamp', 'duration', 'billsec', 'hangup_cause', 'direction', 'telco', 'call_type'];
const causes = ['NORMAL_CLEARING', 'ORIGINATOR_CANCEL', 'NO_ANSWER', 'USER_BUSY', 'UNALLOCATED_NUMBER', 'CALL_REJECTED', 'NO_USER_RESPONSE'];
const telcos = ['Viettel', 'Vinaphone', 'Mobifone'];
let seed = 20261013;
const random = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 4294967296);
const stamp = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
const rows = [columns.join(',')];
for (let i = 0; i < 8000; i++) {
  const account = 101 + i % 6;
  const day = 1 + i % 12;
  const start = new Date(2026, 9, day, 7 + Math.floor(random() * 14), Math.floor(random() * 60), Math.floor(random() * 60));
  const connected = random() < 0.55;
  const cause = connected ? causes[0] : causes[1 + Math.floor(random() * (causes.length - 1))];
  const duration = 10 + Math.floor(random() * 600);
  const billsec = connected ? Math.max(1, duration - Math.floor(random() * 12)) : 0;
  const answer = connected ? new Date(start.getTime() + (duration - billsec) * 1000) : null;
  const end = new Date(start.getTime() + duration * 1000);
  rows.push([`sample-${String(i + 1).padStart(5, '0')}`, account, `Tài khoản ${account}`,
    `090${String(i % 10000000).padStart(7, '0')}`, `091${String((i * 37) % 10000000).padStart(7, '0')}`,
    stamp(start), answer ? stamp(answer) : '', stamp(end), duration, billsec, cause,
    i % 9 === 0 ? 'Inbound' : 'Outbound', telcos[i % telcos.length], 'External'].join(','));
}
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${rows.join('\n')}\n`, 'utf8');
console.log(`${output}: ${rows.length - 1} cuộc gọi giả lập`);
