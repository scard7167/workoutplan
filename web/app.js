// The rules live in CLAUDE.md, exercises.yaml, routine.yaml and config.yaml. data.js is
// generated from all of them plus analyze.py, so nothing here restates a threshold.
//
// Division of labour: every DEEP number (trend slopes, strength index, the volume-load
// bridge, stalls, balance, adherence) is computed once by analyze.py and shipped in
// ANALYTICS. This file renders those. Only the live session - parsing a set, counting
// today's volume, and prescribing the next load for a lift the plan has just added -
// is computed here, against the same rule.
import { EXERCISES, BANDS, UNCOVERED, METRICS, PROGRESSION, ROUTINE, ANALYTICS, SEED_LOG }
  from "./data.js";

const MUSCLES = ["chest","lats","upper_back","front_delts","side_delts","rear_delts",
                 "biceps","triceps","quads","hamstrings","glutes","calves","core"];
const DAYS = ["mon","tue","wed","thu","fri","sat","sun"];
const STORE_SESSION = "strengthlog.session.v2";
const STORE_ROUTINE = "strengthlog.routine.v1";
const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const ALIASES = (() => {
  const pairs = [];
  for (const [name, ex] of Object.entries(EXERCISES)) {
    pairs.push([name.toLowerCase(), name], [name.replace(/_/g, " "), name]);
    for (const a of ex.aliases) pairs.push([a.toLowerCase().trim(), name]);
  }
  return pairs.sort((a, b) => b[0].length - a[0].length);
})();

const state = {
  date: new Date().toISOString().slice(0, 10),
  sets: [],
  sticky: null,
  window: 7,
  lift: ANALYTICS.stalls[0]?.exercise || ROUTINE.lifts[0],
  routine: null,     // null = use the file
};

const routine = () => state.routine || ROUTINE;
const todayKey = () => DAYS[(new Date().getDay() + 6) % 7];
const label = (e) => e.replace(/_/g, " ");

// ------------------------------------------------------------------ parsing
function resolve(t) {
  t = t.toLowerCase().trim();
  for (const [a, n] of ALIASES) if (a === t) return n;
  return null;
}
function splitExercise(s) {
  for (const [a, n] of ALIASES) {
    if (s === a) return { exercise: n, rest: "" };
    if (s.startsWith(a + " ")) return { exercise: n, rest: s.slice(a.length).trim() };
  }
  return { exercise: null, rest: s };
}

function parse(raw) {
  const s = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (!s) return { error: "empty" };
  if (s === "undo") return { undo: true };
  if (s === "/end" || s === "end") return { end: true };
  const swap = s.match(/^swap to (.+)$/);
  if (swap) {
    const n = resolve(swap[1]);
    return n ? { sticky: n } : { error: `unknown exercise: ${swap[1]}` };
  }

  let { exercise, rest } = splitExercise(s);
  if (exercise && rest === "") return { sticky: exercise };
  if (!exercise) exercise = state.sticky;
  if (!exercise) return { error: `name the exercise first (unknown: ${s.split(" ")[0]})` };
  const ex = EXERCISES[exercise];

  let at = null;
  const atM = rest.match(/@\s*(\d+(?:[.,]\d+)?)\s*$/);
  if (atM) { at = parseFloat(atM[1].replace(",", ".")); rest = rest.slice(0, atM.index).trim(); }

  let weight, reps, count = 1, rir = null;
  const bw = rest.match(/^bw\s*(?:x\s*)?(\d+)$/);
  const pair = rest.match(/^(\+)?(\d+(?:[.,]\d+)?)\s*x\s*(\d+)$/);

  if (bw) {
    if (!ex.bodyweight) return { error: `${exercise} is not a bodyweight exercise` };
    weight = 0; reps = parseInt(bw[1], 10); rir = at;
  } else if (pair) {
    const plus = !!pair[1];
    const a = parseFloat(pair[2].replace(",", ".")), b = parseInt(pair[3], 10);
    if (at === null) { weight = a; reps = b; }
    else if (at > 4) { count = a; reps = b; weight = at; }
    else if (plus || a > 4 || !Number.isInteger(a)) { weight = a; reps = b; rir = at; }
    else return { ask: `${a}x${b} @${at}: ${a} kg at RIR ${at}, or ${a} sets of ${b} at ${at} kg?` };
    if (!Number.isInteger(count) || count < 1) return { error: `${count} is not a set count` };
  } else {
    return { error: `cannot parse "${raw.trim()}"` };
  }

  if (!Number.isInteger(reps) || reps < 1) return { error: `reps ${reps} is not a positive integer` };
  if (weight < 0) return { error: `weight ${weight} is negative` };
  if (weight === 0 && !ex.bodyweight) return { error: `weight 0 but ${exercise} is not bodyweight` };
  if (rir !== null && (!Number.isInteger(rir) || rir < 0 || rir > 4))
    return { error: `rir ${rir} is not 0-4` };

  return { sets: Array.from({ length: count }, () => ({ exercise, weight_kg: weight, reps, rir })) };
}

