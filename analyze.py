#!/usr/bin/env python3
"""Analytics for the strength log. stdlib + pyyaml only.

    python3 analyze.py validate      [--log log.csv]
    python3 analyze.py volume        [--window 7]
    python3 analyze.py today         [--date YYYY-MM-DD]   plan for a day + prescribed loads
    python3 analyze.py prescribe     --exercise bench_press
    python3 analyze.py progression   --exercise bench_press
    python3 analyze.py index
    python3 analyze.py bridge
    python3 analyze.py stalls
    python3 analyze.py balance
    python3 analyze.py adherence
    python3 analyze.py report                               everything, in order
    python3 analyze.py json          [--out web/analytics.json]

Metrics are defined once, here and in CLAUDE.md, and must agree:
    e1RM     = weight_kg * (1 + (reps + rir) / 30); blank RIR treated as 1
    hard set = any working set; if RIR is present, only RIR <= 3 counts
    windows  = rolling days back from the last logged date, not calendar weeks

Bodyweight-only sets (weight_kg == 0) have no meaningful e1RM. Every trend here
excludes them and falls back to reps; nothing lets a zero fake a slope.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import math
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
WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
PUSH = ["chest", "front_delts", "triceps"]
PULL = ["lats", "upper_back", "biceps"]
LOWER = ["quads", "hamstrings", "glutes", "calves"]

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

        Zero for a bodyweight-only set - callers building trends must exclude those.
        Never compare raw e1RM across different exercises.
        """
        rir = 1 if self.rir is None else self.rir
        return self.weight_kg * (1 + (self.reps + rir) / 30)

    @property
    def volume_load(self) -> float:
        return self.weight_kg * self.reps

    def is_hard_set(self, hard_set_rir: int) -> bool:
        return self.rir is None or self.rir <= hard_set_rir


# --------------------------------------------------------------------------- #
# loading
# --------------------------------------------------------------------------- #

def load_config(path: str | None = None) -> dict:
    with open(path or os.path.join(HERE, "config.yaml")) as fh:
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
    with open(path or os.path.join(HERE, "exercises.yaml")) as fh:
        lib = yaml.safe_load(fh)
    seen: dict[str, str] = {}
    for name, ex in lib.items():
        for key in ("aliases", "muscles", "increment", "rep_range"):
            if key not in ex:
                raise LogError(f"exercises.yaml: {name} is missing '{key}'")
        bad = [m for m in ex["muscles"] if m not in MUSCLES]
        if bad:
            raise LogError(f"exercises.yaml: {name} lists unknown muscles {bad}")
        if ex["rep_range"][0] > ex["rep_range"][1]:
            raise LogError(f"exercises.yaml: {name} rep_range floor > ceiling")
        if ex["increment"] <= 0:
            raise LogError(f"exercises.yaml: {name} increment must be > 0")
        for alias in list(ex["aliases"]) + [name]:
            alias = alias.lower().strip()
            if seen.get(alias, name) != name:
                raise LogError(
                    f"exercises.yaml: alias '{alias}' claimed by both {seen[alias]} and {name}")
            seen[alias] = name
    return lib


def load_routine(lib: dict, path: str | None = None) -> dict:
    """The plan. Validated against the exercise library - a routine may not name a
    lift that does not exist, and may not declare a lift it never schedules."""
    p = path or os.path.join(HERE, "routine.yaml")
    if not os.path.exists(p):
        raise LogError(f"{p}: no such file - the routine is what the log is measured against")
    with open(p) as fh:
        r = yaml.safe_load(fh)
    scheduled: set[str] = set()
    for day in WEEKDAYS:
        if day not in r["week"]:
            raise LogError(f"routine.yaml: week is missing '{day}'")
        for i, item in enumerate(r["week"][day]["plan"], 1):
            ex = item["exercise"]
            if ex not in lib:
                raise LogError(f"routine.yaml: {day} entry {i} names unknown exercise {ex!r}")
            if not isinstance(item["sets"], int) or item["sets"] < 1:
                raise LogError(f"routine.yaml: {day} {ex} sets must be a positive integer")
            scheduled.add(ex)
    declared = set(r["lifts"])
    if scheduled - declared:
        raise LogError(f"routine.yaml: scheduled but not in lifts: {sorted(scheduled - declared)}")
    if declared - scheduled:
        raise LogError(f"routine.yaml: in lifts but never scheduled: {sorted(declared - scheduled)}")
    return r


def _alias_map(lib: dict) -> dict[str, str]:
    out: dict[str, str] = {}
    for name, ex in lib.items():
        out[name.lower()] = name
        for alias in ex["aliases"]:
            out[alias.lower().strip()] = name
    return out


def resolve_exercise(token: str, lib: dict) -> str | None:
    return _alias_map(lib).get(token.lower().strip())


def load_log(path: str, lib: dict, cfg: dict) -> list[Set]:
    """Strict loader. Fails loud on the first offending line, naming file:line."""
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
            raise LogError(f"{path}:1 header is {header!r}, expected {HEADER!r}")
        for lineno, row in enumerate(reader, start=2):
            if not row or all(not c.strip() for c in row):
                continue
            where = f"{path}:{lineno}"
            if len(row) != len(HEADER):
                raise LogError(f"{where} has {len(row)} fields, expected {len(HEADER)}: {row!r}")
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
                    "only to avoid a later migration")
            if ex_s not in lib:
                hint = resolve_exercise(ex_s, lib)
                extra = f" (did you mean {hint}?)" if hint else ""
                raise LogError(
                    f"{where} exercise {ex_s!r} is not a canonical name in exercises.yaml{extra}")
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
                raise LogError(f"{where} weight_kg 0 but {ex_s} is not a bodyweight exercise")
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
                f"{path}:{s.line} duplicate set: {s.exercise} set {s.set_no} on {s.date} "
                f"already logged at line {seen[key]}")
        seen[key] = s.line


