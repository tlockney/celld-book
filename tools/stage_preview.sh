#!/bin/sh
# Stage dist/ for a multi-page claude.ai artifact preview: stage_preview.sh DEST
# The artifact publisher wraps the main page in its own document skeleton, so the cover is
# written unwrapped (_cover.html); every other page is published as-is beside it.
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEST=$1
rm -rf "$DEST"
mkdir -p "$DEST/icons"
cp "$ROOT"/dist/*.html "$ROOT/dist/manifest.webmanifest" "$DEST/"
cp "$ROOT"/dist/icons/*.png "$DEST/icons/"
python3 - "$ROOT/dist/index.html" "$DEST/_cover.html" <<'EOF'
import re, sys
s = open(sys.argv[1]).read()
head = re.search(r"<head>(.*?)</head>", s, re.S).group(1)
head = re.sub(r'<meta charset="utf-8">\s*|<meta name="viewport"[^>]*>\s*', "", head)
body = re.search(r"<body>(.*)</body>", s, re.S).group(1)
open(sys.argv[2], "w").write(head.strip() + "\n" + body.strip() + "\n")
EOF
ls "$DEST" | wc -l
