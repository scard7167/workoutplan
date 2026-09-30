// Strength Log - Session · Cardio · Progress · Plan · History.
//
// Built from the Nocturne design handoff. Every metric here is recomputed from the set
// log using the handoff's Data formulas (Epley, 78 kg for bodyweight lifts, hard set =
// RIR <= 2, volume 0-3/4-9/10-20/>20). Those deliberately differ from analyze.py's -
// see CLAUDE.md, "The handoff override".
//
// The one thing that does NOT come from the handoff is the load the log sheet opens on:
// that is the repo's double-progression rule, because no load may come from anywhere
// else. The design is unaffected - it is still a stepper with a number in it.

import { EXERCISES, PLANS, ACTIVE_PLAN, SEED_LOG, PROGRESSION, BUILD } from "./data.js";

/* ------------------------------------------------------------------ constants */

const BW_KG = 78;                    // handoff: bodyweight lifts carry 78 kg. A setting one day.
// The app proposes no load, so it needs no increment: `increment` and `rep_range` exist
// only for `analyze.py`, which still has a progression rule. A lift the app invents
// therefore needs neither, and nothing about it is assumed.
const DEFAULT_REP_RANGE = [8, 12];
const CARDIO_GOAL = 3;               // sessions a week, Mon-Sun
const NOISE = 2.5;                   // % - anything inside this is "flat", never up or down
const MIN_N = 4;                     // sessions in the window before a lift is rated

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_LABEL = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
const JS_DAY = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const GROUPS = ["chest", "upper back", "lats", "lower back", "shoulders",
  "biceps", "triceps", "quads", "hamstrings", "glutes", "calves", "abs"];
const TO_GROUP = {
  chest: "chest", lats: "lats", upper_back: "upper back", lower_back: "lower back",
  front_delts: "shoulders", side_delts: "shoulders", rear_delts: "shoulders",
  biceps: "biceps", triceps: "triceps", quads: "quads", hamstrings: "hamstrings",
  glutes: "glutes", calves: "calves", core: "abs", abs: "abs",
};
const COV = {
  missed: { label: "Missed", rank: 0 }, minimum: { label: "Minimum", rank: 1 },
  high: { label: "High", rank: 2 }, optimal: { label: "Optimal", rank: 3 },
};
const covStatus = (n) => (n <= 3 ? "missed" : n <= 9 ? "minimum" : n <= 20 ? "optimal" : "high");

const CARDIO_TYPES = ["Treadmill", "Bike", "Elliptical", "Outdoor run"];
// The canonical names those four resolve to in exercises.yaml. analyze.py resolves them
// through the real alias map; this is only so the pasted rows already read correctly.
const CARDIO_CANON = {
  "Treadmill": "treadmill", "Bike": "bike",
  "Elliptical": "elliptical", "Outdoor run": "outdoor_run",
};
const MUSCLE_PILLS = ["chest", "lats", "upper_back", "lower_back", "side_delts", "front_delts",
  "rear_delts", "biceps", "triceps", "hamstrings", "quads", "glutes", "calves", "core"];

/* ---------------------------------------------------------------- small utils */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clone = (o) => JSON.parse(JSON.stringify(o));
const sum = (a) => a.reduce((p, q) => p + q, 0);
const avg = (a) => (a.length ? sum(a) / a.length : null);
const uniq = (a) => [...new Set(a)];

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const today = () => iso(new Date());
const addDays = (s, n) => { const d = new Date(s + "T00:00:00"); d.setDate(d.getDate() + n); return iso(d); };
const dayDiff = (a, b) => Math.round((new Date(a + "T00:00:00") - new Date(b + "T00:00:00")) / 864e5);
const weekdayOf = (s) => JS_DAY[new Date(s + "T00:00:00").getDay()];
// The year is shown only when it is NOT the current one. Without that, the first point
// of a two-year e1RM chart labelled "29 Sept" reads as today - which is exactly what a
// long-horizon test turned up.
const fmtDate = (s) => {
  const d = new Date(s + "T00:00:00");
  const opts = { day: "numeric", month: "short" };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString("en-GB", opts);
};

// The NEXT date a weekday falls on, counting today as itself. The Plan tab edits a
// repeating week, so the useful question is not "what was this week's Monday" - on a
// Sunday that is six days in the PAST - but "when do I next train this day". This way
// every date on the strip is today or ahead, and today and tomorrow are always right.
function nextDateOf(dayKey) {
  const t = today();
  const want = DAYS.indexOf(dayKey);
  const have = DAYS.indexOf(weekdayOf(t));
  return addDays(t, (want - have + 7) % 7);
}

const dayRel = (dayKey) => {
  const d = nextDateOf(dayKey);
  return d === today() ? "today" : d === addDays(today(), 1) ? "tomorrow" : "";
};

const disp = (ex) => ex.replace(/_/g, " ");
const primeOf = (ex) => (EXERCISES[ex] ? EXERCISES[ex].muscles[0] : (state.custom[ex] || {}).muscle || null);
const groupOf = (ex) => TO_GROUP[primeOf(ex)] || null;
const isBW = (ex) => !!(EXERCISES[ex] && EXERCISES[ex].bodyweight);
const libOf = (ex) => EXERCISES[ex] || state.custom[ex] || null;
const initials = (ex) => disp(ex).split(" ").map((w) => w[0]).slice(0, 2).join("");

const sgn = (v) => (v > 0 ? "+" : v < 0 ? "−" : "±");
const pct = (v, d = 1) => (v == null ? "—" : `${sgn(+v.toFixed(d))}${Math.abs(v).toFixed(d)}%`);
const cls = (v, noise) => (v == null ? "none" : Math.abs(v) < noise ? "flat" : v < 0 ? "down" : "up");
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

/* ------------------------------------------------------------------- the store */
//
// localStorage is the write-ahead buffer: a set is on disk before anything touches the
// network, because a gym with no bars is the normal case. /api/log is the store of
// record - it is what makes the log survive a cleared cache and reach a second device.
// When the API says it has no blob configured the page runs on localStorage alone and
// says so, rather than pretending to have saved.

const LS = "strengthlog.v4";
const API = "api/log";

