'use strict';

const fs = require('fs');
const path = require('path');

function splitCSVRespectQuotes(line) {
  const out = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { current += '"'; i++; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      out.push(current);
      current = '';
    } else current += char;
  }
  out.push(current);
  return out;
}

function parseCSV(text) {
  if (!text) return [];
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(Boolean);
  if (lines.length < 2) return [];
  const header = splitCSVRespectQuotes(lines[0]).map(value => value.replace(/^"|"$/g, '').trim());
  const rows = [];
  const makeRow = (typeof core.makeRowFactory === 'function') ? core.makeRowFactory(header) : null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.indexOf('"') === -1) {
      const columns = line.split(',');
      if (columns.length === 1 && !columns[0].trim()) continue;
      while (columns.length < header.length) columns.push('');
      rows.push(makeRow ? makeRow(columns) : Object.fromEntries(header.map((key, idx) => [key, columns[idx]])));
      continue;
    }
    const columns = splitCSVRespectQuotes(line);
    if (columns.length === 1 && !columns[0].trim()) continue;
    const row = {};
    for (let j = 0; j < header.length; j++) {
      row[header[j]] = (columns[j] === undefined ? '' : columns[j]).replace(/^"|"$/g, '').replace(/""/g, '"');
    }
    rows.push(row);
  }
  return rows;
}

function readJson(file, fallback) {
  if (!file) return fallback;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return fallback; }
}

const [csvPath, paramsPath, namesPath, gatewayPath] = process.argv.slice(2);
if (!csvPath || !paramsPath) {
  console.error('Usage: node report_cube.js <csv> <params.json> [names.json] [gateway.json]');
  process.exit(2);
}

const root = path.resolve(__dirname, '..');
const core = require(path.join(root, 'dashboard-core.js'));

const csvText = fs.readFileSync(csvPath, 'utf8');
const rawRows = parseCSV(csvText);
const rows = core.normalizeCallRecords(rawRows);
const names = readJson(namesPath, {});
const gatewayIndex = readJson(gatewayPath, {});
const params = readJson(paramsPath, {});
const enriched = core.enrichData(rows, names, gatewayIndex);
const cube = core.slimCubeForTransfer(core.buildCube(enriched, params));
process.stdout.write(JSON.stringify({ cube, meta: { sourceRows: rawRows.length, rows: enriched.length } }));
