// Reported from a gym, mid-session: "I wanted to check the logged plan for an exercise
// on an earlier day and it mixed the exercises on several days."
//
// It was not mixed. Lifts already logged today that the day ON SCREEN does not plan for
// are kept visible on purpose (sessionLifts) - hiding them would hide sets about to be
// written. But they were stacked straight under the plan with nothing between, so the
// two lists read as one scrambled day.
//
// A heading now marks where the plan ends. This asserts the heading AND, more
// importantly, that nothing was hidden or moved to get it: every logged lift is still
// on screen and the Finish button still counts every set.
//
//   (cd web && python3 -m http.server 8099 &) && PW_ROOT=/tmp/pw node tests/offplan_head.mjs 8099
import { createRequire } from 'node:module';
const require = createRequire(`${process.env.PW_ROOT}/package.json`);
const { chromium } = require('playwright');
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--ignore-certificate-errors'] });
const p = await b.newPage({ viewport: { width: 390, height: 900 } });
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
await p.goto(`http://127.0.0.1:${process.argv[2] || 8099}/`, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(900);

const heads = () => p.$$eval('.listhead', (n) => n.map((e) => e.textContent.trim()));
const names = () => p.$$eval('#p-Session .liftrow .nm', (n) => n.map((e) => e.textContent.trim()));
const finish = () => p.$eval('[data-act="finish"]', (e) => e.textContent.replace(/\s+/g, ' ').trim());

// --- log today's first two lifts, 4 sets each ---
for (let i = 0; i < 2; i++) {
  await (await p.$$('#p-Session .liftrow'))[i].click(); await p.waitForTimeout(350);
  await p.fill('#s-w', String(50 + i * 10));
  await p.click('[data-act="rir"][data-v="2"]'); await p.waitForTimeout(120);
  for (let s = 0; s < 4; s++) { await p.click('[data-act="log-set"]').catch(() => {}); await p.waitForTimeout(150); }
  await p.keyboard.press('Escape'); await p.waitForTimeout(250);
}
const logged = (await names()).slice(0, 2);
console.log('logged today      :', JSON.stringify(logged));
console.log('heading, same day :', JSON.stringify(await heads()), '(none expected - they ARE in today\'s plan)');
const before = await finish();

// --- now park the chip on another weekday, the way the report happened ---
const mine = await p.$eval('[data-act="open-day"] b', (e) => e.textContent.trim().toLowerCase());
const other = ['mon','tue','wed','thu','fri','sat','sun'].find((d) => d !== mine);
await p.click('[data-act="open-day"]'); await p.waitForTimeout(350);
await p.click(`[data-act="pick-day"][data-v="${other}"]`); await p.waitForTimeout(500);

const h = await heads();
const shown = await names();
const after = await finish();
console.log('chip now          :', await p.$eval('[data-act="open-day"]', (e) => e.textContent.replace(/\s+/g, ' ').trim()));
console.log('heading           :', JSON.stringify(h));
console.log('rows on screen    :', JSON.stringify(shown));
console.log('finish button     :', after, '| before the switch:', before);

const label = other[0].toUpperCase() + other.slice(1);
const ok = h.length === 1                                   // exactly one heading
  && h[0].includes(`${label}'s plan`)                       // names the day on screen
  && logged.every((n) => shown.includes(n))                 // NOTHING was hidden
  && after === before;                                      // every set still counted
console.log(errs.length ? 'ERRORS ' + errs.join('|') : 'no page errors');
console.log(ok ? 'PASS - the off-plan list is labelled, and no logged lift was hidden or dropped'
               : 'FAIL');
await b.close();
process.exit(ok && !errs.length ? 0 : 1);
