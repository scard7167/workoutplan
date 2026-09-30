# Strength log - operating instructions

Personal strength-training log, plan and analytics. Logged SET BY SET on a phone,
mid-session, inside Claude Code. Every interaction is optimised for that: terse input,
one-line output.

Training context: 7 strength sessions/week, full gym, hypertrophy + robustness,
alongside 30-50 km/week cycling and running that this log never sees. Recovery is the
binding constraint, not gym time - sessions were sized at 10-12 working sets, but on
**2026-09-10 every lift was set to 4 sets at the user's request**: the week is now 140
working sets across days of 16-28, and every band was rederived to match. That is ~50%
above the design this log was written around. It is a deliberate choice, not drift, and
the first number to revisit if recovery goes. The cycling already loads the legs, so `calves` is uncovered by
design (see `uncovered_by_design` in config.yaml) and is never a reason to add calf work
here. **Quads were uncovered too until 2026-09-09**, when a direct leg day was added to
Wednesday at the user's request - they are now trained and measured like anything else.
**On 2026-09-11 four gym80 pull machines were added to Friday** (3045 row, 3012N
pullover, 3025 reverse butterfly, 3020 back pull), turning it from shoulders into
shoulders+back: the week is 156 sets across days of 16-32, and lats (16->28),
upper_back (4->8) and rear_delts (12->16) were rederived to match. Friday is now the
biggest day of the week.
**On 2026-09-12 Saturday was replaced wholesale** with four gym80 machines (3030 leg
press, 3001 leg extension, 4416 Bootymizer, 3099 standing lateral raise), so
`chest_supported_row` and `romanian_deadlift` left the routine entirely - the RDL was
the week's only hip hinge. No muscle lost its last lift (checked before the swap), but
three of Saturday's four machines repeat Wednesday's leg day three days later, and TWO
BALANCE BANDS NOW FAIL AS WRITTEN: quad:hamstring 16:4 = 4.00 against a max of 1.5, and
upper:lower 120:40 = 3.00 against a floor of 4.0. Those bands were deliberately NOT
widened - see the comments in config.yaml. The week is still 156 sets.

## Files

| file | role |
|---|---|
| `CLAUDE.md` | these instructions |
| `log.csv` | append-only system of record, one row per working set |
| `current_session.md` | scratch pad for the session in progress (untracked) |
| `exercises.yaml` | exercise library - canonical names, aliases, increments, rep ranges |
| `routine.yaml` | the plans - one or more weekly plans, plus the `schedule` saying which was active from when. Source of truth for "what should happen"; bands in config.yaml are derived from it |
| `config.yaml` | volume target bands (derived from routine.yaml), progression rule, thresholds |
| `analyze.py` | all analytics: loader, volume, prescribe, progression, index, bridge, stalls, balance, adherence |
| `seed_example.py` | regenerates `log.example.csv` by running `prescribe()` forward 12 weeks. **BROKEN since the gym80 machines landed** - see below |
| `log.example.csv` | 12 weeks of generated history, for DEMOING the analytics. Never what gets deployed - see below |
| `web/` | the deployed phone app - Session / Cardio / Progress / Plan / History, live on Vercel. See **The web app** below |

## Schema

```
date,type,exercise,set_no,weight_kg,reps,rir,notes,duration_min,distance_km
```

- `date` ISO `YYYY-MM-DD`.
- `type` `strength` | `cardio`. **Cardio landed on 2026-09-27**, when `log.csv` was still
  empty - which made it the cheapest it would ever be. `type` and the library must agree:
  a `cardio` row must name an entry marked `cardio: true` in `exercises.yaml`, and a
  `strength` row must not. The loader refuses either mismatch.
- `duration_min`, `distance_km` are **cardio only** and must be EMPTY on a strength row.
  `duration_min` is required on a cardio row (>= 0.5); `distance_km` is optional.
  A cardio row carries no `weight_kg`, `reps` or `rir` - the loader refuses them.
- `exercise` canonical name from `exercises.yaml`. Never an alias, never free text.
- `set_no` 1-based, within (date, exercise). Unique.
- `weight_kg` per dumbbell for DB work. `0` for a bodyweight set. For bodyweight
  exercises the number is ADDED load only.
- `reps` integer.
- `rir` 0-4 or blank.
- `notes` free text, optional.

**Warmup sets are never logged.** Working sets only.

## Metrics - single source of truth

- **e1RM** = `weight_kg * (1 + (reps + rir) / 30)`. Blank RIR is treated as 1.
  Never compare raw e1RM across different exercises.
- **Bodyweight sets** (`weight_kg == 0`) have no meaningful e1RM. Track them by reps.
  Exclude them from e1RM trends rather than letting a zero fake a slope.
