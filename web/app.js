// The rules live in CLAUDE.md, exercises.yaml, routine.yaml and config.yaml. data.js is
// generated from all of them plus analyze.py, so nothing here restates a threshold.
//
// Division of labour: every DEEP number (trend slopes, strength index, the volume-load
// bridge, stalls, balance, adherence) is computed once by analyze.py and shipped in
// ANALYTICS. This file renders those. Only the live session - counting today's volume
// and prescribing the next load for a lift the plan has just added - is computed here,
// against the same rule.
//
// Today logs WEIGHT ONLY, against set slots the Plan tab already fixed the count of -
// there is no exercise name or set-count to type or parse. Every logged row still
// carries reps and rir (the schema and the progression rule need both), but since
// neither is asked for, they are always the prescribed target reps and a blank RIR -
// this session can no longer tell "hit the target" from "missed it," so a deload can
// never be triggered from a Today-logged set. That trade is deliberate, made once here,
// not something to silently work around elsewhere.
import { EXERCISES, BANDS, UNCOVERED, METRICS, PROGRESSION, ROUTINE, ANALYTICS, SEED_LOG,
         BUILD } from "./data.js";

const MUSCLES = ["chest","lats","upper_back","front_delts","side_delts","rear_delts",
                 "biceps","triceps","quads","hamstrings","glutes","calves","core"];
const DAYS = ["mon","tue","wed","thu","fri","sat","sun"];
const STORE_SESSION = "strengthlog.session.v3";
const STORE_ROUTINE = "strengthlog.routine.v2";
const STORE_LOG = "strengthlog.committed.v1";
const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const state = {
  // dayOffset is the day being VIEWED, signed: negative is the past. sessionDate is the
  // day `sets` belongs to. They were one thing when Today could only look forward from
  // an open session; now that you can page back through history they cannot be, or
  // stepping to yesterday would re-date the sets you have open for today.
  dayOffset: 0,
  date: "",          // derived from dayOffset - always set via setDay()
  sets: [],
  sessionDate: null, // the date `sets` belongs to; null when there are none
  committed: [],     // sessions submitted on this device, not yet in an analyze.py run
  sticky: null,
  window: 7,
  logLimit: 8,
  lift: ANALYTICS.stalls[0]?.exercise || ROUTINE.lifts[0],
  routine: null,     // null = use the file
  provisional: {},   // lifts that exist in this browser only - see below
  photos: [],        // machine photos waiting to be identified (this session only)
  proposals: null,   // what Claude read off them, pending your confirmation
  remote: [],        // sessions pulled from the store - see `sync` below
  order: {},         // per-day exercise ORDER, owned by the phone - see below
  setsBy: {},        // per-day, per-lift SET COUNT overrides - same ownership as order
  orderAt: null,     // when this device last changed either of them
  orderDirty: false, // changed but not yet in the store
  dropped: 0,        // set-count edits discarded because a newer plan shipped
  queue: [],         // dates written here but not yet in the store
  sync: "off",       // off | idle | pending | error
  syncCode: null,
};

// --------------------------------------------- provisional exercises
// Two doors lead here: a name typed into the Plan tab that the library does not know,
// and a machine identified from a photo. Both produce a lift that exists in this
// browser and nowhere else.
//
// It is deliberately NOT a library entry. exercises.yaml is edited in the repo, by a
// human, because `increment` and `rep_range` decide every future load this lift will
// ever be prescribed - a guessed increment corrupts them silently and forever. So a
// provisional lift carries those fields as null until someone fills them in, and until
// they are filled in it can be PLANNED but not prescribed for and not logged. Export
// carries it out as an exercises.yaml stub; that paste is what makes it real.
const STORE_PROV = "strengthlog.provisional.v1";

// The library as this browser currently sees it: the shipped file, plus whatever is
// provisional. Everything downstream (the rule, the feedback, volume) reads this, so a
// provisional lift needs no special case anywhere except where readiness is checked.
const LIB = Object.create(null);
function rebuildLib() {
  for (const k of Object.keys(LIB)) delete LIB[k];
  Object.assign(LIB, EXERCISES, state.provisional);
}
rebuildLib();

const isProvisional = (e) => !EXERCISES[e] && !!state.provisional[e];
const provReady = (p) => !!p && typeof p.increment === "number" && p.increment > 0
  && Array.isArray(p.rep_range) && p.rep_range[0] > 0 && p.rep_range[1] >= p.rep_range[0]
  && Array.isArray(p.muscles) && p.muscles.length > 0;
// Ready = the progression rule can actually run on it. A shipped entry always is;
// analyze.py refuses to load exercises.yaml otherwise.
const exReady = (e) => EXERCISES[e] ? true : provReady(state.provisional[e]);

const slug = (s) => String(s).toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

function loadProvisional() {
  try {
    const raw = localStorage.getItem(STORE_PROV);
    if (raw) state.provisional = JSON.parse(raw) || {};
  } catch { state.provisional = {}; }
  rebuildLib();
}
function saveProvisional() {
  rebuildLib();
  try { localStorage.setItem(STORE_PROV, JSON.stringify(state.provisional)); }
  catch (e) { showFeedback(`<span class="err">! could not save: ${e.name}. ` +
    `Photos are the bulk of it - remove a few.</span>`); }
}

// Typed text -> a canonical name, the same way CLAUDE.md resolves a name mid-session:
// canonical, then the display form, then aliases. No fuzzy matching - a near-miss that
// silently picks the wrong lift is worse than being told there is no match.
function resolveExercise(text) {
  const q = String(text).toLowerCase().trim().replace(/\s+/g, " ");
  if (!q) return null;
  const k = slug(q);
  if (LIB[k]) return k;
  for (const [name, ex] of Object.entries(LIB)) {
    if (label(name) === q) return name;
    if ((ex.aliases || []).some(a => String(a).toLowerCase() === q)) return name;
  }
  return null;
}

function createProvisional(display, fields = {}) {
  const key = slug(display);
  if (!key || EXERCISES[key]) return key || null;
  state.provisional[key] = {
    aliases: fields.aliases || [],
    muscles: (fields.muscles || []).filter(m => MUSCLES.includes(m)),
    increment: typeof fields.increment === "number" && fields.increment > 0 ? fields.increment : null,
    rep_range: Array.isArray(fields.rep_range) ? fields.rep_range : null,
    bodyweight: !!fields.bodyweight,
    image: fields.image || null,
    note: fields.note || "",
    source: fields.source || "typed",
  };
  saveProvisional();
  return key;
}

