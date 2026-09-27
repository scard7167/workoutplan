#!/usr/bin/env python3
"""Cardio reaches log.csv, and cannot reach a strength number.

The second half is the point. Cardio was rejected outright until 2026-09-27, so nothing
downstream filters it - every analytic just takes whatever `load_log` hands back. The
guarantee is therefore load_log's DEFAULT, and this asserts it rather than trusting it.

    python3 tests/cardio_isolation.py
"""
import csv, json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
import analyze as A                                                  # noqa: E402

lib, cfg = A.load_exercises(), A.load_config()
fails = []


def check(label, cond, detail=""):
    print(f"{'ok  ' if cond else 'FAIL'} {label}{'' if cond else '  <- ' + str(detail)}")
    if not cond:
        fails.append(label)


STORE = {
    "sessions": {"2026-09-25": {"date": "2026-09-25", "lifts": {
        "bench_press": [{"w": 60, "r": 10, "rir": 1}, {"w": 60, "r": 10, "rir": 2}]}}},
    "cardio": [
        {"id": 1, "date": "2026-09-21", "type": "Bike", "min": 45, "km": 18.4},
        {"id": 2, "date": "2026-09-23", "type": "Outdoor run", "min": 38, "km": 7.2},
        {"id": 3, "date": "2026-09-26", "type": "Elliptical", "min": 30, "km": None},
    ],
}

tmp = tempfile.mkdtemp()
log = os.path.join(tmp, "log.csv")
with open(log, "w", newline="") as fh:
    csv.writer(fh).writerow(A.HEADER)
store = os.path.join(tmp, "store.json")
json.dump(STORE, open(store, "w"))


def sync(*extra):
    return subprocess.run([sys.executable, os.path.join(ROOT, "analyze.py"), "sync",
                           "--from", store, "--log", log, *extra],
                          capture_output=True, text=True, cwd=ROOT)


# --- the app's title-case types resolve through exercises.yaml, not a private table
r = sync()
check("dry run writes nothing", len(open(log).read().splitlines()) == 1)
for want in ("bike", "outdoor_run", "elliptical"):
    check(f"{want} resolved from the app's title case", want in r.stdout, r.stdout)

r = sync("--apply")
check("apply succeeded", r.returncode == 0, r.stderr)

# --- chronological, so the append-only warning never fires
dates = [row["date"] for row in csv.DictReader(open(log))]
check("appended in date order", dates == sorted(dates), dates)
check("no append-only warning", "precedes" not in r.stdout + r.stderr)

# --- THE GUARANTEE: the default load is strength-only
st = A.load_log(log, lib, cfg)
ca = A.load_log(log, lib, cfg, kind="cardio", warn=False)
al = A.load_log(log, lib, cfg, kind="all", warn=False)
check("default load is strength only", all(s.type == "strength" for s in st),
      sorted({s.type for s in st}))
check("2 strength rows, not 5", len(st) == 2, len(st))
check("3 cardio rows readable on request", len(ca) == 3, len(ca))
check("kind=all sees both", len(al) == 5, len(al))
check("cardio carries duration", all(c.duration_min for c in ca))
check("cardio carries no load or reps", all(c.weight_kg == 0 and c.reps == 0 for c in ca))

# --- so no strength derivation moves
vol = A.volume_report(st, lib, cfg, 7)
check("volume counts 2 sets, not 5", vol["sets"] == 2, vol.get("sets"))
p = A.prescribe(st, "bench_press", lib, cfg)
check("prescribe unaffected by 113 min of cardio",
      (p["weight_kg"], p["reason"]) == (62.5, "progress"), p)

# --- idempotent
before = open(log).read()
sync("--apply")
check("re-running appends nothing", open(log).read() == before)

# --- a malformed cardio row is refused, and the log is untouched
bad = os.path.join(tmp, "bad.json")
json.dump({"cardio": [{"id": 9, "date": "2026-09-28", "type": "Bike", "min": 0}]},
          open(bad, "w"))
before = open(log).read()
r = subprocess.run([sys.executable, os.path.join(ROOT, "analyze.py"), "sync",
                    "--from", bad, "--log", log, "--apply"],
                   capture_output=True, text=True, cwd=ROOT)
check("zero-duration cardio refused", r.returncode == 2, r.stdout + r.stderr)
check("log untouched after a refusal", open(log).read() == before)

print()
print("FAILED: " + ", ".join(fails) if fails else "all checks passed")
sys.exit(1 if fails else 0)