- **Hard set** = any working set. If RIR is present, only RIR <= 3 counts.
- **Cardio is in no metric.** `load_log()` returns STRENGTH rows by default, so every
  analytic that has ever called it keeps receiving strength sets and nothing else. That
  default IS the guarantee - nothing downstream filters, because nothing downstream ever
  sees a cardio row. Ask for `kind="cardio"` or `kind="all"` deliberately.
- **Windows** = rolling 7 and 14 days back from the last logged date. Not calendar weeks.

These definitions live here and in `analyze.py`. If they ever disagree, that is a bug -
say so, do not pick one.

## The routine - the only source of "what should happen"

`routine.yaml` holds ONE OR MORE weekly **plans** and a `schedule` saying which was
active from when. A plan is a whole week of lifts - a machine block, a free-weights
block, a travel week. Exactly one is active at a time; it names the lifts and, per
weekday, how many sets of each. It is the plan; `log.csv` is what actually happened.

**Switching plans changes three things and nothing else**: what Today prescribes from,
what the Plan tab edits, and which volume bands the sets are measured against. e1RM
trends, the strength index, the volume-load bridge, stalls and balance all take only
`rows, lib, cfg` - they never see the routine, because `log.csv` has no plan column and
never will. A set is a set whoever scheduled it, so a lift that leaves the active plan
keeps its whole history and keeps appearing in Trends. `all_lifts()` and
`analytics_json()` deliberately iterate EVERY plan's lifts plus anything in the log:
indexing those off the active plan is what would make a lift's history vanish the day
you switch blocks, and that is the one thing plans must not do.

The `schedule`, not a column in the log, is how a DATE maps to the plan that governed
it. `plan_on(routine, date)` is the only way to ask. That is what lets `adherence`
measure a fortnight straddling a switch against what was actually asked of you on each
day, rather than retroactively rewriting the earlier half. `volume_report` picks the
plan covering most of the window and names the others in `straddles` rather than
silently choosing one.

The single-plan shape this file started as - a top-level `week` and `lifts` - still
loads, as the one plan `default`. `routine["week"]` and `routine["lifts"]` still mean
the plan active TODAY, so every caller that predates plans keeps working.

Bands are per plan: `volume_targets` is the default, `volume_targets_by_plan` overrides
it. Adding a plan means deriving its bands - `python3 analyze.py bands --plan <id>`
prints the block to paste. A plan judged against another plan's weekly volume reads RED
everywhere and means nothing. `config.yaml`'s `volume_targets` are DERIVED from
the routine - the target is what the routine delivers when followed as written, min/max
are tolerance either side. Change the routine and the bands move with it, never the
other way. `calves` has no routine lift and is marked
`uncovered_by_design`: reported, never flagged RED, never a reason to add calf work.

Editing the routine (in `routine.yaml` directly, or in the web app's Plan tab, exported
and pasted back) requires asking first if it removes a muscle's only lift - the same
bar as adding an exercise to the library. A lift the Plan tab invented is *provisional*
until that paste happens - see **The web app**.

## Progression rule - `analyze.py` only, since 2026-09-30

**The web app proposes no load at all.** Asked why an increment had to be predefined,
the user's answer was the right one: *"keep it free entry only. No need to propose
weight. The intelligence is in progression tracking and load analysis, not the
proposal."* So the rule below is `analyze.py`'s, for the CLI. It does not run in `web/`,
and the 5 kg default that existed for one day is gone with it - nothing is assumed
because nothing needs an increment.

What the app does instead, which is the whole point: the log sheet shows **last session's
actual sets for that lift, RIR and all**, and leaves the weight box empty and yours. See
"Free entry" under The web app.

Double progression, per exercise, using its `rep_range: [floor, ceiling]` and `increment`
from `exercises.yaml` and the thresholds in `config.yaml`:

1. **Deload (checked first).** Any working set falls below `floor` at RIR 0 ->
   drop the load 10%, rounded DOWN to the increment, target reps reset to `floor`.
   Applies immediately, from the next set on.
2. **Progress.** Every working set of that exercise in the last session hit `ceiling`
   with RIR <= 2 -> add one increment, target reps reset to `floor`.
   A blank RIR does not satisfy this. Unverified is not proven.
3. **Hold.** Otherwise keep the load and add reps: target = last session's best reps + 1,
   capped at `ceiling`.

Bodyweight exercises: rule 2 on a 0 kg entry means the first added load (one increment).
Rule 1 cannot go below 0 - hold at bodyweight and lower the rep target instead.

