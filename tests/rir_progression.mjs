// RIR is what lets a load move: rule 2 needs a verified RIR, and a blank one satisfies
// nothing, so a log of blank-RIR sets can only ever HOLD. This asserts the whole chain -
// the control exists, it warns when blank at the rep ceiling, it is sticky across the
// sets of one lift, it reaches the stored session, and the NEXT session then progresses.
//
//   (cd web && python3 -m http.server 8080 &) && PW_ROOT=/tmp/pw node tests/rir_progression.mjs 8080
import { createRequire } from 'node:module';
const require = createRequire(process.env.PW_ROOT ? `${process.env.PW_ROOT}/package.json` : import.meta.url);
const { chromium } = require('playwright');
const b=await chromium.launch({executablePath: process.env.PW_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args:['--ignore-certificate-errors']});
const p=await b.newPage({viewport:{width:390,height:812},deviceScaleFactor:2});
const errs=[];p.on('pageerror',e=>errs.push(e.message));
const U=`http://127.0.0.1:${process.argv[2] || 8080}/`;
const seed=async(sets)=>{
  await p.goto(U,{waitUntil:'domcontentloaded'});await p.waitForTimeout(250);
  await p.evaluate((sets)=>{
    const st={v:4,updated_at:new Date().toISOString(),custom:{},cardio:[],live:null,sessions:{}};
    if(sets.length) st.sessions['2026-09-20']={date:'2026-09-20',plan:'gym80',at:'x',
      lifts:{bench_press:sets.map(([w,r,rir])=>({w,r,rir}))}};
    const wk={};for(const d of ['mon','tue','wed','thu','fri','sat','sun'])wk[d]=[['bench_press',4]];
    st.plans={gym80:{name:'gym80 block',week:wk}};
    st.base={gym80:{name:'gym80 block',week:JSON.parse(JSON.stringify(wk))}};
    localStorage.setItem('strengthlog.v4',JSON.stringify(st));
  },sets);
  await p.goto(U,{waitUntil:'domcontentloaded'});await p.waitForTimeout(450);
  await p.click('#p-Session .liftrow');await p.waitForTimeout(300);
};

// 1. the warning appears at the ceiling with a blank RIR, and goes away when one is tapped
await seed([[60,9,null],[60,9,null]]);           // hold -> target 10 = the ceiling
console.log('reps target:',await p.$eval('#s-r',e=>e.value));
console.log('RIR pills:',await p.$$eval('[data-act="rir"]',n=>n.map(e=>e.textContent)).then(a=>a.join(' ')));
console.log('blank RIR selected:',await p.$eval('[data-act="rir"][data-v=""]',e=>e.getAttribute('aria-pressed')));
console.log('warning shown at ceiling+blank:',!!(await p.$('.sheet .banner .tag')));
await p.click('[data-act="rir"][data-v="1"]');await p.waitForTimeout(250);
console.log('warning after tapping RIR 1:',!!(await p.$('.sheet .banner .tag')));

// 2. RIR is sticky across sets within the lift
await p.click('[data-act="log-set"]');await p.waitForTimeout(250);
console.log('set 1 row:',await p.$eval('.setlist .v',e=>e.textContent));
console.log('RIR still 1 for set 2:',await p.$eval('[data-act="rir"][data-v="1"]',e=>e.getAttribute('aria-pressed')));

// 3. the RIR reaches the stored session, so the rule can progress next time
await p.click('[data-act="log-set"]');await p.waitForTimeout(200);
await p.click('[data-act="log-set"]');await p.waitForTimeout(200);
await p.click('[data-act="log-set"]');await p.waitForTimeout(350);
await p.click('[data-act="finish"]');await p.waitForTimeout(400);
await p.click('[data-act="close-summary"]');await p.waitForTimeout(300);
const stored=await p.evaluate(()=>JSON.parse(localStorage.getItem('strengthlog.v4')).sessions);
const today=Object.keys(stored).sort().pop();
console.log('stored today:',JSON.stringify(stored[today].lifts.bench_press));
await p.click('nav button[data-tab="Session"]');await p.waitForTimeout(250);
await p.click('#p-Session .liftrow');await p.waitForTimeout(350);
console.log('next session prescribes:',await p.$eval('#s-w',e=>e.value),'x',await p.$eval('#s-r',e=>e.value));
console.log('why:',(await p.$eval('.sheet .meta',e=>e.textContent)).slice(0,40));
console.log(errs.length?'ERRORS '+errs.join('|'):'no page errors');
await b.close();
