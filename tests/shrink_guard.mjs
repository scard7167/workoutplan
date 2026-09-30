// The guard in persist() refuses ANY shrinking write, not just a total wipe. Two halves,
// because a guard this blunt can fail in both directions:
//
//   1. it must not block the shrinks that are real - logging grows the log through it,
//      and undoing a cardio entry (which passes `force`) still removes it;
//   2. it must block a PARTIAL loss, which is the case the first version let through.
//      Simulated the way it actually happens: a second copy of the app writes more sets,
//      so this tab's in-memory state is now SMALLER than what is stored. That tab must
//      not be able to write its stale state over the fuller one - it must recover to it.
//
//   (cd web && python3 -m http.server 8099 &) && PW_ROOT=/tmp/pw node tests/shrink_guard.mjs 8099
import { createRequire } from 'node:module';
const require = createRequire(`${process.env.PW_ROOT}/package.json`);
const { chromium } = require('playwright');
const b=await chromium.launch({executablePath: process.env.PW_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args:['--ignore-certificate-errors']});
const p=await b.newPage({viewport:{width:390,height:900}});
const errs=[];p.on('pageerror',e=>errs.push(e.message));
const warn=[];p.on('console',m=>{if(m.type()==='warning')warn.push(m.text());});
const U=`http://127.0.0.1:${process.argv[2] || 8099}/`;
const LS='strengthlog.v4';
const cen=()=>p.evaluate((k)=>{const d=JSON.parse(localStorage.getItem(k)||'{}');
  let sets=0;for(const s of Object.values(d.sessions||{}))for(const v of Object.values(s.lifts||{}))sets+=v.length;
  return {days:Object.keys(d.sessions||{}).length,sets,cardio:(d.cardio||[]).length};},LS);

await p.goto(U,{waitUntil:'domcontentloaded'});await p.waitForTimeout(400);
await p.evaluate((k)=>{
  const wk={};for(const d of ['mon','tue','wed','thu','fri','sat','sun'])wk[d]=[['bench_press',4]];
  localStorage.setItem(k,JSON.stringify({v:4,updated_at:new Date().toISOString(),
    sessions:{},cardio:[],live:null,custom:{},
    plans:{gym80:{name:'gym80 block',week:wk}},base:{gym80:{name:'gym80 block',week:JSON.parse(JSON.stringify(wk))}}}));},LS);
await p.goto(U,{waitUntil:'domcontentloaded'});await p.waitForTimeout(800);

// --- 1. real logging still GROWS the log through the guard ---
await p.click('#p-Session .liftrow');await p.waitForTimeout(350);
await p.fill('#s-w','60');await p.click('[data-act="rir"][data-v="1"]');await p.waitForTimeout(150);
for(let i=0;i<4;i++){await p.click('[data-act="log-set"]').catch(()=>{});await p.waitForTimeout(160);}
await p.keyboard.press('Escape');await p.waitForTimeout(200);
await p.click('[data-act="finish"]');await p.waitForTimeout(400);
await p.click('[data-act="close-summary"]');await p.waitForTimeout(400);
const logged=await cen();
console.log('after logging a session :', JSON.stringify(logged));

// --- 1b. cardio logs, then UNDO must still work - a legitimate shrink, passed force ---
await p.click('nav button[data-tab="Cardio"]');await p.waitForTimeout(300);
await p.click('[data-act="c-log"]');await p.waitForTimeout(400);
console.log('after logging cardio    :', JSON.stringify(await cen()));
await p.click('[data-act="c-undo"]');await p.waitForTimeout(500);
const afterUndo=await cen();
console.log('after cardio UNDO       :', JSON.stringify(afterUndo));

// --- 2. a stale tab cannot write its smaller state over a fuller stored copy ---
// Another copy of the app logged two more days while this tab sat open.
await p.evaluate((k)=>{
  const d=JSON.parse(localStorage.getItem(k));
  const mk=(iso)=>({date:iso,plan:'gym80',at:'x',
    lifts:{bench_press:[{w:60,r:10,rir:1},{w:60,r:10,rir:1},{w:60,r:10,rir:1},{w:60,r:10,rir:1}]}});
  for(const iso of ['2026-01-05','2026-01-06'])d.sessions[iso]=mk(iso);
  d.updated_at=new Date().toISOString();
  localStorage.setItem(k,JSON.stringify(d));
},LS);
const fuller=await cen();
console.log('another copy wrote more :', JSON.stringify(fuller));
await p.evaluate(()=>window.dispatchEvent(new Event('online')));  // -> a persisting write
await p.waitForTimeout(900);
const after=await cen();
console.log('after the stale write   :', JSON.stringify(after));
console.log('warnings                :', warn.filter(w=>/refused/.test(w)).join(' | ')||'none');

const ok = logged.sets===4 && afterUndo.cardio===0
        && after.days===fuller.days && after.sets===fuller.sets;
console.log(ok ? 'PASS - real growth and a real undo pass; a partial loss is refused'
               : 'FAIL - the guard is wrong in one direction or the other');
console.log(errs.length?'ERRORS '+errs.join('|'):'no page errors');
await b.close();
process.exit(ok && !errs.length ? 0 : 1);
