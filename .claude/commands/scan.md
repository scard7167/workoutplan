---
description: Identify a gym machine from a photo/screenshot and map it to the library
allowed-tools: Read, Edit, Write, Bash(python3 analyze.py:*)
---

Identify the exercise in an attached image - a gym machine's nameplate, QR-code landing
page, or a photo of the machine itself - and resolve it against `exercises.yaml`. This
is a chat-time capability: it runs here, in the session, using vision. It is not part
of the deployed web prototype, which is static JS with no model behind it.

1. Read the image. Extract: brand/model if shown, the exercise name (translate if not
   English), the muscle(s) it trains, and anything relevant to `rep_range`/`increment`
   (a plate-loaded stack and its increment if legible, DB pair vs single, bodyweight +
   assist).
2. Try to resolve it against `exercises.yaml` - by name, by translated name, or by what
   the equipment obviously is (an incline plate-stack chest press is functionally
   `incline_db_press`'s machine cousin, not a match to it: DB weight is per-dumbbell,
   machine weight is total stack. Do not conflate the two units under one exercise).
   - **Match found** -> report the canonical name, then `swap to` it (sticky, same as
     typing `swap to X`) so logging can continue immediately. If that exercise has no
     `image` yet, save this photo as its reference image (see step 5) and say so in one
     line - this is cosmetic, not a library change, so it does not need confirmation.
     Say the match and stop.
   - **No match** -> propose a new entry: canonical `snake_case` name, `aliases`
     (include the brand+model exactly as shown, since that is what the QR code will
     show again), `muscles` (only what's actually a prime mover - don't invent
     "upper chest" as its own group, use `chest`), `increment`, `rep_range`. State
     which fields are read directly off the machine vs guessed, and for anything
     guessed, say so and ask rather than picking a plausible-looking default -
     `increment` in particular is load-bearing for the progression rule and a wrong
     guess corrupts every future prescription for that lift silently.
3. **Never write to `exercises.yaml` or `routine.yaml` without an explicit go-ahead** -
   same bar as any other library edit in CLAUDE.md. Ask:
   - confirm the proposed fields (or correct them)
   - whether it also goes into `routine.yaml` - if so, which day/slot, and whether it
     replaces an existing lift there or adds to it (adding changes that muscle's
     weekly volume and its band in `config.yaml`, since bands are derived from the
     routine)
4. On confirmation: add the entry, save the reference photo (step 5), run
   `python3 analyze.py validate` to confirm the library and routine still parse, and say
   what changed in one line. If it was added to `routine.yaml`, note that
   `python3 web/build_data.py` needs a re-run before the web app reflects it.
5. **Saving the reference photo.** Crop to the machine/equipment itself (not surrounding
   UI chrome), resize so the long edge is ~480px, save as JPEG quality ~78 under
   `web/images/<exercise>.jpg`, and set `image: images/<exercise>.jpg` on that exercise's
   entry in `exercises.yaml`. This field is purely cosmetic - the web app shows it as a
   small thumbnail next to the lift, click to expand - and is never read by `analyze.py`
   or the progression rule. `web/build_data.py` fails loud if the path doesn't resolve,
   so a bad crop/save shows up immediately on the next rebuild, not silently.

Never invent a canonical name that isn't in the library and log a set against it
mid-session - resolve or ask first, per the parsing rules in CLAUDE.md.