// Local date parts, not toISOString(): that converts to UTC first, so anyone east of
// Greenwich logging before ~02:00 would have their session filed under yesterday.
function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-` +
         `${String(d.getDate()).padStart(2, "0")}`;
}
// Parsed as local date parts, so the weekday cannot shift by a timezone.
const weekdayOf = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return DAYS[(new Date(y, m - 1, d).getDay() + 6) % 7];
};

function setDay(offset) {
  state.dayOffset = offset;
  const d = new Date();
  d.setDate(d.getDate() + offset);
  state.date = isoDate(d);
}
setDay(0);

const routine = () => state.routine || ROUTINE;
// Cheap stable hash (djb2) of the shipped routine, used to tell whether a stored local
// edit was made against the routine.yaml that is currently deployed.
function routineFingerprint(r) {
  const str = JSON.stringify(r);
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return String(h);
}
const todayKey = () => weekdayOf(state.date);
const label = (e) => e.replace(/_/g, " ");

// --------------------------------------------------- the progression rule
const roundDown = (kg, inc) => Math.floor((kg + 1e-9) / inc) * inc;

// Everything the browser knows happened: what analyze.py had at build time, what the
// store holds, and what this device logged and may not have flushed yet.
const history = () => [...SEED_LOG, ...remoteRows(), ...state.committed];

function priorSession(exercise) {
  const all = history().filter(r => r.exercise === exercise && r.date < state.date);
  const dates = [...new Set(all.map(r => r.date))].sort();
  if (!dates.length) return null;
  const d = dates[dates.length - 1];
  return all.filter(r => r.date === d).sort((a, b) => a.set_no - b.set_no);
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
  const ex = LIB[exercise];
  // No increment and no rep range means there IS no progression rule for this lift yet.
  // Returning a plausible-looking number here is the one thing the rule must never do.
  if (!ex || !exReady(exercise))
    return { weight_kg: null, target_reps: null, reason: "needs setup", basis_date: null };
  const [floor, ceiling] = ex.rep_range;
  const prior = priorSession(exercise);
  if (!prior) return { weight_kg: null, target_reps: floor, reason: "no baseline", basis_date: null };
  const basis_date = prior[0].date;
  const load = prior[prior.length - 1].weight_kg;
  if (prior.some(s => s.reps < floor && s.rir === 0))
    return { ...deload(load, ex, floor), basis_date };
  if (prior.every(s => s.reps >= ceiling && s.rir !== null && s.rir <= PROGRESSION.rir_ceiling))
    return { weight_kg: load + ex.increment, target_reps: floor, reason: "progress", basis_date };
  return { weight_kg: load, target_reps: Math.min(ceiling, Math.max(...prior.map(s => s.reps)) + 1),
           reason: "hold", basis_date };
}
// analyze.py is the authority, but it only knows what was in log.csv when it last ran.
// Once a session submitted on this device is both usable as a baseline (before today)
// and newer than the one Python computed from, its own basis is stale - fall back to
// prescribeJS, which applies the same rule to the newer input. Without this the row
// would show "last week 100" next to a prescription of 45 from a superseded session.
//
// Note such a session can never produce "progress": Today logs a blank RIR, and the
// rule does not treat unverified as proven. It holds at the last logged load, which is
// the correct answer given what was actually recorded.
const prescribe = (e) => {
  const py = ANALYTICS.prescriptions[e];
  if (!py) return prescribeJS(e);
  const superseded = state.committed.some(r =>
    r.exercise === e && r.date < state.date && (!py.basis_date || r.date > py.basis_date));
  return superseded ? prescribeJS(e) : py;
};

// The weight just logged, paired with the target reps for another set of it today.
// No deload branch here: that needs an actual rep/RIR miss, and Today only logs
// weight - every row's reps is already the prescribed target, never a real shortfall.
function nextSet(just) {
  return { weight_kg: just.weight_kg, target_reps: prescribe(just.exercise).target_reps,
           reason: "hold" };
}

// ------------------------------------------------------ feedback contract
function fmtW(w, exercise) {
  if (w === null || w === undefined) return "-";
  if (w === 0) return "bw";
  const plus = exercise && LIB[exercise]?.bodyweight ? "+" : "";
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
// Weight-only logging. Each exercise gets exactly `p.sets` input boxes - the count the
// Plan tab set, and nothing in Today can change it. A slot's position IS its set_no;
// clearing one un-logs that set without renumbering its neighbours.
//
// Everything already logged on the day being viewed, from wherever it is held.
const loggedOn = (date) => history().filter(r => r.date === date);

// A day that already has logged sets is HISTORY: it is shown, not typed into. Editing a
// past session is a correction, and corrections are stated out loud one row at a time
// (CLAUDE.md), never made by quietly overtyping a box. A day with nothing logged is
// still open - which is what makes it possible to enter a session you forgot - unless an
// unsubmitted session for a different day is open, in which case that one has to be
// resolved first rather than silently mixed into this date.
const dayIsHistory = () => loggedOn(state.date).length > 0;
const dayEditable = () =>
  !dayIsHistory() && (state.sessionDate === null || state.sessionDate === state.date);

// The rows to show for one lift on the viewed day: the open session's, or history's.
const setsShown = (exercise) => dayIsHistory()
  ? loggedOn(state.date).filter(r => r.exercise === exercise)
      .sort((a, b) => a.set_no - b.set_no)
  : (state.sessionDate === state.date
      ? state.sets.filter(s => s.exercise === exercise) : []);

function loggedFor(exercise) {
  return setsShown(exercise).length;
}

// The Math.max is a data guard, not a feature: it only fires if the day holds more
// logged sets than the plan now allows (the plan was cut after they were logged), and
// exists so logged data is never hidden. Nothing here can create that state.
function slotCount(p) {
  return Math.max(p.sets, loggedFor(p.exercise));
}

// The viewed day's rows: its weekday's plan, plus anything actually logged that day that
// the plan no longer contains - otherwise a lift dropped from the routine since would
// take its logged sets out of view with it.
function viewPlan() {
  const base = effectivePlan(todayKey());
  const logged = loggedOn(state.date);
  if (!logged.length) return base;
  const have = new Set(base.map(p => p.exercise));
  const extra = [...new Set(logged.map(r => r.exercise))]
    .filter(e => !have.has(e)).sort()
    .map(e => ({ exercise: e, sets: logged.filter(r => r.exercise === e).length,
                 offplan: true }));
  return [...base, ...extra];
}

function renderToday() {
  const day = todayKey();
  const entry = routine().week[day];
  const plan = viewPlan();
  const history_ = dayIsHistory();
  const editable = dayEditable();
  const [yy, mm, dd] = state.date.split("-").map(Number);
  const dayText = new Date(yy, mm - 1, dd)
    .toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });

  // Step a day at a time in either direction. Submitting still moves the plan on without
  // the calendar moving, so an offset is stated plainly with a way back to today.
  const off = state.dayOffset;
  $("today-day").innerHTML =
    `<button class="dnav" id="btn-prevday" aria-label="previous day">&lsaquo;</button>` +
    `<span class="dlabel">${dayText}</span>` +
    `<button class="dnav" id="btn-nextday" aria-label="next day">&rsaquo;</button>` +
    (off === 0 ? "" :
      ` <span class="ahead">${off > 0 ? `+${off}d ahead` : `${-off}d back`}</span> ` +
      `<button class="backtoday" id="btn-backtoday">today</button>`) +
    (history_ ? ` <span class="ahead">logged</span>` : "");
  const step = (n) => { setDay(state.dayOffset + n); saveSession(); renderToday(); };
  $("btn-prevday").onclick = () => step(-1);
  $("btn-nextday").onclick = () => step(1);
  if (off !== 0)
    $("btn-backtoday").onclick = () => { setDay(0); saveSession(); renderToday(); };
  $("today-name").textContent = entry.name;

  const planned = plan.reduce((a, p) => a + p.sets, 0);
  const onDay = plan.reduce((a, p) => a + loggedFor(p.exercise), 0);
  const done = plan.reduce((a, p) => a + Math.min(p.sets, loggedFor(p.exercise)), 0);
  const extra = onDay - done;
  $("today-progress").innerHTML =
    `<b>${onDay}<span style="color:var(--muted)">/${planned}</span></b>sets logged` +
    (extra > 0 ? `<br><span style="color:var(--warn)">${extra} off plan</span>` : "");

  $("today-plan").innerHTML = plan.map(p => {
    const rx = prescribe(p.exercise);
    const n = loggedFor(p.exercise);
    const cls = ["", n >= p.sets ? "done" : "", state.sticky === p.exercise ? "active" : ""].join(" ");
    const img = LIB[p.exercise]?.image;
    const thumb = img
      ? `<button class="thumb" data-img="${img}" aria-label="Show ${label(p.exercise)} photo">
           <img src="${img}" alt="" loading="lazy"></button>`
      : "";
    const placeholder = fmtW(rx.weight_kg, p.exercise);

    // Headline reads "weight x sets": the weight follows what you are ACTUALLY lifting
    // today once anything is logged - the heaviest set entered - and falls back to the
    // prescription before that. The number beside it is the PLANNED set count, matching
    // the boxes below and the Plan tab; it is not the rep target, which sits in the
    // muted line under it since reps are never entered here anyway.
    const onThis = setsShown(p.exercise);
    const top = onThis.length ? Math.max(...onThis.map(s => s.weight_kg)) : null;
    const headline = top === null ? placeholder : fmtW(top, p.exercise);

    // Last session's weight per set, greyed under each box - the number to beat.
    const prior = priorSession(p.exercise);
    const ready = exReady(p.exercise);
    const slots = Array.from({ length: slotCount(p) }, (_, i) => {
      const setNo = i + 1;
      const logged = onThis.find(s => s.set_no === setNo);
      const prev = prior && prior.find(s => s.set_no === setNo);
      return `<div class="slot ${logged ? "filled" : ""}">
        <span class="slotn">${setNo}</span>
        <input type="text" inputmode="decimal" class="slotw" data-ex="${p.exercise}" data-set="${setNo}"
               placeholder="${editable ? placeholder : "&ndash;"}" value="${logged ? +logged.weight_kg : ""}"
               ${ready && editable ? "" : "disabled"}
               aria-label="${label(p.exercise)} set ${setNo} weight">
        <span class="slotprev">${prev ? fmtW(prev.weight_kg, p.exercise) : "&ndash;"}</span>
      </div>`;
    }).join("");
    // Changing the count here changes the PLAN, through the very same setOverride() the
    // Plan tab's stepper calls - so it shows up there, syncs, and survives a publish.
    // An earlier version of this control kept a session-local count instead, which is
    // exactly how Today and Plan came to disagree about how many sets a lift had.
    // Built as a .slot so it shares the boxes' three-row column and lines up with the
    // inputs however the row wraps, rather than being positioned against them by hand.
    const step = (editable && !p.offplan)
      ? `<div class="slot setstep">
           <span class="slotn">&nbsp;</span>
           <span class="stepbtns">
             <button class="addslot" data-role="less" aria-label="one fewer set of ${label(p.exercise)}">&minus;</button>
             <button class="addslot" data-role="more" aria-label="one more set of ${label(p.exercise)}">+</button>
           </span>
         </div>`
      : "";
    // "last week" is the honest label for a lift trained once a week, which is most of
    // them on a 7-day rotation - but a lift scheduled twice a week was last done 3 or 4
    // days ago, and calling that "last week" would be wrong. Say the actual gap instead.
    const daysBack = prior
      ? Math.round((Date.parse(state.date) - Date.parse(prior[0].date)) / 864e5)
      : null;
    const prevLabel = daysBack === null ? "last"
      : daysBack >= 6 && daysBack <= 8 ? "last week" : `${daysBack}d ago`;
    const legend = `<div class="slot slotlab" aria-hidden="true"
        title="${prior ? "last session " + prior[0].date : "no previous session"}">
      <span class="slotn">set</span><span class="labgap"></span>
      <span class="slotprev">${prevLabel}</span></div>`;
    return `<li class="${cls}" data-ex="${p.exercise}">
      <div class="rowtop">
        <span class="nmwrap" data-role="preview">${thumb}<span class="nm">${label(p.exercise)}</span></span>
        <span class="rx ${top === null ? "" : "live"}">${headline} &times; ${p.sets}</span>
      </div>
      <span class="why ${history_ ? "" : rx.reason === "needs setup" ? "needsetup" : rx.reason}">${
        history_
          ? (onThis.length
              ? `logged ${onThis.length} set${onThis.length === 1 ? "" : "s"} ` +
                `&middot; ${onThis[0].reps} reps`
              : "not logged this day")
          : rx.reason === "needs setup"
            ? "no increment or rep range yet &middot; set it in Plan"
            : `${rx.reason}${rx.basis_date ? " since " + rx.basis_date : ""}` +
              ` &middot; ${rx.target_reps} reps`}</span>
      <div class="slots">${legend}${slots}${step}</div></li>`;
  }).join("");

  // Submit and Discard act on the OPEN session. On a day that is already history there
  // is none, and leaving them live would answer "Submit" on a day showing ten logged
  // sets with "nothing logged".
  $("btn-submit").disabled = history_;
  $("btn-clear").disabled = history_;

  for (const li of $("today-plan").querySelectorAll("li")) {
    const ex = li.dataset.ex;
    li.querySelector('[data-role="preview"]').onclick = (e) => {
      if (e.target.closest(".thumb")) return;
      state.sticky = ex; showPrescription(ex);
      for (const other of $("today-plan").querySelectorAll("li")) other.classList.remove("active");
      li.classList.add("active");
    };
    const t = li.querySelector(".thumb");
    if (t) {
      t.onclick = (e) => { e.stopPropagation(); openLightbox(t.dataset.img); };
      t.onkeydown = (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); openLightbox(t.dataset.img); }
      };
    }
    const bump = (n) => {
      const cur = effectivePlan(day).find(x => x.exercise === ex)?.sets ?? 1;
      // Never below what is already logged on this day: the plan may shrink, but not so
      // far that it would hide a set that happened.
      const floor = Math.max(1, loggedFor(ex));
      const next = clamp(cur + n, floor, 8);
      if (next === cur) return;
      setOverride(day, ex, next);
      renderPlan();          // which re-renders Today too, from the same effectivePlan
    };
    li.querySelector('[data-role="less"]')?.addEventListener("click", () => bump(-1));
    li.querySelector('[data-role="more"]')?.addEventListener("click", () => bump(1));

    for (const input of li.querySelectorAll(".slotw")) {
      // No focus-preview here: the row's "rx" text already shows the prescribed
      // weight/reps at a glance, and firing showPrescription() on focus would
      // overwrite the commit feedback the moment focus moves to the next slot.
      input.onblur = () => commitSlot(ex, +input.dataset.set, input.value);
      input.onkeydown = (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        // blur() commits synchronously, which re-renders the whole row and detaches
        // every node in it - a reference grabbed before blur() is already stale by the
        // time it returns, so the next input has to be looked up fresh afterwards.
        const nextSet = +input.dataset.set + 1;
        input.blur();
        document.querySelector(`.slotw[data-ex="${ex}"][data-set="${nextSet}"]`)?.focus();
      };
    }
  }
  renderSyncState();
}

// A slot's position IS its set_no - clearing it removes that logged row without
// shifting any other slot. Reps and RIR are never asked for: reps is always the
// current prescribed target, RIR is always blank. See the file header for why.
function commitSlot(exercise, setNo, raw) {
  const trimmed = raw.trim();
  const existing = state.sets.findIndex(s => s.exercise === exercise && s.set_no === setNo);

  if (trimmed === "") {
    if (existing === -1) return;
    const [dropped] = state.sets.splice(existing, 1);
    if (!state.sets.length) state.sessionDate = null;
    saveSession(); renderToday();
    return showFeedback(`<span class="l1">cleared ${label(exercise)} s${setNo}</span>\n` +
      `<span class="hint">was ${fmtSet(dropped)}</span>`);
  }

  if (dayIsHistory()) {
    renderToday();
    return showFeedback(
      `<span class="err">? ${state.date} is already logged</span>\n` +
      `<span class="hint">a logged day is history here. Correct it by saying so, one row ` +
      `at a time - or remove the session in Trends and log it again.</span>`);
  }
  if (state.sets.length && state.sessionDate !== state.date) {
    renderToday();
    return showFeedback(
      `<span class="err">? an unsubmitted session for ${state.sessionDate} is open</span>\n` +
      `<span class="hint">Submit or Discard it before logging ${state.date}, so sets ` +
      `cannot land on the wrong date.</span>`);
  }
  const ex = LIB[exercise];
  if (!ex || !exReady(exercise)) {
    renderToday();
    return showFeedback(
      `<span class="err">? ${label(exercise)} has no increment or rep range yet</span>\n` +
      `<span class="hint">set them in Plan. Every row needs a rep target, and the rule ` +
      `will not invent one.</span>`);
  }
  const weight = parseFloat(trimmed.replace(",", "."));
  if (!Number.isFinite(weight) || weight < 0) {
    renderToday();
    return showFeedback(`<span class="err">? "${raw}" is not a valid weight</span>`);
  }
  if (weight === 0 && !ex.bodyweight) {
    renderToday();
    return showFeedback(`<span class="err">? weight 0 but ${label(exercise)} is not bodyweight</span>`);
  }

  const row = { exercise, set_no: setNo, weight_kg: weight,
                reps: prescribe(exercise).target_reps, rir: null };
  if (existing === -1) state.sets.push(row); else state.sets[existing] = row;
  state.sessionDate = state.date;
  state.sticky = exercise;
  showFeedback(feedback(row));
  renderToday();
  saveSession();
}

function openLightbox(src) {
  $("lightbox-img").src = src;
  $("lightbox").hidden = false;
}
function closeLightbox() { $("lightbox").hidden = true; $("lightbox-img").src = ""; }
$("lightbox").onclick = closeLightbox;
$("lightbox-close").onclick = (e) => { e.stopPropagation(); closeLightbox(); };
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeLightbox(); });

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
  const live = state.sets.map(s => ({ ...s, date: state.sessionDate || state.date }));
  const all = [...history(), ...live];
  // Nothing logged anywhere yet is a normal day-one state, not an error: anchor the
  // window on today so the bands render at zero rather than throwing on an undefined end.
  const end = all.map(r => r.date).sort().pop() || state.date;
  const startMs = Date.parse(end) - (days - 1) * 864e5;
  const start = isoDate(new Date(startMs));
  const win = all.filter(r => r.date >= start && r.date <= end);
  const counts = Object.fromEntries(MUSCLES.map(m => [m, 0]));
  for (const s of win)
    if (s.rir === null || s.rir === undefined || s.rir <= METRICS.hard_set_rir)
      for (const m of (LIB[s.exercise]?.muscles || [])) counts[m]++;
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
      <div class="v">${ad.empty || ad.rate === null ? "-" : Math.round(ad.rate * 100) + "%"}</div>
      <div class="d">${ad.empty ? "nothing logged yet"
        : `${ad.logged_sets}/${ad.planned_sets} sets · ${ad.trained_days}/${ad.planned_days}d`}</div></div>
    <div class="kpi"><div class="k">Load 7d</div>
      <div class="v">${br.empty ? "-" : (br.vl_current / 1000).toFixed(1) + "t"}</div>
      <div class="d ${br.empty ? "" : br.delta >= 0 ? "up" : "down"}">${br.empty ? "nothing logged yet"
        : `${br.delta >= 0 ? "+" : ""}${(br.delta / 1000).toFixed(1)}t vs prior`}</div></div>`;
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
    ANALYTICS.sessions.length
      ? `best set per session · ${ANALYTICS.index.baseline_weeks}w baseline · to ${ANALYTICS.last_logged}`
      : "no sessions logged yet";
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
  if (b.empty) {
    $("bridge").innerHTML = `<p class="empty">Needs two weeks of logged sets to decompose.
      Nothing in <code>log.csv</code> yet.</p>`;
    return;
  }
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
    : ANALYTICS.sessions.length
      ? `<p class="empty">Nothing stalled. A flat e1RM between load increments is what
         double progression looks like when it is working - only a lift that has stopped
         climbing and is not trending up gets flagged.</p>`
      : `<p class="empty">Nothing logged yet. A stall needs weeks of a lift before it
         means anything.</p>`;
}

