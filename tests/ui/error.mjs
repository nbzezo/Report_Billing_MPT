import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { server } from './mock-server.mjs';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); }
catch {
  const base = process.env.CODEX_NODE_MODULES || path.join(process.env.USERPROFILE || '', '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules');
  playwright = createRequire(path.join(base, 'entry.js'))('playwright');
}
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
  const page = await browser.newPage();
  await page.route('**/api/accounts**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.goto(`${base}/?csv=/tests/ui/fixtures/sample.csv`);
  await page.waitForFunction(() => ['8000', '8.000'].includes(document.querySelector('#kpi_total_text')?.textContent?.trim()), { timeout: 45000 });
  assert.equal(await page.locator('#kpi_total_text').textContent(), '8.000');
  await page.close();

  const failed = await browser.newPage();
  await failed.route('**/*', route => new URL(route.request().url()).pathname === '/tests/ui/fixtures/sample.csv'
    ? route.fulfill({ status: 500, body: 'CSV unavailable' }) : route.continue());
  await failed.goto(`${base}/?csv=/tests/ui/fixtures/sample.csv`);
  await failed.locator('#reportLoadingError:visible').waitFor({ timeout: 15000 });
  await failed.waitForTimeout(1500);
  assert.equal(await failed.locator('#reportLoadingTitle').textContent(), 'Không tải được báo cáo');
  assert.match(await failed.locator('#reportLoadingError').textContent(), /CSV unavailable|HTTP 500/);
  assert.doesNotMatch(await failed.locator('#reportLoadingError').textContent(), /Đang vẽ biểu đồ/);
  await failed.close();
  console.log('UX-10: API accounts sai dạng vẫn nạp CSV; lỗi CSV giữ nguyên lý do sau 1,5 giây.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
