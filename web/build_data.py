#!/usr/bin/env python3
"""Regenerate web/data.js from the YAML library, config and the example log.

The prototype must never carry its own copy of the rules. Run this after editing
exercises.yaml, config.yaml or log.example.csv:

    python3 web/build_data.py
"""
import csv, json, os, subprocess, sys
import yaml

COMPACT = (",", ":")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

lib = yaml.safe_load(open(os.path.join(ROOT, "exercises.yaml")))
cfg = yaml.safe_load(open(os.path.join(ROOT, "config.yaml")))
rows = list(csv.DictReader(open(os.path.join(ROOT, "log.example.csv"))))
routine = yaml.safe_load(open(os.path.join(ROOT, "routine.yaml")))
# Deep analytics are computed once by analyze.py and embedded. The browser renders
# these numbers; it never recomputes them. One implementation, no drift.
subprocess.run([sys.executable, os.path.join(ROOT, "analyze.py"), "json",
                "--log", os.path.join(ROOT, "log.example.csv"),
                "--out", os.path.join(ROOT, "web", "analytics.json")], check=True)
analytics = json.load(open(os.path.join(ROOT, "web", "analytics.json")))

log = [{"date": r["date"], "exercise": r["exercise"], "set_no": int(r["set_no"]),
        "weight_kg": float(r["weight_kg"]), "reps": int(r["reps"]),
        "rir": (None if r["rir"] == "" else int(r["rir"])), "notes": r["notes"]}
       for r in rows]
ex = {k: {"aliases": v["aliases"], "muscles": v["muscles"], "increment": v["increment"],
          "rep_range": v["rep_range"], "bodyweight": bool(v.get("bodyweight"))}
      for k, v in lib.items()}

EX_JSON = json.dumps(ex, separators=COMPACT)
BAND_JSON = json.dumps(cfg["volume_targets"], separators=COMPACT)
METRIC_JSON = json.dumps(cfg["metrics"], separators=COMPACT)
PROG_JSON = json.dumps(cfg["progression"], separators=COMPACT)
ROUTINE_JSON = json.dumps(routine, separators=COMPACT)
UNCOVERED_JSON = json.dumps(cfg.get("uncovered_by_design", []), separators=COMPACT)
ANALYTICS_JSON = json.dumps(analytics, separators=COMPACT)
LOG_JSON = json.dumps(log, separators=COMPACT)

out = ("// GENERATED from exercises.yaml, config.yaml, routine.yaml, log.example.csv and\n"
       "// analyze.py. Do not edit by hand. Regenerate: python3 web/build_data.py\n"
       f"export const EXERCISES = {EX_JSON};\n\n"
       f"export const BANDS = {BAND_JSON};\n\n"
       f"export const UNCOVERED = {UNCOVERED_JSON};\n\n"
       f"export const METRICS = {METRIC_JSON};\n\n"
       f"export const PROGRESSION = {PROG_JSON};\n\n"
       f"export const ROUTINE = {ROUTINE_JSON};\n\n"
       f"export const ANALYTICS = {ANALYTICS_JSON};\n\n"
       f"export const SEED_LOG = {LOG_JSON};\n")
open(os.path.join(ROOT, "web", "data.js"), "w").write(out)
print(f"web/data.js: {len(ex)} exercises, {len(log)} seed sets, "
      f"{len(analytics['sessions'])} sessions of analytics", file=sys.stderr)
