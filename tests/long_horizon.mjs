// Two years of 7-day weeks, to prove the app is a LOG and not a scratchpad: nothing is
// pruned, every session stays readable, the windows still compute, and the whole thing
// fits in localStorage. It is also what turned up two long-horizon bugs - dates with no
// year, and History capped at 60 sessions with no way past them.
//
//   (cd web && python3 -m http.server 8080 &) && PW_ROOT=/tmp/pw node tests/long_horizon.mjs 8080
import { createRequire } from 'node:module';
const require = createRequire(`${process.env.PW_ROOT}/package.json`);
const { chromium } = require('playwright');
const b=await chromium.launch({executablePath: process.env.PW_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args:['--ignore-certificate-errors']});
const p=await b.newPage({viewport:{width:390,height:900}});
const errs=[];p.on('pageerror',e=>errs.push(e.message));
const U=`http://127.0.0.1:${process.argv[2] || 8080}/`;
await p.goto(U,{waitUntil:'domcontentloaded'});await p.waitForTimeout(500);

// TWO YEARS of 7-day weeks, real shape: 6 lifts x 4 sets, load creeping up.
const built = await p.evaluate(()=>{
  const WEEK={mon:['incline_chest_press_machine','standing_chest_press_machine','seated_chest_press_machine','lateral_raise_machine','dip_machine','overhead_triceps_machine'],
    tue:['lat_pulldown_machine','shoulder_press_machine','standing_lateral_raise_machine','face_pull','biceps_machine','triceps_machine'],
    wed:['leg_press_machine','leg_extension_machine','seated_leg_curl_machine','hip_thrust_machine'],
    thu:['bench_press','pullup','triceps_pushdown','barbell_curl'],
    fri:['overhead_press','lateral_raise','back_pull_machine','rowing_machine','pullover_machine','reverse_fly_machine'],
    sat:['leg_press_machine','leg_extension_machine','hip_thrust_machine','standing_lateral_raise_machine'],
    sun:['bench_press','pullup','lateral_raise','face_pull']};
  const K=['sun','mon','tue','wed','thu','fri','sat'];
  const sessions={}; const cardio=[]; let sets=0;
  const end=new Date(); const start=new Date(end); start.setDate(start.getDate()-730);
  for(let d=new Date(start); d<=end; d.setDate(d.getDate()+1)){
    const iso=d.toISOString().slice(0,10); const wk=K[d.getDay()];
    const lifts={}; const w=Math.floor((d-start)/6048e5);
    for(const ex of WEEK[wk]){
      const base=(ex==='pullup')?0:40+ (ex.length%5)*5 + Math.floor(w/4)*2.5;
      lifts[ex]=[0,1,2,3].map(()=>({w:base,r:8+(w%3),rir:1}));
      sets+=4;
    }
    sessions[iso]={date:iso,plan:'gym80',at:iso+'T18:00:00Z',lifts};
    if(d.getDay()%2===0) cardio.push({id:+d, date:iso, type:'Bike', min:45, km:18.2});
  }
  localStorage.setItem('strengthlog.v4',JSON.stringify({v:4,updated_at:new Date().toISOString(),
    sessions,cardio,custom:{},live:null,plans:null,base:null}));
  const bytes=localStorage.getItem('strengthlog.v4').length;
  return {days:Object.keys(sessions).length, sets, cardio:cardio.length, kb:Math.round(bytes/1024)};
});
console.log('seeded:', JSON.stringify(built));

await p.goto(U,{waitUntil:'domcontentloaded'});await p.waitForTimeout(1500);
console.log('header:', await p.$eval('#hmeta',e=>e.textContent));
await p.click('nav button[data-tab="History"]');await p.waitForTimeout(800);
console.log('History:', (await p.$eval('#p-History',e=>e.innerText)).split('\n').slice(0,4).join(' | '));
console.log('cards rendered:', await p.$$eval('#p-History .sessrow',n=>n.length));
const more=await p.$('[data-act="more-hist"]');
console.log('show-more button:', more? (await more.textContent()).trim() : 'MISSING');
if(more){await more.click();await p.waitForTimeout(700);
  console.log('after one tap:', await p.$$eval('#p-History .sessrow',n=>n.length), 'cards');}
console.log('oldest card date:', await p.$$eval('#p-History .sesshead .d',n=>n[n.length-1].textContent));

for (const win of ['4 wk','8 wk','12 wk']) {
  await p.click('nav button[data-tab="Progress"]');await p.waitForTimeout(300);
  await p.click(`[data-act="win"][data-v="${win}"]`);await p.waitForTimeout(700);
  const t=(await p.$eval('#p-Progress',e=>e.innerText)).split('\n');
  console.log(`${win}:`, t.slice(1,4).join(' | ').slice(0,120));
}
// oldest data still reachable in a lift's history?
const lift=await p.$('[data-act="lift"]');
if(lift){await lift.click();await p.waitForTimeout(600);
  const d=(await p.$eval('.full',e=>e.innerText)).split('\n');
  console.log('lift detail:', d.slice(0,10).join(' | ').slice(0,190));}
console.log(errs.length?('ERRORS '+errs.join('|')):'no page errors');
await b.close();
