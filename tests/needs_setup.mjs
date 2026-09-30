// A lift the app invented has no increment, so it cannot be prescribed for or logged.
// This asserts the app says so EARLY: on the Session row before you tap it, and on the
// Plan row where the tag must survive a name long enough to be truncated. Reported after
// tapping a lift mid-session and only then being told.
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

console.log(errs.length?'ERRORS '+errs.join('|'):'no page errors');
await b.close();