function renderBalance() {
  const b = ANALYTICS.balance;
  if (b.empty) {
    $("balance").innerHTML = `<p class="empty">No sets logged yet - no ratios to take.</p>`;
    return;
  }
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
  $("index-meta").textContent = ix.period_end
    ? `each lift vs its own first ${ix.baseline_weeks}w = 100 · ${ix.period_days}d to ${ix.period_end}`
    : `each lift vs its own first ${ix.baseline_weeks}w = 100`;
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
  if (!entries.length)
    $("indexrows").innerHTML = `<p class="empty">Nothing indexed yet - a lift needs
      ${ix.baseline_weeks} weeks of its own history before 100 means anything.</p>`;
  $("index-note").innerHTML = ix.unindexed.length
    ? `Not indexed: ${ix.unindexed.map(u => `<b>${label(u.exercise)}</b> - ${u.reason}`).join("; ")}.`
    : entries.length ? "Every lift has a baseline." : "";
}

// Everything below the fold on Trends comes from analyze.py at build time. Sessions
// submitted on this device are NOT in it, and saying so beats quietly showing numbers
// that are a week stale.
function renderLocalNote() {
  const el = $("localnote");
  const days = [...new Set([...remoteRows(), ...state.committed].map(r => r.date))];
  if (!days.length) { el.hidden = true; return; }
  el.hidden = false;
  const pending = state.queue.length;
  el.innerHTML =
    `<b>${days.length} session${days.length === 1 ? "" : "s"} logged since the last ` +
    `analyze.py run</b> (${days.sort().join(", ")})` +
    (pending ? `, ${pending} not yet synced` : "") +
    `. Counted in the volume bands below and in each lift's "last week" reference - but ` +
    `not in the strength index, per-lift trends, bridge, stalls or adherence. Those are ` +
    `computed by <code>analyze.py</code> from <code>log.csv</code>.`;
}

// --------------------------------------------------------- session log
// Every session on record - the seeded history plus anything submitted on this device -
// newest first, each lift shown against its OWN previous session. That comparison is
// per-exercise, not per-week: a lift trained twice a week is measured against 3 days
// ago, not against a calendar week that never happened.
function buildSessionLog() {
  const rows = history();
  const perEx = new Map();     // exercise -> date -> sets
  const perDate = new Map();   // date -> exercise -> sets
  for (const r of rows) {
    if (!perEx.has(r.exercise)) perEx.set(r.exercise, new Map());
    const em = perEx.get(r.exercise);
    if (!em.has(r.date)) em.set(r.date, []);
    em.get(r.date).push(r);

    if (!perDate.has(r.date)) perDate.set(r.date, new Map());
    const dm = perDate.get(r.date);
    if (!dm.has(r.exercise)) dm.set(r.exercise, []);
    dm.get(r.exercise).push(r);
  }
  // Removable = not yet in log.csv. The immutability rule protects the logged history
  // analyze.py was built from, not a session that is merely stored - and after a cache
  // clear a synced session lives only in `remote`, so keying this on `committed` would
  // silently make it permanent on one device and editable on another.
  const seeded = new Set(SEED_LOG.map(r => r.date));

  return [...perDate.keys()].sort().reverse().map(date => {
    const exercises = [...perDate.get(date)].map(([ex, sets]) => {
      sets = [...sets].sort((a, b) => a.set_no - b.set_no);
      // A session carrying no load is measured in reps, not kilos - a 0 kg "top weight"
      // is not a number, and differencing two of them fakes a flat trend. If the previous
      // session carried load and this one does not (or the reverse), the two are not the
      // same measurement and there is no delta to state.
      const bw = sets.every(s => s.weight_kg === 0);
      const topOf = (arr, asReps) => asReps
        ? Math.max(...arr.map(s => s.reps)) : Math.max(...arr.map(s => s.weight_kg));
      const top = topOf(sets, bw);
      const priorDates = [...perEx.get(ex).keys()].filter(d => d < date).sort();
      const prevDate = priorDates[priorDates.length - 1] || null;
      const prevSets = prevDate ? perEx.get(ex).get(prevDate) : null;
      const prevBw = prevSets ? prevSets.every(s => s.weight_kg === 0) : null;
      const prevTop = prevSets ? topOf(prevSets, prevBw) : null;
      const gap = prevDate
        ? Math.round((Date.parse(date) - Date.parse(prevDate)) / 864e5) : null;
      const comparable = prevSets !== null && prevBw === bw;
      return { ex, sets, bw, top, prevDate, prevSets, prevBw, prevTop, gap, comparable,
               delta: comparable ? +(top - prevTop).toFixed(2) : null };
    }).sort((a, b) => a.ex.localeCompare(b.ex));
    const setCount = exercises.reduce((a, e) => a + e.sets.length, 0);
    return { date, exercises, setCount, submitted: !seeded.has(date) };
  });
}

