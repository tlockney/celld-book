"""Compare a rewritten markdown document (or notebook generator) against its original.

Reports what a clarity rewrite must not lose or silently change:
  - inline code spans (`...`) present before and absent after
  - numbers (with units where attached) present before and absent after
  - URLs present before and absent after
  - heading ids ({#id}) present before and absent after
  - fenced code blocks and raw HTML/SVG figure blocks that changed
  - (generators) code() cells that changed

Usage:
  factcheck.py before.md after.md
  factcheck.py --generator before_build.py after_build.py

Exit 0 always; read the report. A "lost" item is not automatically wrong (a
duplicate may be deliberately merged, a version-history aside deliberately
dropped), but every lost item must be accounted for.
"""
import re
import sys
from collections import Counter

gen = sys.argv[1] == "--generator"
before_path, after_path = (sys.argv[2], sys.argv[3]) if gen else (sys.argv[1], sys.argv[2])
before, after = open(before_path).read(), open(after_path).read()


def fences(s: str) -> list[str]:
    return re.findall(r"^```[^\n]*\n.*?^```", s, re.S | re.M)


def figures(s: str) -> list[str]:
    return re.findall(r"<figure.*?</figure>|<svg.*?</svg>", s, re.S)


def strip_blocks(s: str) -> str:
    s = re.sub(r"^```[^\n]*\n.*?^```", " ", s, flags=re.S | re.M)
    return re.sub(r"<figure.*?</figure>|<svg.*?</svg>", " ", s, flags=re.S)


def prose(s: str) -> str:
    if not gen:
        return strip_blocks(s)
    return "\n".join(re.findall(r"md\(r'''(.*?)'''\)", s, re.S))


def spans(s: str) -> Counter:
    return Counter(re.findall(r"`([^`\n]+)`", s))


NUM = re.compile(r"(?<![\w.])(\d[\d,]*(?:\.\d+)?(?:\s?(?:%|×|ms|s|KiB|MiB|GiB|MB|GB|KB|bytes|seconds|minutes|hours|days|nodes|vCPU))?)(?![\w])")


def numbers(s: str) -> Counter:
    s = re.sub(r"`[^`\n]+`", " ", s)          # inline code counted separately
    s = re.sub(r"https?://\S+", " ", s)
    return Counter(n.strip() for n in NUM.findall(s))


def urls(s: str) -> set[str]:
    return set(u.rstrip(").,") for u in re.findall(r"https?://[^\s)\"'<>]+", s))


def ids(s: str) -> set[str]:
    return set(re.findall(r"\{#([\w-]+)\}", s))


pb, pa = prose(before), prose(after)
lost_spans = sorted(set(spans(pb)) - set(spans(pa)))
lost_numbers = sorted(set(numbers(pb)) - set(numbers(pa)), key=lambda x: (len(x), x))
lost_urls = sorted(urls(before) - urls(after))
lost_ids = sorted(ids(before) - ids(after))

print(f"# factcheck  {before_path}  →  {after_path}")
print(f"words: {len(pb.split())} → {len(pa.split())}")
print(f"\n## inline code spans lost ({len(lost_spans)})")
for x in lost_spans:
    print(f"  `{x}`")
print(f"\n## numbers lost ({len(lost_numbers)})")
print("  " + " · ".join(lost_numbers) if lost_numbers else "  (none)")
print(f"\n## urls lost ({len(lost_urls)})")
for u in lost_urls:
    print(f"  {u}")
print(f"\n## heading ids lost ({len(lost_ids)})")
for i in lost_ids:
    print(f"  {i}")

if gen:
    cb = re.findall(r"code\(r'''(.*?)'''\)", before, re.S)
    ca = re.findall(r"code\(r'''(.*?)'''\)", after, re.S)
    changed = [i for i, (x, y) in enumerate(zip(cb, ca)) if x != y]
    print(f"\n## code cells: {len(cb)} → {len(ca)}; changed: {changed or 'none'}")
else:
    fb, fa = fences(before), fences(after)
    changed_f = [i for i, (x, y) in enumerate(zip(fb, fa)) if x != y]
    print(f"\n## fenced code blocks: {len(fb)} → {len(fa)}; changed indices: {changed_f or 'none'}")
    gb, ga = figures(before), figures(after)
    changed_g = [i for i, (x, y) in enumerate(zip(gb, ga)) if x != y]
    print(f"## figures: {len(gb)} → {len(ga)}; changed indices: {changed_g or 'none'}")
