// Sets logged but never Finished, seen the NEXT DAY. hydrate() used to restore `live`
// only when its date was today, so an unfinished session was silently discarded on load
// and the next persist() wrote the empty replacement over it in BOTH stores. Sets that
// reached disk were destroyed by opening the app the following morning.
//
// Asserts: the session survives the load, the Session tab opens on ITS date, a banner
// offers it, and finishing writes it under ITS OWN date - not today's.
//
//   (cd web && python3 -m http.server 8080 &) && PW_ROOT=/tmp/pw node tests/unfinished_session.mjs 8080
import { createRequire } from 'node:module';
const require = createRequire(`${process.env.PW_ROOT}/package.json`);
const { chromium } = require('playwright');
const b=await chromium.launch({executablePath: process.env.PW_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args:['--ignore-certificate-errors']});
const p=await b.newPage({viewport:{width:390,height:900}});
const errs=[];p.on('pageerror',e=>errs.push(e.message));
const U=`http://127.0.0.1:${process.argv[2] || 8080}/`;
await p.goto(U,{waitUntil:'domcontentloaded'});await p.waitForTimeout(400);
// A session logged YESTERDAY and never finished - exactly the "I logged it and it's gone" shape.
await p.evaluate(()=>{
  const y=new Date();y.setDate(y.getDate()-1);const iso=y.toISOString().slice(0,10);
  const wk={};for(const d of ['mon','tue','wed','thu','fri','sat','sun'])wk[d]=[['bench_press',4]];
  localStorage.setItem('strengthlog.v4',JSON.stringify({v:4,updated_at:new Date().toISOString(),
    sessions:{},cardio:[],custom:{},
    live:{date:iso,plan:'gym80',logged:{bench_press:[{w:60,r:10,rir:1},{w:60,r:9,rir:1},{w:60,r:9,rir:2},{w:60,r:8,rir:2}]},
      extra:{},order:null,rirBy:{},dayKey:null},
    plans:{gym80:{name:'gym80 block',week:wk}},base:{gym80:{name:'gym80 block',week:JSON.parse(JSON.stringify(wk))}}}));
});
await p.goto(U,{waitUntil:'domcontentloaded'});await p.waitForTimeout(700);
console.log('header          :', await p.$eval('#hmeta',e=>e.textContent));
console.log('Session kicker  :', await p.$eval('#p-Session .kicker',e=>e.textContent.trim()));
console.log('Session counter :', await p.$eval('#p-Session .count',e=>e.textContent.trim()));
await p.click('nav button[data-tab="History"]');await p.waitForTimeout(400);
console.log('History         :', (await p.$eval('#p-History',e=>e.innerText)).split('\n').slice(0,3).join(' | '));
await p.click('nav button[data-tab="Progress"]');await p.waitForTimeout(400);
console.log('Progress        :', (await p.$eval('#p-Progress',e=>e.innerText)).split('\n').slice(3,5).join(' | '));
const st=await p.evaluate(()=>{const s=JSON.parse(localStorage.getItem('strengthlog.v4'));
  return {finished:Object.keys(s.sessions||{}).length, liveDate:s.live&&s.live.date,
    liveSets:s.live?Object.values(s.live.logged).flat().length:0};});
console.log('storage         :', JSON.stringify(st));
console.log('--- recovery ---');
await p.click('nav button[data-tab="Session"]');await p.waitForTimeout(400);
console.log('banner   :', await p.$eval('#p-Session .banner.warn',e=>e.innerText.split(String.fromCharCode(10)).join(' ')).catch(()=>'MISSING'));
await p.click('#p-Session .banner.warn [data-act="finish"]');await p.waitForTimeout(500);
console.log('summary  :', await p.$eval('.full.summary',e=>e.innerText.split(String.fromCharCode(10)).slice(0,4).join(' | ')).catch(()=>'none'));
await p.click('[data-act="close-summary"]');await p.waitForTimeout(400);
await p.click('nav button[data-tab="History"]');await p.waitForTimeout(400);
console.log('History  :', (await p.$eval('#p-History',e=>e.innerText)).split(String.fromCharCode(10)).slice(0,6).join(' | '));
const after=await p.evaluate(()=>{const s=JSON.parse(localStorage.getItem('strengthlog.v4'));
  return {finished:Object.keys(s.sessions||{}), sets:Object.values(s.sessions||{}).map(x=>Object.values(x.lifts).flat().length)};});
console.log('storage  :', JSON.stringify(after));
console.log(errs.length?'ERRORS '+errs.join('|'):'no page errors');
await b.close();