function renderSessionLog() {
  const log = buildSessionLog();
  const shown = log.slice(0, state.logLimit);
  const pend = log.filter(sn => sn.submitted).length;
  $("log-meta").textContent = log.length
    ? `${log.length} session${log.length === 1 ? "" : "s"}` +
      (pend ? ` · ${pend} not yet in log.csv` : "")
    : "nothing logged yet";
  $("btn-more").hidden = shown.length >= log.length;
  $("btn-more").textContent = `Show more (${log.length - shown.length} older)`;

  $("sessionlog").innerHTML = shown.map(sn => {
    const lifts = sn.exercises.map(e => {
      const cell = (s) => e.bw ? `bw×${s.reps}` : fmtW(s.weight_kg, e.ex);
      const weights = e.sets.map(cell).join(" · ");
      const prevTxt = e.prevBw ? `${e.prevTop} reps` : fmtW(e.prevTop, e.ex);
      const prev = e.prevDate === null
        ? `<span class="slogprev">first time</span>`
        : `<span class="slogprev">prev ${prevTxt}` +
          `${e.gap ? ` · ${e.gap}d` : ""}</span>`;
      const d = e.delta;
      const dcls = d === null || d === 0 ? "" : d > 0 ? "up" : "down";
      const dtxt = d === null ? "" : d === 0 ? "=" :
        `${d > 0 ? "+" : ""}${d}${e.bw ? "r" : ""}`;
      return `<div class="slogrow">
        <span class="slogex">${label(e.ex)}</span>
        <span class="slogw">${weights}</span>
        ${prev}
        <span class="slogd ${dcls}">${dtxt}</span></div>`;
    }).join("");
    return `<div class="slog">
      <div class="sloghead">
        <span class="slogdate">${sn.date}</span>
        <span class="slogday">${weekdayOf(sn.date)}</span>
        <span class="slogsets">${sn.setCount} sets</span>
        ${sn.submitted ? `<span class="slogbadge">submitted</span>
          <button class="slogdel" data-date="${sn.date}" aria-label="Remove ${sn.date}">remove</button>` : ""}
      </div>${lifts}</div>`;
  }).join("");

  if (!log.length)
    $("sessionlog").innerHTML = `<p class="empty">No sessions yet. Log one on Today and
      press Submit - it appears here, and becomes the reference the next one is read against.</p>`;

  for (const btn of $("sessionlog").querySelectorAll(".slogdel")) {
    btn.onclick = () => {
      const d = btn.dataset.date;
      if (!confirm(`Remove the session submitted on ${d}? It has not reached log.csv yet.`)) return;
      state.committed = state.committed.filter(r => r.date !== d);
      state.remote = state.remote.filter(r => r.date !== d);
      saveCommitted();
      queueDate(d);      // now empty locally, so the flush deletes the document
      flushQueue();
      renderToday(); renderTrends();
    };
  }
}

function renderTrends() {
  renderLocalNote();
  renderKpis(); renderLiftGrid(); renderDetail(); renderMeters();
  renderBridge(); renderStalls(); renderBalance(); renderIndex();
  renderSessionLog();
}

// -------------------------------------------------------------- PLAN view
function loadRoutine() {
  try {
    const raw = localStorage.getItem(STORE_ROUTINE);
    if (!raw) return;
    const d = JSON.parse(raw);
    // A local edit is only valid against the routine.yaml it was made from. If a new
    // one has shipped since, the stored copy is dropped and the file wins - otherwise
    // any device that ever opened the Plan tab would be pinned to that old snapshot
    // forever and would silently never see a deployed routine change again.
    if (!d || !d.routine) return;
    if (d.base === routineFingerprint(ROUTINE)) { state.routine = d.routine; return; }
    // A newer routine.yaml has shipped. The stored structural edits were made against a
    // plan that no longer exists, so they cannot be carried over - but saying nothing is
    // how a set-count change disappears without anyone noticing. Count it and show it.
    state.dropped = DAYS.reduce((n, k) =>
      n + (d.routine.week?.[k]?.plan?.length || 0), 0);
    try { localStorage.removeItem(STORE_ROUTINE); } catch { /* ignore */ }
  } catch { /* ignore */ }
}
// ------------------------------------------------- the order of a day's lifts
// Reordering is COSMETIC: it moves nothing between muscles, so it changes no volume and
// therefore no band. That makes it the one plan edit the phone can own outright - it
// never has to reach routine.yaml, and unlike a set-count change it is not invalidated
// when a new routine.yaml ships.
//
// It is stored as a list of exercise NAMES per day, not as positions, so it survives a
// deploy: a lift the file dropped simply falls out of the list, and one the file added
// lands at the end rather than silently displacing something.
const STORE_ORDER = "strengthlog.order.v1";
const STORE_SETS = "strengthlog.sets.v1";

// THE day's plan, and the only place it is assembled: the published routine.yaml (or a
// structural edit of it), with this device's set-count overrides applied, in this
// device's order. Today, the Plan tab and the export all read this, so they cannot
// disagree with each other.
function effectivePlan(dayKey) {
  const base = routine().week[dayKey].plan;
  const ov = state.setsBy[dayKey] || {};
  const withSets = base.map(p =>
    ov[p.exercise] ? { ...p, sets: clamp(ov[p.exercise], 1, 8) } : p);
  return orderedPlan(dayKey, withSets);
}

// Set counts are stored BY EXERCISE NAME, exactly like the order and for exactly the
// same reason: a snapshot of the whole routine is invalidated the moment a new
// routine.yaml ships, which is how every set count typed on the phone was being wiped by
// the next publish. An override by name survives it - and an override that matches the
// file is not an override at all, so it is dropped rather than left to shadow a later
// change silently.
function setOverride(dayKey, exercise, n) {
  const fileSets = ROUTINE.week[dayKey]?.plan.find(p => p.exercise === exercise)?.sets;
  const day = state.setsBy[dayKey] || (state.setsBy[dayKey] = {});
  if (n === fileSets) delete day[exercise]; else day[exercise] = n;
  if (!Object.keys(day).length) delete state.setsBy[dayKey];
  savePrefs();
}

function orderedPlan(dayKey, plan) {
  const want = state.order[dayKey];
  if (!Array.isArray(want) || !want.length) return plan;
  const rank = new Map(want.map((e, i) => [e, i]));
  // Stable: anything the stored order has never seen keeps its file position, after
  // everything it does know about.
  return [...plan].sort((a, b) =>
    (rank.has(a.exercise) ? rank.get(a.exercise) : want.length + plan.indexOf(a)) -
    (rank.has(b.exercise) ? rank.get(b.exercise) : want.length + plan.indexOf(b)));
}

function savePrefs() {
  state.orderAt = new Date().toISOString();
  state.orderDirty = true;
  try {
    localStorage.setItem(STORE_ORDER, JSON.stringify(
      { days: state.order, updated_at: state.orderAt }));
    localStorage.setItem(STORE_SETS, JSON.stringify(
      { days: state.setsBy, updated_at: state.orderAt }));
  } catch { /* private mode */ }
  flushQueue();
}
const saveOrder = savePrefs;   // reordering and set counts share one prefs write
function loadOrder() {
  try {
    const d = JSON.parse(localStorage.getItem(STORE_ORDER) || "null");
    if (d && d.days) { state.order = d.days; state.orderAt = d.updated_at || null; }
    const t = JSON.parse(localStorage.getItem(STORE_SETS) || "null");
    if (t && t.days) {
      state.setsBy = t.days;
      if (!state.orderAt || (t.updated_at && t.updated_at > state.orderAt))
        state.orderAt = t.updated_at;
    }
  } catch { /* ignore */ }
}

function saveRoutine() {
  try {
    localStorage.setItem(STORE_ROUTINE, JSON.stringify(
      { base: routineFingerprint(ROUTINE), routine: state.routine }));
  } catch { /* private mode */ }
}
function ensureEditable() {
  if (!state.routine) state.routine = JSON.parse(JSON.stringify(ROUTINE));
}

// A provisional lift's missing half. Shown open while the lift is unusable, so the
// blocker is the first thing on screen rather than something to go hunting for.
function defPanel(key, open) {
  const p = state.provisional[key];
  const [floor, ceiling] = p.rep_range || [null, null];
  return `<div class="exdef" data-role="def" data-key="${key}" ${open ? "" : "hidden"}>
    ${p.image ? `<button class="thumb defthumb" data-role="preview" data-img="${p.image}"
        aria-label="Show photo"><img src="${p.image}" alt=""></button>` : ""}
    <div class="deflab">prime movers only</div>
    <div class="defmus">${MUSCLES.map(m =>
      `<button class="mchip ${p.muscles.includes(m) ? "on" : ""}" data-m="${m}">${m}</button>`
    ).join("")}</div>
    <div class="defnums">
      <label>increment kg
        <input type="number" step="0.5" min="0" data-f="inc" value="${p.increment ?? ""}" placeholder="?">
      </label>
      <label>reps
        <input type="number" min="1" data-f="floor" value="${floor ?? ""}" placeholder="floor">
        <span>&ndash;</span>
        <input type="number" min="1" data-f="ceiling" value="${ceiling ?? ""}" placeholder="ceil">
      </label>
      <label class="defbw">
        <input type="checkbox" data-f="bw" ${p.bodyweight ? "checked" : ""}> bodyweight
      </label>
    </div>
    <p class="defnote">${p.note ? `<b>${p.note}</b><br>` : ""}Read the increment off the
      stack. A guess corrupts every future prescription for this lift, silently.</p>
  </div>`;
}