// --------------------------------------------------- the progression rule
const roundDown = (kg, inc) => Math.floor((kg + 1e-9) / inc) * inc;

function priorSession(exercise) {
  const dates = [...new Set(SEED_LOG.filter(r => r.exercise === exercise && r.date < state.date)
                                    .map(r => r.date))].sort();
  if (!dates.length) return null;
  const d = dates[dates.length - 1];
  return SEED_LOG.filter(r => r.exercise === exercise && r.date === d)
                 .sort((a, b) => a.set_no - b.set_no);
}

function deload(load, ex, floor) {
  if (load === 0)
    return { weight_kg: 0, target_reps: Math.max(1, floor - 2),
             reason: "deload floor: bodyweight" };
  return { weight_kg: roundDown(load * (1 - PROGRESSION.deload_pct), ex.increment),
           target_reps: floor, reason: "deload" };
}

// Fallback only. ANALYTICS.prescriptions is the authority for routine lifts; this covers
// a lift the plan gained in the browser and Python has not seen.
function prescribeJS(exercise) {
  const ex = EXERCISES[exercise];
  const [floor, ceiling] = ex.rep_range;
  const prior = priorSession(exercise);
  if (!prior) return { weight_kg: null, target_reps: floor, reason: "no baseline" };
  const load = prior[prior.length - 1].weight_kg;
  if (prior.some(s => s.reps < floor && s.rir === 0)) return deload(load, ex, floor);
  if (prior.every(s => s.reps >= ceiling && s.rir !== null && s.rir <= PROGRESSION.rir_ceiling))
    return { weight_kg: load + ex.increment, target_reps: floor, reason: "progress" };
  return { weight_kg: load, target_reps: Math.min(ceiling, Math.max(...prior.map(s => s.reps)) + 1),
           reason: "hold" };
}
const prescribe = (e) => ANALYTICS.prescriptions[e] || prescribeJS(e);

function nextSet(just) {
  const ex = EXERCISES[just.exercise];
  const [floor] = ex.rep_range;
  if (just.reps < floor && just.rir === 0) return deload(just.weight_kg, ex, floor);
  return { weight_kg: just.weight_kg, target_reps: prescribe(just.exercise).target_reps,
           reason: "hold" };
}

// ------------------------------------------------------ feedback contract
function fmtW(w, exercise) {
  if (w === null || w === undefined) return "-";
  if (w === 0) return "bw";
  const plus = exercise && EXERCISES[exercise]?.bodyweight ? "+" : "";
  return `${plus}${+Number(w).toFixed(2)}`;
}
const fmtSet = (s) =>
  `${fmtW(s.weight_kg, s.exercise)}${s.weight_kg === 0 ? " " : ""}x${s.reps}` +
  `${s.rir === null || s.rir === undefined ? "" : ` @${s.rir}`}`;

function baselineLine(s) {
  const prior = priorSession(s.exercise);
  const m = prior && prior.find(p => p.set_no === s.set_no);
  if (!m) return `<span class="l2">last  no baseline</span>`;
  const dw = +(s.weight_kg - m.weight_kg).toFixed(2), dr = s.reps - m.reps;
  const bits = [];
  if (dw !== 0) bits.push(`${dw > 0 ? "+" : ""}${dw} kg`);
  if (dr !== 0) bits.push(`${dr > 0 ? "+" : ""}${dr} rep${Math.abs(dr) === 1 ? "" : "s"}`);
  if (!bits.length) bits.push("same");
  const cls = dw < 0 || (dw === 0 && dr < 0) ? "down" : (dw > 0 || dr > 0) ? "up" : "";
  return `<span class="l2">last ${m.date} s${m.set_no} ${fmtSet(m)}  ` +
         `<span class="${cls}">${bits.join(" ")}</span></span>`;
}

function feedback(s) {
  const n = nextSet(s);
  const tail = n.reason && n.reason !== "hold" ? `  (${n.reason})` : "";
  return [`<span class="l1">${label(s.exercise)} s${s.set_no} ${fmtSet(s)}</span>`,
          baselineLine(s),
          `<span class="l3">next ${fmtW(n.weight_kg, s.exercise)} x${n.target_reps}${tail}</span>`
         ].join("\n");
}

