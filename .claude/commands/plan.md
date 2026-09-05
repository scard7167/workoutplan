---
description: Propose the next session - exercises and prescribed loads
allowed-tools: Bash(python3 analyze.py:*), Read
---

Propose the next session. Read-only.

1. Run `python3 analyze.py volume --window 7` to find the under-target muscles.
2. Pick 5-7 exercises from `exercises.yaml` that credit those muscles, weighted to the
   biggest gaps. Never propose an exercise that is not in the library. If a gap has no
   library coverage, say so - do not invent a lift.
3. For each exercise, look up its most recent session in `log.csv` and apply the
   progression rule in CLAUDE.md to get the prescribed load and target reps. This is a
   two-number lookup, not an analytics run. No prior session -> print `no baseline` and
   leave the load blank. Never guess a starting load.
4. Print one line per exercise, nothing else:
   `<exercise>  <sets> x <target reps> @ <load> kg   (<reason: progress|hold|deload|no baseline>)`
5. Close with one line: total sets and which muscles the session closes the gap on.

Constraints:
- Every load must be reproducible from the progression rule. If you cannot derive it,
  print `no baseline` rather than a number.
- Never add leg volume on the basis of this log alone.