def _warn_out_of_order(rows: list[Set], path: str) -> None:
    for prev, cur in zip(rows, rows[1:]):
        if cur.date < prev.date:
            print(f"WARNING {path}:{cur.line} date {cur.date} precedes {prev.date} on the "
                  "previous line - log.csv is append-only, check this was a backfill",
                  file=sys.stderr)
            return


# --------------------------------------------------------------------------- #
# windows, sessions, small stats
# --------------------------------------------------------------------------- #

def window(rows: list[Set], days: int, end: dt.date | None = None) -> list[Set]:
    """Rolling window of `days` ending at `end` (default: last logged date)."""
    if not rows:
        return []
    end = end or max(s.date for s in rows)
    start = end - dt.timedelta(days=days - 1)
    return [s for s in rows if start <= s.date <= end]


def sessions_of(rows: list[Set], exercise: str) -> list[tuple[dt.date, list[Set]]]:
    """[(date, sets)] for one exercise, oldest first, sets ordered by set_no."""
    by_date: dict[dt.date, list[Set]] = {}
    for s in rows:
        if s.exercise == exercise:
            by_date.setdefault(s.date, []).append(s)
    return [(d, sorted(by_date[d], key=lambda s: s.set_no)) for d in sorted(by_date)]


def least_squares(xs: list[float], ys: list[float]) -> tuple[float, float, float]:
    """(slope, intercept, r2). Zero variance in x -> slope 0, r2 0."""
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx == 0:
        return 0.0, my, 0.0
    slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx
    intercept = my - slope * mx
    ss_tot = sum((y - my) ** 2 for y in ys)
    ss_res = sum((y - (slope * x + intercept)) ** 2 for x, y in zip(xs, ys))
    r2 = 0.0 if ss_tot == 0 else 1 - ss_res / ss_tot
    return slope, intercept, r2


# --------------------------------------------------------------------------- #
# volume
# --------------------------------------------------------------------------- #

def volume_by_muscle(rows: list[Set], lib: dict, cfg: dict) -> dict[str, int]:
    """Hard sets credited per muscle. A set credits 1 to each prime mover listed."""
    thr = cfg["metrics"]["hard_set_rir"]
    out = {m: 0 for m in MUSCLES}
    for s in rows:
        if s.is_hard_set(thr):
            for m in lib[s.exercise]["muscles"]:
                out[m] += 1
    return out


def flag(count: float, band: dict) -> str:
    """RED below min or above max, AMBER between min and target, GREEN in band."""
    if count < band["min"] or count > band["max"]:
        return "RED"
    if count < band["target"]:
        return "AMBER"
    return "GREEN"


def volume_report(rows: list[Set], lib: dict, cfg: dict, days: int) -> dict:
    if not rows:
        return {"empty": True}
    end = max(s.date for s in rows)
    win = window(rows, days, end)
    counts = volume_by_muscle(win, lib, cfg)
    scale = days / 7
    uncovered = set(cfg.get("uncovered_by_design", []))
    out = []
    for m in MUSCLES:
        band = {k: v * scale for k, v in cfg["volume_targets"][m].items()}
        f = "UNCOVERED" if m in uncovered else flag(counts[m], band)
        out.append({"muscle": m, "sets": counts[m], "band": band, "flag": f,
                    "vs_target": counts[m] - band["target"]})
    return {"empty": False, "window": days, "end": end.isoformat(),
            "sessions": len({s.date for s in win}), "sets": len(win), "muscles": out}


# --------------------------------------------------------------------------- #
# the progression rule - the only source of load prescriptions
# --------------------------------------------------------------------------- #

def round_down(kg: float, inc: float) -> float:
    return round(math.floor((kg + 1e-9) / inc) * inc, 4)


def prescribe(rows: list[Set], exercise: str, lib: dict, cfg: dict) -> dict:
    """Deterministic next load and target reps for one exercise. Double progression.

    This function is the programmatic statement of the only load rule in the project
    and must agree exactly with the rule in CLAUDE.md and config.yaml -> progression.

    1. No prior session -> {"weight_kg": None, "target_reps": floor, "reason":
       "no baseline"}. Never invent a starting load.
    2. Deload, checked first: any set in the last session with reps < floor AND rir == 0
       -> last load * (1 - deload_pct) rounded DOWN to the increment, reps = floor.
    3. Increase: every working set in the last session at reps >= ceiling AND
       rir <= rir_ceiling (a blank RIR does not qualify - unverified is not proven)
       -> last load + increment, reps = floor.
    4. Otherwise hold: same load, reps = min(ceiling, best reps last session + 1).
    5. Bodyweight lifts: weight is ADDED load. Rule 3 on a 0 kg entry gives the first
       increment. Rule 2 cannot go below 0 - hold at bodyweight and cut the rep target.
    6. Mid-session load changes: the load carried forward is the LAST set's load.
    """
    ex = lib[exercise]
    floor, ceiling = ex["rep_range"]
    inc = ex["increment"]
    prog = cfg["progression"]
    hist = sessions_of(rows, exercise)
    if not hist:
        return {"exercise": exercise, "weight_kg": None, "target_reps": floor,
                "reason": "no baseline", "basis_date": None}
    basis, sets = hist[-1]
    load = sets[-1].weight_kg
    common = {"exercise": exercise, "basis_date": basis.isoformat()}

    if any(s.reps < floor and s.rir == 0 for s in sets):
        if load == 0:
            return {**common, "weight_kg": 0.0, "target_reps": max(1, floor - 2),
                    "reason": "deload floor: bodyweight only, rep target cut instead"}
        return {**common, "weight_kg": round_down(load * (1 - prog["deload_pct"]), inc),
                "target_reps": floor, "reason": "deload"}

    if all(s.reps >= ceiling and s.rir is not None and s.rir <= prog["rir_ceiling"]
           for s in sets):
        return {**common, "weight_kg": round(load + inc, 4), "target_reps": floor,
                "reason": "progress"}

    best = max(s.reps for s in sets)
    return {**common, "weight_kg": load, "target_reps": min(ceiling, best + 1),
            "reason": "hold"}


