#!/usr/bin/env python3
"""Regenerate log.example.csv: 12 weeks of plausible history on the current routine.

Every load in the output is produced by analyze.prescribe() - the same function the
app uses - so the example log is exactly what following the rule would produce. Reps
and RIR are simulated: a per-exercise rep capacity that grows slowly, declines across
sets within a session, is capped at the rep-range ceiling (which is what makes double
progression fire), and drops back when the load goes up.

This file generates EXAMPLE data only. It never touches log.csv.

    python3 seed_example.py
"""
import csv
import datetime as dt
import os
import random
import sys

import analyze as A

HERE = os.path.dirname(os.path.abspath(__file__))
END = dt.date(2026, 9, 4)
WEEKS = 12
SKIP_RATE = 0.11          # sessions missed to life
BAD_DAY_RATE = 0.02       # a session that goes badly enough to trip the deload rule
STALL_AFTER_WEEK = 8      # overhead_press flattens out from here - something must stall

START_LOAD = {
    "bench_press": 75.0, "pullup": 0.0, "chest_supported_row": 55.0,
    "overhead_press": 45.0, "lateral_raise": 10.0, "face_pull": 22.5,
    "barbell_curl": 30.0, "triceps_pushdown": 27.5, "romanian_deadlift": 80.0,
    "hanging_leg_raise": 0.0,
}
DELOAD_WEEK = 6           # a planned easy week - real training has them
DECLINE = [0.0, 1.1, 2.0, 2.8]     # reps lost on set 2, 3, 4 relative to the top set


def main() -> int:
    rng = random.Random(4471)
    cfg, lib = A.load_config(), A.load_exercises()
    routine = A.load_routine(lib)

    start = END - dt.timedelta(weeks=WEEKS) + dt.timedelta(days=1)
    start -= dt.timedelta(days=start.weekday())          # begin on a Monday

    capacity = {e: lib[e]["rep_range"][0] + 1.5 for e in routine["lifts"]}
    rows: list[A.Set] = []
    line = 1
    out: list[list] = []

    d = start
    while d <= END:
        if rng.random() < SKIP_RATE:
            d += dt.timedelta(days=1)
            continue
        bad_day = rng.random() < BAD_DAY_RATE
        week_no = (d - start).days // 7
        for item in routine["week"][A.WEEKDAYS[d.weekday()]]["plan"]:
            ex_name = item["exercise"]
            ex = lib[ex_name]
            floor, ceiling = ex["rep_range"]
            p = A.prescribe(rows, ex_name, lib, cfg)

            if p["weight_kg"] is None:
                load = START_LOAD[ex_name]
            else:
                load = p["weight_kg"]
                if p["reason"] == "progress":
                    capacity[ex_name] -= 1.2   # a 2.5-3% load jump costs about a rep
                elif p["reason"].startswith("deload"):
                    capacity[ex_name] += 1.5

            growth = 0.18
            if week_no == DELOAD_WEEK:
                growth = -0.55
            if ex_name == "overhead_press" and week_no >= STALL_AFTER_WEEK:
                growth = 0.0
            capacity[ex_name] += growth + rng.uniform(-0.16, 0.16)
            capacity[ex_name] = min(max(capacity[ex_name], floor - 0.4), ceiling + 2.4)

            for i in range(item["sets"]):
                raw = capacity[ex_name] - DECLINE[min(i, 3)] - (2.4 if bad_day else 0)
                reps = max(1, min(ceiling, int(round(raw))))
                if reps >= ceiling:
                    rir = 2 if i == 0 else rng.choice([1, 2])
                elif bad_day and reps < floor:
                    rir = 0
                else:
                    rir = max(0, min(4, int(round(2 - i * 0.9 + rng.uniform(-0.4, 0.4)))))
                line += 1
                rows.append(A.Set(line, d, "strength", ex_name, i + 1, load, reps, rir, ""))
                out.append([d.isoformat(), "strength", ex_name, i + 1,
                            f"{load:g}", reps, rir, "bad session" if bad_day and i == 0 else ""])
        d += dt.timedelta(days=1)

    path = os.path.join(HERE, "log.example.csv")
    with open(path, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(A.HEADER)
        w.writerows(out)
    print(f"{path}: {len(out)} sets, {len({r[0] for r in out})} sessions, "
          f"{start} -> {END}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
