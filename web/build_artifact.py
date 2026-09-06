#!/usr/bin/env python3
"""Bundle web/ into a single self-contained page (no doctype/head/body wrapper).

Used to publish the prototype as a Claude Artifact, which serves one file and
cannot fetch sibling .js/.css. Everything else stays the same code.

    python3 web/build_artifact.py
"""
import os, re, sys

WEB = os.path.dirname(os.path.abspath(__file__))
read = lambda n: open(os.path.join(WEB, n)).read()

html = read("index.html")
body = html.split("<body>", 1)[1].split("</body>", 1)[0]
body = body.replace('<script type="module" src="app.js"></script>', "").strip()

app = read("app.js")
app = re.sub(r'^import \{.*?\}\s*from "\./data\.js";\n', "", app, flags=re.M | re.S)
data = re.sub(r"^export const ", "const ", read("data.js"), flags=re.M)

out = f"""<title>Strength Log</title>
<style>
{read("styles.css")}</style>

{body}

<script type="module">
{data}
{app}</script>
"""
path = os.path.join(WEB, "artifact.html")
open(path, "w").write(out)
print(f"{path}: {len(out)} bytes", file=sys.stderr)
