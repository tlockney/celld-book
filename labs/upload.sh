#!/bin/sh
# Upload the series-variant lab notebooks (with their executed outputs) and the generators to the homelab
# JupyterLab (work/celld/). Run `deno task series` first. No execution happens here.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
API=${JUPYTER_API:-https://jupyter.home.lockney.net/api/contents/work/celld}
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
for n in celld-01-cells celld-02-bindings celld-03-processes; do
  python3 -c 'import json,sys; json.dump({"type":"notebook","format":"json","content":json.load(open(sys.argv[1]))}, open(sys.argv[2],"w"))' \
    "$ROOT/out/series/labs/$n.ipynb" "$TMP/$n.json"
  printf 'PUT %s.ipynb -> ' "$n"
  curl -s -o /dev/null -w '%{http_code}\n' -X PUT -H 'Content-Type: application/json' --data-binary @"$TMP/$n.json" "$API/$n.ipynb"
done
for f in build_01.py build_02.py build_03.py celld_nb.ts; do
  python3 -c 'import json,sys; json.dump({"type":"file","format":"text","content":open(sys.argv[1]).read()}, open(sys.argv[2],"w"))' \
    "$ROOT/labs/$f" "$TMP/$f.json"
  printf 'PUT %s -> ' "$f"
  curl -s -o /dev/null -w '%{http_code}\n' -X PUT -H 'Content-Type: application/json' --data-binary @"$TMP/$f.json" "$API/$f"
done
