// Prototype of the phone logging loop. The rules live in CLAUDE.md, exercises.yaml and
// config.yaml; data.js is generated from them so this file never restates a threshold.
import { EXERCISES, BANDS, METRICS, PROGRESSION, SEED_LOG } from "./data.js";

const MUSCLES = ["chest","lats","upper_back","front_delts","side_delts","rear_delts",
                 "biceps","triceps","quads","hamstrings","glutes","calves","core"];
const STORE = "strengthlog.session.v1";

// alias -> canonical, longest first so "incline db press" beats "incline"
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
  sets: [],          // {exercise,set_no,weight_kg,reps,rir}
  sticky: null,
  window: 7,
  tab: "session",
};

// ---------------------------------------------------------------- parsing
function resolve(token) {
  const t = token.toLowerCase().trim();
  for (const [alias, name] of ALIASES) if (alias === t) return name;
  return null;
}
function splitExercise(s) {
  for (const [alias, name] of ALIASES) {
    if (s === alias) return { exercise: name, rest: "" };
    if (s.startsWith(alias + " ")) return { exercise: name, rest: s.slice(alias.length).trim() };
  }
  return { exercise: null, rest: s };
}

// Returns {sets:[...]} | {sticky} | {undo} | {end} | {error} | {ask}
function parse(raw) {
  const s = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (!s) return { error: "empty" };
  if (s === "undo") return { undo: true };
  if (s === "/end" || s === "end") return { end: true };

  const swap = s.match(/^swap to (.+)$/);
  if (swap) {
    const name = resolve(swap[1]);
    if (!name) return { error: `unknown exercise: ${swap[1]}` };
    return { sticky: name };
  }

  let { exercise, rest } = splitExercise(s);
  if (exercise && rest === "") return { sticky: exercise };
  if (!exercise) exercise = state.sticky;
  if (!exercise) return { error: `name the exercise first (unknown: ${s.split(" ")[0]})` };

  const ex = EXERCISES[exercise];
  const [floor, ceiling] = ex.rep_range;

  // trailing "@N" - weight when the leading pair is sets x reps, RIR otherwise
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
    else if (at > 4) { count = a; reps = b; weight = at; }            // 3x8 @60 -> sets x reps
    else if (plus || a > 4 || !Number.isInteger(a)) { weight = a; reps = b; rir = at; }
    else return { ask: `${a}x${b} @${at}: ${a} kg at RIR ${at}, or ${a} sets of ${b} at ${at} kg?` };
    if (!Number.isInteger(count) || count < 1) return { error: `${count} is not a set count` };
  } else {
    return { error: `cannot parse "${raw.trim()}"` };
  }

  if (!Number.isInteger(reps) || reps < 1) return { error: `reps ${reps} is not a positive integer` };
  if (weight < 0) return { error: `weight ${weight} is negative` };
  if (weight === 0 && !ex.bodyweight) return { error: `weight 0 but ${exercise} is not bodyweight` };
  if (rir !== null && (!Number.isInteger(rir) || rir < 0 || rir > 4)) return { error: `rir ${rir} is not 0-4` };
  void floor; void ceiling;

  const out = [];
  for (let i = 0; i < count; i++) out.push({ exercise, weight_kg: weight, reps, rir });
  return { sets: out };
}

// ---------------------------------------------------------------- the rule
const roundDown = (kg, inc) => Math.floor((kg + 1e-9) / inc) * inc;

function priorSession(exercise) {
  const dates = [...new Set(SEED_LOG.filter(r => r.exercise === exercise && r.date < state.date)
                                    .map(r => r.date))].sort();
  if (!dates.length) return null;
  const d = dates[dates.length - 1];
  return SEED_LOG.filter(r => r.exercise === exercise && r.date === d).sort((a, b) => a.set_no - b.set_no);
}

