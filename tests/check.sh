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

echo "--- the progression rule: app vs analyze.py, 12 cases ---"
python3 tests/prescribe_ref.py > /tmp/check_ref.txt
node tests/prescribe_app.mjs "$PORT" > /tmp/check_app.txt 2>&1
python3 tests/prescribe_diff.py /tmp/check_ref.txt /tmp/check_app.txt

echo "--- RIR reaches the store and the next session progresses ---"
node tests/rir_progression.mjs "$PORT" | tail -4

echo "--- local durability: IndexedDB mirror, and recovery from a wiped localStorage ---"
node tests/durability.mjs "$PORT" | grep -E "IndexedDB|after wiping|clipboard matches|ERRORS"
