# workoutplan

Personal strength-training log and analytics. Run it in Claude Code; log set by set on the
phone during the session.

- `CLAUDE.md` is the operating manual - parsing rules, the progression rule, the feedback
  contract, the hard rules. Read that, not this.
- `log.csv` is the append-only system of record (empty until the first session).
- `log.example.csv` holds 3 seeded sessions so the analytics produce output on day zero.

```
/start          open a session
bench 80x8 @2   log a set (exercise is sticky afterwards)
/end            validate, append to log.csv, 4-line summary
/review         volume vs target bands, 7d and 14d
/plan           next session, loads from the progression rule
```

```
python3 analyze.py validate --log log.example.csv
python3 analyze.py volume   --log log.example.csv --window 7
```

Requires Python 3.10+ and pyyaml.

## web/ - prototype

A phone-first prototype of the logging loop: terse input, the 3-line feedback contract,
volume vs the target bands. Static HTML/CSS/JS, no build step, no backend.

`web/data.js` is GENERATED from `exercises.yaml`, `config.yaml` and `log.example.csv` -
the prototype never restates a rule. After editing any of those three:

```
python3 web/build_data.py
python3 -m http.server 8000 -d web    # then open http://localhost:8000
```

The prototype does not write `log.csv`. `/end` prints the rows the CLI would append.
