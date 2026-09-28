#!/bin/sh
# Report elements wider than a phone viewport: overflow.sh page.html [width]
# Copies the page with a diagnostic script appended, loads it headless, and prints the findings.
set -e
PAGE=$1; W=${2:-390}
DIST=$(cd "$(dirname "$0")/.." && pwd)/dist
cp "$DIST/$PAGE" "$DIST/_diag.html"
cat >> "$DIST/_diag.html" <<'EOF'
<script>
addEventListener("load", () => {
  const vw = document.documentElement.clientWidth;
  const rows = [];
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0) continue;
    if (r.right > vw + 1 || el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === "visible") {
      const depth = (() => { let d = 0, p = el; while ((p = p.parentElement)) d++; return d; })();
      rows.push({ depth, desc: `${el.tagName.toLowerCase()}.${[...el.classList].join(".")} right=${Math.round(r.right)} w=${Math.round(r.width)} sw=${el.scrollWidth} ws=${getComputedStyle(el).whiteSpace} minw=${getComputedStyle(el).minWidth}` });
    }
  }
  rows.sort((a, b) => a.depth - b.depth);
  const pre = document.createElement("pre");
  pre.id = "diag-out";
  pre.textContent = `vw=${vw} docW=${document.documentElement.scrollWidth}\n` + rows.slice(0, 40).map((r) => "  ".repeat(Math.min(r.depth, 12)) + r.desc).join("\n");
  document.body.append(pre);
});
</script>
EOF
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --window-size="$W,844" \
  --virtual-time-budget=3000 --dump-dom "http://127.0.0.1:8420/_diag.html" 2>/dev/null |
  sed -n '/<pre id="diag-out">/,/<\/pre>/p' | sed 's/<[^>]*>//g; s/&gt;/>/g; s/&lt;/</g'
rm -f "$DIST/_diag.html"
