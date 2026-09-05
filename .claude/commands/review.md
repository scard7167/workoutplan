---
description: Volume and balance review over the rolling windows
allowed-tools: Bash(python3 analyze.py:*), Read
---

Review recent training. Read-only - never writes to `log.csv`.

1. Run `python3 analyze.py volume --window 7` and `python3 analyze.py volume --window 14`.
2. Report the output as-is. Do not recompute, re-weight, or reinterpret the numbers.
3. Then, in at most 6 lines: what is RED, what changed between the 7d and 14d picture,
   and the single highest-value correction for the next session.

Constraints:
- If asked for anything the analytics do not yet produce - e1RM trend, strength index,
  volume-load bridge, stalls, balance ratios - say it is not built yet and name the stub
  in `analyze.py`. Never compute it ad hoc from the CSV.
- Lower-body flags are informational. Never recommend more leg volume on the basis of this
  log alone.
- No encouragement, no filler.