**RIR is the field that lets a load move at all.** Rule 2 needs a verified RIR and rule 1
needs RIR 0; a blank RIR satisfies neither. So a log of blank-RIR sets can only ever
HOLD: reps climb to the ceiling, `min(ceiling, best + 1)` pins them there, and the weight
never changes again. The design handoff's log sheet had no RIR control, which is exactly
the dead end it produced - measured, not guessed: four sets at the 10-rep ceiling gave
`60 x10 (hold)` blank and `62.5 x6 (progress)` at RIR 1. The sheet now carries an RIR
row (0-4 and blank), sticky per lift so it is one tap per exercise rather than per set,
and it says out loud when a blank RIR at the ceiling is what is holding the load down.

No load ever comes from anywhere else. Not from feel, not from a round number, not from
what the plates suggest. If the rule produces 62.5 kg, the prescription is 62.5 kg.

This rule is the CLI's. Nothing in `web/` implements it, so the twelve-case app-vs-CLI
cross-check was retired with it - there is no second copy left to disagree.

`analyze.py prescribe()` is the programmatic statement of this rule and **is built** -
`python3 analyze.py prescribe --exercise NAME [--log FILE]`. It is the referee: anything
else that produces a load must agree with it exactly, including the two rules that are
easy to miss. **A mid-session load change carries the LAST set's load forward**, not the
first. **A lift with no prior session gets NO load** - the rule never invents a starting
one, and neither may any caller.

`web/app.js` used to carry a second copy and was checked against this one over twelve
cases. Both are gone as of 2026-09-30: the app proposes no load, so there is no second
copy to drift. `tests/prescribe_ref.py` still runs this rule over those twelve cases, as
a check on the CLI alone.

    PW_ROOT=/tmp/pw sh tests/check.sh

That runs everything a syntax pass cannot: the module parse, the loader, the CLI rule,
free entry, cardio isolation, the day swap, local durability and two years of history.
Playwright is deliberately NOT in `web/package.json` - that file is what Vercel installs -
so install it anywhere (`npm i --prefix /tmp/pw playwright`) and point `PW_ROOT` at it.

## Session protocol

### `/start`
Read the last 14 days of `log.csv`. Create `current_session.md`. Print exactly 3 lines:
sessions in the last 7 days, the two biggest volume gaps, suggested focus. Then stop.
Never open a new session while `current_session.md` exists - ask whether to commit
(`/end`) or discard it.

### Logging - every message during a session is a set
Exercise is **sticky**: once named, every following message belongs to it until a new
exercise is named or `swap to X` is used.

| input | meaning |
|---|---|
| `bench 60x8 @2` | bench_press, 60 kg, 8 reps, RIR 2 |
| `60x8 @2` | same exercise as the previous set |
| `62.5x6` | same exercise, RIR blank |
| `bench 3x8 @60` | 3 sets of 8 at 60 kg -> expand to 3 rows |
| `pullup bw x9` | pullup, weight 0, 9 reps |
| `pullup +10x6` | pullup, added load 10 kg, 6 reps |
| `undo` | drop the last row from the scratch pad |
| `swap to X` | change the sticky exercise to X |

Parsing rules:
- Resolve the typed name through `aliases` in `exercises.yaml`. No match -> say so and
  ask. Do not guess and do not invent a canonical name.
- `NxM` is sets x reps when a weight follows with `@`; `WxR` is weight x reps otherwise.
  Ambiguous -> ask in one line.
- Append to `current_session.md` only. **Never touch `log.csv` mid-session.**
- `set_no` increments per exercise within the session.

### `/end`
Validate every line in the scratch pad. Fail loud and stop on anything malformed - name
the offending line, change nothing. On success: append to `log.csv`, delete
`current_session.md`, print a 4-line summary.

## The feedback contract

This is the whole point of the app. After every logged set, reply with **at most 3 short
lines**:

1. what was recorded
2. the same exercise and set number from the most recent prior session, with the delta -
   `no baseline` if there is none
3. the prescribed load and target reps for the next set, from the progression rule

```
bench_press s2 80x8 @1
last 2026-09-02 s2 80x7 @2  +1 rep
next 80 x8
```

No encouragement. No filler. No emoji. No coaching commentary. Never soften a regression -
`-1 rep` is the whole sentence. Do not run analytics mid-session: line 2 is a lookup in
`log.csv`, not a computation.

## Analytics

All built. Every number below is computed in `analyze.py`, once, and nowhere else -
the web app renders `web/analytics.json` (generated by `analyze.py json`), it never
recomputes a deep metric in JavaScript.

- `python3 analyze.py validate [--log log.csv]` - strict loader, fails loud with file:line
- `python3 analyze.py volume [--window 7]` - hard sets per muscle vs target bands,
  RED / AMBER / GREEN / UNCOVERED
