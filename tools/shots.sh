#!/bin/sh
# Headless screenshots for a visual check: shots.sh OUTDIR page-or-url[@WxH] ...
# A bare page name is served from the local book server (http://127.0.0.1:8420/).
set -e
OUT=$1; shift
mkdir -p "$OUT"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
for spec in "$@"; do
  page=${spec%%@*}; size=${spec#*@}; [ "$size" = "$spec" ] && size=1280x900
  case "$page" in http*) url=$page ;; *) url="http://127.0.0.1:8420/$page" ;; esac
  name=$(echo "$page-$size" | sed 's|https*://||; s|[/#?=&:]|_|g')
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --window-size="${size%x*},${size#*x}" \
    --screenshot="$OUT/$name.png" "$url" >/dev/null 2>&1
  echo "$OUT/$name.png"
done
