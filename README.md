# workoutplan

Personal strength-training log and analytics. Run it in Claude Code; log set by set on the
phone during the session.

- `CLAUDE.md` is the operating manual - parsing rules, the progression rule, the feedback
  contract, the hard rules. Read that, not this.
- `log.csv` is the append-only system of record (empty until the first session).
- `log.example.csv` holds 12 weeks of generated history so the analytics produce
  output on day zero - real output of `prescribe()`, not hand-typed.

```
/start          open a session
bench 80x8 @2   log a set (exercise is sticky afterwards)
/end            validate, append to log.csv, 4-line summary
/review         volume vs target bands, 7d and 14d
/plan           next session, loads from the progression rule
/scan           drop a photo of a gym machine - resolves it against the library,
                or proposes a new entry and asks before adding it
```

```
python3 analyze.py validate --log log.example.csv
python3 analyze.py volume   --log log.example.csv --window 7
```

Requires Python 3.10+ and pyyaml.

## web/ - prototype

A phone-first prototype: Today (the plan, prescribed loads, terse logging, the 3-line
feedback contract), Trends (e1RM per lift, strength index, the volume-load bridge,
stalls, balance, adherence), Plan (edit the weekly routine, export routine.yaml).
Static HTML/CSS/JS, no build step, no backend.

`web/data.js` embeds the exercise library, the routine, the bands and a full run of
`analyze.py`'s analytics (`web/analytics.json`) - generated, never hand-edited. Every
deep number in Trends is computed once by `analyze.py` and rendered as-is; nothing is
recomputed in JavaScript. After editing `exercises.yaml`, `config.yaml`, `routine.yaml`
or `log.example.csv`:

```
python3 web/build_data.py
python3 -m http.server 8000 -d web    # then open http://localhost:8000
```

An exercise can carry an optional reference photo (`image:` in `exercises.yaml`,
a file under `web/images/`) - shown as a small thumbnail next to it in Today, click to
expand. Purely cosmetic, never read by `analyze.py`. `/scan` attaches these
automatically when it identifies a machine from a photo.

`web/build_artifact.py` bundles everything into one file (`web/artifact.html`, not
tracked) for hosts that can't fetch sibling files, such as a Claude Artifact - any
exercise photo is inlined as a base64 data URI in that build.

The prototype does not write `log.csv`. Finish prints the rows the CLI would append.
Session state and any plan edits live in `localStorage`, per browser.
