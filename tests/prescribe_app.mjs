// Drive web/app.js through the real UI for every case in prescribe_cases.py and print
// the load and rep target the log sheet opens on. Compare against tests/prescribe_ref.py.
//
//   (cd web && python3 -m http.server 8080 &) && node tests/prescribe_app.mjs 8080
//
// Chromium path is the cloud image default; override with PW_CHROME.
//
// Playwright is deliberately NOT a dependency of web/package.json - that file is what
// Vercel installs, and a browser in it would bloat every deploy. Install it anywhere and
// point NODE_PATH at it:
//
//   npm i --prefix /tmp/pw playwright
//   PW_ROOT=/tmp/pw node tests/prescribe_app.mjs 8080
//
// (NODE_PATH does not apply to ES modules, hence PW_ROOT.)
import { createRequire } from 'node:module';
// createRequire, not a path import: playwright's export map does not resolve to
// index.js, and NODE_PATH does not apply to ES modules.
const require = createRequire(process.env.PW_ROOT
  ? `${process.env.PW_ROOT}/package.json` : import.meta.url);
const { chromium } = require('playwright');
const CASES=[["bench_press",[]],
 ["bench_press",[[60,8,1],[60,7,1],[60,7,2]]],
 ["bench_press",[[60,10,1],[60,10,2],[60,10,0]]],
 ["bench_press",[[60,10,1],[60,10,null]]],
 ["bench_press",[[60,5,0],[60,8,2]]],
 ["bench_press",[[60,8,1],[62.5,6,1]]],
 ["bench_press",[[63,4,0]]],
 ["pullup",[[0,9,1],[0,8,1]]],
 ["pullup",[[0,10,1],[0,10,2]]],
 ["pullup",[[0,3,0],[0,5,0]]],
 ["lateral_raise",[[10,15,2],[10,15,1]]],
 ["lat_pulldown_machine",[[50,9,3]]]];
const b=await chromium.launch({executablePath: process.env.PW_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args:['--ignore-certificate-errors']});
const p=await b.newPage({viewport:{width:390,height:812}});
const errs=[];p.on('pageerror',e=>errs.push(e.message));
const U=`http://127.0.0.1:${process.argv[2] || 8080}/`;
for(const [i,[ex,sets]] of CASES.entries()){
  await p.goto(U,{waitUntil:'domcontentloaded'});await p.waitForTimeout(250);
  // Seed exactly the referee's history, plus a plan day that contains the lift so the
  // sheet is reachable through the real UI.
  await p.evaluate(({ex,sets})=>{
    const st={v:4,updated_at:new Date().toISOString(),custom:{},cardio:[],live:null,sessions:{}};
    if(sets.length) st.sessions['2026-09-20']={date:'2026-09-20',plan:'gym80',at:'x',
      lifts:{[ex]:sets.map(([w,r,rir])=>({w,r,rir}))}};
    const wk={};for(const d of ['mon','tue','wed','thu','fri','sat','sun'])wk[d]=[[ex,4]];
    st.plans={gym80:{name:'gym80 block',week:wk}};
    st.base={gym80:{name:'gym80 block',week:JSON.parse(JSON.stringify(wk))}};
    localStorage.setItem('strengthlog.v4',JSON.stringify(st));
  },{ex,sets});
  await p.goto(U,{waitUntil:'domcontentloaded'});await p.waitForTimeout(450);
  await p.click('#p-Session .liftrow');await p.waitForTimeout(300);
  const w=await p.$eval('#s-w',e=>e.value);
  const r=await p.$eval('#s-r',e=>e.value);
  const btn=await p.$eval('[data-act="log-set"]',e=>({t:e.textContent.trim(),d:e.disabled}));
  const note=await p.$eval('.sheet .meta',e=>e.textContent.trim()).catch(()=>'');
  console.log(`${String(i).padStart(2)} ${ex.padEnd(22)} w=${(w===''?'(empty)':w).padEnd(8)} r=${r.padEnd(3)} btn=${btn.d?'DISABLED':'enabled'} :: ${note.slice(0,72)}`);
  await p.keyboard.press('Escape');
}
console.log(errs.length?'ERRORS '+errs.join('|'):'no page errors');
await b.close();