// ------------------------------------------------------------- svg helpers
const SVGNS = "http://www.w3.org/2000/svg";
function svg(vb, cls = "") {
  return `<svg viewBox="${vb}" class="${cls}" role="img" preserveAspectRatio="none">`;
}
function sparkline(values, w = 120, h = 26) {
  if (values.length < 2) return "";
  const lo = Math.min(...values), hi = Math.max(...values), span = hi - lo || 1;
  const pts = values.map((v, i) =>
    `${(i / (values.length - 1) * (w - 2) + 1).toFixed(1)},${(h - 2 - (v - lo) / span * (h - 4)).toFixed(1)}`);
  const last = pts[pts.length - 1].split(",");
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">` +
    `<polyline points="${pts.join(" ")}" fill="none" stroke="var(--accent)" stroke-width="1.5"` +
    ` vector-effect="non-scaling-stroke" stroke-linejoin="round"/>` +
    `<circle cx="${last[0]}" cy="${last[1]}" r="2" fill="var(--accent)"/></svg>`;
}

// ------------------------------------------------------------- TODAY view
function planFor(day) { return routine().week[day].plan; }

function loggedFor(exercise) {
  return state.sets.filter(s => s.exercise === exercise).length;
}

function renderToday() {
  const day = todayKey();
  const entry = routine().week[day];
  const plan = entry.plan;
  const d = new Date();
  $("today-day").textContent =
    d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
  $("today-name").textContent = entry.name;

  const planned = plan.reduce((a, p) => a + p.sets, 0);
  const done = plan.reduce((a, p) => a + Math.min(p.sets, loggedFor(p.exercise)), 0);
  const extra = state.sets.length - done;
  $("today-progress").innerHTML =
    `<b>${state.sets.length}<span style="color:var(--muted)">/${planned}</span></b>sets logged` +
    (extra > 0 ? `<br><span style="color:var(--warn)">${extra} off plan</span>` : "");

  $("today-plan").innerHTML = plan.map(p => {
    const rx = prescribe(p.exercise);
    const n = loggedFor(p.exercise);
    const pips = Array.from({ length: Math.max(p.sets, n) }, (_, i) =>
      `<span class="pip ${i < n ? (i < p.sets ? "on" : "extra") : ""}"></span>`).join("");
    const cls = ["", n >= p.sets ? "done" : "", state.sticky === p.exercise ? "active" : ""].join(" ");
    return `<li class="${cls}" data-ex="${p.exercise}" tabindex="0">
      <span class="nm">${label(p.exercise)}</span>
      <span class="rx">${fmtW(rx.weight_kg, p.exercise)} &times; ${rx.target_reps}</span>
      <span class="why ${rx.reason}">${rx.reason}${rx.basis_date ? " since " + rx.basis_date : ""}</span>
      <span class="pips">${pips}</span></li>`;
  }).join("");

  for (const li of $("today-plan").querySelectorAll("li")) {
    const pick = () => { state.sticky = li.dataset.ex; renderToday(); showPrescription(li.dataset.ex); };
    li.onclick = pick;
    li.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } };
  }
  $("hstate").textContent = `${state.date} · ${state.sets.length} sets`;
}

function showPrescription(exercise) {
  const p = prescribe(exercise);
  const prior = priorSession(exercise);
  const last = prior
    ? `last ${prior[0].date} · ${prior.length} sets · top ${fmtSet(prior[0])}`
    : "last  no baseline";
  $("feedback").innerHTML =
    `<span class="l1">${label(exercise)}</span>\n<span class="l2">${last}</span>\n` +
    `<span class="l3">next ${fmtW(p.weight_kg, exercise)} x${p.target_reps}` +
    `${p.reason === "hold" ? "" : `  (${p.reason})`}</span>`;
}

// ------------------------------------------------------------ TRENDS view
function volumeCounts(days) {
  const live = state.sets.map(s => ({ ...s, date: state.date }));
  const all = [...SEED_LOG, ...live];
  const end = all.map(r => r.date).sort().pop();
  const start = new Date(Date.parse(end) - (days - 1) * 864e5).toISOString().slice(0, 10);
  const win = all.filter(r => r.date >= start && r.date <= end);
  const counts = Object.fromEntries(MUSCLES.map(m => [m, 0]));
  for (const s of win)
    if (s.rir === null || s.rir === undefined || s.rir <= METRICS.hard_set_rir)
      for (const m of EXERCISES[s.exercise].muscles) counts[m]++;
  return { counts, end, sessions: new Set(win.map(r => r.date)).size, sets: win.length };
}

