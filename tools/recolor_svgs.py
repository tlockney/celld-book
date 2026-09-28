"""Restyle the inline SVG figures for the bench sheet: map the old editorial palette (evergreen, ochre,
parchment, warm grays) onto bench-sheet's color tokens, so the diagrams follow the page's light and dark
themes. Colors become inline `style` properties with a light fallback, e.g.
`style="fill:var(--ink, #1b252e)"`, because SVG presentation attributes cannot take var().

    python3 tools/recolor_svgs.py content/series/celld-durable-objects.md content/series/celld-step-by-step.md

Refuses to write a file if it meets a color it has no mapping for.
"""
import re
import sys

TOKENS = {  # bench-sheet token -> its light-theme value (the fallback)
    "ink": "#1b252e", "ink-2": "#4a5763", "ink-3": "#7b8791", "rule": "#d3d9d4",
    "plate": "#e6ebeb", "paper-2": "#ebeee9", "cobalt": "#2a56a0",
}
# (property, role) -> old color -> token. Text and shapes map differently: the same warm gray is
# detail text on a <text> (needs contrast) but a connector on a <path> (should recede).
TEXT_FILL = {"#142822": "ink", "#1f3a32": "ink", "#3a3a36": "ink-2", "#6b6357": "ink-2",
             "#8a7e5e": "ink-3", "#a85a1a": "cobalt"}
SHAPE_FILL = {"#ece4d2": "plate", "#e6dcc4": "plate", "#f3ecdd": "paper-2", "#6b6357": "ink-3",
              "#8a7e5e": "ink-3", "#a85a1a": "cobalt", "#142822": "ink", "#1f3a32": "ink-2",
              "#3a3a36": "ink-2", "#c9bfa3": "rule"}
SHAPE_STROKE = {"#1f3a32": "ink-2", "#142822": "ink", "#3a3a36": "ink-2", "#6b6357": "ink-3",
                "#8a7e5e": "ink-3", "#a85a1a": "cobalt", "#c9bfa3": "rule", "#ece4d2": "plate",
                "#f3ecdd": "paper-2"}

TAG = re.compile(r"<(text|tspan|rect|path|circle|ellipse|line|polyline|polygon|g|use)\b([^>]*?)(/?)>")
ATTR = re.compile(r'\s(fill|stroke)="(#[0-9a-fA-F]{3,6})"')


def css(token: str) -> str:
    return f"var(--{token}, {TOKENS[token]})"


def restyle_tag(m: re.Match, unknown: set) -> str:
    tag, attrs, close = m.group(1), m.group(2), m.group(3)
    decls = []

    def take(a: re.Match) -> str:
        prop, color = a.group(1), a.group(2).lower()
        table = (TEXT_FILL if tag in ("text", "tspan") else SHAPE_FILL) if prop == "fill" else SHAPE_STROKE
        token = table.get(color)
        if token is None:
            unknown.add(f"{tag} {prop}={color}")
            return a.group(0)
        decls.append(f"{prop}:{css(token)}")
        return ""

    attrs = ATTR.sub(take, attrs)
    if not decls:
        return m.group(0)
    style = re.search(r'\sstyle="([^"]*)"', attrs)
    if style:
        merged = style.group(1).rstrip(";") + ";" + ";".join(decls)
        attrs = attrs[:style.start()] + f' style="{merged}"' + attrs[style.end():]
    else:
        attrs += f' style="{";".join(decls)}"'
    return f"<{tag}{attrs}{close}>"


for path in sys.argv[1:]:
    s = open(path).read()
    unknown: set = set()
    count = [0]

    def svg(m: re.Match) -> str:
        count[0] += 1
        return TAG.sub(lambda t: restyle_tag(t, unknown), m.group(0))

    out = re.sub(r"<svg\b.*?</svg>", svg, s, flags=re.S)
    if unknown:
        sys.exit(f"{path}: unmapped colors, nothing written: {sorted(unknown)}")
    left = len(re.findall(r'(?:fill|stroke)="#[0-9a-fA-F]{3,6}"', re.sub(r"(?s)^.*?(?=<svg)", "", out)))
    open(path, "w").write(out)
    print(f"{path}: restyled {count[0]} svg(s); hard-coded colors left in svgs: {left}")
