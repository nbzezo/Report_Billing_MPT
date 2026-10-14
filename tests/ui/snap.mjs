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
const themeArg = process.argv.find(value => value.startsWith('--theme='));
const themes = themeArg ? [themeArg.split('=')[1]] : ['light', 'dark'];
const out = path.join(here, process.argv.includes('--baseline') ? 'baseline' : 'out');
await fs.mkdir(out, { recursive: true });
await fs.access(path.join(here, 'fixtures', 'sample.csv')).catch(() => { throw new Error('Chạy node tests/ui/make-sample.mjs trước.'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
let browser;
try {
  const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  browser = await chromium.launch({ headless: true, executablePath: chrome });
  for (const theme of themes) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/?csv=/tests/ui/fixtures/sample.csv`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => ['8000', '8.000'].includes(document.querySelector('#kpi_total_text')?.textContent?.trim()), { timeout: 45000 });
    await page.waitForFunction(() => !document.querySelector('#reportLoading.show'), { timeout: 45000 });
    if ((await page.locator('#updateReport').textContent()).trim() !== 'Cập nhật') throw new Error('Header chưa dùng một hành động Cập nhật duy nhất.');
    if (!/Dữ liệu từ tệp/.test(await page.locator('#dataFreshnessSummary').textContent())) throw new Error('Header chưa hiển thị độ mới dữ liệu.');
    const kpiMetrics = await page.locator('.kpi-shell').evaluate(element => ({
      height: element.getBoundingClientRect().height,
      card: element.querySelector('.overview-kpi-card')?.getBoundingClientRect().height,
      primary: element.querySelector('.kpi-primary-grid')?.getBoundingClientRect().height,
      status: element.querySelector('.kpi-status')?.getBoundingClientRect().height,
      statusHead: element.querySelector('.kpi-status-head')?.getBoundingClientRect().height,
      statusBar: element.querySelector('.kpi-status-bar')?.getBoundingClientRect().height,
      statusChips: element.querySelector('.status-chips')?.getBoundingClientRect().height,
      statusButton: element.querySelector('.status-chip')?.getBoundingClientRect().height,
      secondary: element.querySelector('.kpi-secondary-grid')?.getBoundingClientRect().height,
    }));
    if (kpiMetrics.height > 360) throw new Error(`Khối KPI Tổng quan vượt mục tiêu 360px: ${JSON.stringify(kpiMetrics)}`);
    const filterHeight = await page.locator('.adw-filterbar').evaluate(element => element.getBoundingClientRect().height);
    if (filterHeight > 112) throw new Error(`Thanh lọc cao ${filterHeight}px ở 1440px.`);
    if (await page.locator('#kpi_conn_text .drilldown-trigger').count() !== 4) throw new Error('Phân bố trạng thái chưa có đủ 4 nút drilldown.');
    const totalKpi = page.locator('#kpi_total');
    await totalKpi.click();
    await page.locator('#callDrilldownDialog[open]').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('#callDrilldownDialog').waitFor({ state: 'hidden' });
    if (!(await totalKpi.evaluate(element => element === document.activeElement))) throw new Error('Drilldown KPI không trả focus về nút kích hoạt.');
    await page.evaluate(() => { window.__snapRunUnifiedReport = window.runUnifiedReport; window.runUnifiedReport = () => markFilterDirty(false); });
    await page.locator('#dateRangeButton').click();
    await page.locator('#dateRangePopover').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    if (!(await page.locator('#dateRangePopover').isHidden())) throw new Error('Popover thời gian không đóng bằng Escape.');
    if (!(await page.locator('#dateRangeButton').evaluate(element => element === document.activeElement))) throw new Error('Popover thời gian không trả focus.');
    await page.locator('#moreFiltersButton').click();
    await page.locator('#mainDirection').selectOption('1');
    await page.locator('#applyMoreFilters').click();
    const directionChip = page.locator('.chip-filter', { hasText: 'Hướng:' });
    await directionChip.waitFor({ state: 'visible' });
    await directionChip.locator('button').click();
    if (!(await directionChip.isHidden())) throw new Error('Nút × không bỏ chip bộ lọc Hướng.');
    await page.evaluate(() => { window.runUnifiedReport = window.__snapRunUnifiedReport; delete window.__snapRunUnifiedReport; });
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
    const updateScopeButton = page.locator('#updateScopeButton');
    await updateScopeButton.click();
    await page.locator('#updateScopePopover').waitFor({ state: 'visible' });
    const independentScope = await page.evaluate(() => {
      const checkbox = document.querySelector('.mpt-account-check');
      if (!checkbox) return null;
      checkbox.checked = true;
      const view = new URL(unifiedReportDataUrl('view'), location.origin);
      const update = new URL(unifiedReportDataUrl('update'), location.origin);
      checkbox.checked = false;
      return { id: checkbox.value, viewAccount: view.searchParams.get('account_id'), viewSyncAccount: view.searchParams.get('sync_account_id'), updateAccount: update.searchParams.get('account_id'), updateSyncAccount: update.searchParams.get('sync_account_id') };
    });
    if (!independentScope || independentScope.viewSyncAccount !== null || independentScope.updateSyncAccount !== independentScope.id || independentScope.viewAccount !== independentScope.updateAccount)
      throw new Error(`Phạm vi tải và phạm vi xem chưa độc lập: ${JSON.stringify(independentScope)}`);
    const dialogAudit = await page.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } }));
    axeSummary.updateScope = dialogAudit.violations.map(item => ({ id: item.id, impact: item.impact, nodes: item.nodes.length }));
    if (!auditOnly) await page.screenshot({ path: path.join(out, `${theme}-update-scope.png`) });
    await page.keyboard.press('Escape');
    if (!(await page.locator('#updateScopePopover').isHidden())) throw new Error('Popover phạm vi tải không đóng bằng Escape.');
    if (!(await updateScopeButton.evaluate(element => element === document.activeElement))) throw new Error('Popover phạm vi tải không trả focus.');
    await page.locator('#askDashboardToggle').click();
    await page.locator('#askDashboardPanel').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.activeElement?.id === 'askQuestionInput');
    await page.waitForTimeout(220);
    const desktopSheet = await page.evaluate(() => {
      const panel = document.getElementById('askDashboardPanel').getBoundingClientRect();
      const update = document.getElementById('updateReport').getBoundingClientRect();
      const bodyPadding = parseFloat(getComputedStyle(document.querySelector('.adw-body')).paddingRight) || 0;
      return { panelRight: panel.right, panelLeft: panel.left, panelTop: panel.top, updateRight: update.right, updateBottom: update.bottom, bodyPadding, viewport: innerWidth };
    });
    const updateClear = desktopSheet.updateBottom <= desktopSheet.panelTop + 1 || desktopSheet.updateRight <= desktopSheet.panelLeft + 1;
    if (desktopSheet.bodyPadding < 350 || Math.abs(desktopSheet.panelRight - desktopSheet.viewport) > 1 || !updateClear)
      throw new Error(`Side sheet desktop che nút Cập nhật: ${JSON.stringify(desktopSheet)}`);
    const assistantAudit = await page.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } }));
    axeSummary.assistant = assistantAudit.violations.map(item => ({ id: item.id, impact: item.impact, nodes: item.nodes.length }));
    if (!auditOnly) await page.screenshot({ path: path.join(out, `${theme}-assistant.png`) });
    await page.keyboard.press('Escape');
    if (!(await page.locator('#askDashboardPanel').isHidden())) throw new Error('Side sheet không đóng bằng Escape.');
    if (!(await page.locator('#askDashboardToggle').evaluate(element => element === document.activeElement))) throw new Error('Side sheet không trả focus về nút mở.');
    if (theme === 'light') {
      await page.setViewportSize({ width: 900, height: 768 });
      await page.keyboard.press('Control+/');
      await page.locator('#askDashboardPanel').waitFor({ state: 'visible' });
      await page.waitForTimeout(220);
      const narrowState = await page.evaluate(() => ({
        open: document.body.classList.contains('ask-panel-open'),
        bodyPadding: parseFloat(getComputedStyle(document.querySelector('.adw-body')).paddingRight) || 0,
      }));
      if (!narrowState.open || narrowState.bodyPadding > 1) throw new Error(`Side sheet 900px không ở chế độ overlay: ${JSON.stringify(narrowState)}`);
      await page.keyboard.press('Escape');
      await page.setViewportSize({ width: 1440, height: 900 });
      const bubbleState = await page.locator('#askDashboardToggle').evaluate(element => {
        const rect = element.getBoundingClientRect();
        const headerBottom = document.querySelector('.adw-headerbar').getBoundingClientRect().bottom;
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, headerBottom, width: innerWidth, height: innerHeight };
      });
      if (bubbleState.left < 0 || bubbleState.right > bubbleState.width || bubbleState.bottom > bubbleState.height || bubbleState.top < bubbleState.headerBottom + 8)
        throw new Error(`Bong bóng AI vượt khung sau resize: ${JSON.stringify(bubbleState)}`);
      if (bubbleState.width - bubbleState.right > 32 || bubbleState.height - bubbleState.bottom > 32)
        throw new Error(`Bong bóng AI không trở lại góc dưới phải: ${JSON.stringify(bubbleState)}`);
    }
    if (theme === 'light' && !auditOnly) {
      await page.setViewportSize({ width: 1024, height: 768 });
      await page.locator('#tabsBar .tab-btn[data-tab="overview"]').click();
      const compactHeight = await page.locator('.adw-filterbar').evaluate(element => element.getBoundingClientRect().height);
      if (compactHeight > 112) throw new Error(`Thanh lọc cao ${compactHeight}px ở 1024px.`);
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
