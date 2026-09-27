#!/usr/bin/env python3
"""Compare tests/prescribe_ref.py's output against tests/prescribe_app.mjs's, case by case.

Exits non-zero on any mismatch, so this is the check and not a thing to read. The two
sides print in different notations on purpose - the CLI in its own display form ("-" for
no load, "bw" for bodyweight, "+2.5" for added load) and the app as the raw box values -
so the normalisation below is where those meet.
"""
import re, sys

ref_lines = [l for l in open(sys.argv[1]) if l.strip()]
app_lines = [l for l in open(sys.argv[2]) if l.strip() and not l.startswith("no page")]

bad = 0
for r, a in zip(ref_lines, app_lines):
    rm = re.search(r"->\s+\S+\s+(\S+)\s+x(\d+)", r)
    am = re.search(r"w=(\S+)\s+r=(\d+)", a)
    if not rm or not am:
        print(f"UNPARSED\n  ref {r.strip()}\n  app {a.strip()}")
        bad += 1
        continue
    rw = rm.group(1)
    want = "(empty)" if rw == "-" else "0" if rw == "bw" else rw.lstrip("+")
    if want != am.group(1) or rm.group(2) != am.group(2):
        print(f"MISMATCH\n  ref {r.strip()}\n  app {a.strip()}")
        bad += 1

if len(ref_lines) != len(app_lines):
    print(f"CASE COUNT differs: referee {len(ref_lines)}, app {len(app_lines)}")
    bad += 1

print(f"{len(ref_lines)} cases, {bad} mismatch{'' if bad == 1 else 'es'}")
sys.exit(1 if bad else 0)