- `python3 analyze.py today [--date YYYY-MM-DD]` - the routine's plan for that day with
  a prescribed load per lift
- `python3 analyze.py prescribe --exercise NAME` - the progression rule for one lift
- `python3 analyze.py progression --exercise NAME` - e1RM trend: best set per session,
  least-squares slope over `analysis.trend_weeks`, kg/week and %/month, r2, NOISY flag
  below `analysis.noisy_r2`. Bodyweight-only sets are excluded; falls back to reps.
- `python3 analyze.py index` - every lift indexed to its own first
  `analysis.baseline_weeks` = 100, rolled up to muscle group weighted by set share
- `python3 analyze.py bridge` - week-over-week volume load (kg lifted), decomposed into
  sets / weight / reps / covar / mix effects. `covar` is the within-week load-rep
  covariance term that makes the identity exact; the residual is asserted to zero and
  the run fails loud if it is not.
- `python3 analyze.py stalls` - no e1RM PR in `analysis.stall_days` days, or a negative
  short-window slope. A deload re-bases the window: performance is judged only against
  sessions since the most recent one, never against a load tier already proven
  unsustainable. One action per flag, always something the progression rule itself can
  produce - never more leg volume.
- `python3 analyze.py balance` - push:pull, quad:hamstring, upper:lower vs
  `balance_bands`
- `python3 analyze.py adherence` - planned sets (from routine.yaml) vs logged, over
  `analysis.adherence_window` days
- `python3 analyze.py plans` - every plan, its lifts and weekly sets, and which is active
- `python3 analyze.py bands [--plan ID]` - the volume bands a plan DELIVERS, as a block
  to paste into `config.yaml`. Bands are derived from the plan they measure, never guessed
- `python3 analyze.py report` - all of the above, in order
- `python3 analyze.py json [--out web/analytics.json]` - the same numbers as one JSON
  blob, consumed by `web/app.js`
- `python3 analyze.py sync --from <store.json> [--apply]` - move finished sessions out of
  the web app's store and into `log.csv`. **Dry run by default**: it prints every row it
  would append and writes nothing. Rows are validated by `load_log` itself - the same
  loader `validate` uses - BEFORE anything is written, so a row that would not load never
  reaches the system of record. It APPENDS, never rewrites. A `(date, exercise)` pair
  already in `log.csv` is skipped WHOLE and reported: the store has no per-set id, so
  there is no way to tell set 3 of a re-opened session from a duplicate of set 3, and a
  silent duplicate in the system of record is far worse than a skip you are told about.
  Two transports, one destination: `--from <store.json>` for the downloaded file, or
  `--rows <file>` for text pasted out of the app's **History -> Copy rows for log.csv**
  (one tap, no file - a download lands somewhere awkward on iOS). Both go through
  `rows_plan()`, so they cannot diverge. Run
  `python3 web/build_data.py` afterwards. Strength and cardio are merged into ONE
  chronological stream before appending, so a cardio row never lands before the strength
  row above it and trips the append-only warning.
- `python3 analyze.py cardio` - weekly cardio minutes and km, and a per-type total.
  **Reported, never inferred from**: no trend, no target band, no verdict. See below.

## The handoff override - 2026-09-27

A design handoff (`Workout_app_design_review.zip`, Nocturne) replaced the web app
wholesale, and the user chose its formulas over `analyze.py`'s where the two disagree.
That choice is recorded here so the repo does not quietly contradict itself. **In
`web/` only** - `analyze.py` and the CLI are untouched and still define the numbers in
this file:

| | `analyze.py` (the CLI, this file) | `web/` since the handoff |
|---|---|---|
| e1RM | `w * (1 + (reps + rir)/30)`, bodyweight sets EXCLUDED | Epley `(w + 78 if bodyweight) * (1 + reps/30)` |
| hard set | any working set; RIR <= 3 when present | RIR <= 2 |
| volume | per-muscle bands DERIVED from `routine.yaml` | flat Missed 0-3 / Minimum 4-9 / Optimal 10-20 / High >20 |
| crediting | 1 to EACH muscle listed | prime mover (`muscles[0]`) only |

Two consequences the user accepted explicitly, having been shown both:

- **The web app will tell you to add leg volume.** Hamstrings sit at 4 sets/week by
  design because of the cycling, and the flat thresholds read that as "Minimum -> add
  2-4 sets a week". The hard rule below still binds ME and the CLI: never recommend
  more leg volume from this log. The app's generic advice is not that recommendation.
- **The two will disagree.** `python3 analyze.py volume` and the app's coverage panel
  measure different things now. That is the override, not a bug - but if a THIRD number
  appears that neither of these tables explains, that is a bug, and say so.