function flagOf(n, band, muscle) {
  if (UNCOVERED.includes(muscle)) return "UNCOVERED";
  if (n < band.min || n > band.max) return "RED";
  if (n < band.target) return "AMBER";
  return "GREEN";
}

function renderKpis() {
  const ix = ANALYTICS.index, ad = ANALYTICS.adherence, br = ANALYTICS.bridge;
  const vals = Object.values(ix.muscles).map(m => m.index).filter(v => v !== null);
  const prior = Object.values(ix.exercises).map(e => e.prior_index).filter(v => v !== null);
  const overall = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  const overallPrior = prior.length ? prior.reduce((a, b) => a + b, 0) / prior.length : null;
  const delta = overall !== null && overallPrior !== null ? overall - overallPrior : null;
  const dcls = delta === null ? "" : delta >= 0 ? "up" : "down";

  $("kpis").innerHTML = `
    <div class="kpi"><div class="k">Strength index</div>
      <div class="v">${overall === null ? "-" : overall.toFixed(0)}</div>
      <div class="d ${dcls}">${delta === null ? "no prior period"
        : `${delta >= 0 ? "+" : ""}${delta.toFixed(1)} vs prior 28d`}</div></div>
    <div class="kpi"><div class="k">Adherence</div>
      <div class="v">${ad.rate === null ? "-" : Math.round(ad.rate * 100) + "%"}</div>
      <div class="d">${ad.logged_sets}/${ad.planned_sets} sets · ${ad.trained_days}/${ad.planned_days}d</div></div>
    <div class="kpi"><div class="k">Load 7d</div>
      <div class="v">${(br.vl_current / 1000).toFixed(1)}t</div>
      <div class="d ${br.delta >= 0 ? "up" : "down"}">${br.delta >= 0 ? "+" : ""}${(br.delta / 1000).toFixed(1)}t vs prior</div></div>`;
}

function trendChip(p) {
  if (!p || p.slope === null || p.per_week === undefined)
    return `<span class="ld">${p?.reason ? "no slope" : "-"}</span>`;
  const u = p.unit || "kg";
  const cls = p.noisy ? "" : p.per_week > 0 ? "up" : p.per_week < 0 ? "down" : "";
  return `<span class="ld ${cls}">${p.per_week >= 0 ? "+" : ""}${p.per_week} ${u}/wk` +
         `${p.noisy ? " · noisy" : ""}</span>`;
}

function renderLiftGrid() {
  const P = ANALYTICS.progression;
  $("trend-meta").textContent =
    `best set per session · ${ANALYTICS.index.baseline_weeks}w baseline · to ${ANALYTICS.last_logged}`;
  $("liftgrid").innerHTML = routine().lifts.map(e => {
    const p = P[e];
    const vals = (p?.points || []).map(x => x.value);
    return `<button class="lift" data-ex="${e}" aria-pressed="${state.lift === e}">
      <span class="ln">${label(e)}</span>
      <span class="lv">${p?.current ?? "-"}<span class="ld"> ${p?.basis === "reps" ? "reps" : "kg e1RM"}</span></span>
      ${trendChip(p)}
      ${sparkline(vals)}</button>`;
  }).join("");
  for (const b of $("liftgrid").querySelectorAll(".lift"))
    b.onclick = () => { state.lift = b.dataset.ex; renderLiftGrid(); renderDetail(); };
}