const store = {
  state: "local",              // local | syncing | synced | error
  detail: "",
  async pull() {
    try {
      const r = await fetch(API, { headers: { accept: "application/json" } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (!j.ok) { store.state = "local"; store.detail = j.reason || "no store"; return null; }
      store.state = "synced";
      return j.data || null;
    } catch (e) { store.state = "local"; store.detail = String(e.message || e); return null; }
  },
  async push(doc) {
    if (store.state === "local" && store.detail === "not_configured") return;
    try {
      const r = await fetch(API, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify(doc),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      store.state = j.ok ? "synced" : "local";
      if (!j.ok) store.detail = j.reason || "no store";
    } catch (e) { store.state = "error"; store.detail = String(e.message || e); }
    renderHeader();
  },
};

// ------------------------------------------------------ local durability
//
// Until a Blob store exists, the phone IS the store, so one copy in localStorage is not
// good enough. Three things harden it, all client-side and needing nothing from Vercel:
//
//   1. navigator.storage.persist() asks the browser to exempt this origin from
//      eviction under storage pressure. An installed PWA is usually granted it.
//   2. Every write also goes to IndexedDB. It is a SEPARATE quota and eviction path
//      from localStorage, so the two rarely die together, and boot takes whichever
//      copy is newer.
//   3. `storage` is reported honestly in the header - "persisted", "local" or
//      "unsaved" - because a log that quietly is not saving is the one thing this app
//      cannot do.

const IDB_DB = "strengthlog";
const IDB_STORE = "state";
let persisted = null;          // null = not asked yet, true/false = the browser's answer

function idb() {
  return new Promise((res, rej) => {
    if (!self.indexedDB) return rej(new Error("no indexedDB"));
    const r = indexedDB.open(IDB_DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(IDB_STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function idbPut(doc) {
  const db = await idb();
  await new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(doc, LS);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
  db.close();
}

async function idbGet() {
  const db = await idb();
  const doc = await new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const q = tx.objectStore(IDB_STORE).get(LS);
    q.onsuccess = () => res(q.result || null);
    q.onerror = () => rej(q.error);
  });
  db.close();
  return doc;
}

let pushTimer = null;
function snapshot() {
  return {
    v: 4, updated_at: new Date().toISOString(),
    sessions: state.sessions, cardio: state.cardio, live: state.live,
    plans: state.plans, base: state.base, custom: state.custom,
    planKey: state.planKey, sessionPlanKey: state.sessionPlanKey,
  };
}

let booted = false;

// Refuse to write a document that has LESS in it than the one already stored, unless the
// user asked for that (a discard). Every way data has been lost here ends in the same
// last step: something writes an emptier document over a fuller one. This is the step,
// so this is where it is stopped - whatever the cause upstream.
// What a document holds, in the three counts that only ever grow by themselves.
function census(d) {
  const sessions = (d && d.sessions) || {};
  let sets = 0;
  for (const s of Object.values(sessions)) {
    for (const v of Object.values((s && s.lifts) || {})) sets += v.length;
  }
  return { days: Object.keys(sessions).length, sets, cardio: ((d && d.cardio) || []).length };
}

// Refuse ANY shrink, not just a total wipe. The first version only caught sessions going
// to zero, which would have let 12 sessions become 1, or a session's 24 sets become 2,
// through untouched - and a partial loss is harder to notice than a complete one.
// Legitimate shrinks (discarding a stale session, undoing a cardio entry) pass force.
function wouldDestroy(doc) {
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(LS) || "null"); } catch { return false; }
  if (!stored) return false;
  const a = census(stored), b = census(doc);
  return b.days < a.days || b.sets < a.sets || b.cardio < a.cardio;
}

function persist(push = true, force = false) {
  const doc = snapshot();
  if (!booted && !force) return;              // nothing is written before the log is read
  if (!force && wouldDestroy(doc)) {
    // Do not write. Recover instead: the stored copy is the real one. The counts go to
    // the console because a guard that silently hides a real bug is its own problem.
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem(LS) || "null"); } catch { /* ignore */ }
    console.warn("strengthlog: refused a shrinking write",
      { stored: census(stored), attempted: census(doc) });
    readLocalBest().then((d) => { if (d) { hydrate(d); renderAll(); } });
    return;
  }
  let localOk = false;
  try { localStorage.setItem(LS, JSON.stringify(doc)); localOk = true; } catch { /* private mode, quota */ }
  // Deliberately not awaited: a set must never wait on a write. A failure here is
  // reported by the next renderHeader, not swallowed.
  idbPut(doc).then(() => { if (!localOk) renderHeader(); })
    .catch(() => { if (!localOk) { store.detail = "neither store accepted the write"; renderHeader(); } });
  if (!push) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => store.push(doc), 1200);
}

function readLocal() {
  try { return JSON.parse(localStorage.getItem(LS) || "null"); } catch { return null; }
}

// Whichever local copy is newer. A cleared localStorage recovers from IndexedDB and
// vice versa; only losing both loses the log.
async function readLocalBest() {
  const a = readLocal();
  let b = null;
  try { b = await idbGet(); } catch { /* no IDB */ }
  if (!a) return b;
  if (!b) return a;
  return (b.updated_at || "") > (a.updated_at || "") ? b : a;
}

async function askPersist() {
  try {
    if (!navigator.storage?.persist) return;
    persisted = await navigator.storage.persisted?.() || false;
    if (!persisted) persisted = await navigator.storage.persist();
  } catch { persisted = null; }
}

/* ------------------------------------------------------------------- the state */

const filePlans = () => {
  const out = {};
  for (const [pid, p] of Object.entries(PLANS)) {
    const week = {};
    for (const d of DAYS) week[d] = ((p.week[d] || {}).plan || []).map((x) => [x.exercise, x.sets]);
    out[pid] = { name: p.name, week };
  }
  return out;
};

const state = {
  tab: "Session",
  win: "8 wk",
  day: weekdayOf(today()),
  plans: filePlans(),
  base: clone(filePlans()),
  custom: {},                      // name -> {muscle, increment|null, rep_range}
  planKey: ACTIVE_PLAN,
  sessionPlanKey: ACTIVE_PLAN,
  sessions: {},                    // date -> {date, plan, lifts:{ex:[{w,r,rir}]}}
  cardio: [],
  live: null,                      // {date, plan, logged:{}, extra:{}, order:null}
  // ui only
  reorder: false, sheet: null, w: 0, r: 8, rir: null, summaryOn: false, lift: null,
  libOn: false, query: "", newMuscle: "chest", switchOn: false, dayOn: false,
  renaming: null, draft: "", renameError: "",
  openSession: null, kpiView: "Muscles", kpiBase: "4W", pbucket: null, histShown: 60,
  lastSummary: null, armedDrop: null, armStale: false,
  cType: "Treadmill", cMin: "30", cKm: "0", cWhen: "visit", cDate: null, cLast: null,
};

const plansOf = () => state.plans[state.planKey] || { name: state.planKey, week: {} };
const weekOf = (pid) => (state.plans[pid] || { week: {} }).week;
const liveDate = () => (state.live ? state.live.date : today());

const staleLive = () => {
  const L = state.live;
  return L && L.date !== today() && sum(Object.values(L.logged || {}).map((v) => v.length)) > 0
    ? L : null;
};

function ensureLive() {
  const d = today();
  // A session from another day that has sets in it is NOT replaced - it is unfinished
  // work, and the Session tab makes you resolve it. An empty one is just cleared.
  if (staleLive()) return state.live;
  if (state.live && state.live.date !== d && !Object.keys(state.live.logged).length) state.live = null;
  if (!state.live) state.live = { date: d, plan: state.sessionPlanKey, logged: {}, extra: {}, order: null, rirBy: {}, dayKey: null };
  return state.live;
}

/* ------------------------------------------------------- the log & derivations */

// Every set the app knows about: log.csv history plus every finished session.
function allSets() {
  const out = SEED_LOG.map((r) => mkSet(r.date, r.exercise, r.weight_kg, r.reps, r.rir));
  for (const s of Object.values(state.sessions)) {
    for (const [ex, sets] of Object.entries(s.lifts)) {
      for (const v of sets) out.push(mkSet(s.date, ex, v.w, v.r, v.rir == null ? null : v.rir));
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function mkSet(date, ex, w, reps, rir) {
  const load = isBW(ex) ? BW_KG + w : w;
  return { date, ex, name: disp(ex), w, reps, rir, load, e1: load * (1 + reps / 30) };
}

// Best set per session, per lift.
function bySession(sets) {
  const m = {};
  for (const s of sets) {
    const x = (m[s.ex] = m[s.ex] || { ex: s.ex, days: {}, all: [] });
    x.all.push(s);
    const d = (x.days[s.date] = x.days[s.date] || { date: s.date, best: 0, sets: 0, top: null, ton: 0, hard: 0, hload: 0 });
    d.sets++; d.ton += s.load * s.reps;
    if (s.rir == null || s.rir <= 2) { d.hard++; d.hload += s.load; }
    if (s.e1 > d.best) { d.best = s.e1; d.top = s; }
  }
  for (const x of Object.values(m)) x.series = Object.values(x.days).sort((a, b) => (a.date < b.date ? -1 : 1));
  return m;
}

// Least-squares slope of e1RM over a series, as %/week of the current value.
function ratePctWeek(series) {
  const n = series.length;
  if (n < 2) return 0;
  const t0 = series[0].date;
  const xs = series.map((d) => dayDiff(d.date, t0) / 7), ys = series.map((d) => d.best);
  const mx = avg(xs), my = avg(ys);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  const slope = den ? num / den : 0;
  const cur = ys[n - 1] || 1;
  return (slope / cur) * 100;
}

function statusOf(series) {
  if (series.length < 2) return null;
  const tail = series.slice(-4).map((d) => d.best);
  if (tail.length >= 3 && Math.max(...tail) - Math.min(...tail) < 0.6) return "plateauing";
  const r = ratePctWeek(series);
  return r > 0.6 ? "progressing" : r > 0.15 ? "maintaining" : r > -0.3 ? "plateauing" : "regressing";
}

const mean2 = (a, end) => { const x = end ? a.slice(-2) : a.slice(0, 2); return x.length ? sum(x) / x.length : 0; };

// Everything Progress needs, for one window.
function windowView(weeks) {
  const sets = allSets();
  if (!sets.length) return { empty: true, lifts: [], sessions: 0, idx: [100], end: today() };
  const end = sets[sets.length - 1].date;
  const from = addDays(end, -(weeks * 7 - 1));
  const win = sets.filter((s) => s.date >= from);
  const per = bySession(win);
  const lifts = Object.values(per).map((x) => {
    const s = x.series, b = s.map((d) => d.best);
    const chg = mean2(b, false) ? (mean2(b, true) / mean2(b, false) - 1) * 100 : 0;
    return {
      ex: x.ex, name: x.name || disp(x.ex), muscle: primeOf(x.ex), group: groupOf(x.ex),
      series: s, n: s.length, chg, cur: b[b.length - 1] || 0, first: b[0] || 0,
      rate: ratePctWeek(s), status: statusOf(s),
      bucket: s.length < MIN_N ? "thin" : chg >= NOISE ? "up" : chg <= -NOISE ? "down" : "flat",
    };
  });
  // Strength index: each lift normalised to its own first session in the window = 100,
  // averaged across lifts, one point per week.
  const nWeeks = Math.max(1, weeks);
  const idx = [];
  for (let k = 0; k < nWeeks; k++) {
    const cut = addDays(from, (k + 1) * 7 - 1);
    const vals = lifts.map((l) => {
      const upto = l.series.filter((d) => d.date <= cut);
      return upto.length && l.first ? (upto[upto.length - 1].best / l.first) * 100 : null;
    }).filter((v) => v != null);
    if (vals.length) idx.push(+avg(vals).toFixed(1));
  }
  if (!idx.length) idx.push(100);
  const sessions = uniq(win.map((s) => s.date)).length;
  // hard sets per group, per week
  const gSets = {};
  for (const s of win) if (s.rir == null || s.rir <= 2) { const g = groupOf(s.ex); if (g) gSets[g] = (gSets[g] || 0) + 1; }
  for (const g of Object.keys(gSets)) gSets[g] = Math.round(gSets[g] / weeks);
  return { empty: false, lifts, sessions, idx, end, from, gSets, sets: win };
}

// The 7-day / last-week / 4-week-average table. Weeks are counted back from the last
// logged session, not the calendar.
function kpiView() {
  const sets = allSets();
  if (!sets.length) return null;
  const last = sets[sets.length - 1].date;
  const wk = (d) => Math.floor(dayDiff(last, d) / 7);
  const ex = {};
  for (const s of sets) {
    const x = (ex[s.ex] = ex[s.ex] || { ex: s.ex, w: {}, pr: null });
    const k = wk(s.date);
    const b = (x.w[k] = x.w[k] || { sets: 0, ton: 0, best: 0, hl: 0 });
    if (s.rir == null || s.rir <= 2) { b.sets++; b.hl += s.load; }
    b.ton += s.load * s.reps;
    b.best = Math.max(b.best, s.e1);
    if (!x.pr || s.e1 > x.pr.e1 + 1e-9) x.pr = { e1: s.e1, date: s.date, w: s.w, reps: s.reps };
  }
  return { last, ex };
}



/* ------------------------------------------------------ effective day / session */

// The day's lifts: the session plan's week, plus any ad-hoc extra sets, in the order
// the session was reordered into (session-scoped, never written back to the plan).
// The weekday whose plan is driving today's session. Normally today's own, but a
// skipped day is the normal case in a 7-day week, so it can be overridden for THIS
// session only - the plan itself is never touched and the sets still log under today's
// real date, because that is when they happened.
const liveDay = () => (state.live && state.live.dayKey) || weekdayOf(liveDate());
const dayShifted = () => liveDay() !== weekdayOf(liveDate());

function sessionLifts() {
  const L = ensureLive();
  const week = weekOf(L.plan);
  const src = week[liveDay()] || [];
  const per = bySession(allSets().filter((s) => s.date < L.date));
  let list = src.map(([ex, sets]) => {
    const x = per[ex];
    const top = x ? x.series[x.series.length - 1].top : null;
    const lib = libOf(ex);
    return {
      ex, name: disp(ex), muscle: primeOf(ex), planSets: sets,
      sets: sets + (L.extra[ex] || 0),
      top: top ? `${top.w} × ${top.reps}` : null,
      done: (L.logged[ex] || []).length,
      needs: !lib,
    };
  });
  // Anything already logged today that this day's plan does not contain still shows,
  // or switching the day would hide sets that are about to be written.
  const shown = new Set(list.map((l) => l.ex));
  for (const ex of Object.keys(L.logged)) {
    if (shown.has(ex)) continue;
    const x = per[ex];
    list.push({
      ex, name: disp(ex), muscle: primeOf(ex), planSets: 0,
      sets: L.logged[ex].length, top: x ? `${x.series[x.series.length - 1].top.w} × ${x.series[x.series.length - 1].top.reps}` : null,
      done: L.logged[ex].length, offPlan: true,
    });
  }
  if (L.order) {
    const ix = (n) => { const i = L.order.indexOf(n); return i < 0 ? 999 : i; };
    list = list.slice().sort((a, b) => ix(a.ex) - ix(b.ex));
  }
  return list;
}

/* ----------------------------------------------------------------- the render */

function renderAll() {
  renderHeader();
  renderSession();
  renderCardio();
  renderProgress();
  renderPlan();
  renderHistory();
  renderOverlay();
  for (const b of document.querySelectorAll("nav button")) {
    const on = b.dataset.tab === state.tab;
    b.setAttribute("aria-selected", on ? "true" : "false");
    $(`p-${b.dataset.tab}`).hidden = !on;
  }
}

function renderHeader() {
  const sets = allSets();
  const n = uniq(sets.map((s) => s.date)).length;
  const dirty = dirtyCount();
  let meta;
  if (state.tab === "Cardio") meta = `${plural(state.cardio.length, "cardio session")}`;
  else if (state.tab === "Plan") meta = dirty ? `${plural(dirty, "unpublished edit")}` : "plan published";
  else meta = `${n} session${n === 1 ? "" : "s"} · ${sets.length} sets`;
  let where;
  if (store.state === "synced") where = "";
  else if (store.state === "error") where = " · offline";
  else if (persisted === true) where = " · on this phone";
  else where = " · local only";
  $("hmeta").textContent = meta + where;
}

const storeBanner = () => {
  if (store.state === "synced") return "";
  if (store.detail === "neither store accepted the write") {
    return `<div class="banner"><span class="tag">unsaved</span><div>
      <b>Nothing is saving.</b> Both local stores refused the write - private browsing, or
      the device is out of space. Sets you log now will be lost on reload.</div></div>`;
  }
  const dur = persisted === true
    ? "Held in two local stores and the browser has been asked not to evict them, so it survives a reload and a restart."
    : "Held in two local stores on this device. Add the app to your home screen and the browser stops evicting them.";
  return `<div class="banner"><span class="tag">${persisted === true ? "on device" : "local"}</span><div>
    <b>Saved on this phone.</b> ${dur} ${store.detail === "not_configured"
      ? "Connect a Blob store to this Vercel project for cross-device sync."
      : "The remote store could not be reached; sets go up on the next load."}
  </div></div>`;
};

/* ------------------------------------------------------------------- 1 Session */

function renderSession() {
  const L = ensureLive();
  const lifts = sessionLifts();
  const setsTotal = sum(lifts.map((l) => l.sets));
  const doneAll = sum(Object.values(L.logged).map((v) => v.length));
  const muscles = uniq(lifts.map((l) => TO_GROUP[l.muscle] || l.muscle).filter(Boolean));
  const planName = (state.plans[L.plan] || {}).name || L.plan;

  const rows = lifts.map((l, i) => {
    const full = l.done >= l.sets;
    const extra = l.sets - l.planSets;
    const img = (EXERCISES[l.ex] || {}).image;
    return `<div class="liftrow${full ? " done" : ""}" role="button" tabindex="0" data-act="open-sheet" data-ex="${esc(l.ex)}">
      <span class="tile">${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : esc(initials(l.ex))}</span>
      <span class="mid">
        <span class="nm">${esc(l.name)}</span>
        <span class="sub">${esc(disp(l.muscle || "custom"))} · last ${l.top ? esc(l.top) : "—"}</span>
      </span>
      ${state.reorder ? `<span class="arrows">
        <button class="step" data-act="move" data-ex="${esc(l.ex)}" data-dir="-1" ${i === 0 ? "disabled" : ""} aria-label="move up"><span>▲</span></button>
        <button class="step" data-act="move" data-ex="${esc(l.ex)}" data-dir="1" ${i === lifts.length - 1 ? "disabled" : ""} aria-label="move down"><span>▼</span></button>
      </span>` : `<span class="rt">
        <span class="n">${l.done}/${l.sets}</span>
        <span class="st${extra > 0 ? " extra" : ""}${l.needs ? " needs" : ""}">${
          l.needs ? "not in library" : extra > 0 ? `+${extra} vs plan` : full ? "done" : "tap to log"}</span>
      </span>`}
    </div>`;
  }).join("");

  const stale = staleLive();
  $("p-Session").innerHTML = `
    ${storeBanner()}
    ${stale ? `<div class="banner warn"><span class="tag warn">unfinished</span><div>
      <b>${plural(sum(Object.values(stale.logged).map((v) => v.length)), "set")} from
      ${esc(fmtDate(stale.date))} were never finished.</b> They are still here. Write them
      to ${esc(fmtDate(stale.date))} where they belong, or discard them - today's session
      cannot start until you choose, so nothing lands on the wrong date.
      <span class="row2">
        <button class="btn sm primary" data-act="finish">Finish ${esc(fmtDate(stale.date))}</button>
        <button class="btn sm${state.armStale ? " primary" : ""}" data-act="drop-stale">${
          state.armStale ? "Tap again to discard" : "Discard"}</button>
      </span></div></div>` : ""}
    <div class="screenhead">
      <div>
        <div class="kicker">${fmtDate(L.date)} · ${esc(planName)}${
          dayShifted() ? ` · ${DAY_LABEL[liveDay()]}'s session` : ""}</div>
        <h1>${lifts.length ? esc(muscles.slice(0, 3).join(" + ")) : "Rest day"}</h1>
      </div>
      <div class="right">
        <div class="count">${doneAll}<span>/${setsTotal}</span></div>
        <div class="caption">sets logged</div>
      </div>
    </div>

    <div class="chiprow">
      <button class="chip" data-act="open-switch">plan <b>${esc(planName)}</b> <span class="mono">⌄</span></button>
      <button class="chip${dayShifted() ? " on" : ""}" data-act="open-day">
        ${dayShifted() ? "doing" : "day"} <b>${DAY_LABEL[liveDay()]}</b> <span class="mono">⌄</span></button>
      ${lifts.length > 1 ? `<button class="btn sm" data-act="toggle-reorder">${state.reorder ? "Done" : "Reorder"}</button>` : ""}
    </div>

    ${lifts.length ? `<div class="liftlist">${rows}</div>` : `
      <div class="empty"><b>Nothing scheduled for ${DAY_LABEL[weekdayOf(L.date)]}.</b>
        Add lifts to this day on the Plan tab, or switch to a plan that trains today.</div>`}

    ${lifts.length ? `<button class="btn primary" data-act="finish">
      ${doneAll ? `Finish session · write ${plural(doneAll, "set")} to the log` : "Finish session"}</button>` : ""}
    <button class="btn ghost" data-act="go-cardio">+ Log cardio for this visit</button>

    <p class="foot">Last-set figures come from your own log. Loads come from the
      double-progression rule, never from feel. Finishing writes the session to the
      store, where Progress and History read it.</p>`;
}

/* -------------------------------------------------------------------- 1b Cardio */

function cardioView() {
  const t = today();
  const dow = (new Date(t + "T00:00:00").getDay() + 6) % 7;
  const monday = addDays(t, -dow);
  const wk = (s) => Math.floor((dayDiff(monday, s) + 6) / 7);
  const counts = {};
  for (const c of state.cardio) { const k = wk(c.date); if (k >= 0) counts[k] = (counts[k] || 0) + 1; }
  const n = (k) => counts[k] || 0;
  const done = n(0), left = Math.max(0, CARDIO_GOAL - done), daysLeft = 7 - dow;
  let streak = 0;
  for (let k = done >= CARDIO_GOAL ? 0 : 1; n(k) >= CARDIO_GOAL; k++) streak++;
  return { t, dow, monday, n, done, left, daysLeft, streak };
}

const pace = (c) => {
  if (!c.km || !/run|Treadmill/i.test(c.type)) return null;
  const p = c.min / c.km, m = Math.floor(p), s = Math.round((p - m) * 60);
  return `${m}:${String(s).padStart(2, "0")} /km`;
};

function renderCardio() {
  const V = cardioView();
  const num = (v) => parseFloat(v) || 0, f1 = (x) => String(+x.toFixed(1));
  const min = num(state.cMin), km = num(state.cKm);
  const selDate = state.cDate || V.t;

  const weeks = [...Array(8)].map((_, i) => 7 - i);
  const max = Math.max(CARDIO_GOAL + 1, ...weeks.map(V.n));
  const bars = weeks.map((k) => {
    const v = V.n(k), h = Math.max(2, Math.round((v / max) * 72));
    const bg = !v ? "var(--color-neutral-800)" : v >= CARDIO_GOAL ? "var(--color-accent)" : "var(--color-accent-dim)";
    return `<div class="col"><span class="n">${v || "—"}</span>
      <span class="bar" style="height:${h}px;background:${bg}"></span>
      <span class="d">${esc(fmtDate(addDays(V.monday, -7 * k)))}</span></div>`;
  }).join("");

  const types = CARDIO_TYPES.map((x) =>
    `<button class="pill ui" data-act="c-type" data-v="${esc(x)}" aria-pressed="${state.cType === x}" style="justify-content:center">${esc(x)}</button>`).join("");
  const whenOpts = [["visit", "With today's lifting"], ["sep", "Separate session"]].map(([k, l]) =>
    `<button class="pill ui" data-act="c-when" data-v="${k}" aria-pressed="${state.cWhen === k}" style="justify-content:center">${esc(l)}</button>`).join("");
  const dayStrip = [...Array(7)].map((_, i) => {
    const d = addDays(V.t, i - 6);
    return `<button class="day" data-act="c-date" data-v="${d}" aria-pressed="${selDate === d}">
      <span class="k">${DAY_LABEL[weekdayOf(d)]}</span><span class="n">${+d.slice(8)}</span></button>`;
  }).join("");

  $("p-Cardio").innerHTML = `
    ${storeBanner()}
    <div>
      <div class="kicker">Week of ${esc(fmtDate(V.monday))} · goal ${CARDIO_GOAL}× a week</div>
      <h1 class="verdict">${V.left ? `${plural(V.left, "more session")} to keep the streak.` : "Goal hit this week."}</h1>
    </div>

    <div class="hgrid two">
      <div class="kpi"><div class="k">Streak</div>
        <div class="v">${V.streak}<span style="font-size:13px;color:var(--color-neutral-600)"> wk</span></div>
        <div class="s">weeks in a row at ${CARDIO_GOAL}×${V.done >= CARDIO_GOAL ? "" : " · this week open"}</div></div>
      <div class="kpi"><div class="k">Left this week</div>
        <div class="v accent">${V.left}<span style="font-size:13px;color:var(--color-neutral-600)">${V.left ? ` of ${CARDIO_GOAL}` : ""}</span></div>
        <div class="s">${V.done} done · ${V.left ? plural(V.daysLeft, "day") + " left" : "streak extended"}</div></div>
    </div>

    <section class="card">
      <div class="cardhead"><span class="label">Sessions per week</span>
        <span class="meta">goal ${CARDIO_GOAL} · accent = hit</span></div>
      <div class="bars">${bars}</div>
    </section>

    <section class="card">
      <div class="cardhead"><span class="label">Log cardio</span></div>
      <div class="grid4">${types}</div>
      <div class="grid2">${whenOpts}</div>
      ${state.cWhen === "sep" ? `<div class="grid7">${dayStrip}</div>` : ""}
      <div class="grid2">
        <div class="stepper"><span class="label">Duration · min</span><div class="row">
          <button class="step" data-act="c-min" data-d="-5" aria-label="less"><span>−</span></button>
          <input class="val mono" id="c-min" inputmode="numeric" value="${esc(state.cMin)}">
          <button class="step" data-act="c-min" data-d="5" aria-label="more"><span>+</span></button></div></div>
        <div class="stepper"><span class="label">Distance · km</span><div class="row">
          <button class="step" data-act="c-km" data-d="-0.5" aria-label="less"><span>−</span></button>
          <input class="val mono" id="c-km" inputmode="decimal" value="${esc(state.cKm)}">
          <button class="step" data-act="c-km" data-d="0.5" aria-label="more"><span>+</span></button></div></div>
      </div>
      <button class="btn primary" data-act="c-log" ${min > 0 ? "" : "disabled"}>
        ${min > 0 ? `Log ${min} min ${esc(state.cType.toLowerCase())}${km > 0 ? ` · ${f1(km)} km` : ""}` : "Enter a duration"}</button>
      ${state.cLast ? `<div class="confirm"><span class="t">Logged ${esc(state.cLast.type.toLowerCase())} · ${state.cLast.min} min${state.cLast.km ? ` · ${f1(state.cLast.km)} km` : ""}${pace(state.cLast) ? ` · ${pace(state.cLast)}` : ""} · ${esc(fmtDate(state.cLast.date))}</span>
        <button class="btn sm" data-act="c-undo">Undo</button></div>` : ""}
    </section>

    <p class="foot">Cardio keeps a weekly goal and nothing else - no trend, no list. Any
      session counts, same visit or separate. It never enters a strength derivation.</p>`;
}

/* ------------------------------------------------------------------ 4 Progress */

function renderProgress() {
  const weeks = parseInt(state.win, 10);
  const W = windowView(weeks);
  const windows = ["4 wk", "8 wk", "12 wk"].map((k) =>
    `<button class="pill" data-act="win" data-v="${k}" aria-pressed="${state.win === k}">${k}</button>`).join("");

  if (W.empty) {
    $("p-Progress").innerHTML = `
      <div class="pills">${windows}</div>
      <div class="empty"><b>No sets logged yet.</b>
        Progress reads your own set log. Log a session and the verdict, the weekly table
        and the per-lift history all start from there - nothing here is seeded.</div>
      <p class="foot">Strength is Epley e1RM from each session's best set. A lift needs
        ${MIN_N} sessions in the window before it is rated.</p>`;
    return;
  }

  const bcnt = (k) => W.lifts.filter((l) => l.bucket === k).length;
  const rated = W.lifts.length - bcnt("thin");
  const ichg = mean2(W.idx, false) ? (mean2(W.idx, true) / mean2(W.idx, false) - 1) * 100 : 0;
  const head = ichg >= NOISE ? "You are getting stronger."
    : ichg <= -NOISE ? "Strength is slipping." : "Strength is holding, not rising.";

  // --- focus next
  const gChg = {};
  for (const l of W.lifts) if (l.bucket !== "thin" && l.group) (gChg[l.group] = gChg[l.group] || []).push(l.chg);
  const focus = [];
  for (const g of GROUPS) {
    const c = gChg[g] ? avg(gChg[g]) : null;
    if (c == null) continue;
    const v = W.gSets[g] || 0, st = covStatus(v);
    if (c <= -NOISE) {
      focus.push({
        t: `${cap(g)} strength down ${Math.abs(c).toFixed(1)}%`,
        b: st === "optimal" || st === "high"
          ? `Volume is already ${v} sets a week, so more sets won't fix it. Check recovery, and whether these lifts come late in the session.`
          : `Only ${v} hard sets a week. Add 2–3 sets a week before changing anything else.`,
      });
    } else if (Math.abs(c) < NOISE && (st === "minimum" || st === "missed")) {
      focus.push({
        t: `${cap(g)} flat on ${v} sets a week`,
        b: "That's under the 10-set range where most gains happen. Add 2–4 sets a week.",
      });
    }
  }

  // --- weekly KPIs
  const kpiHtml = renderKpi();

  const spark = (arr, w, h) => {
    if (!arr || arr.length < 2) return "";
    const mn = Math.min(...arr), mx = Math.max(...arr), sp = mx - mn || 1;
    return arr.map((v, i) => `${((i / (arr.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - mn) / sp) * (h - 4)).toFixed(1)}`).join(" ");
  };
  const idxPts = spark(W.idx, 200, 44);
  const baseY = (() => {
    const mn = Math.min(...W.idx), mx = Math.max(...W.idx), sp = mx - mn || 1;
    return (44 - 2 - ((mean2(W.idx, false) - mn) / sp) * 40).toFixed(1);
  })();

  $("p-Progress").innerHTML = `
    <div class="pills">${windows}</div>

    <div>
      <div class="kicker">${state.win} window · to ${esc(fmtDate(W.end))}</div>
      <h1 class="verdict">${head}</h1>
      <div class="sparkwrap" style="margin-top:12px">
        <span class="mono" style="font-size:30px;font-weight:500;color:${ichg < -NOISE ? "var(--color-accent-300)" : "var(--color-text)"}">${pct(ichg)}</span>
        ${idxPts ? `<svg class="chart" viewBox="0 0 200 44" style="flex:1;max-width:200px" aria-hidden="true">
          <line x1="0" y1="${baseY}" x2="200" y2="${baseY}" stroke="var(--color-neutral-800)" stroke-width="1" stroke-dasharray="3 3"/>
          <polyline points="${idxPts}" fill="none" stroke="var(--color-accent)" stroke-width="1.5" stroke-linejoin="round"/>
        </svg>` : ""}
      </div>
      <p class="body" style="margin:10px 0 0">Across ${rated} lift${rated === 1 ? "" : "s"} over
        ${plural(W.sessions, "session")}: ${bcnt("up")} stronger, ${bcnt("flat")} flat, ${bcnt("down")} weaker.</p>
    </div>

    <div class="sectionlabel">Focus next</div>
    ${focus.length ? focus.slice(0, 3).map((f) =>
      `<div class="focuscard"><div class="t">${esc(f.t)}</div><div class="b">${esc(f.b)}</div></div>`).join("")
      : `<div class="focuscard"><div class="t">Nothing needs changing.</div><div class="b">Keep running the plan.</div></div>`}

    ${kpiHtml}

    <div class="sectionlabel">Estimated 1RM</div>
    <div class="hgrid" style="grid-template-columns:1fr">
      ${W.lifts.slice().sort((a, b) => b.cur - a.cur).map((l) => `
        <button class="krow x" data-act="lift" data-ex="${esc(l.ex)}">
          <span><span class="kname">${esc(l.name)}</span>
            <span class="kread">${esc(disp(l.muscle || ""))} · ${pct(l.rate, 2)}/wk · ${plural(l.n, "session")}</span></span>
          <span class="num ${l.bucket === "up" ? "up" : l.bucket === "down" ? "down" : "flat"}">${
            { progressing: "▲", maintaining: "=", plateauing: "▬", regressing: "▼" }[l.status] || "·"}</span>
          <span class="num">${l.cur.toFixed(1)}</span>
          <span class="num ${cls(l.chg, NOISE)}">${pct(l.chg)}</span>
        </button>`).join("")}
    </div>

    <p class="foot">Strength = Epley e1RM from each session's best set; bodyweight lifts
      carry ${BW_KG} kg. Change = mean of the last two sessions in the window against the
      first two. ±${NOISE}% is noise and reads flat. A lift needs ${MIN_N} sessions
      before it is rated. Hard set = RIR ≤ 2, credited to the prime mover only.</p>`;
}