**Two places the handoff was overruled, both because its design cannot serve the rule:**

1. The log sheet opens on `prescribe()`'s answer, not on last session's weight.
2. The sheet has an **RIR row**, which the handoff's two-stepper design did not. Without
   it no load could ever increase - see the Progression rule. Added, not moved: nothing
   was demoted to make room.

The single-implementation rule still holds in spirit: the web derivations live in one
place (`web/app.js`, the section under "the log & derivations") and nowhere else. They
are not duplicated into the renderers.

## The web app

`web/` is the deployed phone app: five tabs - **Session · Cardio · Progress · Plan ·
History** - plus a log-set sheet, a plan switcher, a finish summary, a lift detail and a
library sheet. Static HTML/CSS/ES-module JS, no framework, no build step. It is live at
**https://workoutplan-seven.vercel.app**, deployed from `web/` on every push to the
branch.

| file | role |
|---|---|
| `web/index.html` | the shell: header, tab bar, five empty panels, one overlay slot |
| `web/styles.css` | Nocturne tokens and component classes. **Never hard-code a hex** - use the variables |
| `web/app.js` | the whole app: store, derivations, five renderers, overlays, one delegated event handler |
| `web/data.js` | GENERATED - the library, the plans, the bands and the log.csv rows |
| `web/api/log.js` | the store of record on Vercel, backed by Vercel Blob |
| `web/manifest.webmanifest`, `icon*.png/svg` | installs to the phone home screen |
| `tests/check.sh` | every check a syntax pass cannot do. Run it before pushing `web/` or `analyze.py` |
| `tests/cardio_isolation.py` | cardio reaches `log.csv`, and asserts it cannot reach a strength number |
| `tests/prescribe_*` | twelve cases over `analyze.py`'s progression rule (the CLI's; the app has none) |
| `tests/durability.mjs` | the IndexedDB mirror, recovery from a wiped `localStorage`, and the clipboard rows |
| `tests/day_swap.mjs` | running another day's session today: lifts change, date does not, plan untouched |
| `tests/long_horizon.mjs` | two years of sessions: nothing pruned, every one still readable, 510 KB |
| `tests/free_entry.mjs` | the app proposes no load: empty box, last session shown as reference |
| `tests/unfinished_session.mjs` | a session logged but never finished survives the next day and lands on its own date |
| `tests/no_empty_write.mjs` | a pre-hydrate write cannot empty the log - the loss that actually happened |

### Where a logged session lives

Three layers, and conflating them loses data:

- **Two local stores, not one.** `localStorage` (`strengthlog.v4`) is the write-ahead
  buffer - a set is on disk before anything touches the network, because a gym with no
  signal is the normal case. Every write is ALSO mirrored to IndexedDB under the same
  key, and boot takes whichever copy has the newer `updated_at`. They are separate quota
  and eviction paths, so a cleared `localStorage` recovers from IndexedDB and vice versa;
  only losing both loses the log. `tests/durability.mjs` proves the recovery by wiping
  `localStorage` outright. `navigator.storage.persist()` is requested on boot, which an
  installed PWA is usually granted - the header then reads `on this phone` rather than
  `local only`. If BOTH stores refuse a write the banner says **nothing is saving**,
  because that is the one state the user must not discover later.
  Still one device until the Blob store exists.
  **Nothing is ever pruned.** There is no sync window, no age cutoff and no session cap
  in storage - `state.sessions` keeps every date and `allSets()` iterates all of them, so
  the app's own trends are long-term by construction. Measured: two years of 7-day weeks
  is 731 sessions, 14,208 sets and 418 cardio entries in **510 KB**, against a ~5 MB
  localStorage budget and far more in IndexedDB. Any cap in the UI is a RENDER cap with a
  way past it (History shows 60 and pages back), never a data cap.
  **Show a year on any date that is not in the current year.** A two-year e1RM chart
  labelled `29 Sept -> 29 Sept` reads as one day; `tests/long_horizon.mjs` found that.
- **`/api/log` is the store of record.** One JSON document, GET and PUT. It is what
  makes the log survive a cleared cache and reach a second device. It needs
  `BLOB_READ_WRITE_TOKEN` in the Vercel project; until that exists the route answers
  `{ ok: false, reason: "not_configured" }` and the page **says so on every screen**.
  A store that silently is not there is the one failure mode this app cannot have.
- **`log.csv` is still the append-only system of record** for `analyze.py`. Nothing in
  the app writes to it and nothing ever should: appending to the system of record is a
  deliberate, reviewed act, not a side effect of tapping Finish. The crossing is
  `analyze.py sync` (see Analytics), fed by **History -> Download for log.csv**, dry-run
  first. Until a sync is run the CLI and the app see different histories - say so rather
  than papering over it.

