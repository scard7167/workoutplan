#!/bin/sh
# Every check that a syntax pass cannot do. Run from the repo root.
#
#   PW_ROOT=/tmp/pw sh tests/check.sh
#
# Playwright is deliberately not in web/package.json - that file is what Vercel installs.
# Install it anywhere (npm i --prefix /tmp/pw playwright) and point PW_ROOT at it.
set -e
PORT=${PORT:-8099}

echo "--- web/app.js parses as a module (node --check alone does not catch this) ---"
node --input-type=module --check < web/app.js && echo "OK"

echo "--- analyze.py imports ---"
python3 -c "import ast,sys;ast.parse(open('analyze.py').read())" && echo "OK"

echo "--- log.csv validates ---"
python3 analyze.py validate

echo "--- log.example.csv validates ---"
python3 analyze.py validate --log log.example.csv

echo "--- cardio reaches log.csv and cannot reach a strength number ---"
python3 tests/cardio_isolation.py

( cd web && python3 -m http.server "$PORT" >/dev/null 2>&1 & echo $! > /tmp/check_srv.pid )
sleep 2
trap 'kill "$(cat /tmp/check_srv.pid)" 2>/dev/null || true' EXIT

echo "--- analyze.py's progression rule still answers (the CLI keeps it; the app does not) ---"
python3 tests/prescribe_ref.py

echo "--- two years of sessions: nothing pruned, windows still compute ---"
node tests/long_horizon.mjs "$PORT" | grep -E "seeded|header:|History:|show-more|after one tap|lift detail|ERRORS"

echo "--- the app proposes no load: free entry, last session shown as reference ---"
node tests/free_entry.mjs "$PORT"

echo "--- an emptier document can never overwrite a fuller one ---"
rm -rf /tmp/slowboot && cp -r web /tmp/slowboot
python3 - <<'PYEOF'
s=open('/tmp/slowboot/app.js').read()
s=s.replace("async function boot() {","async function boot() {\n  await new Promise(r=>setTimeout(r,1500));",1)
open('/tmp/slowboot/app.js','w').write(s)
PYEOF
(cd /tmp/slowboot && python3 -m http.server 8399 >/dev/null 2>&1 & echo $! > /tmp/slow_srv.pid)
sleep 2
node tests/no_empty_write.mjs 8399 | grep -E "before reload|after  reload|PASS|FAIL"
kill "$(cat /tmp/slow_srv.pid)" 2>/dev/null || true

echo "--- a session logged but never finished survives the next day ---"
node tests/unfinished_session.mjs "$PORT" | grep -E "kicker|banner|History  |storage"

echo "--- running another day's session today ---"
node tests/day_swap.mjs "$PORT" | grep -E "a real shift|chip:|logged under date|plan untouched|ERRORS"

echo "--- local durability: IndexedDB mirror, and recovery from a wiped localStorage ---"
node tests/durability.mjs "$PORT" | grep -E "IndexedDB|after wiping|clipboard matches|ERRORS"