function renderPlan() {
  // Today's rows (prescribed loads, set counts) are derived from this same routine
  // state - every routine edit has to refresh both, or Today goes stale the moment
  // you swap a lift, change its sets, or reorder, without needing a tab switch to
  // paper over it.
  renderToday();
  const r = routine();
  const planned = DAYS.reduce((a, d) => a + effectivePlan(d).reduce((x, p) => x + p.sets, 0), 0);
  $("plan-title").textContent = `${planned} sets / week`;
  // Two different kinds of edit, and conflating them is what loses work. Order is
  // stored and needs nothing further. Set counts and lift changes move a muscle's
  // weekly volume, and the bands in config.yaml are DERIVED from that - so until they
  // reach routine.yaml the bands are measuring against a plan that is not the one on
  // screen. Say which is which, and how many.
  const structural = countStructuralEdits();
  $("plan-summary").innerHTML =
    `<b>${scheduledLifts().length}</b>lifts · ${DAYS.length} days` +
    (structural ? `<br><span style="color:var(--warn)">${structural} change${
      structural === 1 ? "" : "s"} not exported</span>` : "");
  renderPlanNote(structural);
  // Shown so a stale page on a phone can be identified rather than argued about.
  // Optional-by-construction: writing to a missing node here would throw and abandon
  // the rest of renderPlan, taking #planweek - the actual plan - with it.
  const buildEl = $("build");
  if (buildEl) buildEl.textContent = `build ${BUILD}`;

  const echo = $("plan-echo");
  if (echo) echo.innerHTML = "";
  $("exlist").innerHTML = Object.keys(LIB).sort()
    .map(e => `<option value="${label(e)}">`).join("");

  $("planweek").innerHTML = DAYS.map(d => {
    const day = r.week[d];
    const shown = effectivePlan(d);
    const n = shown.reduce((a, p) => a + p.sets, 0);
    // Rows are addressed by EXERCISE NAME, not by position: the displayed plan carries
    // overridden copies and is reordered, so an index into it no longer points at the
    // entry the handler has to change.
    const rows = shown.map((p) => {
      const prov = isProvisional(p.exercise), bad = !exReady(p.exercise);
      return `
      <div class="dayrow ${bad ? "unset" : ""}" data-day="${d}" data-ex="${p.exercise}">
        <button class="handle" data-role="handle" aria-label="drag to reorder">&#8942;&#8942;</button>
        <input class="exin" data-role="ex" list="exlist" value="${label(p.exercise)}"
               title="${label(p.exercise)}" autocomplete="off" autocapitalize="none"
               spellcheck="false" aria-label="exercise name">
        <div class="stepper">
          <button data-role="dec" aria-label="fewer sets">&minus;</button>
          <span class="n">${p.sets}</span>
          <button data-role="inc" aria-label="more sets">+</button>
        </div>
        <button class="rm" data-role="rm" aria-label="remove">&times;</button>
        ${prov ? `<button class="provtag ${bad ? "bad" : ""}" data-role="deftoggle">${
          bad ? "needs setup - no increment or rep range" : "not in library"}</button>` : ""}
        ${prov ? defPanel(p.exercise, bad) : ""}
      </div>`;
    }).join("");
    const isViewed = d === todayKey();
    return `<div class="day">
      <div class="dayhead ${isViewed ? "today" : ""}">
        <span class="dd">${d}</span><span class="dn">${day.name}</span>
        ${isViewed ? `<span class="onnow">${dayIsHistory()
            ? "on Today &middot; logged" : "on Today"}</span>` : ""}
        <span class="ds">${n} sets</span></div>
      ${rows}
      <div class="addrow"><button data-role="add" data-day="${d}">+ add a lift</button></div>
    </div>`;
  }).join("");

  for (const row of $("planweek").querySelectorAll(".dayrow")) {
    const d = row.dataset.day, ex = row.dataset.ex;
    const at = () => (state.routine || ROUTINE).week[d].plan.findIndex(x => x.exercise === ex);
    const cur = () => effectivePlan(d).find(x => x.exercise === ex)?.sets ?? 1;
    row.querySelector('[data-role="ex"]').onchange = (e) => {
      const typed = e.target.value;
      const was = ex;
      if (!typed.trim()) { renderPlan(); return; }          // blank is not an edit
      let key = resolveExercise(typed);
      let minted = false;
      if (!key) {
        // Free text the library does not know. Not an error and not a guess: it becomes
        // a lift of this browser's own, inert until its increment and rep range are set.
        key = createProvisional(typed, { source: "typed" });
        minted = true;
      }
      if (!key || key === was) { renderPlan(); return; }
      ensureEditable(); state.routine.week[d].plan[at()].exercise = key;
      saveRoutine(); renderPlan();
      if (minted) showFeedback(
        `<span class="l1">${label(key)} added to ${d}</span>\n` +
        `<span class="l2">not in exercises.yaml - no rule for it yet</span>\n` +
        `<span class="l3">set its increment and rep range in Plan, then Export</span>`);
    };
    const tag = row.querySelector('[data-role="deftoggle"]');
    if (tag) tag.onclick = () => {
      const d2 = row.querySelector('[data-role="def"]');
      if (d2) d2.hidden = !d2.hidden;
    };
    const def = row.querySelector('[data-role="def"]');
    if (def) wireDefPanel(def);
    const setsTo = (n) => {
      const next = clamp(n, 1, 8);
      if (next === cur()) {
        planEcho(
          `<b>${label(ex)} is at ${cur()} set${cur() === 1 ? "" : "s"}.</b> ` +
          (cur() >= 8 ? "8 is the most this app will plan for one lift."
                      : "1 is the fewest - remove the lift instead."));
        return;
      }
      setOverride(d, ex, next);
      renderPlan();
      planEcho(
        `<b>${d} ${label(ex)} &rarr; ${next} set${next === 1 ? "" : "s"}.</b> ` +
        (d === todayKey()
          ? (dayIsHistory()
              ? `Today is showing ${state.date}, which is already logged - the new count ` +
                `applies the next time this day comes round.`
              : `Showing in Today now.`)
          : `Today is showing <b>${todayKey()}</b>, so this will not change what is on ` +
            `that tab until ${d} comes round.`));
    };
    row.querySelector('[data-role="inc"]').onclick = () => setsTo(cur() + 1);
    row.querySelector('[data-role="dec"]').onclick = () => setsTo(cur() - 1);
    row.querySelector('[data-role="rm"]').onclick = () => {
      if (!confirm(`Remove ${label(ex)} from ${d}?`)) return;
      ensureEditable(); state.routine.week[d].plan.splice(at(), 1);
      if (state.setsBy[d]) {           // no entry left for the override to apply to
        delete state.setsBy[d][ex];
        if (!Object.keys(state.setsBy[d]).length) delete state.setsBy[d];
        savePrefs();
      }
      saveRoutine(); renderPlan();
    };
    row.querySelector('[data-role="handle"]').addEventListener("pointerdown", (e) => startDrag(e, row, d));
  }
  for (const btn of $("planweek").querySelectorAll('[data-role="add"]')) {
    btn.onclick = () => {
      ensureEditable();
      state.routine.week[btn.dataset.day].plan.push({ exercise: r.lifts[0], sets: 2 });
      // the new row's combobox is where you type what it actually is
      saveRoutine(); renderPlan();
    };
  }
}