function renderKpi() {
  const K = kpiView();
  const views = ["Muscles", "Exercises"].map((k) =>
    `<button class="pill ui" data-act="kpiview" data-v="${k}" aria-pressed="${state.kpiView === k}">${k}</button>`).join("");
  const bases = [["LW", "vs last wk"], ["4W", "vs 4-wk avg"]].map(([k, l]) =>
    `<button class="pill ui" data-act="kpibase" data-v="${k}" aria-pressed="${state.kpiBase === k}">${l}</button>`).join("");
  const head = `<div class="sectionlabel">Weekly</div>
    <div class="pills">${views}</div><div class="pills">${bases}</div>`;
  if (!K) return `${head}<div class="empty">Nothing logged in the last week.</div>`;

  const B = state.kpiBase === "LW" ? [1] : [1, 2, 3, 4];
  const rel = (a, b) => (a && b ? (a / b - 1) * 100 : null);
  const per = Object.values(K.ex).map((x) => {
    const g = (k) => x.w[k] || {}, s = (k) => g(k).sets || 0;
    const al = (k) => (g(k).sets ? g(k).hl / g(k).sets : 0);
    const sB = avg(B.map(s)), alB = avg(B.map(al).filter(Boolean));
    const bB = avg(B.map((k) => g(k).best || 0).filter(Boolean));
    const b0 = g(0).best || 0;
    return {
      ex: x.ex, name: disp(x.ex), group: groupOf(x.ex) || "other", pr: x.pr,
      s0: s(0), sB, al0: al(0), t0: g(0).ton || 0, dLoad: rel(al(0), alB), dStr: rel(b0, bB), b0,
      active: [0, 1, 2, 3, 4].some((k) => s(k) > 0),
      prNow: x.pr && dayDiff(K.last, x.pr.date) < 7,
    };
  });
  const setsDelta = (s0, sB) => state.kpiBase === "LW"
    ? { v: s0 - sB, txt: `${sgn(s0 - sB)}${Math.abs(Math.round(s0 - sB))}`, noise: 1 }
    : { v: rel(s0, sB), txt: pct(rel(s0, sB), 0), noise: 10 };
  const read = (ds, dl) => {
    if (ds == null && dl == null) return "not trained this week";
    const sp = ds == null ? null : ds <= -10 ? "fewer sets" : ds >= 10 ? "more sets" : "same sets";
    const lp = dl == null ? null : dl <= -2.5 ? "lighter" : dl >= 2.5 ? "heavier" : "same load";
    return [sp, lp].filter(Boolean).join(", ");
  };
  const changeLabel = state.kpiBase === "LW" ? "Change vs last wk" : "Change vs 4-wk avg";
  const colHead = `<div class="krow ${state.kpiView === "Muscles" ? "m" : "x"} khead">
    ${state.kpiView === "Muscles" ? "<span></span>" : ""}<span>${esc(changeLabel)}</span>
    <span class="r">Sets</span><span class="r">Δ Sets</span><span class="r">${state.kpiView === "Muscles" ? "Δ e1RM" : "of PR"}</span></div>`;

  let rows;
  if (state.kpiView === "Muscles") {
    rows = GROUPS.map((gp) => {
      const xs = per.filter((p) => p.group === gp && p.active);
      if (!xs.length) return null;
      const s0 = sum(xs.map((x) => x.s0)), sB = sum(xs.map((x) => x.sB));
      const sd = setsDelta(s0, sB);
      const dL = avg(xs.map((x) => x.dLoad).filter((v) => v != null));
      const dS = avg(xs.map((x) => x.dStr).filter((v) => v != null));
      return {
        _k: dS ?? 0, html: `<div class="krow m">
          <span class="dot ${covStatus(s0)}"></span>
          <span><span class="kname">${esc(gp)}</span>
            <span class="kread">${esc(s0 === 0 ? "not trained this week" : read(rel(s0, sB), dL))}</span></span>
          <span class="num">${s0}</span>
          <span class="num ${cls(sd.v, sd.noise)}">${sd.txt}</span>
          <span class="num ${cls(dS, NOISE)}">${pct(dS)}</span></div>`,
      };
    }).filter(Boolean).sort((a, b) => a._k - b._k).map((x) => x.html).join("");
  } else {
    rows = per.filter((p) => p.active)
      .sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group) || b.s0 - a.s0)
      .map((p) => {
        const sd = setsDelta(p.s0, p.sB);
        const of = p.b0 && p.pr ? (p.b0 / p.pr.e1) * 100 : null;
        return `<button class="krow x" data-act="lift" data-ex="${esc(p.ex)}">
          <span><span class="kname">${esc(p.name)}</span>
            <span class="kread ${p.prNow ? "prnew" : "pr"}">${esc(p.group)} · PR ${p.pr.e1.toFixed(1)} kg · ${p.pr.w ? `${p.pr.w} × ` : ""}${p.pr.reps}${p.pr.w ? "" : " reps"} · ${esc(fmtDate(p.pr.date))}${p.prNow ? " · new" : ""}</span>
            <span class="kread">${p.s0 ? `avg ${p.al0.toFixed(1)} kg/set · ${Math.round(p.t0).toLocaleString("en-GB")} kg total` : "not trained this week"}</span></span>
          <span class="num">${p.s0}</span>
          <span class="num ${cls(sd.v, sd.noise)}">${sd.txt}</span>
          <span class="num ${of == null ? "none" : p.prNow ? "down" : "flat"}">${of == null ? "—" : `${Math.round(of)}%`}</span>
        </button>`;
      }).join("");
  }

  const note = state.kpiView === "Muscles"
    ? "Sets = hard sets (RIR ≤ 2). Load = average kg per hard set, compared within each exercise then averaged for the muscle. Grey = within noise. Dot = this week's volume: red under 4, yellow 4–9, green 10–20, ring over 20."
    : "“Of PR” = this week's best e1RM as a share of the all-time best; accent = new PR in the last 7 days. Tap a row for the lift's history.";

  return `${head}
    <div class="hgrid" style="grid-template-columns:1fr">${colHead}${rows || `<div class="empty">Nothing logged in the last 7 days.</div>`}</div>
    <p class="foot">${esc(note)}</p>`;
}

