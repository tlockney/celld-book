"""Audit the built book: leftover series phrasing in visible prose, glossary and xref counts per page."""
import glob
import html
import re
import sys

DIST = sys.argv[1] if len(sys.argv) > 1 else "dist"
PAT = re.compile(r"Part [012](?! ?—)|Notebooks? \d|Reading Room|series|§ \d\d")


def visible(s: str) -> str:
    s = re.sub(r"<(script|style|pre|svg|code)\b.*?</\1>", " ", s, flags=re.S)
    s = re.sub(r'<div class="outputs">.*?</section>', " ", s, flags=re.S)
    s = re.sub(r'<header class="bookbar">.*?</nav>', " ", s, flags=re.S)
    return html.unescape(re.sub(r"<[^>]+>", " ", s))


for f in sorted(glob.glob(f"{DIST}/*.html")):
    s = open(f).read()
    text = visible(s)
    hits = []
    for m in PAT.finditer(text):
        ctx = re.sub(r"\s+", " ", text[max(0, m.start() - 50):m.end() + 40])
        hits.append(ctx)
    gloss = s.count('class="gloss"')
    xlinks = len(re.findall(r'<a href="(?:[a-z0-9-]+\.html)?#?[^"]*">(?:Chapter|Chapters|Lab|Appendix|Part II|Step|§)', s))
    print(f"== {f.split('/')[-1]}  gloss={gloss} xref-links={xlinks} leftovers={len(hits)}")
    for h in hits[:12]:
        print("    …" + h + "…")