// This panel edits IN PLACE and never calls renderPlan(). Re-rendering the plan on a
// field change replaces the very input being typed into: on a phone that eats the
// keystroke, the focus and the caret. So each edit writes state, saves, and touches
// only the two things that can visibly change - the row's own flag, and Today.
function wireDefPanel(def) {
  const key = def.dataset.key;
  const p = state.provisional[key];
  if (!p) return;
  const row = def.closest(".dayrow");

  const refresh = () => {
    const bad = !exReady(key);
    row.classList.toggle("unset", bad);
    const tag = row.querySelector('[data-role="deftoggle"]');
    if (tag) {
      tag.classList.toggle("bad", bad);
      tag.textContent = bad ? "needs setup - no increment or rep range" : "not in library";
    }
    renderToday();   // the prescription and the set boxes hang on exactly this
  };

  for (const chip of def.querySelectorAll(".mchip")) {
    chip.onclick = () => {
      const m = chip.dataset.m;
      p.muscles = p.muscles.includes(m) ? p.muscles.filter(x => x !== m) : [...p.muscles, m];
      chip.classList.toggle("on", p.muscles.includes(m));
      saveProvisional(); refresh();
    };
  }
  const num = (f) => {
    const v = parseFloat(String(def.querySelector(`[data-f="${f}"]`).value).replace(",", "."));
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const write = () => {
    p.increment = num("inc");
    const floor = num("floor"), ceiling = num("ceiling");
    p.rep_range = floor && ceiling && ceiling >= floor ? [floor, ceiling] : null;
    p.bodyweight = def.querySelector('[data-f="bw"]').checked;
    saveProvisional(); refresh();
  };
  // input, not change: change waits for blur, so the last field typed before pressing
  // Export would not have been written yet.
  for (const el of def.querySelectorAll('input[type="number"]')) el.oninput = write;
  def.querySelector('[data-f="bw"]').onchange = write;
}

// Pointer-based reorder - not the HTML5 drag-and-drop API, which has no real touch
// support and this has to work with a thumb, mid-session. Rows in the SAME day only;
// reordering across days is a different edit (move + remove) and out of scope here.
function startDrag(e, row, day) {
  e.preventDefault();
  const list = [...row.parentElement.querySelectorAll(".dayrow")];
  const fromIndex = list.indexOf(row);
  const h = row.getBoundingClientRect().height;
  let current = fromIndex;
  const startY = e.clientY;

  row.setPointerCapture(e.pointerId);
  row.classList.add("dragging");

  // Recomputed from each row's FIXED original index against fromIndex/current on every
  // change, not patched incrementally - an incremental patch loses track of rows that
  // move back out of the affected range when the drag reverses direction mid-gesture.
  function onMove(ev) {
    const dy = ev.clientY - startY;
    row.style.transform = `translateY(${dy}px)`;
    const slot = clamp(Math.round(fromIndex + dy / h), 0, list.length - 1);
    if (slot === current) return;
    current = slot;
    list.forEach((el, idx) => {
      if (el === row) return;
      const shift = (current > fromIndex && idx > fromIndex && idx <= current) ? -1
        : (current < fromIndex && idx < fromIndex && idx >= current) ? 1 : 0;
      el.style.transform = shift ? `translateY(${shift * h}px)` : "";
    });
  }
  function onUp() {
    row.releasePointerCapture(e.pointerId);
    row.removeEventListener("pointermove", onMove);
    row.removeEventListener("pointerup", onUp);
    row.removeEventListener("pointercancel", onUp);
    if (current !== fromIndex) {
      // Writes the ORDER, never the routine: a reorder must not mark the plan as
      // structurally edited, because it changes no volume and needs no export - and
      // making it structural is what would get it thrown away on the next deploy.
      const names = effectivePlan(day).map(p => p.exercise);
      const [moved] = names.splice(fromIndex, 1);
      names.splice(current, 0, moved);
      state.order[day] = names;
      saveOrder();
    }
    renderPlan();
  }
  row.addEventListener("pointermove", onMove);
  row.addEventListener("pointerup", onUp);
  row.addEventListener("pointercancel", onUp);
}

// How far the local plan has drifted from the file, counted in the units that matter:
// a lift added or removed, and a set count changed.
function countStructuralEdits() {
  let n = 0;
  for (const d of DAYS) {
    const file = new Map(ROUTINE.week[d].plan.map(p => [p.exercise, p.sets]));
    const now = new Map(effectivePlan(d).map(p => [p.exercise, p.sets]));
    for (const [ex, sets] of now) n += !file.has(ex) ? 1 : (file.get(ex) !== sets ? 1 : 0);
    for (const ex of file.keys()) if (!now.has(ex)) n += 1;
  }
  return n;
}

const planEcho = (html) => { const el = $("plan-echo"); if (el) el.innerHTML = html; };

function renderPlanNote(structural) {
  const el = $("plannote");
  if (!el) return;
  const bits = [];
  if (state.dropped)
    bits.push(`<b>A newer plan was published.</b> Set-count and lift edits made against ` +
      `the old one could not be carried over and were dropped; your <b>order is kept</b>. ` +
      `Redo them below if you still want them.`);
  if (structural)
    bits.push(`<b>${structural} change${structural === 1 ? "" : "s"} live only in this ` +
      `browser.</b> Set counts and lift changes move a muscle's weekly volume, and the ` +
      `bands are derived from <code>routine.yaml</code> - until you Export and paste ` +
      `them in, the bands are measuring a different plan. A new publish will drop them.`);
  if (!bits.length && Object.keys(state.order).length)
    bits.push(state.sync === "off"
      ? `Your exercise order is saved in this browser. It survives a new publish; set ` +
        `counts and lift changes still need Export.`
      : `Your exercise order is stored and follows you across devices. It survives a new ` +
        `publish - only set counts and lift changes need Export.`);
  el.hidden = !bits.length;
  el.className = "scannote" + (state.dropped ? " bad" : "");
  el.innerHTML = bits.join("<br><br>");
}

// Derived, never carried: analyze.py requires lifts and the schedule to agree exactly,
// and the stored `lifts` list goes stale the moment a lift is added in the browser.
const scheduledLifts = () =>
  [...new Set(DAYS.flatMap(d => effectivePlan(d).map(p => p.exercise)))].sort();

function exportYaml() {
  const scheduled = scheduledLifts();
  const out = $("yamlout");
  out.hidden = false;

  // Refuse rather than emit a routine that cannot load. A failed export costs a minute;
  // a plausible-looking increment pasted into exercises.yaml is wrong for months.
  const unset = scheduled.filter(e => !exReady(e));
  if (unset.length) {
    out.textContent =
      `# NOT EXPORTED - ${unset.length} lift(s) have no increment or rep range:\n` +
      unset.map(e => `#   ${label(e)}`).join("\n") +
      "\n#\n# Open the row and fill them in. analyze.py would reject this routine, and\n" +
      "# a guessed increment is worse than a failed export.";
    return;
  }

  const lines = [];
  const prov = scheduled.filter(isProvisional);
  if (prov.length) {
    // Every non-YAML line carries the ===== marker, so selecting the block and
    // stripping "# " cannot drag a sentence of prose into exercises.yaml with it.
    lines.push("# ===== exercises.yaml - add these FIRST, uncommented. routine.yaml",
               "# ===== below names them and will not load until they exist.");
    for (const e of prov) {
      const x = state.provisional[e];
      lines.push(`# ${e}:`);
      lines.push(`#   aliases: [${(x.aliases || []).map(a => JSON.stringify(a)).join(", ")}]`);
      lines.push(`#   muscles: [${x.muscles.join(", ")}]`);
      lines.push(`#   increment: ${x.increment}`);
      lines.push(`#   rep_range: [${x.rep_range[0]}, ${x.rep_range[1]}]`);
      if (x.bodyweight) lines.push("#   bodyweight: true");
      if (x.note) lines.push(`#   # read off the machine: ${x.note}`);
    }
    lines.push("# ===== end exercises.yaml", "");
  }
  lines.push("lifts:", ...scheduled.map(l => `  - ${l}`), "", "week:");
  for (const d of DAYS) {
    lines.push(`  ${d}:`, `    name: ${routine().week[d].name}`, "    plan:");
    for (const p of effectivePlan(d))
      lines.push(`      - {exercise: ${p.exercise}, sets: ${p.sets}}`);
  }
  out.textContent = lines.join("\n");
}

// ---------------------------------------------------------------- sync
// Where a logged session actually lives.
//
// localStorage is the WRITE-AHEAD BUFFER, never the store of record: it is one browser
// on one device, and a cleared cache takes a year of training with it. The store is the
// artifact's own database, reachable only inside claude.ai - so every write lands
// locally first and is flushed when the store is there. A gym basement with no signal is
// the normal case, not the edge case, and Submit must never block on the network.
//
// One document per SESSION, not per set: the database caps at 5,000 documents, and
// 7 sessions a week is ~364 a year - over a decade of headroom. A document per set would
// burn that cap in eleven weeks.
//
// The page reads a bounded WINDOW, not the whole history. Queries scan the collection,
// so pulling three years of sessions on every load would eventually cost a
// resource_exhausted. The window only has to cover what the browser computes for itself:
// the "last week" reference row and the 7/14-day volume bands. Everything longer-range
// is analyze.py's job, from log.csv, and no amount of local history changes that.
const STORE_QUEUE = "strengthlog.queue.v1";
const SYNC_WINDOW = 60;      // days of history to pull; the widest local window is 14

let DB = null;
let flushing = false;

const dbErr = (e) => (e && typeof e.code === "string") ? e.code : "unavailable";

function saveQueue() {
  try { localStorage.setItem(STORE_QUEUE, JSON.stringify(state.queue)); }
  catch { /* private mode */ }
}
function loadQueue() {
  try {
    const d = JSON.parse(localStorage.getItem(STORE_QUEUE) || "[]");
    if (Array.isArray(d)) state.queue = d.filter(x => typeof x === "string");
  } catch { /* ignore */ }
}
const queueDate = (date) => {
  if (!state.queue.includes(date)) state.queue.push(date);
  saveQueue();
};

// Rows this device has not flushed win over the copy in the store: they are newer by
// construction, and a session edited offline must not be overwritten by its own
// pre-edit version on the next pull.
const remoteRows = () => {
  const local = new Set(state.committed.map(r => r.date));
  return state.remote.filter(r => !local.has(r.date));
};

function sessionDoc(date) {
  const sets = state.committed
    .filter(r => r.date === date)
    .map(({ exercise, set_no, weight_kg, reps, rir }) =>
      ({ exercise, set_no, weight_kg, reps, rir: rir ?? null }));
  return { date, sets, updated_at: new Date().toISOString(), schema: 1 };
}

async function pullRemote() {
  if (!DB) return;
  const since = isoDate(new Date(Date.now() - SYNC_WINDOW * 864e5));
  try {
    const snap = await DB.collection("sessions")
      .where("date", ">=", since).orderBy("date", "desc").limit(200).get();
    const rows = [];
    for (const d of snap.docs) {
      const body = d.data();
      if (!body || !Array.isArray(body.sets)) continue;
      for (const s of body.sets)
        rows.push({ ...s, date: body.date || d.id, rir: s.rir ?? null, notes: "" });
    }
    state.remote = rows;
  } catch (e) {
    setSync("error", dbErr(e));
  }
  // The order is one small document, not part of the session window. Last write wins by
  // timestamp; a local change not yet flushed is by definition newer and is left alone.
  try {
    const [o, t] = await Promise.all([
      DB.doc("prefs/order").get(), DB.doc("prefs/sets").get()]);
    const od = o.exists ? o.data() : null, td = t.exists ? t.data() : null;
    const stamp = String(od?.updated_at || td?.updated_at || "");
    if (!state.orderDirty && stamp && (!state.orderAt || stamp > state.orderAt)) {
      if (od?.days) state.order = od.days;
      if (td?.days) state.setsBy = td.days;
      state.orderAt = stamp;
      try {
        localStorage.setItem(STORE_ORDER,
          JSON.stringify({ days: state.order, updated_at: state.orderAt }));
        localStorage.setItem(STORE_SETS,
          JSON.stringify({ days: state.setsBy, updated_at: state.orderAt }));
      } catch { /* private mode */ }
    }
  } catch { /* prefs are a convenience - never fail a sync over them */ }
}

// One date at a time, stopping at the first failure so the queue keeps its order and
// nothing is dropped on a flaky connection. A date with no local rows means the session
// was removed here, so the document goes too.
async function flushQueue() {
  if (!DB || flushing || (!state.queue.length && !state.orderDirty)) return;
  flushing = true;
  setSync("pending");
  try {
    for (const date of [...state.queue]) {
      const doc = sessionDoc(date);
      try {
        if (doc.sets.length) await DB.doc(`sessions/${date}`).set(doc);
        else await DB.doc(`sessions/${date}`).delete();
      } catch (e) {
        const code = dbErr(e);
        // invalid_argument and quota_exceeded cannot be retried into success - say so
        // and stop, rather than looping on a write that will never land.
        setSync("error", code);
        if (code === "quota_exceeded" || code === "invalid_argument") state.queue = [];
        saveQueue();
        flushing = false;
        return;
      }
      state.queue = state.queue.filter(d => d !== date);
      saveQueue();
    }
    if (state.orderDirty) {
      try {
        await DB.doc("prefs/order").set(
          { days: state.order, updated_at: state.orderAt, schema: 1 });
        await DB.doc("prefs/sets").set(
          { days: state.setsBy, updated_at: state.orderAt, schema: 1 });
        state.orderDirty = false;
      } catch (e) { setSync("error", dbErr(e)); flushing = false; return; }
    }
    await pullRemote();
    setSync("idle");
  } finally {
    flushing = false;
    renderSyncState();
  }
}

function setSync(mode, code) {
  state.sync = mode;
  state.syncCode = code || null;
  renderSyncState();
}

function renderSyncState() {
  const n = state.queue.length;
  const txt =
    state.sync === "off"     ? ""
    : state.sync === "error" ? ` · sync ${state.syncCode || "failed"}`
    : n                      ? ` · ${n} to sync`
    : " · synced";
  $("hstate").textContent = `${state.date} · ${state.sets.length} sets${txt}`;
  const el = $("syncnote");
  if (!el) return;
  el.hidden = state.sync === "off" && !n;
  el.className = "scannote" + (state.sync === "error" ? " bad" : "");
  el.innerHTML =
    state.sync === "off"
      ? `<b>${n} session${n === 1 ? "" : "s"} held on this device only.</b> There is no ` +
        `store behind this copy of the page - open it inside claude.ai to sync, or ` +
        `Export rows and paste them into <code>log.csv</code>.`
    : state.sync === "error"
      ? `<b>Sync failed (${state.syncCode}).</b> ${n} session${n === 1 ? "" : "s"} still ` +
        `only on this device. It retries on the next load; Export rows is the way out ` +
        `if it keeps failing.`
    : n
      ? `${n} session${n === 1 ? "" : "s"} waiting to sync.`
      : `Synced. Sessions are stored on your Claude account and reach every device.`;
}

// Resolves late and may never resolve: served anywhere but inside claude.ai there is no
// store at all, and the page has to stay fully usable - localStorage alone, exactly as
// it behaved before this existed.
async function openStore() {
  try {
    DB = await window.claude?.use?.("db");
  } catch { DB = null; }
  if (!DB) { setSync("off"); return; }
  setSync("idle");
  await pullRemote();
  await flushQueue();
  // renderPlan too: a pull can bring back an exercise order this device did not have
  // (a fresh browser, or a cleared cache), and the Plan tab is rendered once at boot.
  renderToday(); renderTrends(); renderPlan();
}

// ------------------------------------------------------------ photo dump
// Drop in photos of the machines - a nameplate, the QR-code landing page, the machine
// itself - and get back a proposed lift per photo. In the published Artifact this runs
// against Claude through the `sample` capability, on your own account. Served anywhere
// else (Vercel, a file:// copy) there is no model behind the page: the photos are still
// kept and attached to lifts, and identification is what `/scan` does in Claude Code.
//
// What comes back is a PROPOSAL, never a commit. Nothing reaches the plan until you
// press Add, and `increment` arrives null unless Claude could actually read it off the
// machine - the one field that must never be a guess.
let SAMPLE = null, SAMPLE_IMAGES = null;

// ~480px long edge at q0.78, the same shape /scan saves reference photos in: a dozen
// of these fit in localStorage, a dozen phone originals do not.
function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, 480 / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      c.toBlob(
        (blob) => blob
          ? resolve({ blob, url: c.toDataURL("image/jpeg", 0.78) })
          : reject(new Error("could not encode")),
        "image/jpeg", 0.78);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("not an image")); };
    img.src = url;
  });
}

