"""One-off figure label fixes (2026-09-28), found while restyling the diagrams:
- version history left in labels (the prose rewrite had kept figures untouched);
- the Resident box's cost label overflowing its 200px box;
- spaced em dashes in label text, to the series' unspaced house style.
Every replacement must match exactly once (or the stated count)."""
import re

S = __file__.rsplit("/tools/", 1)[0] + "/content/series/"


def edit(path: str, pairs: list[tuple[str, str, int]]) -> None:
    s = open(path).read()
    for a, b, n in pairs:
        c = s.count(a)
        assert c == n, (path, a[:70], c, n)
        s = s.replace(a, b)
    open(path, "w").write(s)
    print(f"{path.rsplit('/', 1)[1]}: {sum(n for *_, n in pairs)} label edit(s)")


def unspace_svg_dashes(path: str) -> None:
    s = open(path).read()
    n = 0

    def fix(m: re.Match) -> str:
        nonlocal n
        out = re.sub(r"(>[^<]*?) — ([^<]*<)", lambda t: t.group(1) + "—" + t.group(2), m.group(0))
        while out != (out2 := re.sub(r"(>[^<]*?) — ([^<]*<)", lambda t: t.group(1) + "—" + t.group(2), out)):
            out = out2
        n += m.group(0).count(" — ") - out.count(" — ")
        return out

    s = re.sub(r"<svg\b.*?</svg>", fix, s, flags=re.S)
    open(path, "w").write(s)
    print(f"{path.rsplit('/', 1)[1]}: {n} spaced em dash(es) in figure text made unspaced")


FG = S + "celld-durable-objects.md"
GUIDE = S + "celld-step-by-step.md"

edit(FG, [
    (">v0.4.0, versioned</text>", ">versioned</text>", 1),
    ("balancing (v0.4.1) hands it", "balancing hands it", 1),
    ("adoption in place, no restart (v0.4.0)", "adoption in place, no restart", 1),
    ("yes · since v0.4.0", "graded Yes", 4),
    ("yes · from the start", "graded Yes", 1),
    ('<text class="m" font-size="8.5" text-anchor="middle" x="440" y="216" style="fill:var(--ink-2, #4a5763)">~1,000 per 8 GB node · ≈ $0.05/month each</text>',
     '<text class="m" font-size="8.5" text-anchor="middle" x="440" y="212" style="fill:var(--ink-2, #4a5763)">~1,000 per 8 GB node</text>\n'
     '<text class="m" font-size="8.5" text-anchor="middle" x="440" y="226" style="fill:var(--ink-2, #4a5763)">≈ $0.05/month each</text>', 1),
])
unspace_svg_dashes(FG)
unspace_svg_dashes(GUIDE)
