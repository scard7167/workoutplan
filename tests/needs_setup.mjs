// A lift the app invents is loggable immediately on the 5 kg default, and the assumption
// is LABELLED - Session row, Plan tag (beside the name, which truncates), and a banner in
// the sheet. Reported as being told "needs setup" only after tapping a lift mid-session.
//
//   (cd web && python3 -m http.server 8080 &) && PW_ROOT=/tmp/pw node tests/needs_setup.mjs 8080
import { createRequire } from 'node:module';
const require = createRequire(`${process.env.PW_ROOT}/package.json`);
const { chromium } = require('playwright');
const b=await chromium.launch({executablePath: process.env.PW_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args:['--ignore-certificate-errors']});
const p=await b.newPage({viewport:{width:390,height:900},deviceScaleFactor:2});
const errs=[];p.on('pageerror',e=>errs.push(e.message));
const U=`http://127.0.0.1:${process.argv[2] || 8080}/`;
await p.goto(U,{waitUntil:'domcontentloaded'});await p.waitForTimeout(500);
// reproduce the report: a real lift plus provisional ones with long names
await p.evaluate(()=>{
  const day=[['lat_pulldown_machine',4],['side_raises_standing_machine',3],
    ['biceps_curl_pull_sitting',3],['military_press_sitting',3],['preacher_machine',5]];
  const wk={};for(const d of ['mon','tue','wed','thu','fri','sat','sun'])wk[d]=day;
  localStorage.setItem('strengthlog.v4',JSON.stringify({v:4,updated_at:new Date().toISOString(),
    sessions:{},cardio:[],live:null,
    custom:{side_raises_standing_machine:{muscle:'side_delts',muscles:['side_delts'],increment:null,rep_range:[8,12]},
      biceps_curl_pull_sitting:{muscle:'biceps',muscles:['biceps'],increment:null,rep_range:[8,12]},
      military_press_sitting:{muscle:'front_delts',muscles:['front_delts'],increment:null,rep_range:[8,12]},
      preacher_machine:{muscle:'biceps',muscles:['biceps'],increment:null,rep_range:[8,12]}},
    plans:{gym80:{name:'gym80 block',week:wk}},base:{gym80:{name:'gym80 block',week:JSON.parse(JSON.stringify(wk))}}}));
});
await p.goto(U,{waitUntil:'domcontentloaded'});await p.waitForTimeout(700);
console.log('SESSION rows:');
for(const r of await p.$$eval('#p-Session .liftrow',ns=>ns.map(e=>{
  const nm=e.querySelector('.nm').textContent.trim();
  const st=e.querySelector('.st')?.textContent.trim();
  return `${nm.padEnd(32)} -> ${st}`;}))) console.log('   ',r);
await p.click('nav button[data-tab="Plan"]');await p.waitForTimeout(400);
console.log('PLAN rows (tag must survive a long name):');
for(const r of await p.$$eval('#p-Plan .planrow',ns=>ns.map(e=>{
  const nm=e.querySelector('.nm');
  const tag=e.querySelector('.tag');
  const clipped=nm.scrollWidth>nm.clientWidth+1;
  return `${nm.textContent.trim().padEnd(32)} tag=${tag?tag.textContent.trim():'none'}${clipped?'  (name truncated)':''}`;}))) console.log('   ',r);

// the whole point of the change: an invented lift must now be loggable
await p.click('nav button[data-tab="Session"]');await p.waitForTimeout(300);
const rows=await p.$$('#p-Session .liftrow');
await rows[4].click();await p.waitForTimeout(400);
console.log('SHEET for an invented lift:');
console.log('   banner:', await p.$eval('.sheet .banner',e=>e.innerText.split(String.fromCharCode(10)).join(' ')).catch(()=>'none'));
console.log('   weight box disabled:', await p.$eval('#s-w',e=>e.disabled).catch(()=>'MISSING'));
console.log('   log button:', await p.$eval('[data-act="log-set"]',e=>({t:e.textContent.trim(),d:e.disabled})).then(JSON.stringify));
await p.fill('#s-w','35');await p.waitForTimeout(150);
await p.click('[data-act="rir"][data-v="2"]');await p.waitForTimeout(150);
await p.click('[data-act="log-set"]');await p.waitForTimeout(250);
console.log('   after logging, set list:', await p.$eval('.setlist .v',e=>e.textContent).catch(()=>'NOT LOGGED'));
await p.keyboard.press('Escape');await p.waitForTimeout(200);
await p.click('[data-act="finish"]');await p.waitForTimeout(400);
await p.click('[data-act="close-summary"]');await p.waitForTimeout(300);
await p.click('nav button[data-tab="Session"]');await p.waitForTimeout(300);
await rows[4].click().catch(()=>{});await p.waitForTimeout(400);
console.log('   next prescription:', await p.$eval('#s-w',e=>e.value).catch(()=>'?'), 'x', await p.$eval('#s-r',e=>e.value).catch(()=>'?'));
console.log(errs.length?'ERRORS '+errs.join('|'):'no page errors');
await b.close();
