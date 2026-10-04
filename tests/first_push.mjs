// The first load after a Blob store is connected.
//
// The store answers {ok:true, data:null} - reachable, but empty - while the phone
// already holds sessions. Before this was handled, boot took the "nothing remote"
// branch and only re-rendered the header: the existing log stayed on one device until
// the user happened to log another set. That is the exact window the store exists to
// close, so boot now pushes what it has.
//
// Also asserts the other half: an empty phone must NOT push, or every cold open would
// write an empty document over the store of record.
//
//   (cd web && python3 -m http.server 8099 &) && PW_ROOT=/tmp/pw node tests/first_push.mjs 8099
import { createRequire } from 'node:module';
const require = createRequire(`${process.env.PW_ROOT}/package.json`);
const { chromium } = require('playwright');
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--ignore-certificate-errors'] });
const U = `http://127.0.0.1:${process.argv[2] || 8099}/`;
const LS = 'strengthlog.v4';

async function run(seed) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 900 } });
  const p = await ctx.newPage();
  const puts = [];
  // Stand in for the Blob-backed route: reachable, and empty.
  await p.route('**/api/log', async (route) => {
    const req = route.request();
    if (req.method() === 'PUT') { puts.push(JSON.parse(req.postData() || '{}')); return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"data":null}' });
  });
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(U, { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(400);
  if (seed) await p.evaluate(([k, d]) => localStorage.setItem(k, JSON.stringify(d)), [LS, seed]);
  else await p.evaluate((k) => localStorage.removeItem(k), LS);
  await p.goto(U, { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(1600);
  const header = (await p.textContent('header')) || '';
  await ctx.close();
  return { puts, errs, header: header.replace(/\s+/g, ' ').trim() };
}

const wk = {}; for (const d of ['mon','tue','wed','thu','fri','sat','sun']) wk[d] = [['bench_press', 4]];
const plans = { gym80: { name: 'gym80 block', week: wk } };
const seeded = {
  v: 4, updated_at: new Date().toISOString(), cardio: [], live: null, custom: {},
  sessions: { '2026-10-02': { date: '2026-10-02', plan: 'gym80', at: 'x',
    lifts: { bench_press: [{ w: 60, r: 10, rir: 1 }, { w: 60, r: 9, rir: 1 }, { w: 60, r: 9, rir: 2 }] } } },
  plans, base: JSON.parse(JSON.stringify(plans)),
};

const withData = await run(seeded);
const sent = withData.puts[0];
const sessionsSent = sent ? Object.keys(sent.sessions || {}) : [];
console.log('phone HAS a session  : PUTs =', withData.puts.length, '| sessions sent =', JSON.stringify(sessionsSent));

const empty = await run(null);
console.log('phone is EMPTY       : PUTs =', empty.puts.length, '(must be 0 - never write an empty doc over the store)');
console.log('header               :', empty.header.slice(0, 80));

const ok = withData.puts.length === 1 && sessionsSent.length === 1 && sessionsSent[0] === '2026-10-02'
        && empty.puts.length === 0 && !withData.errs.length && !empty.errs.length;
console.log([...withData.errs, ...empty.errs].length ? 'ERRORS ' + [...withData.errs, ...empty.errs].join('|') : 'no page errors');
console.log(ok ? 'PASS - an existing log goes up on first load; an empty one never does'
               : 'FAIL');
await b.close();
process.exit(ok ? 0 : 1);
