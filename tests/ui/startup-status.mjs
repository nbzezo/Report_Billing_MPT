import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { server } from './mock-server.mjs';

const require = createRequire(path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/entry.js'));
const { chromium } = require('playwright');
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
const pending = [];
try {
  browser = await chromium.launch({ headless:true, executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/profiles', route => route.fulfill({ json:{profiles:[
    {id:'p1',name:'First',domain:'https://demo.invalid',username:'demo'},
    {id:'p2',name:'Second',domain:'https://demo.invalid',username:'demo'}
  ]} }));
  await page.route('**/api/data-status?*', route => {
    const query = new URL(route.request().url()).searchParams;
    assert.equal(query.get('light'), '1');
    if (query.get('profile_id') === 'p1') {
      return new Promise(resolve => pending.push(async () => {
        await route.fulfill({json:{rows:999,totalRows:999,retentionDays:60}});
        resolve();
      }));
    }
    return route.fulfill({json:{rows:222,totalRows:222,retentionDays:60}});
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`, {waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => mptActiveProfileId === 'p1' && mptProfiles.length === 2);
  const selected = await page.evaluate(() => Promise.race([
    mptSelectProfile('p1', false).then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 500))
  ]));
  assert.equal(selected, true, 'Profile selection waits for a slow status query');
  await page.evaluate(() => mptSelectProfile('p2', false));
  await page.waitForFunction(() => document.getElementById('databaseStatus').textContent.includes('222'));
  assert.ok(pending.length > 0);
  await Promise.all(pending.splice(0).map(release => release()));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const text = await page.locator('#databaseStatus').textContent();
  assert.ok(text.includes('222') && !text.includes('999'), 'Late status response overwrote the new profile');
  assert.deepEqual(errors, []);
  console.log('PASS: lightweight status, nonblocking selection and stale-response protection');
} finally {
  await Promise.allSettled(pending.splice(0).map(release => release()));
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