/* ---------------------------------------------------------------------- 5 Plan */

const weekSets = (week) => sum(DAYS.map((d) => sum((week[d] || []).map((x) => x[1]))));
function groupTotals(week) {
  const m = {}; for (const g of GROUPS) m[g] = 0;
  for (const d of DAYS) for (const [ex, s] of week[d] || []) { const g = groupOf(ex); if (g in m) m[g] += s; }
  return m;
}
// One edit is one lift changed, added or removed - not one changed day. Counting the
// day's whole row made a single stepper press report four unpublished edits.
const dirtyCount = () => {
  const a = weekOf(state.planKey), b = (state.base[state.planKey] || {}).week || {};
  let n = 0;
  for (const d of DAYS) {
    const x = new Map(a[d] || []), y = new Map(b[d] || []);
    for (const [ex, s] of x) if (!y.has(ex) || y.get(ex) !== s) n++;
    for (const ex of y.keys()) if (!x.has(ex)) n++;
  }
  return n;
};

function renderPlan() {
  const P = plansOf();
  const week = P.week;
  const dayLifts = week[state.day] || [];
  const live = state.planKey === state.sessionPlanKey && state.day === weekdayOf(today());
  const gNow = groupTotals(week), gBase = groupTotals((state.base[state.planKey] || { week: {} }).week);

  // The strip used to read "MON 24 / TUE 28 / WED 24" - weekday over the week's set
  // count. Two digits under a weekday name is read as a DATE by everyone, and since the
  // counts do not ascend it looked like random dates. So the count now carries its unit,
  // the real date of this week's occurrence sits beside the weekday, and today and
  // tomorrow are marked. Nothing was removed.
  const strip = DAYS.map((d) => {
    const n = sum((week[d] || []).map((x) => x[1]));
    const date = nextDateOf(d);
    const rel = date === today() ? "today" : date === addDays(today(), 1) ? "tmrw" : "";
    return `<button class="day${rel ? " rel" : ""}" data-act="day" data-v="${d}"
      aria-pressed="${state.day === d}"
      aria-label="${DAY_LABEL[d]} ${fmtDate(date)}${rel ? `, ${rel === "today" ? "today" : "tomorrow"}` : ""}, ${plural(n, "set")}">
      <span class="k">${DAY_LABEL[d]}</span>
      <span class="dt">${+date.slice(8)}</span>
      <span class="n">${n ? `${n} set${n === 1 ? "" : "s"}` : "rest"}</span>
      ${rel ? `<span class="rl">${rel}</span>` : ""}</button>`;
  }).join("");

  const armed = (i) => state.armedDrop === `${state.day}:${i}`;
  const rows = dayLifts.map(([ex, s], i) => {
    const prov = !EXERCISES[ex];

    return `<div class="planrow">
      <span class="mid"><span class="nm">${esc(disp(ex))}</span>
        ${prov ? `<span class="tag">new</span>` : ""}
        <span class="sub${live ? " live" : ""}">${esc(disp(primeOf(ex) || "custom"))}${live ? " · drives today" : ""}</span></span>
      <button class="step" data-act="sets" data-i="${i}" data-d="-1" aria-label="one set fewer"><span>−</span></button>
      <span class="v">${s}</span>
      <button class="step" data-act="sets" data-i="${i}" data-d="1" aria-label="one set more"><span>+</span></button>
      <button class="step drop${armed(i) ? " armed" : ""}" data-act="drop" data-i="${i}"
        aria-label="${armed(i) ? "confirm removing" : "remove"} ${esc(disp(ex))}"><span>${armed(i) ? "✓" : "✕"}</span></button>
    </div>`;
  }).join("");

  const cov = GROUPS.map((g) => {
    const v = gNow[g], b = gBase[g], st = covStatus(v);
    return { st, rank: COV[st].rank, v, html: `<div class="covrow">
      <span class="dot d9 ${st}"></span><span class="nm">${g}</span>
      <span class="was">${v !== b ? `was ${b}` : ""}</span>
      <span class="num">${v}</span><span class="st">${COV[st].label}</span></div>` };
  }).sort((a, b) => a.rank - b.rank || a.v - b.v).map((x) => x.html).join("");
  const cnt = (s) => GROUPS.filter((g) => covStatus(gNow[g]) === s).length;
  const covSummary = [["missed", "missed"], ["minimum", "minimum"], ["high", "high"]]
    .map(([s, l]) => (cnt(s) ? `${cnt(s)} ${l}` : "")).filter(Boolean).join(" · ") || "all optimal";
  const dirty = dirtyCount();

  $("p-Plan").innerHTML = `
    <div class="screenhead">
      <div>
        <div class="kicker">Editing plan</div>
        <button class="planname" data-act="open-switch">${esc(P.name)} <span class="cv">⌄</span></button>
      </div>
      <div class="right"><div class="count">${weekSets(week)}</div><div class="caption">sets / week</div></div>
    </div>

    <div class="daystrip">${strip}</div>
    <p class="foot" style="margin:-6px 0 0">Dates = next time that day comes round. Small
      figure = planned sets.</p>

    <div class="screenhead" style="align-items:center">
      <h1 style="font-size:16px">${DAY_LABEL[state.day]} ${esc(fmtDate(nextDateOf(state.day)))}${
        dayRel(state.day) ? ` · ${dayRel(state.day)}` : ""}${dayLifts.length ? "" : " · rest"}</h1>
      <span class="meta">${plural(sum(dayLifts.map((x) => x[1])), "set")}</span>
    </div>

    ${rows || `<div class="empty">Nothing on ${DAY_LABEL[state.day]}. Add a lift below.</div>`}
    <button class="btn ghost" data-act="open-lib">Search the library to add a lift</button>

    <div class="coverage">
      <div class="cardhead"><span class="label">Muscle coverage</span><span class="meta">${esc(covSummary)}</span></div>
      <div class="legend">
        <span><i class="dot missed"></i>0–3</span><span><i class="dot minimum"></i>4–9</span>
        <span><i class="dot optimal"></i>10–20</span><span><i class="dot high"></i>20+</span>
      </div>
      ${cov}
    </div>

    <button class="btn primary" data-act="publish" ${dirty ? "" : "disabled"}>
      ${dirty ? `Publish ${plural(dirty, "edit")}` : "Plan published"}</button>
    ${dirty ? `<button class="btn" data-act="undo-plan">Undo</button>` : ""}
    <button class="btn ghost" data-act="export">Export routine.yaml</button>
    <pre id="yamlout" class="mono" hidden style="white-space:pre-wrap;word-break:break-word;font-size:11px;color:var(--color-neutral-400);background:var(--color-surface);padding:12px;border-radius:8px;max-height:280px;overflow:auto"></pre>

    <p class="foot">The plan's set counts are the session's targets: change one here and
      Session asks for it. Session's reorder and "+1 set" never change the plan.
      Coverage rates planned hard sets a week per prime mover. Build ${esc(BUILD)}.</p>`;
}

