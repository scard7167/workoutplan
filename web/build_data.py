#!/usr/bin/env python3
"""Regenerate web/data.js from the YAML library, config and a log.

The prototype must never carry its own copy of the rules. Run this after editing
exercises.yaml, config.yaml, routine.yaml or the log:

    python3 web/build_data.py                 # log.csv - the real one. What gets deployed.
    python3 web/build_data.py --example       # log.example.csv - 12 weeks of generated
                                              # history, for demoing the analytics

The default is the REAL log, empty or not. A build that quietly seeds the deployed app
with 12 weeks of fabricated history is worse than an empty one: on day one every lift
would show a "last week" number that never happened, and the whole point of the log is
that its numbers are true.
"""
import argparse, csv, json, os, subprocess, sys
import yaml

COMPACT = (",", ":")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

ap = argparse.ArgumentParser(description=__doc__,
                             formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("--example", action="store_true",
                help="build from log.example.csv instead of log.csv")
args = ap.parse_args()
LOG_NAME = "log.example.csv" if args.example else "log.csv"
LOG_PATH = os.path.join(ROOT, LOG_NAME)

lib = yaml.safe_load(open(os.path.join(ROOT, "exercises.yaml")))
cfg = yaml.safe_load(open(os.path.join(ROOT, "config.yaml")))
rows = list(csv.DictReader(open(LOG_PATH)))
routine = yaml.safe_load(open(os.path.join(ROOT, "routine.yaml")))
# Deep analytics are computed once by analyze.py and embedded. The browser renders
# these numbers; it never recomputes them. One implementation, no drift.
subprocess.run([sys.executable, os.path.join(ROOT, "analyze.py"), "json",
                "--log", LOG_PATH,
                "--out", os.path.join(ROOT, "web", "analytics.json")], check=True)
analytics = json.load(open(os.path.join(ROOT, "web", "analytics.json")))

log = [{"date": r["date"], "exercise": r["exercise"], "set_no": int(r["set_no"]),
        "weight_kg": float(r["weight_kg"]), "reps": int(r["reps"]),
        "rir": (None if r["rir"] == "" else int(r["rir"])), "notes": r["notes"]}
       for r in rows]

# image is optional and purely cosmetic - a relative path under web/. Fail loud if the
# library declares one that isn't actually there, same as any other broken reference.
for name, v in lib.items():
    if "image" in v and not os.path.exists(os.path.join(ROOT, "web", v["image"])):
        sys.exit(f"exercises.yaml: {name} image {v['image']!r} does not exist under web/")

ex = {k: {"aliases": v["aliases"], "muscles": v["muscles"], "increment": v["increment"],
          "rep_range": v["rep_range"], "bodyweight": bool(v.get("bodyweight")),
          **({"image": v["image"]} if "image" in v else {})}
      for k, v in lib.items()}

EX_JSON = json.dumps(ex, separators=COMPACT)
BAND_JSON = json.dumps(cfg["volume_targets"], separators=COMPACT)
METRIC_JSON = json.dumps(cfg["metrics"], separators=COMPACT)
PROG_JSON = json.dumps(cfg["progression"], separators=COMPACT)
ROUTINE_JSON = json.dumps(routine, separators=COMPACT)
UNCOVERED_JSON = json.dumps(cfg.get("uncovered_by_design", []), separators=COMPACT)
ANALYTICS_JSON = json.dumps(analytics, separators=COMPACT)
LOG_JSON = json.dumps(log, separators=COMPACT)

BUILD = __import__("datetime").datetime.now().strftime("%Y-%m-%d %H:%M")

out = (f"// GENERATED from exercises.yaml, config.yaml, routine.yaml, {LOG_NAME} and\n"
       "// analyze.py. Do not edit by hand. Regenerate: python3 web/build_data.py\n"
       f"export const EXERCISES = {EX_JSON};\n\n"
       f"export const BANDS = {BAND_JSON};\n\n"
       f"export const UNCOVERED = {UNCOVERED_JSON};\n\n"
       f"export const METRICS = {METRIC_JSON};\n\n"
       f"export const PROGRESSION = {PROG_JSON};\n\n"
       f"export const ROUTINE = {ROUTINE_JSON};\n\n"
       f"export const ANALYTICS = {ANALYTICS_JSON};\n\n"
       f"export const SEED_LOG = {LOG_JSON};\n\n"
       f"export const BUILD = {json.dumps(BUILD)};\n")
open(os.path.join(ROOT, "web", "data.js"), "w").write(out)
print(f"web/data.js: {len(ex)} exercises, {len(log)} seed sets, "
      f"{len(analytics['sessions'])} sessions of analytics", file=sys.stderr)