def today_plan(rows: list[Set], routine: dict, lib: dict, cfg: dict,
               date: dt.date) -> dict:
    """The routine's plan for one day, with a prescribed load per lift."""
    day = WEEKDAYS[date.weekday()]
    entry = routine["week"][day]
    prior = [s for s in rows if s.date < date]
    items = []
    for p in entry["plan"]:
        pr = prescribe(prior, p["exercise"], lib, cfg)
        done = [s for s in rows if s.date == date and s.exercise == p["exercise"]]
        items.append({**pr, "planned_sets": p["sets"], "logged_sets": len(done)})
    return {"date": date.isoformat(), "day": day, "name": entry["name"], "plan": items,
            "planned_sets": sum(p["sets"] for p in entry["plan"])}


# --------------------------------------------------------------------------- #
# progression, index, bridge, stalls, balance, adherence
# --------------------------------------------------------------------------- #

def exercise_progression(rows: list[Set], exercise: str, lib: dict, cfg: dict) -> dict:
    """e1RM trend for one exercise: best set per session, least-squares slope.

    Bodyweight-only sets are excluded (e1RM 0 would fake a trend); an exercise with no
    loaded sets falls back to best reps per session and reports basis "reps", with no
    kg/week. Slope needs analysis.min_trend_points sessions inside analysis.trend_weeks;
    below that it returns no slope and says why. A fit under analysis.noisy_r2 is
    labelled noisy rather than presented as a trend.
    """
    an = cfg["analysis"]
    hist = sessions_of(rows, exercise)
    if not hist:
        return {"exercise": exercise, "points": [], "basis": None, "reason": "no data"}

    loaded = [(d, ss) for d, ss in hist if any(s.weight_kg > 0 for s in ss)]
    basis = "e1rm" if loaded else "reps"
    if basis == "e1rm":
        points = [{"date": d.isoformat(),
                   "value": round(max(s.e1rm for s in ss if s.weight_kg > 0), 2),
                   "weight_kg": max((s for s in ss if s.weight_kg > 0),
                                    key=lambda s: s.e1rm).weight_kg,
                   "reps": max((s for s in ss if s.weight_kg > 0),
                               key=lambda s: s.e1rm).reps,
                   "sets": len(ss)}
                  for d, ss in loaded]
    else:
        points = [{"date": d.isoformat(), "value": max(s.reps for s in ss),
                   "weight_kg": 0.0, "reps": max(s.reps for s in ss), "sets": len(ss)}
                  for d, ss in hist]

    best = max(points, key=lambda p: p["value"])
    out = {"exercise": exercise, "basis": basis,
           "regime_change": bool(loaded) and len(loaded) < len(hist),
           "points": points,
           "n_sessions": len(points), "first": points[0]["date"], "last": points[-1]["date"],
           "best": best["value"], "best_date": best["date"], "current": points[-1]["value"]}

    end = dt.date.fromisoformat(points[-1]["date"])
    start = end - dt.timedelta(weeks=an["trend_weeks"])
    win = [p for p in points if dt.date.fromisoformat(p["date"]) >= start]
    if len(win) < an["min_trend_points"]:
        return {**out, "slope": None,
                "reason": f"insufficient data ({len(win)} sessions in "
                          f"{an['trend_weeks']}w, need {an['min_trend_points']})"}

    x0 = dt.date.fromisoformat(win[0]["date"])
    xs = [(dt.date.fromisoformat(p["date"]) - x0).days for p in win]
    ys = [p["value"] for p in win]
    slope, intercept, r2 = least_squares(xs, ys)
    pct_month = (slope * 30 / intercept * 100) if intercept else None
    return {**out, "slope_per_day": round(slope, 4),
            "per_week": round(slope * 7, 2),
            "pct_per_month": round(pct_month, 2) if pct_month is not None else None,
            "r2": round(r2, 3), "noisy": r2 < an["noisy_r2"],
            "trend_sessions": len(win), "unit": "kg" if basis == "e1rm" else "reps"}


