---
description: Open a training session
allowed-tools: Bash(python3 analyze.py:*), Bash(ls:*), Bash(tail:*), Bash(grep:*), Read, Write
---

Open a new training session.

1. If `current_session.md` exists, STOP. Print one line naming the date and set count it
   holds, and ask: commit it with `/end`, or discard it? Do not create a new one.
2. Read `log.csv`. Take the last 14 days of rows.
3. Run `python3 analyze.py volume --window 7`. If `log.csv` has no rows yet, run it
   against `log.example.csv` and say the numbers are from the example log.
4. Create `current_session.md` with today's ISO date as a heading and nothing else.
5. Print exactly 3 lines, then stop:
   - `trained: N sessions in last 7d (dates)`
   - `gaps: <muscle> <delta>, <muscle> <delta>` - the two biggest under-target muscles
   - `focus: <2-4 canonical exercise names>` addressing those gaps

Do not print anything else. No plan, no encouragement, no analysis. Lower-body gaps are
reported but never turned into a focus recommendation - the cycling is not in this log.

After this, every message is a set. See the parsing table and the feedback contract in
CLAUDE.md.
