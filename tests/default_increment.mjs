// Every branch of the progression rule against an invented lift on the 5 kg default:
// no history gives no load, the rep ceiling steps 35 -> 40, a hold adds a rep, and below
// floor at RIR 0 deloads 35 -> 30 (rounded DOWN to the 5 kg increment).
//
//   (cd web && python3 -m http.server 8080 &) && PW_ROOT=/tmp/pw node tests/default_increment.mjs 8080
import { createRequire } from 'node:module';
const require = createRequire(`${process.env.PW_ROOT}/package.json`);
const { chromium } = require('playwright');
const b=await chromium.launch({executablePath: process.env.PW_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args:['--ignore-certificate-errors']});
const p=await b.newPage({viewport:{width:390,height:900}});
const errs=[];p.on('pageerror',e=>errs.push(e.message));
const U=`http://127.0.0.1:${process.argv[2] || 8080}/`;
const seed=async(sets)=>{
  await p.goto(U,{waitUntil:'domcontentloaded'});await p.waitForTimeout(300);
  await p.evaluate((sets)=>{
    const wk={};for(const d of ['mon','tue','wed','thu','fri','sat','sun'])wk[d]=[['preacher_machine',4]];
    const st={v:4,updated_at:new Date().toISOString(),cardio:[],live:null,sessions:{},
      custom:{preacher_machine:{muscle:'biceps',muscles:['biceps'],increment:null,rep_range:[8,12]}},
      plans:{gym80:{name:'gym80 block',week:wk}},base:{gym80:{name:'gym80 block',week:JSON.parse(JSON.stringify(wk))}}};
    if(sets.length) st.sessions['2026-09-25']={date:'2026-09-25',plan:'gym80',at:'x',
      lifts:{preacher_machine:sets.map(([w,r,rir])=>({w,r,rir}))}};
    localStorage.setItem('strengthlog.v4',JSON.stringify(st));
  },sets);
  await p.goto(U,{waitUntil:'domcontentloaded'});await p.waitForTimeout(600);
  await p.click('#p-Session .liftrow');await p.waitForTimeout(350);
  const r={w:await p.$eval('#s-w',e=>e.value), r:await p.$eval('#s-r',e=>e.value),
    why:(await p.$eval('.sheet .meta',e=>e.textContent)).trim().slice(0,58)};
  await p.keyboard.press('Escape');await p.waitForTimeout(200);
  return r;
};
console.log('no history      ->', JSON.stringify(await seed([])));
console.log('4x12 @1 (ceil)  ->', JSON.stringify(await seed([[35,12,1],[35,12,1],[35,12,2],[35,12,1]])));
console.log('4x10 @1 (hold)  ->', JSON.stringify(await seed([[35,10,1],[35,10,1],[35,9,1],[35,9,2]])));
console.log('below floor @0  ->', JSON.stringify(await seed([[35,6,0],[35,8,1]])));
console.log(errs.length?'ERRORS '+errs.join('|'):'no page errors');
await b.close();
