#!/usr/bin/env python3
"""Print analyze.py's answer for every case in prescribe_cases.py.

analyze.py prescribe() is the referee for the copy of the rule in web/app.js. Run this,
then tests/prescribe_app.mjs against a server on web/, and compare line for line. Four
of these twelve disagreed the first time the check was run, so it is not ceremony.

    python3 tests/prescribe_ref.py
    (cd web && python3 -m http.server 8080 &) && node tests/prescribe_app.mjs 8080
"""
import csv, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, ROOT)
from prescribe_cases import CASES                                    # noqa: E402
import analyze as A                                                  # noqa: E402

for i, (ex, sets) in enumerate(CASES):
    path = os.path.join(tempfile.gettempdir(), f"prescribe_case{i}.csv")
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        # A.HEADER, not a literal: a column added to the schema must not break this.
        w.writerow(A.HEADER)
        for n, (kg, reps, rir) in enumerate(sets, 1):
            row = ["2026-09-20", "strength", ex, n, kg, reps, "" if rir is None else rir, ""]
            w.writerow(row + [""] * (len(A.HEADER) - len(row)))
    r = subprocess.run([sys.executable, os.path.join(ROOT, "analyze.py"), "prescribe",
                        "--log", path, "--exercise", ex],
                       capture_output=True, text=True, cwd=ROOT)
    if r.returncode:
        sys.exit(f"case {i} ({ex}): analyze.py failed\n{r.stderr}")
    print(f"{i:2} {ex:24} {str(sets)[:44]:46} -> {r.stdout.strip()}")
