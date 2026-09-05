---
description: Validate the session, append to log.csv, print a 4-line summary
allowed-tools: Bash(python3 analyze.py:*), Bash(cat:*), Bash(rm:*), Bash(cp:*), Read, Write, Edit
---

Close the session in `current_session.md`.

1. If `current_session.md` does not exist, print `no open session` and stop.
2. Validate EVERY line before writing anything:
   - resolves to a canonical exercise in `exercises.yaml`
   - `set_no` 1-based and unique within (date, exercise)
   - `weight_kg` >= 0, and 0 only for exercises flagged `bodyweight: true`
   - `reps` >= 1, `rir` blank or 0-4
   - date is today's ISO date unless the session says otherwise
   Anything malformed: FAIL LOUD. Print `FAIL <line N>: <reason>` for every bad line,
   change nothing, delete nothing, and stop. Do not repair a line silently.
3. Append the validated rows to `log.csv` in exact schema order. Append only - never
   rewrite, reorder, or edit an existing row.
4. Run `python3 analyze.py validate`. If it fails, say so loudly - the append is already
   on disk and needs an explicit, stated correction.
5. Delete `current_session.md`.
6. Print exactly 4 lines:
   - `logged: N sets, M exercises, <date>`
   - `volume: <top 3 muscles by sets today>`
   - `PRs: <exercise e1RM new best>` or `PRs: none`
   - `next: <the two muscles furthest under their 7d band>`

No commentary beyond those 4 lines.