function renderDetail() {
  const p = ANALYTICS.progression[state.lift];
  const box = $("liftdetail");
  if (!p || p.points.length < 2) {
    box.innerHTML = `<p class="empty">${label(state.lift)}: not enough sessions to plot.</p>`;
    return;
  }
  const W = 600, H = 190, L = 38, R = 8, T = 12, B = 26;
  const vals = p.points.map(v => v.value);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.15 || 1;
  const y0 = lo - pad, y1 = hi + pad;
  const t0 = Date.parse(p.points[0].date), t1 = Date.parse(p.points[p.points.length - 1].date);
  const X = (d) => L + (Date.parse(d) - t0) / ((t1 - t0) || 1) * (W - L - R);
  const Y = (v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);

  const line = p.points.map(pt => `${X(pt.date).toFixed(1)},${Y(pt.value).toFixed(1)}`).join(" ");
  const grid = [y0, (y0 + y1) / 2, y1].map(v =>
    `<line x1="${L}" y1="${Y(v).toFixed(1)}" x2="${W - R}" y2="${Y(v).toFixed(1)}"
       stroke="var(--line)" stroke-width="1" vector-effect="non-scaling-stroke"/>
     <text x="${L - 6}" y="${(Y(v) + 3.5).toFixed(1)}" text-anchor="end" fill="var(--muted)"
       font-size="10" font-family="var(--mono)">${v.toFixed(0)}</text>`).join("");

  let trend = "";
  if (p.slope_per_day !== undefined && p.slope_per_day !== null && !p.noisy) {
    const win = p.points.filter(pt => Date.parse(pt.date) >= t1 - p.trend_sessions * 864e5 * 30);
    const s0 = win[0], s1 = p.points[p.points.length - 1];
    const days = (Date.parse(s1.date) - Date.parse(s0.date)) / 864e5;
    const yStart = s1.value - p.slope_per_day * days;
    trend = `<line x1="${X(s0.date).toFixed(1)}" y1="${Y(yStart).toFixed(1)}"
        x2="${X(s1.date).toFixed(1)}" y2="${Y(s1.value).toFixed(1)}"
        stroke="var(--ink-2)" stroke-width="1" stroke-dasharray="4 3"
        vector-effect="non-scaling-stroke"/>`;
  }
  const dots = p.points.map(pt =>
    `<circle cx="${X(pt.date).toFixed(1)}" cy="${Y(pt.value).toFixed(1)}" r="2.2"
       fill="${pt.value === p.best ? "var(--good)" : "var(--accent)"}"><title>${pt.date}: ${pt.value}</title></circle>`).join("");

  const slopeTxt = p.slope === null || p.per_week === undefined
    ? (p.reason || "no slope")
    : `${p.per_week >= 0 ? "+" : ""}${p.per_week} ${p.unit}/week · ` +
      `${p.pct_per_month >= 0 ? "+" : ""}${p.pct_per_month}%/month · r² ${p.r2}` +
      (p.noisy ? " · NOISY, not a trend" : "");

  box.innerHTML = `<div class="dhead"><h3>${label(state.lift)}</h3>
      <span class="meta">${p.n_sessions} sessions · best ${p.best} on ${p.best_date}</span></div>
    <svg viewBox="0 0 ${W} ${H}" role="img"
      aria-label="${label(state.lift)} best set per session, ${slopeTxt}">
      ${grid}${trend}
      <polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="1.6"
        vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
      ${dots}
      <text x="${L}" y="${H - 8}" fill="var(--muted)" font-size="10" font-family="var(--mono)">${p.first}</text>
      <text x="${W - R}" y="${H - 8}" text-anchor="end" fill="var(--muted)" font-size="10"
        font-family="var(--mono)">${p.last}</text>
    </svg>
    <p class="legend">${slopeTxt}${p.regime_change
      ? " · <b>bodyweight sets excluded</b>: added load and bodyweight reps are not the same measurement"
      : ""}</p>`;
}

function renderMeters() {
  const { counts, end, sessions, sets } = volumeCounts(state.window);
  const scale = state.window / 7;
  $("meters").innerHTML = MUSCLES.map(m => {
    const band = { min: BANDS[m].min * scale, target: BANDS[m].target * scale, max: BANDS[m].max * scale };
    const n = counts[m], f = flagOf(n, band, m);
    const axis = Math.max(band.max * 1.25, n * 1.08, 1);
    const pc = (v) => clamp(v / axis * 100, 0, 100);
    return `<div class="meter">
      <div class="mtop"><span class="mname">${label(m)}</span>
        <span class="mval">${n} / ${band.min}-${band.max}</span>
        <span class="mflag ${f}">${f}</span></div>
      <div class="track" role="img" aria-label="${m}: ${n} sets, band ${band.min} to ${band.max}, ${f}">
        <span class="band" style="left:${pc(band.min)}%;width:${pc(band.max) - pc(band.min)}%"></span>
        <span class="bar ${f}" style="width:${pc(n)}%"></span>
        <span class="tick" style="left:${pc(band.target)}%"></span></div></div>`;
  }).join("");
  $("vol-legend").innerHTML =
    `Rolling ${state.window}d to ${end} · ${sessions} sessions · ${sets} working sets, today included. ` +
    `Bar = hard sets credited to prime movers only. Block = <b>min-max</b>, tick = <b>target</b>, ` +
    `both derived from routine.yaml.<br>` +
    `<b>${UNCOVERED.map(label).join(" and ")}</b> are uncovered by design - the cycling and running ` +
    `load them and this log never sees it.`;
}

