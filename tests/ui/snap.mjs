import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { server } from './mock-server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const require = createRequire(import.meta.url);
function loadPlaywright() {
  try { return require('playwright'); } catch { /* bundled runtime below */ }
  const base = process.env.CODEX_NODE_MODULES || path.join(process.env.USERPROFILE || '', '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules');
  return createRequire(path.join(base, 'entry.js'))('playwright');
}
const { chromium } = loadPlaywright();
const tabs = ['overview', 'quality', 'time', 'advanced', 'billing', 'cid', 'settings'];
const auditOnly = process.argv.includes('--audit-only');
const out = path.join(here, process.argv.includes('--baseline') ? 'baseline' : 'out');
await fs.mkdir(out, { recursive: true });
await fs.access(path.join(here, 'fixtures', 'sample.csv')).catch(() => { throw new Error('Chạy node tests/ui/make-sample.mjs trước.'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
let browser;
try {
  const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  browser = await chromium.launch({ headless: true, executablePath: chrome });
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/?csv=/tests/ui/fixtures/sample.csv`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => ['8000', '8.000'].includes(document.querySelector('#kpi_total_text')?.textContent?.trim()), { timeout: 45000 });
    await page.waitForFunction(() => !document.querySelector('#reportLoading.show'), { timeout: 45000 });
    const axe = path.join(here, 'vendor', 'axe.min.js');
    await fs.access(axe);
    await page.addScriptTag({ path: axe });
    const axeSummary = {};
    for (const tab of tabs) {
      await page.locator(`#tabsBar .tab-btn[data-tab="${tab}"]`).click();
      await page.waitForTimeout(auditOnly ? 80 : 180);
      const activeState = await page.locator(`#tabsBar .tab-btn[data-tab="${tab}"]`).getAttribute('aria-current');
      if (activeState !== 'page') throw new Error(`Sidebar chưa đánh dấu màn hình ${tab} đang mở.`);
      if (!auditOnly) {
        await page.screenshot({ path: path.join(out, `${theme}-${tab}.png`) });
        await page.screenshot({ path: path.join(out, `${theme}-${tab}-full.png`), fullPage: true });
      }
      const result = await page.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } }));
      axeSummary[tab] = result.violations.map(item => ({
        id: item.id,
        impact: item.impact || 'unknown',
        nodes: item.nodes.length,
        targets: item.nodes.slice(0, 3).map(node => node.target.join(' ')),
      }));
    }
    await page.locator('#tabsBar .tab-btn[data-tab="overview"]').click();
    const infoButton = page.locator('.info-btn').first();
    await infoButton.click();
    if (await page.locator('#uiInfoPopover').isHidden()) throw new Error('Popover công thức không mở.');
    const popoverAudit = await page.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } }));
    axeSummary.popover = popoverAudit.violations.map(item => ({ id: item.id, impact: item.impact, nodes: item.nodes.length }));
    await page.keyboard.press('Escape');
    if (!(await page.locator('#uiInfoPopover').isHidden())) throw new Error('Popover công thức không đóng bằng Escape.');
    if (!(await infoButton.evaluate(element => element === document.activeElement))) throw new Error('Popover không trả focus về nút kích hoạt.');
    await page.locator('#openMptSource').click();
    await page.locator('#mptSourcePanel[open]').waitFor();
    const dialogAudit = await page.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } }));
    axeSummary.dialog = dialogAudit.violations.map(item => ({ id: item.id, impact: item.impact, nodes: item.nodes.length }));
    if (!auditOnly) await page.screenshot({ path: path.join(out, `${theme}-dialog.png`) });
    await page.evaluate(() => document.getElementById('mptSourcePanel')?.close());
    await page.locator('#askDashboardToggle').click();
    await page.locator('#askDashboardPanel').waitFor({ state: 'visible' });
    const assistantAudit = await page.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } }));
    axeSummary.assistant = assistantAudit.violations.map(item => ({ id: item.id, impact: item.impact, nodes: item.nodes.length }));
    if (!auditOnly) await page.screenshot({ path: path.join(out, `${theme}-assistant.png`) });
    await page.locator('#askPanelClose').click();
    if (theme === 'light' && !auditOnly) {
      await page.setViewportSize({ width: 1024, height: 768 });
      await page.locator('#tabsBar .tab-btn[data-tab="overview"]').click();
      await page.screenshot({ path: path.join(out, 'light-overview-1024.png'), fullPage: true });
    }
    console.log(`${theme} axe theo màn hình: ${JSON.stringify(axeSummary)}`);
    if (errors.length) console.warn(`${theme} page errors: ${errors.slice(0, 5).join(' | ')}`);
    await context.close();
  }
  console.log(`Ảnh: ${out}`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