def strength_index(rows: list[Set], lib: dict, cfg: dict, period_days: int = 28) -> dict:
    """Every exercise indexed to its own first-4-week baseline = 100, rolled up to muscle.

    Baseline = mean best-set e1RM over the exercise's first analysis.baseline_weeks of
    logged history, counted from that exercise's own first date. Fewer than 2 sessions
    in the baseline window -> the exercise is "unindexed" and is named in the output
    rather than silently dropped. Bodyweight-only exercises index on best reps and are
    marked basis "reps" so the two measurements are never presented as the same thing.
    Muscle roll-up weights each exercise by its share of that muscle's hard sets in the
    period; co-primary lifts contribute to both muscles at full weight, exactly as
    volume is credited.
    """
    an = cfg["analysis"]
    if not rows:
        # EXACTLY the populated return's keys. An empty log is a normal state on day one,
        # and every consumer - print_index, the JSON blob, the web app - reads this shape.
        # A short dict here is a KeyError somewhere else, which is what it was.
        return {"period_days": period_days, "period_end": None,
                "baseline_weeks": an["baseline_weeks"], "exercises": {},
                "muscles": {}, "unindexed": []}
    end = max(s.date for s in rows)
    cur_start = end - dt.timedelta(days=period_days - 1)
    prev_start = cur_start - dt.timedelta(days=period_days)

    per_ex, unindexed = {}, []
    for exercise in sorted({s.exercise for s in rows}):
        prog = exercise_progression(rows, exercise, lib, cfg)
        pts = prog["points"]
        if not pts:
            continue
        first = dt.date.fromisoformat(pts[0]["date"])
        base_end = first + dt.timedelta(weeks=an["baseline_weeks"])
        base = [p["value"] for p in pts if dt.date.fromisoformat(p["date"]) < base_end]
        if lib[exercise].get("bodyweight") and prog.get("regime_change"):
            unindexed.append({
                "exercise": exercise,
                "reason": "bodyweight lift: reps at bodyweight and added load are not the "
                          "same measurement, so there is no comparable baseline"})
            continue
        if len(base) < 2:
            unindexed.append({"exercise": exercise, "reason": f"{len(base)} baseline sessions"})
            continue
        baseline = sum(base) / len(base)
        def idx(lo, hi):
            vals = [p["value"] for p in pts if lo <= dt.date.fromisoformat(p["date"]) <= hi]
            return round(max(vals) / baseline * 100, 1) if vals and baseline else None
        per_ex[exercise] = {
            "index": idx(cur_start, end), "prior_index": idx(prev_start, cur_start - dt.timedelta(days=1)),
            "basis": prog["basis"], "baseline": round(baseline, 2),
            "baseline_from": pts[0]["date"], "baseline_to": base_end.isoformat(),
            "n_sessions": prog["n_sessions"]}

    thr = cfg["metrics"]["hard_set_rir"]
    win = [s for s in rows if cur_start <= s.date <= end and s.is_hard_set(thr)]
    per_muscle = {}
    for m in MUSCLES:
        weights: dict[str, int] = {}
        for s in win:
            if m in lib[s.exercise]["muscles"]:
                weights[s.exercise] = weights.get(s.exercise, 0) + 1
        usable = {e: w for e, w in weights.items()
                  if e in per_ex and per_ex[e]["index"] is not None}
        if not usable:
            per_muscle[m] = {"index": None, "coverage": 0.0, "exercises": []}
            continue
        total = sum(usable.values())
        val = sum(per_ex[e]["index"] * w for e, w in usable.items()) / total
        per_muscle[m] = {"index": round(val, 1),
                         "coverage": round(total / sum(weights.values()), 2),
                         "exercises": sorted(usable)}
    return {"period_days": period_days, "period_end": end.isoformat(),
            "baseline_weeks": an["baseline_weeks"], "exercises": per_ex,
            "muscles": per_muscle, "unindexed": unindexed}


def volume_load_bridge(rows: list[Set], lib: dict, cfg: dict) -> dict:
    """Week-over-week volume load, decomposed price-volume-mix style.

    VL = sum(weight_kg * reps) over hard sets in a rolling 7-day window. Bodyweight-only
    sets contribute 0 and are reported separately as a set count so the bridge is not
    silently blind to them. Per exercise, with S = hard sets, w = mean weight/set,
    r = mean reps/set, the sequential (Bennet-style) decomposition is

        sets   = (S1 - S0) * w0 * r0
        weight = S1 * (w1 - w0) * r0
        reps   = S1 * w1 * (r1 - r0)

    Order is fixed - sets, then weight, then reps - so runs are comparable.

    Those three only reconstruct S*w_bar*r_bar, which is NOT the true VL: within a week
    heavy sets carry fewer reps, so weight and reps covary and sum(w*r) differs from
    S*w_bar*r_bar by that covariance. The difference is carried explicitly as the COVAR
    effect (C1 - C0, where C = VL - S*w_bar*r_bar) rather than being hidden in a
    tolerance. A large covar line means the week's load/rep mix changed shape - a top
    set got heavier while back-off sets got lighter, say.

    Exercises present in only one window are MIX and get their own line, never smeared
    into the others. The residual is asserted to zero.
    """
    thr = cfg["metrics"]["hard_set_rir"]
    if not rows:
        return {"empty": True}
    end = max(s.date for s in rows)
    w1 = [s for s in window(rows, 7, end) if s.is_hard_set(thr)]
    w0 = [s for s in window(rows, 7, end - dt.timedelta(days=7)) if s.is_hard_set(thr)]

    def agg(ss):
        out: dict[str, dict] = {}
        for s in ss:
            a = out.setdefault(s.exercise, {"S": 0, "w": 0.0, "r": 0.0, "vl": 0.0, "bw": 0})
            a["S"] += 1
            a["w"] += s.weight_kg
            a["r"] += s.reps
            a["vl"] += s.volume_load
            a["bw"] += 1 if s.weight_kg == 0 else 0
        for a in out.values():
            a["w"] /= a["S"]
            a["r"] /= a["S"]
            a["covar"] = a["vl"] - a["S"] * a["w"] * a["r"]
        return out

    a0, a1 = agg(w0), agg(w1)
    lines, tot = [], {"sets": 0.0, "weight": 0.0, "reps": 0.0, "covar": 0.0, "mix": 0.0}
    for ex in sorted(set(a0) | set(a1)):
        p, c = a0.get(ex), a1.get(ex)
        if p is None:
            eff = {"sets": 0.0, "weight": 0.0, "reps": 0.0, "covar": 0.0, "mix": c["vl"]}
        elif c is None:
            eff = {"sets": 0.0, "weight": 0.0, "reps": 0.0, "covar": 0.0, "mix": -p["vl"]}
        else:
            eff = {"sets": (c["S"] - p["S"]) * p["w"] * p["r"],
                   "weight": c["S"] * (c["w"] - p["w"]) * p["r"],
                   "reps": c["S"] * c["w"] * (c["r"] - p["r"]),
                   "covar": c["covar"] - p["covar"],
                   "mix": 0.0}
        for k in tot:
            tot[k] += eff[k]
        lines.append({"exercise": ex, "vl_prior": round(p["vl"], 1) if p else 0.0,
                      "vl_current": round(c["vl"], 1) if c else 0.0,
                      **{k: round(v, 1) for k, v in eff.items()}})

    vl0 = sum(s.volume_load for s in w0)
    vl1 = sum(s.volume_load for s in w1)
    residual = vl0 + sum(tot.values()) - vl1
    if abs(residual) > 1e-6:
        raise LogError(
            f"volume_load_bridge residual {residual:.6f} is not zero - decomposition is "
            f"wrong. Per-exercise lines: {lines}")
    lines.sort(key=lambda l: -abs(l["sets"] + l["weight"] + l["reps"] + l["covar"] + l["mix"]))
    return {"empty": False, "end": end.isoformat(),
            "vl_prior": round(vl0, 1), "vl_current": round(vl1, 1),
            "delta": round(vl1 - vl0, 1), "effects": {k: round(v, 1) for k, v in tot.items()},
            "residual": round(residual, 9), "lines": lines,
            "bodyweight_sets": {"prior": sum(a["bw"] for a in a0.values()),
                                "current": sum(a["bw"] for a in a1.values())}}