function renderBridge() {
  const b = ANALYTICS.bridge;
  const rows = [["sets", b.effects.sets], ["weight", b.effects.weight], ["reps", b.effects.reps],
                ["covar", b.effects.covar], ["mix", b.effects.mix]];
  const span = Math.max(...rows.map(r => Math.abs(r[1])), 1);
  const bars = rows.map(([k, v]) => {
    const w = Math.abs(v) / span * 46;
    const left = v >= 0 ? 50 : 50 - w;
    const col = v >= 0 ? "var(--good)" : "var(--crit)";
    return `<div class="wfrow"><span class="wl">${k}</span>
      <span class="wtrack"><span class="zero" style="left:50%"></span>
        <span style="left:${left}%;width:${w}%;background:${col}"></span></span>
      <span class="wv">${v >= 0 ? "+" : ""}${Math.round(v).toLocaleString()}</span></div>`;
  }).join("");
  $("bridge").innerHTML = `<div class="wf">
    <div class="wfrow"><span class="wl">prior wk</span><span class="wtrack"></span>
      <span class="wv">${Math.round(b.vl_prior).toLocaleString()}</span></div>
    ${bars}
    <div class="wfrow total"><span class="wl">this wk</span><span class="wtrack"></span>
      <span class="wv">${Math.round(b.vl_current).toLocaleString()}</span></div></div>
    <p class="legend">kg lifted = &Sigma;(weight &times; reps) over hard sets.
      <b>covar</b> is the within-week load/rep mix, which is what makes the identity exact -
      residual ${b.residual}. Bodyweight sets carry no load and are excluded:
      ${b.bodyweight_sets.prior} &rarr; ${b.bodyweight_sets.current} this week.</p>`;
}

function renderStalls() {
  const f = ANALYTICS.stalls;
  $("stalls").innerHTML = f.length ? f.map(s => `
    <div class="flagrow"><div class="fh">
      <span class="sev ${s.severity}">${s.severity.toUpperCase()}</span>
      <span class="fn">${label(s.exercise)}</span>
      <span class="fs">${s.slope_per_week >= 0 ? "+" : ""}${s.slope_per_week}/wk · flat ${s.flat_days}d</span>
    </div><div class="fa">${s.action}</div></div>`).join("")
    : `<p class="empty">Nothing stalled. A flat e1RM between load increments is what double
       progression looks like when it is working - only a lift that has stopped climbing
       over ${ANALYTICS.stalls.length === 0 ? "three weeks" : ""} and is not trending up gets flagged.</p>`;
}

function renderBalance() {
  const b = ANALYTICS.balance;
  const rows = ["push_pull", "quad_hamstring", "upper_lower"].map(k => {
    const r = b[k];
    return `<div class="ratio"><span class="rn">${k.replace(/_/g, " : ")}</span>
      <span class="rv ${r.flag}">${r.value === null ? "-" : r.value}</span>
      <span class="rb">${r.band.min}-${r.band.max}</span></div>`;
  }).join("");
  $("balance").innerHTML = rows + `<p class="legend">${b.note}</p>`;
}

function renderIndex() {
  const ix = ANALYTICS.index;
  $("index-meta").textContent = `each lift vs its own first ${ix.baseline_weeks}w = 100 · ${ix.period_days}d to ${ix.period_end}`;
  const entries = Object.entries(ix.exercises).filter(([, v]) => v.index !== null)
    .sort((a, b) => b[1].index - a[1].index);
  const hi = Math.max(120, ...entries.map(([, v]) => v.index));
  $("indexrows").innerHTML = entries.map(([e, v]) => {
    const w = clamp(v.index / hi * 100, 0, 100);
    const base = clamp(100 / hi * 100, 0, 100);
    const col = v.index >= 100 ? "var(--good)" : "var(--warn)";
    return `<div class="idxrow"><span class="in">${label(e)}</span>
      <span class="it"><span style="width:${w}%;background:${col};opacity:.55"></span>
        <span class="base" style="left:${base}%"></span></span>
      <span class="iv">${v.index}</span></div>`;
  }).join("");
  $("index-note").innerHTML = ix.unindexed.length
    ? `Not indexed: ${ix.unindexed.map(u => `<b>${label(u.exercise)}</b> - ${u.reason}`).join("; ")}.`
    : "Every lift has a baseline.";
}

function renderTrends() {
  renderKpis(); renderLiftGrid(); renderDetail(); renderMeters();
  renderBridge(); renderStalls(); renderBalance(); renderIndex();
}

