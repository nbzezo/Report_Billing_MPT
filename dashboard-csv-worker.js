'use strict';

// Logic thuần dùng chung với trang và Node test (normalize/classify/enrich…).
// Milestone 1a: nạp sẵn ở đây để xác nhận chạy được trong worker; worker sẽ
// dùng tới nó ở milestone kế (enrich + buildCube trong worker).
try { importScripts('/dashboard-core.js'); } catch (e) { /* worker vẫn parse CSV được nếu thiếu */ }

function splitCSVRespectQuotes(line){
  const out=[];
  let current='';
  let quoted=false;
  for(let i=0;i<line.length;i++){
    const char=line[i];
    if(char==='"'){
      if(quoted&&line[i+1]==='"'){ current+='"'; i++; }
      else quoted=!quoted;
    }else if(char===','&&!quoted){
      out.push(current);
      current='';
    }else current+=char;
  }
  out.push(current);
  return out;
}

function parseCSV(text){
  if(!text) return [];
  if(text.charCodeAt(0)===0xFEFF) text=text.slice(1);
  const lines=text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n').filter(Boolean);
  if(lines.length<2) return [];
  const header=splitCSVRespectQuotes(lines[0]).map(value=>value.replace(/^"|"$/g,'').trim());
  const rows=[];
  for(let i=1;i<lines.length;i++){
    const columns=splitCSVRespectQuotes(lines[i]);
    if(columns.length===1&&!columns[0].trim()) continue;
    const row={};
    for(let j=0;j<header.length;j++){
      row[header[j]]=(columns[j]===undefined?'':columns[j]).replace(/^"|"$/g,'').replace(/""/g,'"');
    }
    rows.push(row);
  }
  return rows;
}

self.onmessage=event=>self.postMessage(parseCSV(String(event.data||'')));