async function addPhotos(files) {
  const list = [...files].filter(f => f.type.startsWith("image/"));
  if (!list.length) return;
  for (const f of list) {
    try {
      const { blob, url } = await shrinkImage(f);
      state.photos.push({ id: `p${Date.now()}${state.photos.length}`, blob, url, name: f.name });
    } catch (e) {
      showScanNote(`could not read ${f.name} (${f.type || "unknown type"}): ${e.message}. ` +
        `If it is a HEIC photo, share it as JPEG or take a screenshot of it.`, true);
    }
  }
  state.proposals = null;
  renderScan();
}

const showScanNote = (msg, bad) => {
  $("scan-note").innerHTML = bad ? `<span class="err">${msg}</span>` : msg;
};

function libraryDigest() {
  return Object.keys(EXERCISES).sort().map(e => {
    const x = EXERCISES[e];
    return `${e}: ${(x.aliases || []).join(", ")}`;
  }).join("\n");
}

function scanPrompt(n) {
  return [
    `${n} photo(s) of gym equipment follow, in order: a machine nameplate, a QR-code`,
    "landing page, or the machine itself. Identify the exercise in each.",
    "",
    "Existing exercise library (canonical name: aliases):",
    libraryDigest(),
    "",
    `Valid muscle groups - nothing outside this list is allowed: ${MUSCLES.join(", ")}`,
    "",
    "Return ONLY a JSON array, one object per photo, in photo order:",
    '{"photo": <0-based index>, "match": <canonical library name or null>,',
    ' "name": <snake_case English name for a NEW entry, translated from the nameplate, or null>,',
    ' "aliases": [<brand and model exactly as shown>, <the nameplate text as shown>],',
    ' "muscles": [<prime movers ONLY>], "rep_range": [<floor>, <ceiling>],',
    ' "increment_kg": <number or null>, "increment_source": "read" | "unknown",',
    ' "bodyweight": <true|false>, "confidence": "high" | "low",',
    ' "note": <one short line: what the plate says, and anything you could not read>}',
    "",
    "Rules:",
    '- "match" only when the photo is clearly the SAME exercise already in the library.',
    "  A plate-stack machine is NOT a match for a dumbbell or barbell version: dumbbell",
    "  weight is per-dumbbell, stack weight is total, and one entry cannot carry both",
    "  units. When in doubt propose a new entry.",
    '- "increment_kg": ONLY when the plate increment is actually legible in the photo.',
    '  Otherwise null and "unknown". Never infer it from what a stack usually is - a',
    "  wrong increment silently corrupts every future load prescription for this lift.",
    '- "muscles": prime movers only. Do not list a muscle that merely assists. Two',
    "  entries only where a lift is genuinely co-primary.",
    '- Not gym equipment: {"photo": i, "match": null, "name": null, "note": "<what it is>"}.',
  ].join("\n");
}

async function identifyPhotos() {
  if (!SAMPLE || !state.photos.length) return;
  const max = SAMPLE_IMAGES.maxCount || 4;
  const batch = state.photos.slice(0, max);
  $("btn-identify").disabled = true;
  showScanNote(`reading ${batch.length} photo${batch.length === 1 ? "" : "s"}…`);
  try {
    const out = await SAMPLE.json(scanPrompt(batch.length), {
      images: batch.map(p => p.blob), modelTier: "complex",
    });
    const arr = Array.isArray(out) ? out : [out];
    state.proposals = arr.map((r, i) => ({
      ...r,
      photoId: batch[r && Number.isInteger(r.photo) ? r.photo : i]?.id ?? batch[i]?.id,
      sets: 3,
      day: todayKey(),
    }));
    showScanNote(batch.length < state.photos.length
      ? `${batch.length} of ${state.photos.length} read - this view allows ${max} per call.`
      : "");
  } catch (e) {
    state.proposals = null;
    showScanNote(e?.code === "rate_limited" ? "rate limited - try again in a minute"
      : e?.code === "not_granted" ? "you declined - nothing was sent"
      : `could not read the photos: ${e?.message || e}`, true);
  }
  $("btn-identify").disabled = false;
  renderScan();
}

// A proposal becomes a lift only here, and an unread increment stays unread: the field
// is empty and the row cannot be exported until a human types what the stack says.
function acceptProposal(pr) {
  const photo = state.photos.find(p => p.id === pr.photoId);
  let key = pr.match && EXERCISES[pr.match] ? pr.match : null;
  if (!key) {
    if (!pr.name) return;
    key = createProvisional(pr.name, {
      aliases: pr.aliases, muscles: pr.muscles,
      increment: pr.increment_source === "read" ? pr.increment_kg : null,
      rep_range: Array.isArray(pr.rep_range) ? pr.rep_range : null,
      bodyweight: !!pr.bodyweight, image: photo?.url || null,
      note: pr.note || "", source: "photo",
    });
  }
  if (!key) return;
  ensureEditable();
  state.routine.week[pr.day].plan.push({ exercise: key, sets: clamp(pr.sets, 1, 8) });
  saveRoutine();
  state.proposals = state.proposals.filter(x => x !== pr);
  if (photo) state.photos = state.photos.filter(p => p.id !== photo.id);
  renderPlan();
  renderScan();
}

function renderScan() {
  const on = !!SAMPLE;
  $("scan-meta").textContent = on
    ? "read on your Claude account"
    : "no model here - use /scan";
  $("btn-identify").hidden = !on || !state.photos.length;

  $("scanqueue").innerHTML = state.photos.map(p =>
    `<div class="qthumb"><img src="${p.url}" alt="${p.name}">
       <button class="qdel" data-id="${p.id}" aria-label="Remove ${p.name}">&times;</button>
     </div>`).join("");
  for (const b of $("scanqueue").querySelectorAll(".qdel")) {
    b.onclick = () => {
      state.photos = state.photos.filter(p => p.id !== b.dataset.id);
      state.proposals = null;
      renderScan();
    };
  }

  const props = state.proposals || [];
  $("scanout").innerHTML = props.map((pr, i) => {
    const photo = state.photos.find(p => p.id === pr.photoId);
    if (!pr.match && !pr.name)
      return `<div class="prop bad"><div class="prophead"><b>not equipment</b></div>
        <p class="defnote">${pr.note || ""}</p></div>`;
    const known = pr.match && EXERCISES[pr.match];
    const read = pr.increment_source === "read" && typeof pr.increment_kg === "number";
    return `<div class="prop" data-i="${i}">
      <div class="prophead">
        ${photo ? `<button class="thumb" data-role="preview" data-img="${photo.url}"
            aria-label="Show photo"><img src="${photo.url}" alt=""></button>` : ""}
        <span class="propname">${label(known ? pr.match : slug(pr.name || ""))}</span>
        <span class="proptag ${known ? "known" : "new"}">${known ? "in library" : "new"}</span>
      </div>
      <div class="propmeta">${(pr.muscles || []).join(" · ") || "no muscles read"}
        ${pr.confidence === "low" ? ' · <span class="lowconf">low confidence</span>' : ""}</div>
      ${known ? "" : `<div class="propnums">
        <label class="${read ? "" : "missing"}">increment kg
          <input type="number" step="0.5" min="0" data-f="inc"
                 value="${read ? pr.increment_kg : ""}" placeholder="?">
        </label>
        <label>reps
          <input type="number" min="1" data-f="floor" value="${pr.rep_range?.[0] ?? ""}">
          <span>&ndash;</span>
          <input type="number" min="1" data-f="ceiling" value="${pr.rep_range?.[1] ?? ""}">
        </label>
      </div>`}
      <p class="defnote">${pr.note || ""}${read ? "" :
        known ? "" : "<br>The increment was not legible - read it off the stack."}</p>
      <div class="propadd">
        <select data-f="day">${DAYS.map(d =>
          `<option value="${d}" ${d === pr.day ? "selected" : ""}>${d}</option>`).join("")}</select>
        <div class="stepper">
          <button data-f="less" aria-label="fewer sets">&minus;</button>
          <span class="n">${pr.sets}</span>
          <button data-f="more" aria-label="more sets">+</button>
        </div>
        <button class="primary" data-f="add">Add</button>
        <button data-f="skip">Skip</button>
      </div>
    </div>`;
  }).join("");

  for (const el of $("scanout").querySelectorAll(".prop[data-i]")) {
    const pr = props[+el.dataset.i];
    const q = (f) => el.querySelector(`[data-f="${f}"]`);
    q("day").onchange = (e) => { pr.day = e.target.value; };
    q("less").onclick = () => { pr.sets = clamp(pr.sets - 1, 1, 8); renderScan(); };
    q("more").onclick = () => { pr.sets = clamp(pr.sets + 1, 1, 8); renderScan(); };
    q("skip").onclick = () => {
      state.proposals = state.proposals.filter(x => x !== pr); renderScan();
    };
    q("add").onclick = () => {
      const inc = q("inc"), fl = q("floor"), ce = q("ceiling");
      if (inc) {
        const v = parseFloat(String(inc.value).replace(",", "."));
        pr.increment_kg = Number.isFinite(v) && v > 0 ? v : null;
        pr.increment_source = pr.increment_kg ? "read" : "unknown";
        const f = parseFloat(fl.value), c = parseFloat(ce.value);
        pr.rep_range = f > 0 && c >= f ? [f, c] : null;
      }
      acceptProposal(pr);
    };
    const t = el.querySelector('[data-role="preview"]');
    if (t) t.onclick = () => openLightbox(t.dataset.img);
  }
}