// -------------------------------------------------------------- PLAN view
function loadRoutine() {
  try {
    const raw = localStorage.getItem(STORE_ROUTINE);
    if (raw) state.routine = JSON.parse(raw);
  } catch { /* ignore */ }
}
function saveRoutine() {
  try { localStorage.setItem(STORE_ROUTINE, JSON.stringify(state.routine)); }
  catch { /* private mode */ }
}
function ensureEditable() {
  if (!state.routine) state.routine = JSON.parse(JSON.stringify(ROUTINE));
}

function renderPlan() {
  const r = routine();
  const planned = DAYS.reduce((a, d) => a + r.week[d].plan.reduce((x, p) => x + p.sets, 0), 0);
  $("plan-title").textContent = `${planned} sets / week`;
  $("plan-summary").innerHTML =
    `<b>${r.lifts.length}</b>lifts · ${DAYS.length} days` +
    (state.routine ? `<br><span style="color:var(--warn)">edited, not exported</span>` : "");

  $("planweek").innerHTML = DAYS.map(d => {
    const day = r.week[d];
    const n = day.plan.reduce((a, p) => a + p.sets, 0);
    const rows = day.plan.map((p, i) => `
      <div class="dayrow" data-day="${d}" data-i="${i}">
        <select data-role="ex">${Object.keys(EXERCISES).sort().map(e =>
          `<option value="${e}" ${e === p.exercise ? "selected" : ""}>${label(e)}</option>`).join("")}</select>
        <div class="stepper">
          <button data-role="dec" aria-label="fewer sets">&minus;</button>
          <span class="n">${p.sets}</span>
          <button data-role="inc" aria-label="more sets">+</button>
        </div>
        <button class="rm" data-role="rm" aria-label="remove">&times;</button>
      </div>`).join("");
    return `<div class="day">
      <div class="dayhead ${d === todayKey() ? "today" : ""}">
        <span class="dd">${d}</span><span class="dn">${day.name}</span>
        <span class="ds">${n} sets</span></div>
      ${rows}
      <div class="addrow"><button data-role="add" data-day="${d}">+ add a lift</button></div>
    </div>`;
  }).join("");

  for (const row of $("planweek").querySelectorAll(".dayrow")) {
    const d = row.dataset.day, i = +row.dataset.i;
    row.querySelector('[data-role="ex"]').onchange = (e) => {
      ensureEditable(); state.routine.week[d].plan[i].exercise = e.target.value;
      saveRoutine(); renderPlan();
    };
    row.querySelector('[data-role="inc"]').onclick = () => {
      ensureEditable(); state.routine.week[d].plan[i].sets =
        clamp(state.routine.week[d].plan[i].sets + 1, 1, 8);
      saveRoutine(); renderPlan();
    };
    row.querySelector('[data-role="dec"]').onclick = () => {
      ensureEditable(); state.routine.week[d].plan[i].sets =
        clamp(state.routine.week[d].plan[i].sets - 1, 1, 8);
      saveRoutine(); renderPlan();
    };
    row.querySelector('[data-role="rm"]').onclick = () => {
      ensureEditable(); state.routine.week[d].plan.splice(i, 1);
      saveRoutine(); renderPlan();
    };
  }
  for (const btn of $("planweek").querySelectorAll('[data-role="add"]')) {
    btn.onclick = () => {
      ensureEditable();
      state.routine.week[btn.dataset.day].plan.push({ exercise: r.lifts[0], sets: 2 });
      saveRoutine(); renderPlan();
    };
  }
}

function exportYaml() {
  const r = routine();
  const lines = ["lifts:", ...r.lifts.map(l => `  - ${l}`), "", "week:"];
  for (const d of DAYS) {
    const day = r.week[d];
    lines.push(`  ${d}:`, `    name: ${day.name}`, "    plan:");
    for (const p of day.plan) lines.push(`      - {exercise: ${p.exercise}, sets: ${p.sets}}`);
  }
  const out = $("yamlout");
  out.textContent = lines.join("\n");
  out.hidden = false;
}

// ------------------------------------------------------------ session I/O
function nextSetNo(exercise) { return loggedFor(exercise) + 1; }

function submit(raw) {
  const r = parse(raw);
  if (r.error) return showFeedback(`<span class="err">? ${r.error}</span>`);
  if (r.ask) return showFeedback(`<span class="err">? ${r.ask}</span>`);
  if (r.undo) return undo();
  if (r.end) return showCsv();
  if (r.sticky) { state.sticky = r.sticky; renderToday(); return showPrescription(r.sticky); }

  let last = null;
  for (const s of r.sets) {
    const row = { ...s, set_no: nextSetNo(s.exercise) };
    state.sets.push(row);
    last = row;
  }
  state.sticky = last.exercise;
  showFeedback(feedback(last));
  renderToday();
  saveSession();
}