// Double progression, exactly as written in CLAUDE.md. Session-level prescription.
function prescribe(exercise) {
  const ex = EXERCISES[exercise];
  const [floor, ceiling] = ex.rep_range;
  const prior = priorSession(exercise);
  if (!prior) return { weight: null, reps: floor, reason: "no baseline" };

  const load = prior[prior.length - 1].weight_kg;
  if (prior.some(s => s.reps < floor && s.rir === 0)) return deload(load, ex, floor);
  if (prior.every(s => s.reps >= ceiling && s.rir !== null && s.rir <= PROGRESSION.rir_ceiling)) {
    return { weight: load + ex.increment, reps: floor, reason: "progress" };
  }
  const best = Math.max(...prior.map(s => s.reps));
  return { weight: load, reps: Math.min(ceiling, best + 1), reason: "hold" };
}
function deload(load, ex, floor) {
  if (load === 0) return { weight: 0, reps: Math.max(1, floor - 2), reason: "deload floor: bodyweight" };
  return { weight: roundDown(load * (1 - PROGRESSION.deload_pct), ex.increment), reps: floor, reason: "deload" };
}

// What to put on line 3 after `justLogged`. Load holds inside a session; a set that
// falls below floor at RIR 0 deloads immediately.
function nextSet(justLogged) {
  const ex = EXERCISES[justLogged.exercise];
  const [floor] = ex.rep_range;
  if (justLogged.reps < floor && justLogged.rir === 0) return deload(justLogged.weight_kg, ex, floor);
  const p = prescribe(justLogged.exercise);
  return { weight: justLogged.weight_kg, reps: p.reps, reason: "hold" };
}

// ---------------------------------------------------------------- feedback contract
// Bodyweight lifts show added load as "+10"; a bare bodyweight set reads "bw x9".
function fmtW(w, exercise) {
  if (w === 0) return "bw";
  const plus = exercise && EXERCISES[exercise] && EXERCISES[exercise].bodyweight ? "+" : "";
  return `${plus}${+w.toFixed(2)}`;
}
const fmtSet = (s) => `${fmtW(s.weight_kg, s.exercise)}${s.weight_kg === 0 ? " " : ""}x${s.reps}` +
                      `${s.rir === null ? "" : ` @${s.rir}`}`;

function baselineLine(s) {
  const prior = priorSession(s.exercise);
  const match = prior && prior.find(p => p.set_no === s.set_no);
  if (!match) return `<span class="l2">last  no baseline</span>`;
  const dw = +(s.weight_kg - match.weight_kg).toFixed(2);
  const dr = s.reps - match.reps;
  const bits = [];
  if (dw !== 0) bits.push(`${dw > 0 ? "+" : ""}${dw} kg`);
  if (dr !== 0) bits.push(`${dr > 0 ? "+" : ""}${dr} rep${Math.abs(dr) === 1 ? "" : "s"}`);
  if (!bits.length) bits.push("same");
  const cls = dw < 0 || (dw === 0 && dr < 0) ? "down" : (dw > 0 || dr > 0) ? "up" : "";
  return `<span class="l2">last ${match.date} s${match.set_no} ${fmtSet(match)}  ` +
         `<span class="${cls}">${bits.join(" ")}</span></span>`;
}

function feedback(s) {
  const n = nextSet(s);
  const load = n.weight === null ? "-" : fmtW(n.weight, s.exercise);
  const tail = n.reason && n.reason !== "hold" ? `  (${n.reason})` : "";
  return [
    `<span class="l1">${s.exercise} s${s.set_no} ${fmtSet(s)}</span>`,
    baselineLine(s),
    `<span class="l3">next ${load} x${n.reps}${tail}</span>`,
  ].join("\n");
}

// ---------------------------------------------------------------- volume
const isHard = (s) => s.rir === null || s.rir <= METRICS.hard_set_rir;

function volume(days) {
  const live = state.sets.map(s => ({ ...s, date: state.date }));
  const all = [...SEED_LOG, ...live];
  if (!all.length) return { counts: null };
  const end = all.map(r => r.date).sort().pop();
  const start = new Date(Date.parse(end) - (days - 1) * 864e5).toISOString().slice(0, 10);
  const win = all.filter(r => r.date >= start && r.date <= end);
  const counts = Object.fromEntries(MUSCLES.map(m => [m, 0]));
  for (const s of win) if (isHard(s)) for (const m of EXERCISES[s.exercise].muscles) counts[m]++;
  return { counts, end, sessions: new Set(win.map(r => r.date)).size, sets: win.length };
}
function flagOf(n, band) {
  if (n < band.min || n > band.max) return "critical";
  if (n < band.target) return "warning";
  return "good";
}
const FLAGTEXT = { good: "GREEN", warning: "AMBER", critical: "RED" };

