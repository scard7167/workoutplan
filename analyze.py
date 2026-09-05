#!/usr/bin/env python3
"""Analytics for the strength log. stdlib + pyyaml only.

Usage:
    python3 analyze.py validate [--log log.csv]
    python3 analyze.py volume   [--log log.csv] [--window 7]

Not built yet (each raises NotImplementedError with its full spec):
    prescribe, progression, index, bridge, stalls, balance

Metrics are defined once, here and in CLAUDE.md, and must agree:
    e1RM     = weight_kg * (1 + (reps + rir) / 30); blank RIR treated as 1
    hard set = any working set; if RIR is present, only RIR <= 3 counts
    windows  = rolling 7 and 14 days back from the last logged date, not calendar weeks
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import os
import sys
from dataclasses import dataclass
from typing import Iterable

import yaml

HEADER = ["date", "type", "exercise", "set_no", "weight_kg", "reps", "rir", "notes"]
VALID_TYPES = {"strength", "cardio"}
MUSCLES = [
    "chest", "lats", "upper_back", "front_delts", "side_delts", "rear_delts",
    "biceps", "triceps", "quads", "hamstrings", "glutes", "calves", "core",
]

HERE = os.path.dirname(os.path.abspath(__file__))


class LogError(Exception):
    """Raised on any malformed input. Always names the offending line."""


@dataclass(frozen=True)
class Set:
    line: int
    date: dt.date
    type: str
    exercise: str
    set_no: int
    weight_kg: float
    reps: int
    rir: int | None
    notes: str

    @property
    def e1rm(self) -> float:
        """weight_kg * (1 + (reps + rir) / 30). Blank RIR treated as 1.

        Meaningless for bodyweight-only sets (weight_kg == 0) - callers that build
        trends must exclude them. Never compare raw e1RM across different exercises.
        """
        rir = 1 if self.rir is None else self.rir
        return self.weight_kg * (1 + (self.reps + rir) / 30)

    def is_hard_set(self, hard_set_rir: int) -> bool:
        return self.rir is None or self.rir <= hard_set_rir


# --------------------------------------------------------------------------- #
# loading
# --------------------------------------------------------------------------- #

def load_config(path: str | None = None) -> dict:
    path = path or os.path.join(HERE, "config.yaml")
    with open(path) as fh:
        cfg = yaml.safe_load(fh)
    missing = [m for m in MUSCLES if m not in cfg["volume_targets"]]
    if missing:
        raise LogError(f"config.yaml: volume_targets missing muscles: {missing}")
    unknown = [m for m in cfg["volume_targets"] if m not in MUSCLES]
    if unknown:
        raise LogError(f"config.yaml: volume_targets has unknown muscles: {unknown}")
    for m, band in cfg["volume_targets"].items():
        if not (band["min"] <= band["target"] <= band["max"]):
            raise LogError(f"config.yaml: {m} band is not min <= target <= max: {band}")
    return cfg


def load_exercises(path: str | None = None) -> dict:
    path = path or os.path.join(HERE, "exercises.yaml")
    with open(path) as fh:
        lib = yaml.safe_load(fh)
    seen_alias: dict[str, str] = {}
    for name, ex in lib.items():
        for key in ("aliases", "muscles", "increment", "rep_range"):
            if key not in ex:
                raise LogError(f"exercises.yaml: {name} is missing '{key}'")
        bad = [m for m in ex["muscles"] if m not in MUSCLES]
        if bad:
            raise LogError(f"exercises.yaml: {name} lists unknown muscles {bad}")
        floor, ceiling = ex["rep_range"]
        if floor > ceiling:
            raise LogError(f"exercises.yaml: {name} rep_range floor > ceiling")
        if ex["increment"] <= 0:
            raise LogError(f"exercises.yaml: {name} increment must be > 0")
        for alias in list(ex["aliases"]) + [name]:
            alias = alias.lower().strip()
            prior = seen_alias.get(alias)
            if prior and prior != name:
                raise LogError(
                    f"exercises.yaml: alias '{alias}' is claimed by both {prior} and {name}"
                )
            seen_alias[alias] = name
    return lib


def resolve_exercise(token: str, lib: dict) -> str | None:
    """Canonical name for what was typed at the rack, or None if unknown."""
    return _alias_map(lib).get(token.lower().strip())


def _alias_map(lib: dict) -> dict[str, str]:
    out: dict[str, str] = {}
    for name, ex in lib.items():
        out[name.lower()] = name
        for alias in ex["aliases"]:
            out[alias.lower().strip()] = name
    return out


def load_log(path: str, lib: dict, cfg: dict) -> list[Set]:
    """Strict loader. Fails loud on the first offending line, naming file:line.

    Validates: exact header, field count, ISO date, type in {strength,cardio},
    exercise present in the library as a canonical name (never an alias, never free
    text), set_no >= 1 and unique within (date, exercise), weight_kg >= 0,
    reps >= 1, rir blank or 0-4. Out-of-order dates are a warning, not an error -
    a backfilled session is legitimate; a rewritten one is not.
    """
    if not os.path.exists(path):
        raise LogError(f"{path}: no such file")

    rows: list[Set] = []
    with open(path, newline="") as fh:
        reader = csv.reader(fh)
        try:
            header = next(reader)
        except StopIteration:
            raise LogError(f"{path}: file is empty, expected header {','.join(HEADER)}")
        if header != HEADER:
            raise LogError(
                f"{path}:1 header is {header!r}, expected {HEADER!r}"
            )
        for lineno, row in enumerate(reader, start=2):
            if not row or all(not c.strip() for c in row):
                continue
            where = f"{path}:{lineno}"
            if len(row) != len(HEADER):
                raise LogError(
                    f"{where} has {len(row)} fields, expected {len(HEADER)}: {row!r}"
                )
            date_s, type_s, ex_s, set_s, w_s, reps_s, rir_s, notes = [c.strip() for c in row]

            try:
                date = dt.date.fromisoformat(date_s)
            except ValueError:
                raise LogError(f"{where} date {date_s!r} is not ISO YYYY-MM-DD")

            if type_s not in VALID_TYPES:
                raise LogError(f"{where} type {type_s!r} not in {sorted(VALID_TYPES)}")

            if type_s == "cardio":
                raise LogError(
                    f"{where} type 'cardio' is not supported in v1 - the column exists "
                    "only to avoid a later migration"
                )

            if ex_s not in lib:
                hint = resolve_exercise(ex_s, lib)
                extra = f" (did you mean {hint}?)" if hint else ""
                raise LogError(
                    f"{where} exercise {ex_s!r} is not a canonical name in "
                    f"exercises.yaml{extra}"
                )

            set_no = _int(set_s, where, "set_no", lo=1)
            reps = _int(reps_s, where, "reps", lo=1, hi=100)
            rir = None if rir_s == "" else _int(rir_s, where, "rir", lo=0, hi=4)

            try:
                weight = float(w_s)
            except ValueError:
                raise LogError(f"{where} weight_kg {w_s!r} is not a number")
            if weight < 0:
                raise LogError(f"{where} weight_kg {weight} is negative")
            if weight == 0 and not lib[ex_s].get("bodyweight"):
                raise LogError(
                    f"{where} weight_kg 0 but {ex_s} is not a bodyweight exercise"
                )

            rows.append(Set(lineno, date, type_s, ex_s, set_no, weight, reps, rir, notes))

    _check_duplicates(rows, path)
    _warn_out_of_order(rows, path)
    return rows


def _int(raw: str, where: str, field: str, lo: int | None = None, hi: int | None = None) -> int:
    try:
        val = int(raw)
    except ValueError:
        raise LogError(f"{where} {field} {raw!r} is not an integer")
    if lo is not None and val < lo:
        raise LogError(f"{where} {field} {val} is below {lo}")
    if hi is not None and val > hi:
        raise LogError(f"{where} {field} {val} is above {hi}")
    return val


def _check_duplicates(rows: Iterable[Set], path: str) -> None:
    seen: dict[tuple[dt.date, str, int], int] = {}
    for s in rows:
        key = (s.date, s.exercise, s.set_no)
        if key in seen:
            raise LogError(
                f"{path}:{s.line} duplicate set: {s.exercise} set {s.set_no} on "
                f"{s.date} already logged at line {seen[key]}"
            )
        seen[key] = s.line


def _warn_out_of_order(rows: list[Set], path: str) -> None:
    for prev, cur in zip(rows, rows[1:]):
        if cur.date < prev.date:
            print(
                f"WARNING {path}:{cur.line} date {cur.date} precedes {prev.date} on the "
                "previous line - log.csv is append-only, check this was a backfill",
                file=sys.stderr,
            )
            return


# --------------------------------------------------------------------------- #
# windows and volume
# --------------------------------------------------------------------------- #

def window(rows: list[Set], days: int, end: dt.date | None = None) -> list[Set]:
    """Rolling window of `days` ending at `end` (default: last logged date)."""
    if not rows:
        return []
    end = end or max(s.date for s in rows)
    start = end - dt.timedelta(days=days - 1)
    return [s for s in rows if start <= s.date <= end]


def volume_by_muscle(rows: list[Set], lib: dict, cfg: dict) -> dict[str, int]:
    """Hard sets credited per muscle. A set credits 1 to each prime mover listed."""
    thr = cfg["metrics"]["hard_set_rir"]
    out = {m: 0 for m in MUSCLES}
    for s in rows:
        if not s.is_hard_set(thr):
            continue
        for m in lib[s.exercise]["muscles"]:
            out[m] += 1
    return out


def flag(count: int, band: dict) -> str:
    """RED below min or above max, AMBER between min and target, GREEN in band."""
    if count < band["min"] or count > band["max"]:
        return "RED"
    if count < band["target"]:
        return "AMBER"
    return "GREEN"


def report_volume(rows: list[Set], lib: dict, cfg: dict, days: int) -> int:
    if not rows:
        print("log is empty - nothing to report")
        return 0
    end = max(s.date for s in rows)
    win = window(rows, days, end)
    counts = volume_by_muscle(win, lib, cfg)
    scale = days / 7
    sessions = len({s.date for s in win})

    print(f"VOLUME  rolling {days}d to {end}  |  {sessions} sessions, {len(win)} working sets")
    print(f"{'muscle':<12}{'sets':>5}  {'band (min/target/max)':<22}{'flag':<7}vs target")
    print("-" * 62)
    gaps: list[tuple[float, str]] = []
    for m in MUSCLES:
        band = {k: v * scale for k, v in cfg["volume_targets"][m].items()}
        n = counts[m]
        f = flag(n, band)
        delta = n - band["target"]
        bandtxt = f"{band['min']:g}/{band['target']:g}/{band['max']:g}"
        print(f"{m:<12}{n:>5}  {bandtxt:<22}{f:<7}{delta:+.0f}")
        if f != "GREEN":
            gaps.append((delta, m))

    reds = [m for m in MUSCLES if flag(counts[m], {k: v * scale for k, v in cfg["volume_targets"][m].items()}) == "RED"]
    print("-" * 62)
    if reds:
        print("RED: " + ", ".join(reds))
    else:
        print("RED: none")
    under = sorted((g for g in gaps if g[0] < 0))[:2]
    if under:
        print("biggest gaps: " + ", ".join(f"{m} {d:+.0f}" for d, m in under))
    lower = {"quads", "hamstrings", "glutes", "calves"}
    if lower & set(reds):
        print(
            "note: lower-body flags are informational only - cycling and running load "
            "is not in this log. Do not add leg volume on the basis of this report."
        )
    return 0


# --------------------------------------------------------------------------- #
# not built yet
# --------------------------------------------------------------------------- #

def prescribe(rows: list[Set], exercise: str, lib: dict, cfg: dict) -> dict:
    """NOT IMPLEMENTED. Deterministic next load and target reps for one exercise.

    Spec (double progression; this function is the programmatic statement of the only
    load rule in the project, and must agree exactly with the rule in CLAUDE.md and
    config.yaml -> progression):

    Inputs:  all rows for `exercise`, ordered by date; the library entry (increment,
             rep_range [floor, ceiling], bodyweight flag); config progression block
             (rir_ceiling, deload_pct, deload_rounding).
    Output:  {"exercise", "weight_kg", "target_reps", "reason", "basis_date"}.

    Algorithm:
      1. Take the MOST RECENT session for the exercise (all working sets on that date).
         No prior session -> return {"weight_kg": None, "target_reps": floor,
         "reason": "no baseline"}. Never invent a starting load.
      2. Deload check first. If ANY set in that session had reps < floor AND rir == 0,
         return weight = last session's load * (1 - deload_pct), rounded DOWN to a
         multiple of increment (deload_rounding), target_reps = floor,
         reason = "deload".
      3. Increase check. If EVERY working set in that session hit reps >= ceiling AND
         rir <= rir_ceiling (blank RIR does NOT satisfy this - it is unverified),
         return weight = last load + increment, target_reps = floor, reason = "progress".
      4. Otherwise hold: weight = last load, target_reps = min(ceiling,
         max reps achieved in the last session + 1), reason = "hold, add reps".
      5. Bodyweight exercises: weight_kg is ADDED load. Step 3 on a 0 kg entry returns
         weight = increment (i.e. first added load). Step 2 on a 0 kg entry cannot
         deload below 0 - return 0 with reason "deload floor: bodyweight only, drop
         reps target instead".
      6. If the last session used two different loads for the same exercise (a
         mid-session deload), the load carried forward is the LAST set's load.

    Mid-session prescriptions are NOT produced by this function - see CLAUDE.md: during
    a session the same rule is applied as a lookup against current_session.md and the
    last prior session, never as an analytics run. Both paths must produce the same
    number; if they ever disagree, this function is the referee.
    """
    raise NotImplementedError(prescribe.__doc__)


def exercise_progression(rows: list[Set], exercise: str, lib: dict, cfg: dict) -> dict:
    """NOT IMPLEMENTED. e1RM trend for one exercise.

    Spec:
      - Filter to `exercise`. Exclude bodyweight-only sets (weight_kg == 0): e1RM is 0
        for them and would fake a trend. If ALL sets are bodyweight-only, return
        {"basis": "reps_only"} plus best reps per session, and no slope.
      - Best set per session = the set with the highest e1RM on that date. Emit one
        point per session: (date, best_e1rm, weight_kg, reps, rir, set_no).
      - Least-squares slope of best_e1rm on days-since-first-session, over the last
        config.analysis.trend_weeks (8) weeks. Require >= 4 session points; fewer ->
        {"slope": None, "reason": "insufficient data (n sessions)"}.
      - Report slope as kg/week (slope * 7) and as %/month relative to the fitted value
        at the window start (slope * 30 / intercept_at_window_start * 100).
      - Also return: n_sessions, first/last session date, best e1RM ever and its date,
        r_squared of the fit (a slope with r2 < 0.3 must be labelled noisy).
      - Never compare raw e1RM across different exercises. This function returns one
        exercise only, by design.
    """
    raise NotImplementedError(exercise_progression.__doc__)


def strength_index(rows: list[Set], lib: dict, cfg: dict) -> dict:
    """NOT IMPLEMENTED. Index every exercise to its own baseline = 100, roll up to muscle.

    Spec:
      - Per exercise: baseline = mean of best-set e1RM over the exercise's first
        config.analysis.baseline_weeks (4) weeks of logged history, counted from that
        exercise's FIRST logged date, not the log's first date. Require >= 2 sessions
        in the baseline period; otherwise the exercise is "unindexed" and is excluded
        from roll-ups (say so in the output, do not silently drop it).
      - index_t = best-set e1RM in period t / baseline * 100.
      - Bodyweight-only exercises have no e1RM: index them on best reps per session
        instead, same formula, and mark them basis="reps" in the output so the two are
        never presented as the same measurement.
      - Muscle roll-up: for each muscle, weighted mean of its exercises' indices,
        weighted by that exercise's share of hard sets credited to that muscle in the
        period. Co-primary exercises contribute to both muscles at full weight, the
        same way volume is credited.
      - Return: per-exercise {index, basis, baseline_e1rm, n_sessions} and per-muscle
        {index, weight_source_exercises, coverage} for the requested period
        (default: rolling 28 days) plus the prior period for comparison.
      - An index is meaningless without its baseline date range - always return it.
    """
    raise NotImplementedError(strength_index.__doc__)


def volume_load_bridge(rows: list[Set], lib: dict, cfg: dict) -> dict:
    """NOT IMPLEMENTED. Week-over-week volume-load bridge, price-volume-mix style.

    Spec:
      - Volume load VL = sum(weight_kg * reps) over hard sets in a rolling 7-day window.
        Bodyweight-only sets contribute 0 and must be reported separately as a set count
        so the bridge is not silently blind to them.
      - Compare current window (w1) to prior window (w0). Decompose dVL = VL1 - VL0 into
        three effects, computed at the exercise level then summed:
            sets effect   = (S1 - S0) * w0_bar * r0_bar
            weight effect = S1 * (w1_bar - w0_bar) * r0_bar
            reps effect   = S1 * w1_bar * (r1_bar - r0_bar)
        where S = hard sets, w_bar = mean weight per set, r_bar = mean reps per set.
        This is the standard sequential (Bennet-style) decomposition: sets first, then
        weight, then reps. Order is fixed so results are comparable across runs.
      - Exercises present in only one window are a MIX effect: report them as their own
        line (entered / dropped), never smeared into the other three effects.
      - assert abs(VL0 + sets + weight + reps + mix - VL1) < 1e-6, and fail loud with
        the per-exercise residual table if it does not hold.
      - Return per-exercise and total lines, sorted by absolute contribution.
    """
    raise NotImplementedError(volume_load_bridge.__doc__)


def detect_stalls(rows: list[Set], lib: dict, cfg: dict) -> list[dict]:
    """NOT IMPLEMENTED. Flag stalled exercises with a suggested action.

    Spec:
      - For each exercise with >= config.analysis.stall_sessions (3) sessions in the last
        8 weeks, compute best-set e1RM per session (bodyweight-only: best reps).
      - STALL if either: (a) no new best in the last `stall_sessions` sessions, or
        (b) the least-squares slope over the trend window is negative.
      - Severity: "watch" if (a) only, "stalled" if (a) and (b), "regressing" if (b) and
        the last session's best is below the 8-week median.
      - Each flag carries exactly one suggested action, chosen deterministically:
          * every recent set at rep_range ceiling but RIR >= 3   -> "load is too light:
            apply the increment, the progression rule has not been followed"
          * any set below floor at RIR 0 in the last 2 sessions  -> "deload 10%"
          * reps stuck mid-range with RIR <= 1 for 3 sessions    -> "rep-range shift:
            move to the next range down and add load"
          * none of the above                                    -> "swap the exercise"
      - Return one dict per flag: {exercise, severity, evidence (the session e1RMs),
        action}. Never suggest an action the progression rule cannot produce, and never
        suggest more leg volume.
    """
    raise NotImplementedError(detect_stalls.__doc__)


def balance_ratios(rows: list[Set], lib: dict, cfg: dict) -> dict:
    """NOT IMPLEMENTED. Push:pull, quad:hamstring, upper:lower vs config bands.

    Spec:
      - Hard sets over the rolling 7-day window, credited per prime mover as in
        volume_by_muscle.
      - push  = chest + front_delts + triceps
        pull  = lats + upper_back + biceps
        upper = push + pull + side_delts + rear_delts + core
        lower = quads + hamstrings + glutes + calves
      - Ratios: push/pull, quads/hamstrings, upper/lower. Denominator 0 -> return None
        with reason "no denominator volume", never a division by zero or an infinity.
      - Compare each to config.balance_bands; flag RED outside the band, GREEN inside.
      - Return {ratio, value, band, flag, numerator_sets, denominator_sets} per ratio.
      - upper:lower is expected to run high and its band already reflects that. An
        out-of-band upper:lower is NOT a recommendation to add leg volume - the cycling
        and running load is not in this log. State that in the output.
    """
    raise NotImplementedError(balance_ratios.__doc__)


# --------------------------------------------------------------------------- #
# cli
# --------------------------------------------------------------------------- #

STUBS = {
    "prescribe": prescribe,
    "progression": exercise_progression,
    "index": strength_index,
    "bridge": volume_load_bridge,
    "stalls": detect_stalls,
    "balance": balance_ratios,
}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["validate", "volume", *STUBS])
    ap.add_argument("--log", default=os.path.join(HERE, "log.csv"))
    ap.add_argument("--window", type=int, default=7)
    ap.add_argument("--exercise", default=None)
    args = ap.parse_args(argv)

    try:
        cfg = load_config()
        lib = load_exercises()
        rows = load_log(args.log, lib, cfg)
    except LogError as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 2

    if args.command == "validate":
        sessions = len({s.date for s in rows})
        print(f"OK: {args.log} - {len(rows)} working sets, {sessions} sessions, "
              f"{len({s.exercise for s in rows})} exercises")
        return 0

    if args.command == "volume":
        return report_volume(rows, lib, cfg, args.window)

    fn = STUBS[args.command]
    print(f"NOT BUILT YET: {fn.__name__}()\n", file=sys.stderr)
    try:
        if fn in (prescribe, exercise_progression):
            fn(rows, args.exercise, lib, cfg)
        else:
            fn(rows, lib, cfg)
    except NotImplementedError as exc:
        print(str(exc).strip(), file=sys.stderr)
    return 3


if __name__ == "__main__":
    raise SystemExit(main())