function undo() {
  const dropped = state.sets.pop();
  renderToday(); saveSession();
  showFeedback(dropped
    ? `<span class="l1">dropped ${label(dropped.exercise)} s${dropped.set_no} ${fmtSet(dropped)}</span>\n` +
      `<span class="hint">${state.sets.length} sets left</span>`
    : `<span class="err">? nothing to undo</span>`);
}

function showCsv() {
  const out = $("csvout");
  if (!state.sets.length) { out.hidden = true; return showFeedback(`<span class="err">? no open session</span>`); }
  const rows = state.sets.map(s =>
    `${state.date},strength,${s.exercise},${s.set_no},${+s.weight_kg},${s.reps},${s.rir === null ? "" : s.rir},`);
  out.textContent = "date,type,exercise,set_no,weight_kg,reps,rir,notes\n" + rows.join("\n");
  out.hidden = false;
  const { counts } = volumeCounts(7);
  const top = MUSCLES.filter(m => counts[m] > 0).sort((a, b) => counts[b] - counts[a]).slice(0, 3);
  showFeedback(
    `<span class="l1">logged: ${state.sets.length} sets, ${new Set(state.sets.map(s => s.exercise)).size} exercises</span>\n` +
    `<span class="l2">volume 7d: ${top.map(m => `${label(m)} ${counts[m]}`).join(", ")}</span>\n` +
    `<span class="hint">paste the rows below into log.csv, then run analyze.py validate</span>`);
}

function showFeedback(html) { $("feedback").innerHTML = html; }

function saveSession() {
  try { localStorage.setItem(STORE_SESSION, JSON.stringify(
    { date: state.date, sets: state.sets, sticky: state.sticky })); }
  catch { /* private mode */ }
}
function loadSession() {
  try {
    const raw = localStorage.getItem(STORE_SESSION);
    if (!raw) return;
    const d = JSON.parse(raw);
    if (d && d.date === state.date && Array.isArray(d.sets)) {
      state.sets = d.sets; state.sticky = d.sticky || null;
    }
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------- wiring
function selectTab(name) {
  for (const t of ["today", "trends", "plan"]) {
    $(`tab-${t}`).setAttribute("aria-selected", String(t === name));
    $(`p-${t}`).hidden = t !== name;
  }
  $("composer").style.display = name === "today" ? "flex" : "none";
}
for (const t of ["today", "trends", "plan"]) $(`tab-${t}`).onclick = () => selectTab(t);

$("btn-log").onclick = () => { const i = $("input"); if (i.value.trim()) { submit(i.value); i.value = ""; } i.focus(); };
$("btn-undo").onclick = () => { undo(); $("input").focus(); };
$("btn-end").onclick = showCsv;
$("btn-clear").onclick = () => {
  if (!state.sets.length || confirm("Discard the open session? Nothing has been written to log.csv.")) {
    state.sets = []; state.sticky = null; $("csvout").hidden = true;
    renderToday(); showFeedback(`<span class="hint">session discarded</span>`);
    saveSession();
  }
};
$("input").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btn-log").click(); });

for (const b of document.querySelectorAll("#volseg button")) {
  b.onclick = () => {
    state.window = +b.dataset.w;
    for (const x of document.querySelectorAll("#volseg button")) x.ariaPressed = String(x === b);
    renderMeters();
  };
}
$("btn-yaml").onclick = exportYaml;
$("btn-reset").onclick = () => {
  if (confirm("Discard your edits and reload routine.yaml as published?")) {
    state.routine = null;
    try { localStorage.removeItem(STORE_ROUTINE); } catch { /* ignore */ }
    $("yamlout").hidden = true;
    renderPlan();
  }
};

// ----------------------------------------------------------------- start
loadRoutine();
loadSession();
selectTab("today");
renderToday();
renderTrends();
renderPlan();
const opener = ANALYTICS.stalls[0];
showFeedback(state.sets.length
  ? `<span class="hint">session restored: ${state.sets.length} sets</span>`
  : `<span class="l1">${routine().week[todayKey()].name}</span>\n` +
    `<span class="l2">${ANALYTICS.sessions.length} sessions logged · last ${ANALYTICS.last_logged}</span>\n` +
    `<span class="hint">tap a lift, or type ${opener ? `"${label(opener.exercise)}"` : "an exercise"} to start</span>`);
