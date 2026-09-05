#!/usr/bin/env python3
"""Regenerate web/data.js from the YAML library, config and the example log.

The prototype must never carry its own copy of the rules. Run this after editing
exercises.yaml, config.yaml or log.example.csv:

    python3 web/build_data.py
"""
import csv, json, os, sys
import yaml

COMPACT = (",", ":")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

lib = yaml.safe_load(open(os.path.join(ROOT, "exercises.yaml")))
cfg = yaml.safe_load(open(os.path.join(ROOT, "config.yaml")))
rows = list(csv.DictReader(open(os.path.join(ROOT, "log.example.csv"))))

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
LOG_JSON = json.dumps(log, separators=COMPACT)

out = ("// GENERATED from exercises.yaml, config.yaml and log.example.csv. Do not edit by hand.\n"
       "// Regenerate: python3 web/build_data.py\n"
       f"export const EXERCISES = {EX_JSON};\n\n"
       f"export const BANDS = {BAND_JSON};\n\n"
       f"export const METRICS = {METRIC_JSON};\n\n"
       f"export const PROGRESSION = {PROG_JSON};\n\n"
       f"export const SEED_LOG = {LOG_JSON};\n")
open(os.path.join(ROOT, "web", "data.js"), "w").write(out)
print(f"web/data.js: {len(ex)} exercises, {len(log)} seed sets", file=sys.stderr)