// The picker is opened by a real <label for>, not by JS calling .click() on a hidden
// input: on iOS a display:none file input often does not open at all from a synthetic
// click, which is exactly the "cannot submit the image" this hit. The label needs no
// script, so keyboard activation is all that is left to wire.
$("photos").onchange = (e) => { addPhotos(e.target.files); e.target.value = ""; };
$("btn-pick").addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("photos").click(); }
});
for (const ev of ["dragenter", "dragover"])
  $("drop").addEventListener(ev, (e) => { e.preventDefault(); $("drop").classList.add("over"); });
for (const ev of ["dragleave", "drop"])
  $("drop").addEventListener(ev, (e) => { e.preventDefault(); $("drop").classList.remove("over"); });
$("drop").addEventListener("drop", (e) => addPhotos(e.dataTransfer.files));
$("btn-identify").onclick = identifyPhotos;

// Resolves late and may never resolve at all - the page is built for its absence and
// lights the feature up if and when the viewer can run it.
(async () => {
  try {
    const s = await window.claude?.use?.("sample");
    if (!s) return;
    const lim = await s.limits().catch(() => null);
    if (!lim?.images) return;
    SAMPLE = s;
    SAMPLE_IMAGES = lim.images;
    // Deliberately NOT narrowed to lim.images.mediaTypes. An iPhone's camera roll is
    // HEIC, which is not on that list, so filtering by it greys out the very photos
    // this feature is for. Everything is re-encoded to JPEG by shrinkImage() before it
    // is sent, so what the input accepts and what Claude accepts are different things.
    renderScan();
  } catch { /* no viewer, no capability - the fallback copy is already rendered */ }
})();

// ------------------------------------------------------------ session I/O
const csvRow = (s) =>
  `${s.date},strength,${s.exercise},${s.set_no},${+s.weight_kg},${s.reps},` +
  `${s.rir === null || s.rir === undefined ? "" : s.rir},`;

// Everything submitted on this device plus whatever is open right now, so nothing is
// lost between here and log.csv.
function showCsv() {
  const out = $("csvout");
  const live = state.sets.map(s => ({ ...s, date: state.sessionDate || state.date }));
  const rows = [...state.committed, ...live].sort((a, b) =>
    a.date.localeCompare(b.date) || a.exercise.localeCompare(b.exercise) || a.set_no - b.set_no);
  if (!rows.length) { out.hidden = true; return showFeedback(`<span class="err">? nothing logged yet</span>`); }
  out.textContent = "date,type,exercise,set_no,weight_kg,reps,rir,notes\n" + rows.map(csvRow).join("\n");
  out.hidden = false;
  const days = new Set(rows.map(r => r.date)).size;
  showFeedback(
    `<span class="l1">${rows.length} sets across ${days} session${days === 1 ? "" : "s"}</span>\n` +
    `<span class="l2">${state.committed.length} submitted, ${live.length} still open</span>\n` +
    `<span class="hint">paste into log.csv, then: analyze.py validate &amp;&amp; web/build_data.py</span>`);
}

// Submit: bank the session on this device and move to the next day's plan.
//
// This is the honest limit of what a static page can do. It makes the session real for
// everything the browser computes itself - volume against the bands, and the "last week"
// baseline the next session is measured against, which is most of the point. It does NOT
// touch the deep analytics: e1RM slopes, strength index, the volume-load bridge, stalls
// and adherence all come from analyze.py at build time and stay frozen until log.csv is
// updated and it runs again. Recomputing them here would mean a second implementation of
// the rule in JavaScript, which is the one thing CLAUDE.md rules out.
function submitSession() {
  if (!state.sets.length)
    return showFeedback(`<span class="err">? nothing logged - no session to submit</span>`);

  const wasDate = state.sessionDate || state.date;
  const dated = state.sets.map(s => ({ ...s, date: wasDate, notes: "" }));
  const sets = dated.length;
  const lifts = new Set(dated.map(s => s.exercise)).size;

  state.committed = [...state.committed, ...dated];
  saveCommitted();
  queueDate(wasDate);
  flushQueue();          // deliberately not awaited: Submit must never wait on a network
  state.sets = [];
  state.sessionDate = null;
  state.sticky = null;
  $("csvout").hidden = true;
  saveSession();

  // Advance from the day just submitted, wherever the view happened to be.
  setDay(Math.round((Date.parse(wasDate) - Date.parse(isoDate(new Date()))) / 864e5) + 1);
  saveSession();          // the new (empty) day, so a reload lands in the same place
  renderToday(); renderTrends();

  showFeedback(
    `<span class="l1">submitted ${wasDate}: ${sets} sets, ${lifts} lifts</span>\n` +
    `<span class="l2">next up ${state.date} &middot; ${routine().week[todayKey()].name}</span>\n` +
    `<span class="hint">${DB ? "stored on your Claude account" : "held on this device"} ` +
    `· deep trends need an analyze.py run</span>`);
}

function saveCommitted() {
  try { localStorage.setItem(STORE_LOG, JSON.stringify(state.committed)); }
  catch { /* private mode */ }
}
function loadCommitted() {
  try {
    const raw = localStorage.getItem(STORE_LOG);
    const d = raw ? JSON.parse(raw) : null;
    if (Array.isArray(d)) state.committed = d.filter(r => r && r.date && r.exercise);
  } catch { /* ignore */ }
}

function showFeedback(html) { $("feedback").innerHTML = html; }

function saveSession() {
  try { localStorage.setItem(STORE_SESSION, JSON.stringify(
    { date: state.sessionDate, sets: state.sets, sticky: state.sticky,
      viewDate: state.date, dayOffset: state.dayOffset })); }
  catch { /* private mode */ }
}
function loadSession() {
  try {
    const raw = localStorage.getItem(STORE_SESSION);
    if (!raw) return;
    const d = JSON.parse(raw);
    if (!d) return;
    // The sets carry their OWN date, so they survive a reload whatever day was on screen
    // - but only as that date. A session left open overnight reappears under the day it
    // was logged on, never silently under today.
    if (Array.isArray(d.sets) && d.sets.length && d.date) {
      state.sets = d.sets;
      state.sessionDate = d.date;
      state.sticky = d.sticky || null;
    }
    // Restore the view. dayOffset is now signed, and is recomputed from the stored view
    // date so that yesterday stays yesterday across a date rollover rather than becoming
    // the day before that.
    const view = d.viewDate || d.date;
    if (view && /^\d{4}-\d{2}-\d{2}$/.test(view)) {
      const off = Math.round((Date.parse(view) - Date.parse(isoDate(new Date()))) / 864e5);
      if (Number.isFinite(off) && Math.abs(off) <= 400) setDay(off);
    } else if (Number.isInteger(d.dayOffset)) {
      setDay(d.dayOffset);
    }
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------- wiring
function selectTab(name) {
  for (const t of ["today", "trends", "plan"]) {
    $(`tab-${t}`).setAttribute("aria-selected", String(t === name));
    $(`p-${t}`).hidden = t !== name;
  }
}
for (const t of ["today", "trends", "plan"]) $(`tab-${t}`).onclick = () => selectTab(t);

$("btn-more").onclick = () => { state.logLimit += 20; renderSessionLog(); };
$("btn-submit").onclick = submitSession;
$("btn-end").onclick = showCsv;
$("btn-clear").onclick = () => {
  if (!state.sets.length || confirm("Discard the open session? Nothing has been written to log.csv.")) {
    state.sessionDate = null;
    state.sets = []; state.sticky = null; $("csvout").hidden = true;
    renderToday(); showFeedback(`<span class="hint">session discarded</span>`);
    saveSession();
  }
};

for (const b of document.querySelectorAll("#volseg button")) {
  b.onclick = () => {
    state.window = +b.dataset.w;
    for (const x of document.querySelectorAll("#volseg button")) x.ariaPressed = String(x === b);
    renderMeters();
  };
}
$("btn-yaml").onclick = exportYaml;
$("btn-reset").onclick = () => {
  if (confirm("Discard your edits - set counts, lifts AND your exercise order - and reload routine.yaml as published?")) {
    state.routine = null;
    state.dropped = 0;
    state.order = {};
    state.setsBy = {};
    savePrefs();
    try { localStorage.removeItem(STORE_ROUTINE); } catch { /* ignore */ }
    $("yamlout").hidden = true;
    renderPlan();
  }
};

// ----------------------------------------------------------------- start
loadProvisional();   // before anything renders: the routine may name one of these
loadRoutine();
loadCommitted();
loadQueue();
loadOrder();
loadSession();
selectTab("today");
renderToday();
renderTrends();
renderPlan();
renderScan();
openStore();                                   // async; the page is already usable
addEventListener("online", () => flushQueue());
showFeedback(state.sets.length
  ? `<span class="hint">session restored: ${state.sets.length} sets</span>`
  : `<span class="l1">${routine().week[todayKey()].name}</span>\n` +
    `<span class="l2">${ANALYTICS.sessions.length
      ? `${ANALYTICS.sessions.length} sessions logged · last ${ANALYTICS.last_logged}`
      : "no history yet - every lift reads no baseline until you log it"}</span>\n` +
    `<span class="hint">tap into a set box and enter the weight</span>`);
