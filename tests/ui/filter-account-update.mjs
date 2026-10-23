import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { server } from './mock-server.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const require=createRequire(import.meta.url);
function loadPlaywright(){
  try{ return require('playwright'); }catch{}
  const base=process.env.CODEX_NODE_MODULES||path.join(process.env.USERPROFILE||'','.cache','codex-runtimes','codex-primary-runtime','dependencies','node','node_modules');
  return createRequire(path.join(base,'entry.js'))('playwright');
}
const { chromium }=loadPlaywright();
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port;
let browser;
try{
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  const page=await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/?csv=/tests/ui/fixtures/sample.csv`,{waitUntil:'domcontentloaded'});
  await page.locator('.acc-checkbox').first().waitFor({state:'attached'});
  await page.locator('.mpt-account-check').nth(1).waitFor({state:'attached'});
  const state=await page.evaluate(()=>{
    document.querySelectorAll('.acc-checkbox,.mpt-account-check').forEach(input=>{ input.checked=false; });
    const view=document.querySelector('.acc-checkbox');
    view.checked=true;
    const fallback=new URL(unifiedReportDataUrl('update'),location.origin).searchParams;
    const explicit=document.querySelectorAll('.mpt-account-check')[1];
    explicit.checked=true;
    const override=new URL(unifiedReportDataUrl('update'),location.origin).searchParams;
    return {
      viewId:view.value,
      reportId:fallback.get('account_id'),
      fallbackSyncId:fallback.get('sync_account_id'),
      explicitId:explicit.value,
      overrideSyncId:override.get('sync_account_id'),
    };
  });
  if(state.reportId!==state.viewId||state.fallbackSyncId!==state.viewId) throw new Error(`Cập nhật không kế thừa tài khoản đang xem: ${JSON.stringify(state)}`);
  if(state.overrideSyncId!==state.explicitId) throw new Error(`Phạm vi tải riêng không ghi đè: ${JSON.stringify(state)}`);
  console.log(`OK account update scope: ${JSON.stringify(state)}`);
}finally{
  if(browser) await browser.close();
  await new Promise(resolve=>server.close(resolve));
}
