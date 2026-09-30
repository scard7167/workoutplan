// The last step of every way this app has lost data: something writes an emptier
// document over a fuller one. Here the trigger is an `online` event - a network-state
// change, which on a phone in a gym fires constantly - landing before boot has hydrated,
// so persist() writes state.sessions = {} over the real log in BOTH stores.
//
// Run against a build whose boot() is artificially slowed; without the guard the stored
// session goes from ["2026-09-29"] to []. With it, it survives.
//
//   (cd web && python3 -m http.server 8080 &) && PW_ROOT=/tmp/pw node tests/no_empty_write.mjs 8080
import { createRequire } from 'node:module';
const require = createRequire(`${process.env.PW_ROOT}/package.json`);
const { chromium } = require('playwright');
const b=await chromium.launch({executablePath: process.env.PW_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args:['--ignore-certificate-errors']});
const p=await b.newPage({viewport:{width:390,height:900}});
const warn=[];p.on('console',m=>{if(m.type()==='warning')warn.push(m.text());});
const U=`http://127.0.0.1:${process.argv[2] || 8080}/`;
await p.goto(U,{waitUntil:'domcontentloaded'});await p.waitForTimeout(2200);
await p.evaluate(()=>{
  const y=new Date();y.setDate(y.getDate()-1);const iso=y.toISOString().slice(0,10);
  const wk={};for(const d of ['mon','tue','wed','thu','fri','sat','sun'])wk[d]=[['bench_press',4]];
  localStorage.setItem('strengthlog.v4',JSON.stringify({v:4,updated_at:new Date().toISOString(),
    cardio:[],live:null,custom:{},
    sessions:{[iso]:{date:iso,plan:'gym80',at:'x',lifts:{bench_press:[{w:60,r:10,rir:1},{w:60,r:10,rir:1}]}}},
    plans:{gym80:{name:'gym80 block',week:wk}},base:{gym80:{name:'gym80 block',week:JSON.parse(JSON.stringify(wk))}}}));});
const stored=()=>p.evaluate(()=>Object.keys(JSON.parse(localStorage.getItem('strengthlog.v4')||'{}').sessions||{}));
console.log('  before reload :', JSON.stringify(await stored()));
// reload, then force a PERSISTING write while boot is still asleep
await p.goto(U,{waitUntil:'commit'});
await p.waitForTimeout(150);
await p.evaluate(()=>{                       // the shape of any pre-hydrate write
  window.dispatchEvent(new Event('online')); // -> persist() with an empty state
});
await p.waitForTimeout(2600);
console.log('  after  reload :', JSON.stringify(await stored()));
console.log('  warnings      :', warn.length?warn.join(' | '):'none');
const end=await stored();
console.log(end.length ? 'PASS - the log survived a pre-hydrate write' : 'FAIL - DATA DESTROYED');
await b.close();
process.exit(end.length ? 0 : 1);
