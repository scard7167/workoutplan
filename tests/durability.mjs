// Until a Blob store exists the phone IS the store, so this asserts the two things that
// make that survivable: every write is mirrored to IndexedDB, and wiping localStorage
// alone does NOT lose the log. Also checks the clipboard path that replaces the file
// download - the rows it copies must be exactly what `analyze.py sync --rows` accepts.
//
//   (cd web && python3 -m http.server 8080 &) && PW_ROOT=/tmp/pw node tests/durability.mjs 8080
import { createRequire } from 'node:module';
const require = createRequire(`${process.env.PW_ROOT}/package.json`);
const { chromium } = require('playwright');
const b=await chromium.launch({executablePath: process.env.PW_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args:['--ignore-certificate-errors']});
const U=`http://127.0.0.1:${process.argv[2] || 8080}/`;
const ctx=await b.newContext({viewport:{width:390,height:812},permissions:['clipboard-read','clipboard-write']});
const p=await ctx.newPage();
const errs=[];p.on('pageerror',e=>errs.push(e.message));
await p.goto(U,{waitUntil:'domcontentloaded'});await p.waitForTimeout(600);

// log a session + cardio through the UI
await p.evaluate(()=>{
  const wk={};for(const d of ['mon','tue','wed','thu','fri','sat','sun'])wk[d]=[['bench_press',2]];
  localStorage.setItem('strengthlog.v4',JSON.stringify({v:4,updated_at:new Date().toISOString(),
    custom:{},cardio:[],live:null,sessions:{},
    plans:{gym80:{name:'gym80 block',week:wk}},base:{gym80:{name:'gym80 block',week:JSON.parse(JSON.stringify(wk))}}}));
});
await p.goto(U,{waitUntil:'domcontentloaded'});await p.waitForTimeout(600);
console.log('header:', await p.$eval('#hmeta',e=>e.textContent));
console.log('banner tag:', await p.$eval('#p-Session .banner .tag',e=>e.textContent.trim()));

await p.click('#p-Session .liftrow');await p.waitForTimeout(350);
await p.fill('#s-w','50');await p.waitForTimeout(150);
await p.click('[data-act="rir"][data-v="2"]');await p.waitForTimeout(150);
await p.click('[data-act="log-set"]');await p.waitForTimeout(200);
await p.click('[data-act="log-set"]');await p.waitForTimeout(300);
await p.click('[data-act="finish"]');await p.waitForTimeout(400);
await p.click('[data-act="close-summary"]');await p.waitForTimeout(300);
await p.click('nav button[data-tab="Cardio"]');await p.waitForTimeout(250);
await p.click('[data-act="c-log"]');await p.waitForTimeout(350);

// IndexedDB mirror written?
const idb=await p.evaluate(()=>new Promise(res=>{
  const r=indexedDB.open('strengthlog',1);
  r.onsuccess=()=>{const db=r.result;const tx=db.transaction('state','readonly');
    const q=tx.objectStore('state').get('strengthlog.v4');
    q.onsuccess=()=>res(q.result?{sessions:Object.keys(q.result.sessions||{}).length,cardio:(q.result.cardio||[]).length}:null);
    q.onerror=()=>res('err');};
  r.onerror=()=>res('open-err');}));
console.log('IndexedDB mirror:', JSON.stringify(idb));

// clear localStorage ONLY - the log must come back from IndexedDB
await p.evaluate(()=>localStorage.clear());
await p.goto(U,{waitUntil:'domcontentloaded'});await p.waitForTimeout(700);
await p.click('nav button[data-tab="History"]');await p.waitForTimeout(300);
const hist=(await p.$eval('#p-History',e=>e.innerText)).split('\n').slice(0,3).join(' / ');
console.log('after wiping localStorage:', hist);

// copy rows
await p.click('[data-act="copy-rows"]');await p.waitForTimeout(400);
const shown=await p.$eval('#rowsout',e=>e.textContent);
console.log('--- rowsout ---'); console.log(shown.trim());
const clip=await p.evaluate(()=>navigator.clipboard.readText().catch(()=>'(unreadable)'));
console.log('--- clipboard matches:', clip.trim()===shown.replace(/^Copied\. Paste it to Claude\.\s*/,'').trim());
console.log(errs.length?'ERRORS '+errs.join('|'):'no page errors');
await b.close();