// ---------------------------------------------------------------- render
const $ = (id) => document.getElementById(id);

function renderFeedback(html) { $("feedback").innerHTML = html; }

function renderSets() {
  const ul = $("setlist");
  if (!state.sets.length) {
    ul.innerHTML = `<li class="empty">no sets yet - type <code>bench 80x8 @2</code></li>`;
  } else {
    ul.innerHTML = state.sets.map((s, i) =>
      `<li><span class="n">${i + 1}</span><span class="ex">${s.exercise}</span>` +
      `<span>s${s.set_no}</span><span>${fmtSet(s)}</span></li>`).reverse().join("");
  }
  const ex = new Set(state.sets.map(s => s.exercise)).size;
  $("hstate").textContent = state.sets.length
    ? `${state.date} · ${state.sets.length} sets · ${ex} lifts`
    : `${state.date} · no open session`;
}

function renderVolume() {
  const { counts, end, sessions, sets } = volume(state.window);
  const scale = state.window / 7;
  $("vsub").textContent = counts
    ? `rolling ${state.window}d to ${end} · ${sessions} sessions · ${sets} working sets`
    : "no data";
  if (!counts) { $("meters").innerHTML = ""; return; }

  $("meters").innerHTML = MUSCLES.map(m => {
    const band = { min: BANDS[m].min * scale, target: BANDS[m].target * scale, max: BANDS[m].max * scale };
    const n = counts[m];
    const f = flagOf(n, band);
    const axis = Math.max(band.max * 1.25, n * 1.08, 1);
    const pct = (v) => `${Math.min(100, (v / axis) * 100)}%`;
    return `<div class="meter">
      <div class="mtop">
        <span class="mname">${m.replace("_", " ")}</span>
        <span class="mval">${n} / ${+band.min.toFixed(0)}-${+band.max.toFixed(0)}</span>
        <span class="mflag ${f}">${FLAGTEXT[f]}</span>
      </div>
      <div class="track" role="img"
           aria-label="${m}: ${n} sets, band ${band.min} to ${band.max}, target ${band.target}, ${FLAGTEXT[f]}">
        <span class="band" style="left:${pct(band.min)};width:${(Math.min(band.max, axis) - band.min) / axis * 100}%"></span>
        <span class="bar ${f}" style="width:${pct(n)}"></span>
        <span class="tick" style="left:${pct(band.target)}"></span>
      </div>
    </div>`;
  }).join("");
}

function renderHistory() {
  const dates = [...new Set(SEED_LOG.map(r => r.date))].sort().reverse();
  $("history").innerHTML = dates.map(d => {
    const rows = SEED_LOG.filter(r => r.date === d);
    const byEx = [...new Set(rows.map(r => r.exercise))];
    const body = byEx.map(e => {
      const ss = rows.filter(r => r.exercise === e).sort((a, b) => a.set_no - b.set_no);
      return `<tr><td class="ex">${e}</td><td class="num">${ss.map(fmtSet).join("  ")}</td></tr>`;
    }).join("");
    return `<div class="session"><h3>${d}</h3>
      <div class="meta">${rows.length} sets · ${byEx.length} lifts · seeded from log.example.csv</div>
      <table>${body}</table></div>`;
  }).join("");
}

function renderAll() { renderSets(); renderVolume(); renderHistory(); save(); }

// ---------------------------------------------------------------- actions
function nextSetNo(exercise) {
  return state.sets.filter(s => s.exercise === exercise).length + 1;
}

function submit(raw) {
  const r = parse(raw);
  if (r.error)  return renderFeedback(`<span class="err">? ${r.error}</span>`);
  if (r.ask)    return renderFeedback(`<span class="err">? ${r.ask}</span>`);
  if (r.undo)   return undo();
  if (r.end)    return showCsv();
  if (r.sticky) {
    state.sticky = r.sticky;
    const p = prescribe(r.sticky);
    const prior = priorSession(r.sticky);
    const load = p.weight === null ? "-" : fmtW(p.weight, r.sticky);
    const last = prior
      ? `last ${prior[0].date} ${prior.length} sets, top ${fmtSet(prior[0])}`
      : "last  no baseline";
    renderFeedback(`<span class="l1">${r.sticky}</span>\n` +
      `<span class="l2">${last}</span>\n` +
      `<span class="l3">next ${load} x${p.reps}${p.reason === "hold" ? "" : `  (${p.reason})`}</span>`);
    return save();
  }
  let last = null;
  for (const s of r.sets) {
    const row = { ...s, set_no: nextSetNo(s.exercise) };
    state.sets.push(row);
    last = row;
  }
  state.sticky = last.exercise;
  renderFeedback(feedback(last));
  renderAll();
}

