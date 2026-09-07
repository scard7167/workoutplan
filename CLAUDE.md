# Strength log - operating instructions

Personal strength-training log, plan and analytics. Logged SET BY SET on a phone,
mid-session, inside Claude Code. Every interaction is optimised for that: terse input,
one-line output.

Training context: 7 short strength sessions/week, full gym, hypertrophy + robustness,
alongside 30-50 km/week cycling and running that this log never sees. Recovery is the
binding constraint, not gym time - sessions run 10-12 working sets, not 20+. Legs are
already loaded by the cardio; quads and calves are uncovered by design (see
`uncovered_by_design` in config.yaml) and are never a reason to add leg work here.

## Files

| file | role |
|---|---|
| `CLAUDE.md` | these instructions |
| `log.csv` | append-only system of record, one row per working set |
| `current_session.md` | scratch pad for the session in progress (untracked) |
| `exercises.yaml` | exercise library - canonical names, aliases, increments, rep ranges |
| `routine.yaml` | the plan - which lifts, how many sets, on which day. Source of truth for "what should happen"; bands in config.yaml are derived from it |
| `config.yaml` | volume target bands (derived from routine.yaml), progression rule, thresholds |
| `analyze.py` | all analytics: loader, volume, prescribe, progression, index, bridge, stalls, balance, adherence |
| `seed_example.py` | regenerates `log.example.csv` by running `prescribe()` forward 12 weeks - the example log is real output of the real rule, not hand-typed |
| `log.example.csv` | 12 weeks of generated history, for DEMOING the analytics. Never what gets deployed - see below |
| `web/` | phone-first prototype UI (Today / Trends / Plan). See **The web app** below |

## Schema

```
date,type,exercise,set_no,weight_kg,reps,rir,notes
```

- `date` ISO `YYYY-MM-DD`.
- `type` `strength` | `cardio`. Cardio is unused in v1; the column exists so adding it
  later is not a migration. The loader rejects `cardio` rows today.
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
- **Windows** = rolling 7 and 14 days back from the last logged date. Not calendar weeks.

These definitions live here and in `analyze.py`. If they ever disagree, that is a bug -
say so, do not pick one.

## The routine - the only source of "what should happen"

`routine.yaml` names the lifts and, per weekday, how many sets of each. It is the plan;
`log.csv` is what actually happened. `config.yaml`'s `volume_targets` are DERIVED from
the routine - the target is what the routine delivers when followed as written, min/max
are tolerance either side. Change the routine and the bands move with it, never the
other way. `quads` and `calves` have no routine lift and are marked
`uncovered_by_design`: reported, never flagged RED, never a reason to add leg work.

Editing the routine (in `routine.yaml` directly, or in the web app's Plan tab, exported
and pasted back) requires asking first if it removes a muscle's only lift - the same
bar as adding an exercise to the library. A lift the Plan tab invented is *provisional*
until that paste happens - see **The web app**.

## Progression rule - the only source of load prescriptions

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

No load ever comes from anywhere else. Not from feel, not from a round number, not from
what the plates suggest. If the rule produces 62.5 kg, the prescription is 62.5 kg.

`analyze.py prescribe()` is the programmatic statement of this rule and is **not built
yet**. Mid-session, apply the rule above as a lookup against `current_session.md` and the
most recent prior session in `log.csv` - that is arithmetic on two numbers, not analytics.
When `prescribe()` lands it must produce identical output; it is the referee.

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
- `python3 analyze.py report` - all of the above, in order
- `python3 analyze.py json [--out web/analytics.json]` - the same numbers as one JSON
  blob, consumed by `web/app.js`

## The web app

`web/` is a static page - no server, no database. It renders `web/data.js` and
`web/analytics.json`, both generated. It never recomputes a deep metric in JavaScript;
the only arithmetic it does itself is the live session (today's volume, and the
progression rule for a lift Python has not seen yet), against the same rule.

Two copies exist and they are not equally capable:

- the **published Artifact**, opened inside claude.ai, where `window.claude` grants the
  page the `sample` capability - it can ask Claude, with images, on the viewer's account
- **any other copy** (Vercel, `file://`), where there is no model behind the page at all

Every model-backed feature must degrade to the second case, silently and by default.

### Provisional exercises

The Plan tab's exercise field takes free text, and the photo dump proposes machines from
photos. Both can produce a lift that is not in `exercises.yaml`. Such a lift is
**provisional**: it lives in `localStorage` under `strengthlog.provisional.v1`, in that
browser and nowhere else.

A provisional lift can be planned. It cannot be prescribed for and cannot be logged
until it has `muscles`, `rep_range` and `increment`, because those decide every load it
will ever be given - `prescribe()` returns `needs setup`, the weight boxes are disabled,
and `Export routine.yaml` refuses outright rather than emit a routine `analyze.py` would
reject. **`increment` is never guessed**, by the page or by the model reading the photo:
it is filled in only where it was actually legible, and is otherwise left blank for a
human. A wrong increment is silent and permanent; a refused export costs a minute.

Export carries a provisional lift out as a commented `exercises.yaml` stub above the
routine. Pasting both blocks is what makes it real - the same bar as any other library
edit, and still a decision a human makes in the repo.

## Volume accounting

`muscles` in `exercises.yaml` are **prime movers only**. A set credits 1 to each muscle
listed and nothing to anything else. Two entries only where a lift is genuinely
co-primary (dips, rows, squats, RDLs). Indirect work is real but uncounted, which is why
the bands in `config.yaml` sit below the numbers the literature quotes - triceps and front
delts already get plenty from pressing. Do not raise the bands to match a paper that
counts indirect stimulus.

Lower-body bands are deliberately conservative because of the cycling.

## Hard rules

- `log.csv` history is **immutable**. Corrections are stated out loud, one row at a time,
  and never made silently or in bulk.
- Never prescribe a load the progression rule does not produce.
- Never add an exercise to `exercises.yaml`, or remove a muscle's only routine lift,
  without asking first. A provisional lift in the web app is not an exception - it is
  what asking looks like when there is no repo to hand.
- Never guess an `increment`. Not in the library, not in a photo scan, not to unblock an
  export. Read it off the machine or leave it blank.
- If a metric is not built, **say so**. Never compute it ad hoc from the CSV - and if a
  new metric is added, it goes in `analyze.py` first, never only in `web/app.js`.
- Never recommend more leg volume on the basis of this log alone. `quads` and `calves`
  are uncovered by design; their report line is UNCOVERED, never RED.
- `web/data.js` and `web/analytics.json` are generated files. Never hand-edit them -
  run `python3 web/build_data.py` after changing `exercises.yaml`, `config.yaml`,
  `routine.yaml` or `log.csv`.
- `web/build_data.py` builds from `log.csv`, the real log, empty or not. `--example`
  builds the demo from `log.example.csv` - never deploy that build. Seeding the live app
  with generated history puts a "last week" number on every lift that never happened,
  which is the one thing this log exists not to do.