/* ------------------------------------------------------------------- 7 History */

function historySessions() {
  const per = {};
  for (const s of allSets()) {
    const d = (per[s.date] = per[s.date] || { date: s.date, sets: 0, load: 0, lifts: {} });
    d.sets++; d.load += s.load * s.reps;
    (d.lifts[s.ex] = d.lifts[s.ex] || []).push(`${s.w} × ${s.reps}`);
  }
  return Object.values(per).sort((a, b) => (a.date < b.date ? 1 : -1));
}

function renderHistory() {
  const all = historySessions();
  const totalT = sum(all.map((s) => s.load)) / 1000;
  $("p-History").innerHTML = `
    <div class="screenhead">
      <div><div class="kicker">All sessions</div><h1>${all.length} logged</h1></div>
      <div class="right"><div class="count">${totalT.toFixed(1)}<span>t</span></div><div class="caption">total load</div></div>
    </div>
    ${Object.keys(state.sessions).length || state.cardio.length ? `
      <button class="btn primary" data-act="copy-rows">Copy rows for log.csv</button>
      <pre id="rowsout" class="mono" hidden style="white-space:pre-wrap;word-break:break-all;font-size:10.5px;color:var(--color-neutral-400);background:var(--color-surface);padding:12px;border-radius:8px;max-height:240px;overflow:auto"></pre>
      <button class="btn ghost" data-act="export-store">Download as a file instead</button>` : ""}
    ${all.length ? all.slice(0, state.histShown).map((s) => {
      const open = state.openSession === s.date;
      return `<div class="sessrow">
        <button class="sesshead" data-act="sess" data-v="${s.date}" aria-expanded="${open}">
          <span class="d">${esc(fmtDate(s.date))}</span>
          <span class="l">${esc(Object.keys(s.lifts).map(disp).join(" · "))}</span>
          <span class="m">${s.sets} · ${(s.load / 1000).toFixed(1)}t</span>
          <span class="c">›</span></button>
        ${open ? `<div class="sessbody">${Object.entries(s.lifts).map(([ex, v]) =>
          `<div class="r"><span class="n">${esc(disp(ex))}</span><span class="s mono">${esc(v.join("  "))}</span></div>`).join("")}</div>` : ""}
      </div>`;
    }).join("") : `<div class="empty"><b>No sessions yet.</b>
      Finish a session on the Session tab and it appears here immediately.</div>`}
    ${all.length > state.histShown ? `<button class="btn" data-act="more-hist">
      Show more · ${all.length - state.histShown} older session${all.length - state.histShown === 1 ? "" : "s"}</button>` : ""}
    <p class="foot">Tonnage is load × reps, bodyweight lifts at ${BW_KG} kg. Cardio is
      never counted here. <b>Copy rows for log.csv</b> puts them on the clipboard, ready to
      paste to Claude - no file needed. The download saves the same thing as JSON;
      <code>python3 analyze.py sync --from &lt;that file&gt;</code> shows what it would
      append to the real log, and <code>--apply</code> writes it. Nothing here touches
      <code>log.csv</code> on its own.</p>`;
}

/* ------------------------------------------------------------------- overlays */

function renderOverlay() {
  const o = $("overlay");
  if (state.summaryOn) return void (o.innerHTML = summaryHtml());
  if (state.lift) return void (o.innerHTML = liftHtml());
  if (state.sheet) return void (o.innerHTML = `<div class="scrim" data-act="close-ov"></div>${sheetHtml()}`);
  if (state.dayOn) return void (o.innerHTML = `<div class="scrim" data-act="close-ov"></div>${dayHtml()}`);
  if (state.switchOn) return void (o.innerHTML = `<div class="scrim" data-act="close-ov"></div>${switchHtml()}`);
  if (state.libOn) return void (o.innerHTML = `<div class="scrim" data-act="close-ov"></div>${libHtml()}`);
  o.innerHTML = "";
}


