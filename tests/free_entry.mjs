// The app proposes NO load. Asserted here because it replaced a progression rule that
// drove the weight box, and the tests for that rule were retired with it:
//
//   - the weight box opens EMPTY on the first set of a lift, with no "rule asks" text
//   - last session's actual sets are shown instead, RIR and all - the reference, not a
//     proposal
//   - set 2 opens on set 1's numbers (continuity, not a proposal)
//   - a lift never logged before says so and still logs any value you type
//
//   (cd web && python3 -m http.server 8080 &) && PW_ROOT=/tmp/pw node tests/free_entry.mjs 8080
import { createRequire } from 'node:module';
const require = createRequire(`${process.env.PW_ROOT}/package.json`);
const { chromium } = require('playwright');
const b=await chromium.launch({executablePath: process.env.PW_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args:['--ignore-certificate-errors']});
const p=await b.newPage({viewport:{width:390,height:900},deviceScaleFactor:2});
const errs=[];p.on('pageerror',e=>errs.push(e.message));
const U=`http://127.0.0.1:${process.argv[2] || 8080}/`;
await p.goto(U,{waitUntil:'domcontentloaded'});await p.waitForTimeout(400);
await p.evaluate(()=>{
  const wk={};for(const d of ['mon','tue','wed','thu','fri','sat','sun'])wk[d]=[['bench_press',4],['preacher_machine',3]];
  localStorage.setItem('strengthlog.v4',JSON.stringify({v:4,updated_at:new Date().toISOString(),cardio:[],live:null,
    custom:{preacher_machine:{muscle:'biceps',muscles:['biceps'],increment:null,rep_range:[8,12]}},
    sessions:{'2026-09-25':{date:'2026-09-25',plan:'gym80',at:'x',lifts:{
      bench_press:[{w:62.5,r:10,rir:1},{w:62.5,r:9,rir:1},{w:60,r:9,rir:2}]}}},
    plans:{gym80:{name:'gym80 block',week:wk}},base:{gym80:{name:'gym80 block',week:JSON.parse(JSON.stringify(wk))}}}));
});
await p.goto(U,{waitUntil:'domcontentloaded'});await p.waitForTimeout(700);
console.log('session rows:', (await p.$$eval('#p-Session .liftrow',ns=>ns.map(e=>
  e.querySelector('.nm').textContent.trim()+' -> '+e.querySelector('.st').textContent.trim()))).join(' | '));

await p.click('#p-Session .liftrow');await p.waitForTimeout(400);
console.log('WITH history:');
console.log('   last-time box:', await p.$eval('.lastbox',e=>e.innerText.replace(/\s+/g,' ')).catch(()=>'MISSING'));
console.log('   weight box   :', JSON.stringify(await p.$eval('#s-w',e=>e.value)), '(must be empty - no proposal)');
console.log('   any "rule asks" text:', (await p.$eval('.sheet',e=>e.innerText)).includes('rule asks'));
await p.fill('#s-w','65');await p.click('[data-act="rir"][data-v="1"]');await p.waitForTimeout(150);
await p.click('[data-act="log-set"]');await p.waitForTimeout(250);
console.log('   set 2 carries set 1 forward:', await p.$eval('#s-w',e=>e.value), 'x', await p.$eval('#s-r',e=>e.value));
await p.keyboard.press('Escape');await p.waitForTimeout(250);

const rows=await p.$$('#p-Session .liftrow');
await rows[1].click();await p.waitForTimeout(400);
console.log('NEW lift, never logged:');
console.log('   reference:', await p.$eval('.sheet .meta',e=>e.textContent.trim()).catch(()=>'?'));
console.log('   weight box:', JSON.stringify(await p.$eval('#s-w',e=>e.value)));
console.log('   log button:', await p.$eval('[data-act="log-set"]',e=>({t:e.textContent.trim(),d:e.disabled})).then(JSON.stringify));
await p.fill('#s-w','37.5');await p.waitForTimeout(150);
await p.click('[data-act="log-set"]');await p.waitForTimeout(250);
console.log('   logged free value:', await p.$eval('.setlist .v',e=>e.textContent).catch(()=>'NOT LOGGED'));

console.log(errs.length?'ERRORS '+errs.join('|'):'no page errors');
await b.close();