### Rules the UI has to keep

- **One render entry point: `renderAll()`.** Every mutation goes through `setState()`,
  which persists and re-renders everything. Two tabs reading one state at different
  moments is how Plan and Today came to disagree in the previous app.
- **An emptier document may NEVER overwrite a fuller one.** `persist()` refuses to write
  when the stored copy has sessions and the one being written has none, and re-hydrates
  from storage instead; `force: true` is the only way past it, used by the deliberate
  discards. Nothing is written at all before boot has hydrated (`booted`), and boot now
  READS THE LOG FIRST - `askPersist()` is slow on a phone and nothing depends on its
  answer, so it no longer sits in front of the read.
  This is the last step of every way this app has lost data, which is why the guard lives
  here rather than at each cause. The one that actually bit: `addEventListener("online",
  () => persist())` - a network-state change, constant on a phone in a gym - firing
  before hydrate and writing `sessions: {}` over the real log in BOTH stores. Proven with
  a slowed boot: without the guard `["2026-09-29"]` becomes `[]`.
  Asserted by `tests/no_empty_write.mjs`.
- **A live session is NEVER dropped by a load, whatever its date.** `hydrate()` restored
  `live` only when `doc.live.date === today()`, so sets logged and not Finished were
  silently discarded the next morning - and the empty replacement was then persisted over
  them in BOTH stores. That is destruction of data already on disk, and it was reported
  as "my logged workout from yesterday is missing". Now: `live` is restored whatever its
  date; a stale one WITH sets holds the Session tab on its own date behind a loud banner
  offering **Finish** (writes under that date, not today) or **Discard** (armed, two
  taps); an empty one is still just cleared. Today's session cannot start until it is
  resolved, so nothing lands on the wrong date. Asserted by `tests/unfinished_session.mjs`.
- **Finishing a session must be idempotent.** `finish()` moves the sets out of the live
  session and into `sessions` in the same breath and renders the summary from its own
  snapshot. Pressing Finish twice must never log the session twice.
- **The baseline is read BEFORE the session joins the log**, or every lift measures
  itself against the sets just logged and every delta reads "held".
- **Free entry: the app proposes no load.** The weight box opens EMPTY on the first set
  of a lift and takes any number you type. In its place the sheet shows **last session's
  actual sets for that lift**, RIR and all - the reference, not a proposal. Within a
  session set 2 opens on set 1's numbers, which is not proposing a load, it is not making
  you retype what you just entered. Do not reintroduce a suggested weight, from a rule or
  from last week's number: it was removed on purpose.
- **Today can run another day's session.** A skipped day is the normal case in a 7-day
  week, so the Session tab has a day chip: pick any weekday and today runs THAT day's
  lifts. It is session-scoped, like the reorder and the ad-hoc "+1 set" - `live.dayKey`,
  never the plan. The sets still log under TODAY's real date, because that is when they
  happened: a Monday session done on Tuesday reads as Monday unmet and chest logged on
  Tuesday, which is the truth and what `adherence` should see. The kicker and the chip
  both say so when the day is shifted. A lift with sets already logged today that the
  chosen day does not contain still shows, or switching would hide sets about to be
  written. Asserted by `tests/day_swap.mjs`.
- **RIR is recorded, and never defaulted.** It feeds e1RM and the hard-set count, which
  is why it is still captured now the app proposes nothing. It is sticky per lift - one
  tap per exercise, not per set. Never default it to a number the user did not press.
- **A lift you add is loggable immediately.** Nothing has to be set up first, because
  nothing is prescribed. Only a lift that is in neither the library nor `state.custom` is
  refused, and the Session row says `not in library` rather than waiting until you tap
  it. The Plan tab's `new` tag sits BESIDE the name, never inside `.nm`, which truncates
  with an ellipsis and was swallowing it on any long lift name.
  `Export routine.yaml` emits a stub with `increment: ?` - it claims nothing, and says
  the value is only needed if you want `analyze.py` to prescribe.
- **The Plan day strip shows DATES, and the set count carries its unit.** It first
  shipped as a weekday over the week's set count - `MON 24 / TUE 28 / WED 24` - and was
  reported as "the dates are random", correctly: two digits under a weekday name is read
  as a date by everyone, and set counts do not ascend. The date shown is the NEXT
  occurrence of that weekday, counting today as itself, because on a Sunday "this week's
  Monday" is six days in the PAST and tomorrow would never be marked. Today and tomorrow
  are tagged on the strip. Any figure that could be mistaken for a date needs its unit.
- **Touch targets are 44px, and the destructive control is armed.** The row's `x` takes
  two taps and sits clear of the `+` beside it. Both were got wrong before.
