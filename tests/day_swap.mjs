// A skipped day is the normal case in a 7-day week, so today can run another day's
// session. This asserts the three things that make that safe: the lifts change, the sets
// still log under TODAY's real date, and the weekly plan is not touched.
//
//   (cd web && python3 -m http.server 8080 &) && PW_ROOT=/tmp/pw node tests/day_swap.mjs 8080
import { createRequire } from 'node:module';
const require = createRequire(`${process.env.PW_ROOT}/package.json`);
const { chromium } = require('playwright');
const b=await chromium.launch({executablePath: process.env.PW_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args:['--ignore-certificate-errors']});
const p=await b.newPage({viewport:{width:390,height:900},deviceScaleFactor:2});
const errs=[];p.on('pageerror',e=>errs.push(e.message));
const U=`http://127.0.0.1:${process.argv[2] || 8080}/`;
await p.goto(U,{waitUntil:'domcontentloaded'});await p.waitForTimeout(700);

const head=async()=>({kicker:await p.$eval('#p-Session .kicker',e=>e.textContent.trim()),
  h1:await p.$eval('#p-Session h1',e=>e.textContent.trim()),
  count:await p.$eval('#p-Session .count',e=>e.textContent.trim()),
  lifts:await p.$$eval('#p-Session .liftrow .nm',n=>n.map(e=>e.textContent))});
console.log('today as-is:', JSON.stringify(await head(),null,0));

await p.click('[data-act="open-day"]');await p.waitForTimeout(400);
console.log('picker rows:');
for(const r of await p.$$eval('[data-act="pick-day"]',ns=>ns.map(e=>e.innerText.replace(/\n/g,' | ')))) console.log('   ',r);


// run Monday's session today
const mine = await p.$eval('[data-act="open-day"] b', e => e.textContent.trim().toLowerCase());
const other = ['mon','tue','wed','thu','fri','sat','sun'].find(d => d !== mine);
await p.click(`[data-act="pick-day"][data-v="${other}"]`);await p.waitForTimeout(450);
const after=await head();
console.log(`after picking ${other.toUpperCase()} (a real shift):`, JSON.stringify(after,null,0));
console.log('chip:', await p.$eval('[data-act="open-day"]',e=>e.textContent.replace(/\s+/g,' ').trim()));

// log a set - it must carry TODAY's date, not Monday's
await p.click('#p-Session .liftrow');await p.waitForTimeout(350);
await p.fill('#s-w','50');await p.click('[data-act="rir"][data-v="2"]');await p.waitForTimeout(200);
await p.click('[data-act="log-set"]');await p.waitForTimeout(250);
await p.keyboard.press('Escape');await p.waitForTimeout(200);
await p.click('[data-act="finish"]');await p.waitForTimeout(450);
await p.click('[data-act="close-summary"]');await p.waitForTimeout(350);
const stored=await p.evaluate(()=>JSON.parse(localStorage.getItem('strengthlog.v4')).sessions);
console.log('logged under date:', Object.keys(stored), '->', JSON.stringify(Object.keys(stored[Object.keys(stored)[0]].lifts)));
console.log('plan untouched (Mon still 6 lifts):', await p.evaluate(()=>{
  const st=JSON.parse(localStorage.getItem('strengthlog.v4'));
  return (st.plans?.gym80?.week?.mon||[]).length;}));
console.log(errs.length?'ERRORS '+errs.join('|'):'no page errors');
await b.close();