def detect_stalls(rows: list[Set], lib: dict, cfg: dict) -> list[dict]:
    """Flag stalled exercises, each with exactly one suggested action.

    For every exercise with >= analysis.stall_sessions sessions inside the trend window:
      (a) no new best in the last analysis.stall_days DAYS, or (b) a negative slope.

    Days, not session count: at 3-4 sessions a week a flat e1RM between load increments
    is exactly what double progression looks like when it is working. Counting sessions
    flags every lift every week and the report becomes noise.

    Severity: "watch" for (a) alone, "stalled" for (a)+(b), "regressing" for (b) with the
    latest best below the window median. The action is chosen deterministically and can
    only ever be something the progression rule can produce - never more leg volume.

    A deload re-bases the comparison. The progression rule itself resets target reps to
    floor after one - a legitimate lower-load restart, not a failure to sustain the old
    load - so judging current performance against a pre-deload median or "best" compares
    it to a load tier already proven unsustainable. If the most recent deload for this
    exercise falls inside the trend window, only sessions from that point on are used.
    """
    an = cfg["analysis"]
    out = []
    for exercise in sorted({s.exercise for s in rows}):
        prog = exercise_progression(rows, exercise, lib, cfg)
        pts = prog["points"]
        if len(pts) < an["stall_sessions"]:
            continue
        end = dt.date.fromisoformat(pts[-1]["date"])
        win = [p for p in pts
               if dt.date.fromisoformat(p["date"]) >= end - dt.timedelta(weeks=an["trend_weeks"])]
        floor = lib[exercise]["rep_range"][0]
        deload_dates = {s.date for s in rows
                        if s.exercise == exercise and s.reps < floor and s.rir == 0}
        if deload_dates:
            last_deload = max(deload_dates)
            win = [p for p in win if dt.date.fromisoformat(p["date"]) > last_deload]
        if len(win) < an["stall_sessions"]:
            continue
        cutoff = end - dt.timedelta(days=an["stall_days"])
        recent = [p for p in win if dt.date.fromisoformat(p["date"]) > cutoff]
        earlier = [p for p in win if dt.date.fromisoformat(p["date"]) <= cutoff]
        if not recent or not earlier:
            continue
        best_before = max(p["value"] for p in earlier)
        no_pr = all(p["value"] <= best_before for p in recent)
        flat_days = (end - max(
            (dt.date.fromisoformat(p["date"]) for p in win if p["value"] > best_before),
            default=cutoff)).days
        # Slope over the SHORT window: a lift that climbed for two months and then went
        # flat is stalling now, and an 8-week fit would hide that behind the old climb.
        short = [p for p in win if dt.date.fromisoformat(p["date"])
                 >= end - dt.timedelta(weeks=an["stall_trend_weeks"])]
        if len(short) >= an["min_trend_points"]:
            x0 = dt.date.fromisoformat(short[0]["date"])
            slope, _, _ = least_squares(
                [(dt.date.fromisoformat(p["date"]) - x0).days for p in short],
                [p["value"] for p in short])
        else:
            slope = prog.get("slope_per_day")
        negative = slope is not None and slope < 0
        # A lift that is still climbing is not stalled, however long since its last best.
        if not (negative or (no_pr and (slope is None or slope <= 0))):
            continue
        vals = sorted(p["value"] for p in win)
        median = vals[len(vals) // 2] if len(vals) % 2 else (vals[len(vals) // 2 - 1] + vals[len(vals) // 2]) / 2
        if negative and win[-1]["value"] < median:
            severity = "regressing"
        elif no_pr and negative:
            severity = "stalled"
        else:
            severity = "watch"

        ex = lib[exercise]
        floor, ceiling = ex["rep_range"]
        last_dates = [dt.date.fromisoformat(p["date"]) for p in win[-3:]]
        recent_sets = [s for s in rows if s.exercise == exercise and s.date in last_dates]
        rc = cfg["progression"]["rir_ceiling"]
        if any(s.reps < floor and s.rir == 0 for s in recent_sets):
            action = (f"deload {int(cfg['progression']['deload_pct'] * 100)}% - "
                      "the progression rule already says so")
        elif recent_sets and all(s.reps >= ceiling for s in recent_sets) and \
                all(s.rir is not None and s.rir <= rc for s in recent_sets):
            action = ("add one increment - every set is at the rep ceiling inside RIR "
                      f"{rc}, so the rule says progress and it has not been applied")
        elif recent_sets and all(s.rir is not None and s.rir <= 1 for s in recent_sets):
            action = "rep-range shift: move down a range and add load"
        else:
            action = "swap the exercise"
        out.append({"exercise": exercise, "severity": severity, "basis": prog["basis"],
                    "flat_days": flat_days if no_pr else 0,
                    "slope_per_week": round(slope * 7, 2) if slope is not None else None,
                    "slope_window_weeks": an["stall_trend_weeks"],
                    "evidence": [{"date": p["date"], "value": p["value"]} for p in win],
                    "action": action})
    order = {"regressing": 0, "stalled": 1, "watch": 2}
    out.sort(key=lambda f: (order[f["severity"]], f["exercise"]))
    return out


def balance_ratios(rows: list[Set], lib: dict, cfg: dict) -> dict:
    """push:pull, quad:hamstring and upper:lower over the rolling 7-day window."""
    counts = volume_by_muscle(window(rows, 7), lib, cfg)
    groups = {
        "push_pull": (sum(counts[m] for m in PUSH), sum(counts[m] for m in PULL)),
        "quad_hamstring": (counts["quads"], counts["hamstrings"]),
        "upper_lower": (sum(counts[m] for m in MUSCLES if m not in LOWER),
                        sum(counts[m] for m in LOWER)),
    }
    out = {}
    for name, (num, den) in groups.items():
        band = cfg["balance_bands"][name]
        if den == 0:
            out[name] = {"value": None, "band": band, "flag": "NO DATA",
                         "reason": "no denominator volume", "numerator_sets": num,
                         "denominator_sets": den}
            continue
        val = num / den
        out[name] = {"value": round(val, 2), "band": band,
                     "flag": "GREEN" if band["min"] <= val <= band["max"] else "RED",
                     "numerator_sets": num, "denominator_sets": den}
    out["note"] = ("upper:lower runs high by design - the cycling and running load is not "
                   "in this log. An out-of-band upper:lower is not a reason to add leg volume.")
    return out


def adherence(rows: list[Set], routine: dict, lib: dict, cfg: dict) -> dict:
    """Planned sets (from routine.yaml, by weekday) vs logged sets over the window."""
    days = cfg["analysis"]["adherence_window"]
    if not rows:
        return {"empty": True}
    end = max(s.date for s in rows)
    start = end - dt.timedelta(days=days - 1)
    thr = cfg["metrics"]["hard_set_rir"]

    planned: dict[str, int] = {}
    planned_days = 0
    d = start
    while d <= end:
        planned_days += 1
        for p in routine["week"][WEEKDAYS[d.weekday()]]["plan"]:
            planned[p["exercise"]] = planned.get(p["exercise"], 0) + p["sets"]
        d += dt.timedelta(days=1)

    logged: dict[str, int] = {}
    for s in rows:
        if start <= s.date <= end and s.is_hard_set(thr):
            logged[s.exercise] = logged.get(s.exercise, 0) + 1

    lines = [{"exercise": e, "planned": planned.get(e, 0), "logged": logged.get(e, 0),
              "delta": logged.get(e, 0) - planned.get(e, 0)}
             for e in sorted(set(planned) | set(logged))]
    lines.sort(key=lambda l: l["delta"])
    tp, tl = sum(planned.values()), sum(logged.values())
    trained = len({s.date for s in rows if start <= s.date <= end})
    return {"empty": False, "window": days, "end": end.isoformat(),
            "planned_sets": tp, "logged_sets": tl,
            "rate": round(tl / tp, 3) if tp else None,
            "planned_days": planned_days, "trained_days": trained,
            "off_plan": [l["exercise"] for l in lines if l["planned"] == 0 and l["logged"] > 0],
            "lines": lines}


# --------------------------------------------------------------------------- #
# printing
# --------------------------------------------------------------------------- #

def _bar(n, band, width=22):
    axis = max(band["max"] * 1.25, n * 1.05, 1)
    fill = int(round(n / axis * width))
    lo, hi = int(round(band["min"] / axis * width)), int(round(band["max"] / axis * width))
    cells = []
    for i in range(width):
        inside = lo <= i < hi
        cells.append("#" if i < fill else ("-" if inside else " "))
    return "".join(cells)


def print_volume(rep: dict) -> None:
    if rep.get("empty"):
        print("log is empty - nothing to report")
        return
    print(f"VOLUME  rolling {rep['window']}d to {rep['end']}  |  {rep['sessions']} sessions, "
          f"{rep['sets']} working sets")
    print(f"{'muscle':<12}{'sets':>5}  {'band':<12}{'':<24}{'flag':<10}vs target")
    print("-" * 74)
    for m in rep["muscles"]:
        b = m["band"]
        bandtxt = f"{b['min']:g}/{b['target']:g}/{b['max']:g}"
        print(f"{m['muscle']:<12}{m['sets']:>5}  {bandtxt:<12}{_bar(m['sets'], b):<24}"
              f"{m['flag']:<10}{m['vs_target']:+.0f}")
    print("-" * 74)
    reds = [m["muscle"] for m in rep["muscles"] if m["flag"] == "RED"]
    print("RED: " + (", ".join(reds) if reds else "none"))
    unc = [m["muscle"] for m in rep["muscles"] if m["flag"] == "UNCOVERED"]
    if unc:
        print(f"UNCOVERED by design (cycling/running, not in this log): {', '.join(unc)}")
    under = sorted((m for m in rep["muscles"] if m["flag"] == "RED" and m["vs_target"] < 0),
                   key=lambda m: m["vs_target"])[:2]
    if under:
        print("biggest gaps: " + ", ".join(f"{m['muscle']} {m['vs_target']:+.0f}" for m in under))


def fmt_load(w, ex_lib):
    if w is None:
        return "-"
    if w == 0:
        return "bw"
    return f"{'+' if ex_lib.get('bodyweight') else ''}{w:g}"


def print_today(t: dict, lib: dict) -> None:
    print(f"{t['date']}  {t['day']}  {t['name']}  ({t['planned_sets']} planned sets)")
    print("-" * 62)
    for p in t["plan"]:
        load = fmt_load(p["weight_kg"], lib[p["exercise"]])
        done = f"{p['logged_sets']}/{p['planned_sets']}"
        print(f"{p['exercise']:<28}{done:>6}  {load:>7} x{p['target_reps']:<4}({p['reason']})")


def print_progression(p: dict) -> None:
    if not p["points"]:
        print(f"{p['exercise']}: {p.get('reason', 'no data')}")
        return
    unit = p.get("unit", "")
    print(f"{p['exercise']}  basis={p['basis']}  {p['n_sessions']} sessions  "
          f"{p['first']} -> {p['last']}")
    print(f"  best {p['best']} on {p['best_date']}   current {p['current']}")
    if p.get("slope") is None and "reason" in p:
        print(f"  slope: {p['reason']}")
        return
    noisy = "  NOISY (r2 below threshold - do not read this as a trend)" if p["noisy"] else ""
    print(f"  slope {p['per_week']:+g} {unit}/week   {p['pct_per_month']:+g} %/month   "
          f"r2 {p['r2']}{noisy}")


def print_index(ix: dict) -> None:
    print(f"STRENGTH INDEX  baseline = each lift's first {ix['baseline_weeks']}w = 100  "
          f"| last {ix['period_days']}d to {ix['period_end'] or 'nothing logged yet'}")
    print("-" * 62)
    if not ix["exercises"] and not ix["unindexed"]:
        print(f"  no logged sets - an index needs {ix['baseline_weeks']} weeks of a lift "
              f"before it means anything")
        print("-" * 62)
        return
    for ex, v in sorted(ix["exercises"].items(), key=lambda kv: -(kv[1]["index"] or 0)):
        prior = f"{v['prior_index']:g}" if v["prior_index"] is not None else "-"
        cur = f"{v['index']:g}" if v["index"] is not None else "-"
        print(f"{ex:<28}{cur:>7}   prior {prior:>6}   basis {v['basis']}")
    print("-" * 62)
    for m, v in ix["muscles"].items():
        if v["index"] is not None:
            print(f"{m:<14}{v['index']:>7}   coverage {v['coverage']:.0%}   "
                  f"{', '.join(v['exercises'])}")
    if ix["unindexed"]:
        print("unindexed (too little baseline): " +
              ", ".join(f"{u['exercise']} ({u['reason']})" for u in ix["unindexed"]))


def print_bridge(b: dict) -> None:
    if b.get("empty"):
        print("log is empty - nothing to report")
        return
    e = b["effects"]
    print(f"VOLUME-LOAD BRIDGE  week to {b['end']} vs the week before")
    print(f"  prior      {b['vl_prior']:>10,.0f} kg")
    print(f"  sets       {e['sets']:>+10,.0f}")
    print(f"  weight     {e['weight']:>+10,.0f}")
    print(f"  reps       {e['reps']:>+10,.0f}")
    print(f"  covar      {e['covar']:>+10,.0f}   (within-week load/rep mix shape)")
    print(f"  mix        {e['mix']:>+10,.0f}   (lifts entering or leaving the plan)")
    print(f"  current    {b['vl_current']:>10,.0f} kg   ({b['delta']:+,.0f})")
    print(f"  residual   {b['residual']:>10.9f}")
    print(f"  bodyweight sets not in the load figure: {b['bodyweight_sets']['prior']} -> "
          f"{b['bodyweight_sets']['current']}")
    print("-" * 62)
    for l in b["lines"][:6]:
        net = l["sets"] + l["weight"] + l["reps"] + l["covar"] + l["mix"]
        print(f"{l['exercise']:<28}{net:>+9,.0f}   sets {l['sets']:>+7,.0f}  "
              f"weight {l['weight']:>+7,.0f}  reps {l['reps']:>+7,.0f}  "
              f"covar {l['covar']:>+7,.0f}  mix {l['mix']:>+7,.0f}")


def print_stalls(flags: list[dict]) -> None:
    if not flags:
        print("STALLS: none")
        return
    print("STALLS")
    print("-" * 62)
    for f in flags:
        slope = f"{f['slope_per_week']:+g}/wk" if f["slope_per_week"] is not None else "no slope"
        print(f"{f['severity'].upper():<11}{f['exercise']:<28}{slope}   flat {f['flat_days']}d")
        print(f"           {' '.join(str(e['value']) for e in f['evidence'][-6:])}")
        print(f"           -> {f['action']}")


def print_balance(b: dict) -> None:
    print("BALANCE  rolling 7d")
    print("-" * 62)
    for name in ("push_pull", "quad_hamstring", "upper_lower"):
        r = b[name]
        val = f"{r['value']:g}" if r["value"] is not None else r.get("reason", "-")
        print(f"{name:<18}{val:>7}   band {r['band']['min']:g}-{r['band']['max']:g}   "
              f"{r['flag']:<8}{r['numerator_sets']}:{r['denominator_sets']} sets")
    print(b["note"])


def print_adherence(a: dict) -> None:
    if a.get("empty"):
        print("log is empty - nothing to report")
        return
    print(f"ADHERENCE  last {a['window']}d to {a['end']}   "
          f"{a['trained_days']}/{a['planned_days']} days trained")
    print(f"  planned {a['planned_sets']} sets, logged {a['logged_sets']} "
          f"({a['rate']:.0%})" if a["rate"] is not None else "  no plan")
    print("-" * 62)
    for l in a["lines"]:
        tag = "  off-plan" if l["planned"] == 0 else ""
        print(f"{l['exercise']:<28}{l['logged']:>4}/{l['planned']:<4}{l['delta']:>+5}{tag}")


# --------------------------------------------------------------------------- #
# json export - the web app renders these numbers, it does not recompute them
# --------------------------------------------------------------------------- #

def analytics_json(rows, routine, lib, cfg) -> dict:
    today = max(s.date for s in rows) if rows else dt.date.today()
    return {
        "generated_from": "analyze.py",
        "last_logged": today.isoformat(),
        "volume": {str(d): volume_report(rows, lib, cfg, d) for d in cfg["metrics"]["windows"]},
        "progression": {e: exercise_progression(rows, e, lib, cfg) for e in routine["lifts"]},
        "index": strength_index(rows, lib, cfg),
        "bridge": volume_load_bridge(rows, lib, cfg),
        "stalls": detect_stalls(rows, lib, cfg),
        "balance": balance_ratios(rows, lib, cfg),
        "adherence": adherence(rows, routine, lib, cfg),
        "prescriptions": {e: prescribe(rows, e, lib, cfg) for e in routine["lifts"]},
        "week": {d: {"name": routine["week"][d]["name"], "plan": routine["week"][d]["plan"]}
                 for d in WEEKDAYS},
        "sessions": sorted({s.date.isoformat() for s in rows}),
    }


# --------------------------------------------------------------------------- #
# cli
# --------------------------------------------------------------------------- #

COMMANDS = ["validate", "volume", "today", "prescribe", "progression", "index",
            "bridge", "stalls", "balance", "adherence", "report", "json"]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=COMMANDS)
    ap.add_argument("--log", default=os.path.join(HERE, "log.csv"))
    ap.add_argument("--window", type=int, default=7)
    ap.add_argument("--exercise", default=None)
    ap.add_argument("--date", default=None)
    ap.add_argument("--out", default=os.path.join(HERE, "web", "analytics.json"))
    args = ap.parse_args(argv)

    try:
        cfg = load_config()
        lib = load_exercises()
        routine = load_routine(lib)
        rows = load_log(args.log, lib, cfg)
    except LogError as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 2

    def need_exercise():
        if not args.exercise:
            print("FAIL: --exercise is required for this command", file=sys.stderr)
            return None
        name = args.exercise if args.exercise in lib else resolve_exercise(args.exercise, lib)
        if not name:
            print(f"FAIL: unknown exercise {args.exercise!r}", file=sys.stderr)
            return None
        return name

    try:
        if args.command == "validate":
            print(f"OK: {args.log} - {len(rows)} working sets, "
                  f"{len({s.date for s in rows})} sessions, "
                  f"{len({s.exercise for s in rows})} exercises; routine.yaml OK "
                  f"({len(routine['lifts'])} lifts)")
        elif args.command == "volume":
            print_volume(volume_report(rows, lib, cfg, args.window))
        elif args.command == "today":
            date = dt.date.fromisoformat(args.date) if args.date else dt.date.today()
            print_today(today_plan(rows, routine, lib, cfg, date), lib)
        elif args.command == "prescribe":
            name = need_exercise()
            if not name:
                return 2
            p = prescribe(rows, name, lib, cfg)
            print(f"{p['exercise']}  {fmt_load(p['weight_kg'], lib[name])} "
                  f"x{p['target_reps']}  ({p['reason']}"
                  f"{', from ' + p['basis_date'] if p['basis_date'] else ''})")
        elif args.command == "progression":
            name = need_exercise()
            if not name:
                return 2
            print_progression(exercise_progression(rows, name, lib, cfg))
        elif args.command == "index":
            print_index(strength_index(rows, lib, cfg))
        elif args.command == "bridge":
            print_bridge(volume_load_bridge(rows, lib, cfg))
        elif args.command == "stalls":
            print_stalls(detect_stalls(rows, lib, cfg))
        elif args.command == "balance":
            print_balance(balance_ratios(rows, lib, cfg))
        elif args.command == "adherence":
            print_adherence(adherence(rows, routine, lib, cfg))
        elif args.command == "report":
            print_volume(volume_report(rows, lib, cfg, 7)); print()
            print_adherence(adherence(rows, routine, lib, cfg)); print()
            print_index(strength_index(rows, lib, cfg)); print()
            print_bridge(volume_load_bridge(rows, lib, cfg)); print()
            print_stalls(detect_stalls(rows, lib, cfg)); print()
            print_balance(balance_ratios(rows, lib, cfg))
        elif args.command == "json":
            blob = analytics_json(rows, routine, lib, cfg)
            os.makedirs(os.path.dirname(args.out), exist_ok=True)
            with open(args.out, "w") as fh:
                json.dump(blob, fh, separators=(",", ":"))
            print(f"{args.out}: {os.path.getsize(args.out)} bytes", file=sys.stderr)
    except LogError as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