function sheetHtml() {
  const ex = state.sheet, L = ensureLive();
  const lift = sessionLifts().find((l) => l.ex === ex) || { sets: 3, top: null };
  const done = L.logged[ex] || [];
  const lib = libOf(ex);
  const needs = !lib;
  // Last session's sets for this lift, in full. This is the REFERENCE the app exists to
  // give - what you actually did - not a proposal. The weight box stays empty and yours.
  const prev = bySession(allSets().filter((x) => x.date < L.date))[ex];
  const last = prev ? prev.series[prev.series.length - 1] : null;
  const lastSets = last ? allSets().filter((x) => x.ex === ex && x.date === last.date) : [];
  return `<div class="sheet" role="dialog" aria-modal="true">
    <span class="handle"></span>
    <div class="sheethead">
      <div><h2>${esc(disp(ex))}</h2>
        <div class="sub">${esc(disp(primeOf(ex) || "custom"))} · target ${plural(lift.sets, "set")}</div></div>
      <button class="closebtn" data-act="close-ov">Close</button>
    </div>
    ${needs ? `<div class="banner"><span class="tag">unknown lift</span><div>
      <b>This lift is not in the library.</b> Add it on the Plan tab before logging it.
      </div></div>` : `
    ${lastSets.length ? `<div class="lastbox">
      <span class="label">Last time · ${esc(fmtDate(last.date))}</span>
      <span class="sets mono">${lastSets.map((x) =>
        `${x.w}×${x.reps}${x.rir == null ? "" : `<i>@${x.rir}</i>`}`).join("   ")}</span>
    </div>` : `<p class="meta">First time logging this lift.</p>`}
    <div class="grid2">
      <div class="stepper"><span class="label">Weight · kg</span><div class="row">
        <button class="step" data-act="w" data-d="-2.5" aria-label="less"><span>−</span></button>
        <input class="val mono" id="s-w" inputmode="decimal" placeholder="—" value="${state.w == null ? "" : state.w}">
        <button class="step" data-act="w" data-d="2.5" aria-label="more"><span>+</span></button></div></div>
      <div class="stepper"><span class="label">Reps</span><div class="row">
        <button class="step" data-act="r" data-d="-1" aria-label="fewer"><span>−</span></button>
        <input class="val mono" id="s-r" inputmode="numeric" value="${state.r}">
        <button class="step" data-act="r" data-d="1" aria-label="more"><span>+</span></button></div></div>
    </div>
    <div class="rirrow">
      <span class="label">RIR</span>
      <div class="pills">
        ${[0, 1, 2, 3, 4].map((n) =>
          `<button class="pill" data-act="rir" data-v="${n}" aria-pressed="${state.rir === n}">${n}</button>`).join("")}
        <button class="pill" data-act="rir" data-v="" aria-pressed="${state.rir == null}">—</button>
      </div>
    </div>
    <p class="meta" style="margin:-4px 0 0">Type the weight you are actually using. Steppers
      move 2.5 kg and 1 rep. RIR feeds e1RM and the hard-set count.</p>`}
    ${done.length ? `<div class="setlist">${done.map((v, i) =>
      `<div class="r"><span class="k">set ${i + 1}</span><span class="v">${v.w} × ${v.r}${v.rir == null ? "" : ` @${v.rir}`}</span></div>`).join("")}</div>` : ""}
    <div style="display:flex;gap:9px">
      <button class="btn primary" data-act="log-set" ${needs || state.w == null ? "disabled" : ""}>${
        state.w == null ? "Enter the weight" : `Log set ${done.length + 1} · ${state.w} × ${state.r}`}</button>
      <button class="btn sm" data-act="extra-set" style="flex:none">+1 set</button>
    </div>
  </div>`;
}

// Choosing which day's workout to run today. Session-scoped: the plan is untouched and
// the sets still log under today's date, so a skipped Monday done on Tuesday reads as
// exactly that - Monday unmet, Tuesday's chest work logged on Tuesday.
function dayHtml() {
  const L = ensureLive();
  const week = weekOf(L.plan);
  const mine = weekdayOf(L.date);
  const rows = DAYS.map((d) => {
    const plan = week[d] || [];
    const n = sum(plan.map((x) => x[1]));
    const muscles = uniq(plan.map(([ex]) => TO_GROUP[primeOf(ex)] || primeOf(ex)).filter(Boolean));
    const on = d === liveDay();
    return `<button class="planpick${on ? " on" : ""}" data-act="pick-day" data-v="${d}">
      <span><span class="nm">${DAY_LABEL[d]}${d === mine ? " · today" : ""}</span>
        <span class="sub">${n ? `${plural(n, "set")} · ${esc(muscles.slice(0, 3).join(" + "))}` : "rest day"}</span></span>
      ${on ? `<span class="tag on">doing</span>` : ""}</button>`;
  }).join("");
  return `<div class="sheet" role="dialog" aria-modal="true">
    <span class="handle"></span>
    <div class="sheethead"><div><h2>Which session today?</h2>
      <div class="sub">${fmtDate(L.date)} is a ${DAY_LABEL[mine]}. Missed a day? Run it now.</div></div>
      <button class="closebtn" data-act="close-ov">Close</button></div>
    ${rows}
    <p class="foot">This changes today only - the weekly plan is not touched, and the sets
      are logged under today's real date.</p>
  </div>`;
}

function switchHtml() {
  const rows = Object.entries(state.plans).map(([pid, p]) => {
    const g = groupTotals(p.week);
    const mi = GROUPS.filter((x) => covStatus(g[x]) === "missed").length;
    const meta = `${weekSets(p.week)} sets / wk · ${mi ? `${mi} missed` : "none missed"}${pid === state.sessionPlanKey ? " · drives today" : ""}`;
    if (state.renaming === pid) {
      return `<div class="card" style="gap:8px">
        <input class="input" id="rename" value="${esc(state.draft)}" autocomplete="off" spellcheck="false">
        ${state.renameError ? `<div class="err">${esc(state.renameError)}</div>` : ""}
        <div style="display:flex;gap:8px">
          <button class="btn primary sm" data-act="rename-save">Save</button>
          <button class="btn sm" data-act="rename-cancel">Cancel</button></div></div>`;
    }
    return `<div style="display:flex;gap:7px;align-items:stretch">
      <button class="planpick${pid === state.planKey ? " on" : ""}" data-act="pick-plan" data-v="${esc(pid)}" style="flex:1">
        <span><span class="nm">${esc(p.name)}</span><span class="sub">${esc(meta)}</span></span></button>
      <button class="btn sm" data-act="rename" data-v="${esc(pid)}" style="flex:none">Rename</button>
      <button class="btn sm primary" data-act="train" data-v="${esc(pid)}" style="flex:none">Train</button>
    </div>`;
  }).join("");
  return `<div class="sheet" role="dialog" aria-modal="true">
    <span class="handle"></span>
    <div class="sheethead"><div><h2>Your plans</h2>
      <div class="sub">the plan you train is separate from the one you edit</div></div>
      <button class="closebtn" data-act="close-ov">Close</button></div>
    ${rows}
    <div style="display:flex;gap:8px">
      <button class="btn ghost sm" data-act="new-plan" data-v="blank" style="flex:1">Start blank</button>
      <button class="btn ghost sm" data-act="new-plan" data-v="copy" style="flex:1">Copy “${esc(plansOf().name)}”</button>
    </div>
  </div>`;
}

function libHtml() {
  const q = state.query.trim().toLowerCase();
  const inDay = new Set((weekOf(state.planKey)[state.day] || []).map((x) => x[0]));
  const inPlans = {};
  for (const [pid, p] of Object.entries(state.plans)) {
    for (const d of DAYS) for (const [ex] of p.week[d] || []) (inPlans[ex] = inPlans[ex] || new Set()).add(p.name);
  }
  for (const ex of Object.keys(EXERCISES)) inPlans[ex] = inPlans[ex] || new Set();
  for (const ex of Object.keys(state.custom)) inPlans[ex] = inPlans[ex] || new Set();
  const counts = {};
  for (const s of allSets()) counts[s.ex] = (counts[s.ex] || 0) + 1;
  const lib = Object.keys(inPlans).sort();
  const results = lib.filter((ex) => !inDay.has(ex) && (!q || disp(ex).includes(q)));
  const exact = lib.some((ex) => disp(ex) === q);

  return `<div class="sheet" role="dialog" aria-modal="true" style="max-height:82%">
    <span class="handle"></span>
    <div class="sheethead"><div><h2>Add a lift to ${DAY_LABEL[state.day]}</h2></div>
      <button class="closebtn" data-act="close-ov">Close</button></div>
    <input class="input" id="libq" placeholder="Search, or type a new lift's name" value="${esc(state.query)}" autocomplete="off" spellcheck="false">
    ${results.length ? `<div class="label">In your plans · ${results.length}</div>
      <div style="display:flex;flex-direction:column;gap:6px">${results.slice(0, 60).map((ex) => `
        <button class="planpick" data-act="add-lift" data-v="${esc(ex)}">
          <span><span class="nm">${esc(disp(ex))}</span>
            <span class="sub">${esc(disp(primeOf(ex) || "custom"))} · ${[...inPlans[ex]].join(" + ") || "library"} · ${counts[ex] || 0} sets logged</span></span>
          <span class="mono" style="color:var(--color-accent-400);font-size:18px">+</span></button>`).join("")}</div>`
      : q ? `<p class="meta">No lift in your library or plans matches.</p>` : ""}
    ${q && !exact ? `<div class="card">
      <span class="label">New lift</span>
      <p class="body" style="margin:0">A lift you add here is loggable straight away - the
        app proposes no load, so there is nothing to set up first. Export it into
        <code>exercises.yaml</code> when you want <code>analyze.py</code> to see it too.</p>
      <div class="pills">${MUSCLE_PILLS.map((m) =>
        `<button class="pill" data-act="new-muscle" data-v="${m}" aria-pressed="${state.newMuscle === m}">${esc(disp(m))}</button>`).join("")}</div>
      <button class="btn primary" data-act="create-lift">Add “${esc(state.query.trim())}” as a new lift</button>
    </div>` : ""}
  </div>`;
}

function summaryHtml() {
  const S = state.lastSummary;
  if (!S) {
    return `<div class="full summary" role="dialog" aria-modal="true">
      <div><div class="kicker">${fmtDate(today())} · nothing logged</div>
        <h1 class="big">Nothing written.</h1></div>
      <p class="body">Tap a lift on the Session tab to log a set, then finish again.</p>
      <button class="btn primary" data-act="close-summary">Back</button></div>`;
  }
  const doneAll = S.sets, load = S.load, lifts = S.lifts;
  const up = lifts.filter((l) => l.d > 0).length;
  const held = lifts.find((l) => l.d === 0) || lifts[0];
  const muscles = uniq(lifts.map((l) => groupOf(l.ex)).filter(Boolean));
  const W = windowView(4);
  const under = W.empty ? null : GROUPS.map((g) => ({ g, v: W.gSets[g] || 0 }))
    .filter((x) => covStatus(x.v) === "missed" || covStatus(x.v) === "minimum")
    .sort((a, b) => a.v - b.v)[0];

  return `<div class="full summary" role="dialog" aria-modal="true">
    <div><div class="kicker">${fmtDate(S.date)} · session complete</div>
      <h1 class="big">${esc(muscles.slice(0, 2).join(" + ") || "Session")}, logged.</h1></div>
    <div class="hgrid three">
      <div class="kpi"><div class="k">Sets</div><div class="v">${doneAll}</div></div>
      <div class="kpi"><div class="k">Load</div><div class="v">${(load / 1000).toFixed(1)}t</div></div>
      <div class="kpi"><div class="k">Lifts up</div><div class="v accent">${up}</div></div>
    </div>
    <div class="sectionlabel">What moved</div>
    <div style="display:flex;flex-direction:column;gap:9px">
      ${lifts.map((l) => `<div class="wm"><span class="n">${esc(disp(l.ex))}</span>
        <span class="t">${esc(l.top)}</span>
        <span class="d${l.d > 0 ? " up" : ""}">${l.d == null ? "new" : l.d > 0 ? `+${l.d}` : l.d < 0 ? String(l.d) : "held"}</span></div>`).join("")}
    </div>
    ${held ? `<div class="note"><div class="t">${esc(disp(held.ex))} ${held.d === 0 ? `held at ${esc(held.top)}` : `at ${esc(held.top)}`}</div>
      <div class="b">${held.d === 0
        ? "Same load as last session. Chase one more rep on the top set before adding weight."
        : "First time this lift has a baseline - next session is measured against it."}</div></div>` : ""}
    <div class="nextrow"><span class="tag">next</span>
      <span class="t">${under ? `${cap(under.g)} is on ${plural(under.v, "hard set")} a week - the thinnest group in the last four weeks.`
        : "Nothing under-dosed in the last four weeks. Run the plan."}</span></div>
    <button class="btn primary" data-act="close-summary">Done</button>
  </div>`;
}