function undo() {
  const dropped = state.sets.pop();
  renderAll();
  renderFeedback(dropped
    ? `<span class="l1">dropped ${dropped.exercise} s${dropped.set_no} ${fmtSet(dropped)}</span>\n` +
      `<span class="hint">${state.sets.length} sets left</span>`
    : `<span class="err">? nothing to undo</span>`);
}

function showCsv() {
  const out = $("csvout");
  if (!state.sets.length) { out.hidden = true; return renderFeedback(`<span class="err">? no open session</span>`); }
  const rows = state.sets.map(s =>
    `${state.date},strength,${s.exercise},${s.set_no},${+s.weight_kg},${s.reps},${s.rir === null ? "" : s.rir},`);
  out.textContent = "date,type,exercise,set_no,weight_kg,reps,rir,notes\n" + rows.join("\n");
  out.hidden = false;
  const ex = new Set(state.sets.map(s => s.exercise));
  const { counts } = volume(7);
  const top = MUSCLES.filter(m => counts[m] > 0).sort((a, b) => counts[b] - counts[a]).slice(0, 3);
  renderFeedback(
    `<span class="l1">logged: ${state.sets.length} sets, ${ex.size} exercises, ${state.date}</span>\n` +
    `<span class="l2">volume 7d: ${top.map(m => `${m} ${counts[m]}`).join(", ")}</span>\n` +
    `<span class="hint">prototype: paste the rows below into log.csv, then run analyze.py validate</span>`);
}

function save() {
  try { localStorage.setItem(STORE, JSON.stringify({ date: state.date, sets: state.sets, sticky: state.sticky })); }
  catch { /* private mode - the session just lives in memory */ }
}
function load() {
  try {
    const raw = localStorage.getItem(STORE);
    if (!raw) return;
    const d = JSON.parse(raw);
    if (d && d.date === state.date && Array.isArray(d.sets)) { state.sets = d.sets; state.sticky = d.sticky || null; }
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------- wiring
function selectTab(name) {
  state.tab = name;
  for (const t of ["session", "volume", "history"]) {
    $(`tab-${t}`).setAttribute("aria-selected", String(t === name));
    $(`p-${t}`).hidden = t !== name;
  }
  $("composer").style.display = name === "session" ? "flex" : "none";
}
for (const t of ["session", "volume", "history"]) $(`tab-${t}`).onclick = () => selectTab(t);

$("w7").onclick  = () => { state.window = 7;  $("w7").ariaPressed = "true";  $("w14").ariaPressed = "false"; renderVolume(); };
$("w14").onclick = () => { state.window = 14; $("w7").ariaPressed = "false"; $("w14").ariaPressed = "true";  renderVolume(); };

$("btn-log").onclick = () => { const i = $("input"); if (i.value.trim()) { submit(i.value); i.value = ""; } i.focus(); };
$("btn-undo").onclick = () => { undo(); $("input").focus(); };
$("btn-end").onclick = showCsv;
$("btn-clear").onclick = () => {
  if (!state.sets.length || confirm("Discard the open session? Nothing has been written to log.csv.")) {
    state.sets = []; state.sticky = null; $("csvout").hidden = true;
    renderAll(); renderFeedback(`<span class="hint">session discarded</span>`);
  }
};
$("input").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btn-log").click(); });

load();
selectTab("session");
renderAll();
renderFeedback(state.sets.length
  ? `<span class="hint">session restored: ${state.sets.length} sets</span>`
  : `<span class="l1">no open session</span>\n<span class="l2">3 sessions seeded, last 2026-09-04</span>\n` +
    `<span class="hint">bench 80x8 @2 · 80x7 · pullup bw x9 · bench 3x8 @60 · undo · swap to dip</span>`);
