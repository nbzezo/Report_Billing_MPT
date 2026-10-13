import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const accounts = Array.from({ length: 6 }, (_, i) => ({ id: String(101 + i), name: `Tài khoản ${101 + i}` }));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.woff2': 'font/woff2', '.png': 'image/png' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = value => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
  if (url.pathname === '/api/profiles') return json({ profiles: [{ id: 'p1', name: 'Billing 01', domain: 'https://demo.invalid', username: 'demo' }] });
  if (url.pathname === '/api/accounts') return json(accounts);
  if (url.pathname.startsWith('/api/')) return json({});
  const requested = url.pathname === '/' ? '/V2_0_Call_Dashboard_MPT.html' : url.pathname;
  const file = path.resolve(root, `.${decodeURIComponent(requested)}`);
  if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
  try {
    const body = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
});
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(8787, '127.0.0.1', () => console.log('Mock dashboard: http://127.0.0.1:8787'));
}
export { server };
