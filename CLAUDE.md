# Strength log - operating instructions

Personal strength-training log and analytics. Logged SET BY SET on a phone, mid-session,
inside Claude Code. Every interaction is optimised for that: terse input, one-line output.

Training context: 3x/week, full gym, hypertrophy + robustness. 30-50 km/week cycling and
running that this log never sees. Legs are already loaded by that cardio.

## Files

| file | role |
|---|---|
| `CLAUDE.md` | these instructions |
| `log.csv` | append-only system of record, one row per working set |
| `current_session.md` | scratch pad for the session in progress (untracked) |
| `exercises.yaml` | exercise library - canonical names, aliases, increments, rep ranges |
| `config.yaml` | volume target bands, progression rule, thresholds |
| `analyze.py` | all analytics |
| `log.example.csv` | 3 seeded sessions so analytics run before the first real one |

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

Built:
- `python3 analyze.py validate [--log log.csv]` - strict loader, fails loud with file:line
- `python3 analyze.py volume [--window 7]` - hard sets per muscle vs target bands,
  RED / AMBER / GREEN

Not built yet - these raise `NotImplementedError` carrying their full spec:
`prescribe`, `progression`, `index`, `bridge`, `stalls`, `balance`.

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
- Never add an exercise to `exercises.yaml` without asking first.
- If a metric is not built yet, **say so**. Never compute it ad hoc from the CSV.
- Never recommend more leg volume on the basis of this log alone. The cycling and running
  are not in it.