function liftHtml() {
  const ex = state.lift;
  const sets = allSets().filter((s) => s.ex === ex);
  if (!sets.length) return "";
  const per = bySession(sets)[ex];
  const series = per.series, vals = series.map((d) => d.best);
  const mn = Math.min(...vals), mx = Math.max(...vals), sp = mx - mn || 1;
  const pts = vals.length > 1
    ? vals.map((v, i) => `${((i / (vals.length - 1)) * 320).toFixed(1)},${(90 - 4 - ((v - mn) / sp) * 82).toFixed(1)}`).join(" ") : "";
  const W = windowView(parseInt(state.win, 10));
  const row = W.lifts.find((l) => l.ex === ex) || {};
  const call = {
    progressing: "Keep adding load at the current rate.",
    maintaining: "Holding. Add a set before adding weight.",
    plateauing: "Flat across the last sessions — chase reps at this load, then step up.",
    regressing: "Falling. Check recovery and volume before pushing load again.",
  }[row.status] || "Not enough sessions in this window to call it.";
  const best = sets.reduce((a, b) => (b.e1 > a.e1 ? b : a), sets[0]);

  return `<div class="full" role="dialog" aria-modal="true">
    <div class="sheethead">
      <div><div class="kicker">${esc(disp(primeOf(ex) || ""))}</div><h1 class="big">${esc(disp(ex))}</h1></div>
      <button class="closebtn" data-act="close-ov">Close</button></div>
    <section class="card">
      <div class="cardhead"><span class="label">Estimated 1RM</span><span class="meta">${plural(series.length, "session")}</span></div>
      ${pts ? `<svg class="chart" viewBox="0 0 320 90" aria-hidden="true">
        <polyline points="${pts}" fill="none" stroke="var(--color-accent)" stroke-width="1.5" stroke-linejoin="round"/></svg>` : `<p class="meta">One session so far.</p>`}
      <div class="cardhead"><span class="meta">${esc(fmtDate(series[0].date))} · ${vals[0].toFixed(1)}</span>
        <span class="meta">${esc(fmtDate(series[series.length - 1].date))} · ${vals[vals.length - 1].toFixed(1)}</span></div>
    </section>
    <div class="hgrid three">
      <div class="kpi"><div class="k">Best e1RM</div><div class="v">${best.e1.toFixed(1)}</div></div>
      <div class="kpi"><div class="k">Top set</div><div class="v" style="font-size:17px">${best.w}×${best.reps}</div></div>
      <div class="kpi"><div class="k">Sets</div><div class="v">${sets.length}</div></div>
    </div>
    <div class="nextrow"><span class="tag${row.status === "progressing" ? " on" : ""}">${esc(row.status || "no call")}</span>
      <span class="t">${esc(call)}</span></div>
  </div>`;
}

/* ------------------------------------------------------------------- actions */

function setState(patch, opts = {}) {
  Object.assign(state, patch);
  if (opts.persist !== false) persist(true, opts.force === true);
  renderAll();
}

function editPlan(fn) {
  const plans = clone(state.plans);
  fn(plans[state.planKey].week);
  setState({ plans });
}

// Finishing WRITES, so it has to be idempotent: the sets move out of the live session
// and into `sessions` in the same breath, and the summary renders from its own snapshot.
// Pressing Finish twice must not log the session twice.
function finish() {
  const L = ensureLive();
  const entries = Object.entries(L.logged).filter(([, v]) => v.length);
  if (!entries.length) { setState({ summaryOn: true, lastSummary: null }); return; }
  const sessions = { ...state.sessions };
  const prior = sessions[L.date] ? sessions[L.date].lifts : {};
  const lifts = { ...prior };
  for (const [ex, v] of entries) lifts[ex] = (lifts[ex] || []).concat(v.map((x) => ({ w: x.w, r: x.r, rir: x.rir == null ? null : x.rir })));
  // The baseline has to be read BEFORE the session joins the log, or every lift
  // measures itself against the sets just logged and every delta reads "held".
  const prev = bySession(allSets().filter((s) => s.date < L.date));
  const snap = {
    date: L.date,
    lifts: entries.map(([ex, v]) => {
      const best = v.reduce((a, b) => (b.w * b.r > a.w * a.r ? b : a), v[0]);
      const p = prev[ex];
      const prevW = p ? p.series[p.series.length - 1].top.w : null;
      return { ex, top: `${best.w} × ${best.r}`, d: prevW == null ? null : best.w - prevW };
    }),
    sets: sum(entries.map(([, v]) => v.length)),
    load: sum(entries.map(([ex, v]) => sum(v.map((x) => (isBW(ex) ? BW_KG + x.w : x.w) * x.r)))),
  };
  state.sessions = sessions;
  sessions[L.date] = { date: L.date, plan: L.plan, lifts, at: new Date().toISOString() };
  state.live = { date: today(), plan: state.sessionPlanKey, logged: {}, extra: {}, order: null, rirBy: {}, dayKey: null };
  setState({ summaryOn: true, lastSummary: snap, sheet: null, reorder: false });
}

function closeSummary() {
  setState({ summaryOn: false, lastSummary: null, tab: "Progress" });
}

function uniqueName(base) {
  let n = base, i = 2;
  const names = new Set(Object.values(state.plans).map((p) => p.name));
  while (names.has(n)) n = `${base} ${i++}`;
  return n;
}

function newPlan(copy) {
  const pid = `local-${Date.now().toString(36)}`;
  const week = copy ? clone(weekOf(state.planKey)) : Object.fromEntries(DAYS.map((d) => [d, []]));
  const name = uniqueName(copy ? `${plansOf().name} copy` : "new plan");
  const plans = { ...state.plans, [pid]: { name, week } };
  const base = { ...state.base, [pid]: { name, week: clone(week) } };
  setState({ plans, base, planKey: pid, renaming: pid, draft: name, renameError: "", switchOn: true });
}

function saveRename() {
  const pid = state.renaming, n = (state.draft || "").trim();
  if (!pid) return;
  if (!n) return setState({ renameError: "Give the plan a name." }, { persist: false });
  const clash = Object.entries(state.plans).some(([k, p]) => k !== pid && p.name === n);
  if (clash) return setState({ renameError: `A plan called “${n}” already exists.` }, { persist: false });
  const plans = clone(state.plans); plans[pid].name = n;
  setState({ plans, renaming: null, renameError: "" });
}

function logSet() {
  const ex = state.sheet, L = ensureLive();
  const lib = libOf(ex);
  if (!lib || state.w == null) return;
  const logged = { ...L.logged };
  logged[ex] = (logged[ex] || []).concat([{ w: state.w, r: state.r, rir: state.rir }]);
  L.logged = logged;
  L.rirBy = { ...(L.rirBy || {}), [ex]: state.rir };
  const lift = sessionLifts().find((l) => l.ex === ex) || { sets: 3 };
  // The sheet auto-dismisses once the lift's target set count is reached; otherwise it
  // stays open on the same load for the next set.
  setState(logged[ex].length >= lift.sets ? { sheet: null } : {});
}

function openSheet(ex) {
  const L = ensureLive();
  const already = (L.logged[ex] || []);
  // Within a session, set 2 opens on set 1's numbers - that is not proposing a load, it
  // is not making you retype what you just entered. The FIRST set of a lift opens empty:
  // the app does not tell you what to lift.
  const seed = already.length ? already[already.length - 1] : { w: null, r: 8 };
  const hist = allSets().filter((x) => x.ex === ex);
  const rir = already.length ? already[already.length - 1].rir
    : (L.rirBy || {})[ex] !== undefined ? L.rirBy[ex]
    : hist.length ? hist[hist.length - 1].rir : null;
  setState({ sheet: ex, w: seed.w, r: seed.r, rir: rir === undefined ? null : rir }, { persist: false });
}

function logCardio() {
  const min = parseFloat(state.cMin) || 0, km = parseFloat(state.cKm) || 0;
  if (!(min > 0)) return;
  const t = today();
  const rec = {
    id: Date.now(), date: state.cWhen === "visit" ? t : (state.cDate || t),
    type: state.cType, min, km: km > 0 ? +km.toFixed(2) : null, lift: state.cWhen === "visit",
  };
  setState({ cLast: rec, cardio: [rec, ...state.cardio].sort((a, b) => (a.date < b.date ? 1 : -1)) });
}

// The app cannot write to log.csv and must not try: that file is the system of record
// and appending to it is a deliberate, reviewed act. So it hands over exactly what
// `analyze.py sync` reads, and the CLI does the appending, dry-run first.
function exportStore() {
  // Cardio goes too: analyze.py sync reads both, resolves the app's title-case type
  // ("Outdoor run") through exercises.yaml's aliases, and writes cardio rows.
  const doc = {
    v: 4, exported_at: new Date().toISOString(),
    sessions: state.sessions, cardio: state.cardio,
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 1)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `strengthlog-${today()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// The rows exactly as log.csv wants them, so they can be pasted into a chat instead of
// travelling as a file. analyze.py sync also accepts this shape via --rows.
function logRows() {
  const out = [];
  const dates = Object.keys(state.sessions).sort();
  for (const d of dates) {
    for (const [ex, sets] of Object.entries(state.sessions[d].lifts)) {
      sets.forEach((v, i) => out.push(
        [d, "strength", ex, i + 1, v.w, v.r, v.rir == null ? "" : v.rir, "", "", ""].join(",")));
    }
  }
  const per = {};
  for (const c of [...state.cardio].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    const name = CARDIO_CANON[c.type] || c.type.toLowerCase().replace(/\s+/g, "_");
    const k = `${c.date}/${name}`;
    per[k] = (per[k] || 0) + 1;
    out.push([c.date, "cardio", name, per[k], "", "", "", "", c.min, c.km == null ? "" : c.km].join(","));
  }
  // One chronological stream, matching what analyze.py sync appends.
  return out.sort((a, b) => (a.slice(0, 10) < b.slice(0, 10) ? -1 : a.slice(0, 10) > b.slice(0, 10) ? 1 : 0)).join("\n");
}

async function copyRows() {
  const text = logRows();
  const el = $("rowsout");
  if (!text) { el.textContent = "Nothing logged yet."; el.hidden = false; return; }
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch { /* no permission */ }
  el.textContent = (ok ? "Copied. Paste it to Claude.\n\n" : "Clipboard refused - select and copy this:\n\n") + text;
  el.hidden = false;
  if (!ok) {
    const r = document.createRange();
    r.selectNodeContents(el);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  }
}

function exportYaml() {
  const out = ["plans:"];
  for (const [pid, p] of Object.entries(state.plans)) {
    const lifts = uniq(DAYS.flatMap((d) => (p.week[d] || []).map((x) => x[0]))).sort();
    out.push(`  ${pid}:`, `    name: ${p.name}`, "    lifts:");
    for (const ex of lifts) out.push(`      - ${ex}`);
    out.push("    week:");
    for (const d of DAYS) {
      const rows = p.week[d] || [];
      out.push(`      ${d}:`);
      out.push(`        name: ${(PLANS[pid] || { week: {} }).week?.[d]?.name || d}`);
      if (!rows.length) { out.push("        plan: []"); continue; }
      out.push("        plan:");
      for (const [ex, s] of rows) out.push(`          - exercise: ${ex}`, `            sets: ${s}`);
    }
  }
  out.push("schedule:", `  - plan: ${state.sessionPlanKey}`, `    from: ${today()}`);
  const provisional = Object.keys(state.custom);
  const head = provisional.length
    ? "# These lifts are not in exercises.yaml yet. Paste them in first.\n" +
      "# The app proposes no load, so it never needed an increment and none is claimed\n" +
      "# here. analyze.py's own progression rule does - fill it in from the machine if\n" +
      "# you want the CLI to prescribe, or leave it out.\n" +
      provisional.map((n) => {
        const c = libOf(n) || {};
        return `#   ${n}: {muscles: [${c.muscle}], increment: ?, ` +
          `rep_range: [${(c.rep_range || DEFAULT_REP_RANGE).join(", ")}]}\n`;
      }).join("") + "\n"
    : "";
  const el = $("yamlout");
  el.textContent = head + out.join("\n") +
    "\n\n# Paste into routine.yaml, then: python3 analyze.py bands --plan <id>\n";
  el.hidden = false;
}