- **A design change may not move or hide a control** - see Hard rules.
- **`node --check` is not enough for `web/app.js`.** Use
  `node --input-type=module --check < web/app.js`, then load the page in a browser and
  assert each `#p-<Tab>` has children: a thrown error inside a render leaves a blank tab
  with nothing in the terminal to show it.
- **`[hidden]` needs its explicit rule in `styles.css`**, and a file input is never
  inside a hidden container.

### Not designed yet

The handoff flags these and they were NOT invented: auth/onboarding, a settings screen
(body weight is hard-coded at 78 kg, units, band editing), a rest timer, and the
`routine.yaml` import path. Ask before adding any of the rest.

Three things WERE added beyond the handoff, each because the app is unusable or dishonest
without it: empty states and the local-only banner (`log.csv` is empty and there is no
store yet), the RIR row (no load could otherwise ever increase), and
**History -> Copy rows for log.csv** (the only way sessions can reach `analyze.py`).

### The published Artifact

`artifact.html` and `build_artifact.py` build the claude.ai copy of the PREVIOUS
three-tab app. They are stale as of this handoff and the artifact still runs the old
code. Rebuild them or retire them deliberately - do not assume the live artifact matches
`web/`.

## `seed_example.py` is broken, and was before the handoff

`python3 seed_example.py` dies with `KeyError: 'seated_chest_press_machine'`. Its
`START_LOAD` table knows 15 lifts; the routine now plans 29, so **16 are missing** - it
has been broken since the gym80 machines were added on 2026-09-11/12 and nobody re-ran
it. Confirmed against an unmodified checkout, so it is not fallout from the redesign.

Consequence: `log.example.csv` cannot currently be regenerated. When the cardio columns
were added on 2026-09-27 it was migrated in place instead - two empty fields appended to
each of its 883 rows, no value invented. That is acceptable for a generated demo file and
would not be for `log.csv`.

Fixing it means choosing a plausible start load for 16 machines. Those are demo numbers
and not prescriptions, so the "never guess an increment" rule does not bite - but they
are still invented, so ask before adding them rather than filling the table in quietly.

## Free entry - 2026-09-30

The app proposed a load for one day, and briefly did it by assuming a 5 kg increment for
any lift the app invented. Both are gone. The sequence is worth keeping because the
reasoning is:

1. A lift the app invented had no `increment`, so it could not be prescribed for, so it
   could not be logged. That bill arrived at 05:06 in a gym, four lifts into a session.
2. The stopgap was a 5 kg default, labelled `assumed` everywhere it appeared.
3. Then the real question: **why does the app need to propose a weight at all?**
   It does not. Logging was ALWAYS free entry - `#s-w` is a plain decimal input and the
   steppers move a flat 2.5 kg. `increment` only ever decided how much the rule ADDED on
   a progression. Remove the proposal and the increment, the default, the assumption
   labels and the app-vs-CLI cross-check all become unnecessary at once.

So: **the weight box opens empty, and last session's real sets are shown instead.** The
value of this app is the tracking and the analysis, not telling you what to lift.

Still true: 21 gym80 machines carry `increment: 5   # UNVERIFIED` in `exercises.yaml`.
They now affect only `analyze.py prescribe()`, and nothing in the app. Correct them if
the CLI's prescription ever matters; otherwise they are inert.

## Cardio - recorded, not yet trusted

The schema, the library entries (`treadmill`, `bike`, `elliptical`, `outdoor_run`, all
marked `cardio: true`), the sync path and `analyze.py cardio` all exist as of
2026-09-27. What does NOT exist is permission to conclude anything from them.

The reason is completeness, not principle. The training context is 30-50 km/week of
cycling and running; the app captures gym cardio plus an outdoor run. **A partial cardio
record that looked authoritative would be worse than none** - it would show lightly
loaded legs, and every derivation built on it would be confidently wrong. So until the
record is complete enough to trust:

- cardio reaches no strength derivation (structurally - see Metrics),
- the lower-body bands stay conservative,
- the two failing balance bands stay as they are,
- and **the leg-volume hard rule is untouched**. "There is cardio in the log now" is not
  an argument against it; a complete record of what the legs actually carry would be.

Revisit after about four weeks of consistent logging. If the record is real by then,
rederive the lower-body bands and judge those balance bands against something true. If
it is patchy, say so and keep the honest blind spot.

`cardio: true` entries in `exercises.yaml` carry NO `muscles`, `increment` or
`rep_range`, and `load_exercises()` refuses an entry that declares both. That is what
makes "no prescription for cardio" structural rather than a convention. `build_data.py`
leaves them out of `web/data.js` entirely, so a cardio lift cannot be planned in the app.

