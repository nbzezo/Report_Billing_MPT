import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { server } from './mock-server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const base = process.env.CODEX_NODE_MODULES || path.join(process.env.USERPROFILE || '', '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules');
const { chromium } = (() => { try { return require('playwright'); } catch { return createRequire(path.join(base, 'entry.js'))('playwright'); } })();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless:true, executablePath:process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/?csv=/tests/ui/fixtures/sample.csv`);
  await page.waitForFunction(() => document.getElementById('overviewAlerts')?.textContent.trim() && document.getElementById('overviewHotspots')?.textContent.trim(), null, { timeout:45000 });
  const state = await page.evaluate(() => ({
    beforeCharts: Boolean(document.getElementById('overviewHighlights').compareDocumentPosition(document.getElementById('chart_conn_donut')) & Node.DOCUMENT_POSITION_FOLLOWING),
    cid: document.getElementById('overviewCid').textContent.trim(),
    charts: ['chart_conn_donut','chart_answer_gauge','chart_direction_split','chart_minutes_day','chart_minutes_account'].every(id=>document.getElementById(id).style.display!=='none'),
    previous: overviewPreviousPeriod({startDate:'2026-11-04',endDate:'2026-11-10'}),
    gapRejected: !overviewHasEveryDay({meta:{dateMin:'2026-11-04',dateMax:'2026-11-06'},minutesPerDay:{dates:['2026-11-04','2026-11-06']}},'2026-11-04','2026-11-06')
  }));
  if (!state.beforeCharts || !state.charts || !state.gapRejected || !/Chưa tải lịch sử CID/.test(state.cid) || state.previous.startDate!=='2026-10-28' || state.previous.endDate!=='2026-11-03') throw new Error(JSON.stringify(state));
  const cidSample = await page.evaluate(() => {
    cidState.loaded=true; cidState.profileId=mptActiveProfileId;
    cidState.events=[]; cidState.routings=[]; cidState.timeline=buildCidTimeline([]);
    const total=loadedRowTotal;
    loadedRowTotal=enriched.length+1;
    renderOverviewCid();
    const text=document.getElementById('overviewCid').textContent;
    loadedRowTotal=total;
    cidState.loaded=false; cidState.timeline=null;
    renderOverviewCid();
    return text;
  });
  if (!/bị cắt mẫu/.test(cidSample) || !/Cuộc gọi lãng phí/.test(cidSample)) throw new Error('CID bị cắt mẫu vẫn hiển thị số ảnh hưởng.');
  await page.locator('#overviewHighlights [data-overview-tab="cid"]').click();
  if (!(await page.locator('.tab-btn[data-tab="cid"]').getAttribute('aria-current'))) throw new Error('Liên kết CID không mở tab CID.');
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('Overview highlights OK');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