/* --------------------------------------------------------------- event wiring */

document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-act],[role=tab]");
  if (!t) return;
  if (t.getAttribute("role") === "tab") {
    setState({ tab: t.dataset.tab, sheet: null, summaryOn: false, lift: null, libOn: false, switchOn: false, dayOn: false, reorder: false }, { persist: false });
    $("main").scrollTop = 0;
    return;
  }
  const a = t.dataset.act, v = t.dataset.v;
  const num = (x) => parseFloat(x);
  switch (a) {
    // session
    case "open-sheet": openSheet(t.dataset.ex); break;
    case "move": {
      const L = ensureLive();
      const cur = (L.order || sessionLifts().map((l) => l.ex)).slice();
      const i = cur.indexOf(t.dataset.ex), j = i + parseInt(t.dataset.dir, 10);
      if (i >= 0 && j >= 0 && j < cur.length) { cur.splice(j, 0, cur.splice(i, 1)[0]); L.order = cur; }
      setState({});
      break;
    }
    case "toggle-reorder": {
      const L = ensureLive();
      if (!state.reorder) L.order = sessionLifts().map((l) => l.ex);
      setState({ reorder: !state.reorder });
      break;
    }
    case "finish": finish(); break;
    case "close-summary": closeSummary(); break;
    case "drop-stale": {
      // Destructive, so it is armed: the first tap only asks.
      if (!state.armStale) { setState({ armStale: true }, { persist: false }); break; }
      state.armStale = false;
      state.live = null;
      setState({}, { force: true });
      break;
    }
    case "go-cardio": setState({ tab: "Cardio", cWhen: "visit" }, { persist: false }); break;
    // log sheet
    case "w": {
      const inc = 2.5;                 // the stepper's own step; no library value is read
      const base = state.w == null ? (num(t.dataset.d) > 0 ? inc - num(t.dataset.d) : null) : state.w;
      if (base == null) break;
      setState({ w: Math.max(0, +(base + num(t.dataset.d)).toFixed(2)) }, { persist: false });
      break;
    }
    case "r": setState({ r: Math.max(1, state.r + num(t.dataset.d)) }, { persist: false }); break;
    case "rir": setState({ rir: v === "" ? null : parseInt(v, 10) }, { persist: false }); break;
    case "log-set": logSet(); break;
    case "extra-set": {
      const L = ensureLive();
      L.extra = { ...L.extra, [state.sheet]: (L.extra[state.sheet] || 0) + 1 };
      setState({});
      break;
    }
    // cardio
    case "c-type": setState({ cType: v, cKm: v === "Elliptical" ? "0" : state.cKm }, { persist: false }); break;
    case "c-when": setState({ cWhen: v }, { persist: false }); break;
    case "c-date": setState({ cDate: v }, { persist: false }); break;
    case "c-min": setState({ cMin: String(Math.max(0, (parseFloat(state.cMin) || 0) + num(t.dataset.d))) }, { persist: false }); break;
    case "c-km": setState({ cKm: String(Math.max(0, +((parseFloat(state.cKm) || 0) + num(t.dataset.d)).toFixed(1))) }, { persist: false }); break;
    case "c-log": logCardio(); break;
    case "c-undo": setState({ cardio: state.cardio.filter((x) => x.id !== (state.cLast || {}).id), cLast: null }, { force: true }); break;
    // progress
    case "win": setState({ win: v }, { persist: false }); break;
    case "kpiview": setState({ kpiView: v }, { persist: false }); break;
    case "kpibase": setState({ kpiBase: v }, { persist: false }); break;
    case "lift": setState({ lift: t.dataset.ex }, { persist: false }); break;
    // plan
    case "day": setState({ day: v, armedDrop: null }, { persist: false }); break;
    case "sets": editPlan((w) => { const r = w[state.day][+t.dataset.i]; r[1] = Math.max(0, r[1] + parseInt(t.dataset.d, 10)); }); break;
    case "drop": {
      // Removing a lift is destructive, so the first tap only arms it.
      const key = `${state.day}:${t.dataset.i}`;
      if (state.armedDrop !== key) { setState({ armedDrop: key }, { persist: false }); break; }
      state.armedDrop = null;
      editPlan((w) => { w[state.day].splice(+t.dataset.i, 1); });
      break;
    }
    case "publish": { const base = clone(state.base); base[state.planKey] = clone(state.plans[state.planKey]); setState({ base }); break; }
    case "undo-plan": { const plans = clone(state.plans); plans[state.planKey] = clone(state.base[state.planKey]); setState({ plans }); break; }
    case "export": exportYaml(); break;
    case "export-store": exportStore(); break;
    case "copy-rows": copyRows(); break;
    case "open-lib": setState({ libOn: true, query: "" }, { persist: false }); break;
    case "add-lift": editPlan((w) => { w[state.day] = (w[state.day] || []).concat([[v, 3]]); }); setState({ libOn: false, query: "" }); break;
    case "new-muscle": setState({ newMuscle: v }, { persist: false }); break;
    case "create-lift": {
      const name = state.query.trim().toLowerCase().replace(/\s+/g, "_");
      if (!name) break;
      const custom = { ...state.custom, [name]: { muscle: state.newMuscle, muscles: [state.newMuscle], increment: null, rep_range: DEFAULT_REP_RANGE } };
      state.custom = custom;
      editPlan((w) => { w[state.day] = (w[state.day] || []).concat([[name, 3]]); });
      setState({ libOn: false, query: "" });
      break;
    }
    // plan switcher
    case "open-switch": setState({ switchOn: true }, { persist: false }); break;
    case "open-day": setState({ dayOn: true }, { persist: false }); break;
    case "pick-day": {
      const L = ensureLive();
      L.dayKey = v === weekdayOf(L.date) ? null : v;
      L.order = null;                       // the old order belonged to the old day
      setState({ dayOn: false });
      break;
    }
    case "pick-plan": setState({ planKey: v, switchOn: false }); break;
    case "train": {
      const L = ensureLive();
      if (!Object.keys(L.logged).length) { L.plan = v; L.order = null; }
      setState({ sessionPlanKey: v, switchOn: false, tab: "Session" });
      break;
    }
    case "rename": setState({ renaming: v, draft: state.plans[v].name, renameError: "" }, { persist: false }); break;
    case "rename-save": saveRename(); break;
    case "rename-cancel": setState({ renaming: null, renameError: "" }, { persist: false }); break;
    case "new-plan": newPlan(v === "copy"); break;
    // history
    case "sess": setState({ openSession: state.openSession === v ? null : v }, { persist: false }); break;
    case "more-hist": setState({ histShown: state.histShown + 120 }, { persist: false }); break;
    // overlays
    case "close-ov": setState({ sheet: null, lift: null, libOn: false, switchOn: false, dayOn: false, renaming: null }, { persist: false }); break;
    default: break;
  }
});

// Typed numbers and the library query. Committed on input so a half-typed value never
// gets lost to a re-render; the re-render is what would eat it, so these do not trigger
// a full renderAll.
document.addEventListener("input", (e) => {
  const el = e.target;
  if (el.id === "s-w") {
    const v = parseFloat(el.value);
    state.w = el.value.trim() === "" || isNaN(v) ? null : Math.max(0, v);
    syncSheetLabel();
  }
  else if (el.id === "s-r") { state.r = Math.max(1, parseInt(el.value, 10) || 1); syncSheetLabel(); }
  else if (el.id === "c-min") { state.cMin = el.value.replace(/[^0-9]/g, ""); }
  else if (el.id === "c-km") { state.cKm = el.value.replace(",", ".").replace(/[^0-9.]/g, ""); }
  else if (el.id === "libq") { state.query = el.value; const at = el.selectionStart; renderOverlay(); const n = $("libq"); if (n) { n.focus(); n.setSelectionRange(at, at); } }
  else if (el.id === "rename") { state.draft = el.value; }
});
document.addEventListener("change", (e) => {
  if (["c-min", "c-km"].includes(e.target.id)) { persist(); renderCardio(); }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && ["s-w", "s-r", "c-min", "c-km", "libq"].includes(e.target.id)) e.target.blur();
  if (e.target.id === "rename") { if (e.key === "Enter") saveRename(); if (e.key === "Escape") setState({ renaming: null }, { persist: false }); }
  if (e.key === "Escape" && (state.sheet || state.libOn || state.switchOn || state.dayOn || state.lift)) {
    setState({ sheet: null, libOn: false, switchOn: false, dayOn: false, lift: null }, { persist: false });
  }
});
// A div role=button still has to answer the keyboard.
document.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.matches?.('[role="button"][data-act]')) {
    e.preventDefault(); e.target.click();
  }
});

function syncSheetLabel() {
  const b = document.querySelector('[data-act="log-set"]');
  if (!b) return;
  const n = (state.live && state.live.logged[state.sheet] || []).length + 1;
  b.disabled = state.w == null;
  b.textContent = state.w == null ? "Enter the weight" : `Log set ${n} · ${state.w} × ${state.r}`;
}

/* ----------------------------------------------------------------------- boot */

function hydrate(doc) {
  if (!doc) return;
  if (doc.sessions) state.sessions = { ...state.sessions, ...doc.sessions };
  if (Array.isArray(doc.cardio)) {
    const byId = new Map(state.cardio.map((c) => [c.id, c]));
    for (const c of doc.cardio) byId.set(c.id, c);
    state.cardio = [...byId.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
  }
  if (doc.plans) state.plans = { ...state.plans, ...doc.plans };
  if (doc.base) state.base = { ...state.base, ...doc.base };
  if (doc.custom) state.custom = { ...state.custom, ...doc.custom };
  if (doc.planKey && state.plans[doc.planKey]) state.planKey = doc.planKey;
  if (doc.sessionPlanKey && state.plans[doc.sessionPlanKey]) state.sessionPlanKey = doc.sessionPlanKey;
  // Restored whatever its date. This used to be `=== today()`, which SILENTLY DISCARDED
  // a session logged yesterday and never finished - and the next persist() wrote the
  // empty replacement over it in both stores. Sets that reach disk must never be dropped
  // by a load.
  if (doc.live) state.live = doc.live;
}

async function boot() {
  // The log is read FIRST. askPersist() can be slow on a phone and nothing depends on
  // its answer, so it no longer sits in front of the read.
  const local0 = await readLocalBest();
  hydrate(local0);
  booted = true;
  renderAll();
  await askPersist();
  const local = local0;
  state.day = weekdayOf(today());
  renderAll();
  const remote = await store.pull();
  if (remote) {
    // Remote is the store of record; anything only here goes up on the next push.
    const localer = local && remote.updated_at && local.updated_at > remote.updated_at;
    hydrate(remote);
    if (localer) hydrate(local);
    renderAll();
    persist(localer);
  } else {
    renderHeader();
  }
}

addEventListener("online", () => persist());
boot();