## Volume accounting

`muscles` in `exercises.yaml` are **prime movers only**. A set credits 1 to each muscle
listed and nothing to anything else. Two entries only where a lift is genuinely
co-primary (dips, rows, squats, RDLs). Indirect work is real but uncounted, which is why
the bands in `config.yaml` sit below the numbers the literature quotes - triceps and front
delts already get plenty from pressing. Do not raise the bands to match a paper that
counts indirect stimulus.

Lower-body bands are deliberately conservative because of the cycling - that holds even
now quads are trained directly.

## Hard rules

- `log.csv` history is **immutable**. Corrections are stated out loud, one row at a time,
  and never made silently or in bulk.
- Never prescribe a load the progression rule does not produce - and in `web/`, never
  prescribe one at all. Free entry was chosen deliberately; see the Progression rule.
- Never add an exercise to `exercises.yaml`, or remove a muscle's only routine lift,
  without asking first. A provisional lift in the web app is not an exception - it is
  what asking looks like when there is no repo to hand.
- **Never guess an `increment` in `exercises.yaml`** - a value written to the repo is a
  claim someone read it off the machine. The app no longer needs one at all, so there is
  nothing to unblock by guessing. `increment` now matters only to `analyze.py`.
- If a metric is not built, **say so**. Never compute it ad hoc from the CSV - and if a
  new metric is added, it goes in `analyze.py` first, never only in `web/app.js`.
  Since the handoff override the web app recomputes its OWN metrics from the set log by
  its own formulas; that is a declared, documented divergence, not a licence to invent a
  third number in a renderer.
- Never recommend more leg volume on the basis of this log alone. The cycling and
  running are not in it, so this log cannot see what the legs already carry. That the
  user has since chosen to add a leg day does not license recommending more.
  `calves` is uncovered by design; its report line is UNCOVERED, never RED. The web
  app's Focus-next cards WILL say "add 2-4 sets a week" for hamstrings, because the
  user chose the handoff's flat thresholds knowing that - see The handoff override.
  That is the app talking, not this rule being relaxed.
- **No analytic may be indexed off the ACTIVE plan.** Trends, the index, the bridge,
  stalls and balance read `log.csv` alone and must keep doing so; anything that iterates
  lifts iterates `all_lifts()` (every plan) plus what the log holds. A lift dropping out
  of Trends because a plan changed is a bug, not a filter.
- **A design change may not move or hide a control.** It may reorder cards, retype a
  label, restyle a component, or ADD a readout. It may not demote what someone reaches
  for by habit, and it may not change the interaction model - those are product changes
  and have to be asked for in those words. A UX review saying "remove X" is evidence X
  is badly placed, not permission to move it. Learned by doing it wrong: a review was
  implemented as two eight-item passes, Today became a one-set-at-a-time view with the
  flat list behind a tap, and the whole thing was reverted. Work a review ITEM BY ITEM,
  agreeing each before building it.
- **A file input is never inside a hidden container.** Off-screen and in layout, always.
  A file input inside `[hidden]` or `display:none` does not reliably open the picker on
  iOS, even behind its label. This has broken once.
- **`[hidden]` needs an explicit rule in `styles.css`.** The published Artifact's wrapper
  supplies `[hidden]{display:none!important}`; a local copy of the page does not, so a
  `display:flex` element ignores the attribute entirely and a local test disagrees with
  the bundle.
- **`node --check` is not enough for `web/app.js`.** It parses the file as CommonJS and
  will pass a module-level syntax error that stops the whole page loading. Use
  `node --input-type=module --check < web/app.js`, and load the page in a browser and
  assert every `#p-<Tab>` panel has children - a thrown error inside a render leaves the
  tab blank with nothing in the terminal to show it.
- **Touch targets in the row controls are 44px tall, and never smaller.** They were 28px,
  which reads in a test as working and on a phone as broken. A destructive control (the
  row's `x`) is kept clear of a frequently used one and confirms before acting.
- **The store must never fail silently.** If `/api/log` is not configured or cannot be
  reached, the page says `local only` in the header and carries a banner on every
  screen. A log that quietly does not save is worse than one that refuses to.
- `web/data.js` and `web/analytics.json` are generated files. Never hand-edit them -
  run `python3 web/build_data.py` after changing `exercises.yaml`, `config.yaml`,
  `routine.yaml` or `log.csv`.
- `web/build_data.py` builds from `log.csv`, the real log, empty or not. `--example`
  builds the demo from `log.example.csv` - never deploy that build. Seeding the live app
  with generated history puts a "last week" number on every lift that never happened,
  which is the one thing this log exists not to do.
