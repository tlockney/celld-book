"""Check the built downloads: notebooks keep code/outputs byte-identical, prose uses book references
with absolute links, no variant markers leak, the zip is complete, and the lab pages link them."""
import io
import json
import re
import sys
import zipfile

ROOT = __file__.rsplit("/tools/", 1)[0] + "/"
LABS = ["celld-01-cells", "celld-02-bindings", "celld-03-processes"]
bad = 0


def check(label: str, ok: bool, detail: str = "") -> None:
    global bad
    bad += not ok
    print(f"{'ok  ' if ok else 'FAIL'} {label}{' — ' + detail if detail else ''}")


for n in LABS:
    src = json.load(open(f"{ROOT}content/labs/{n}.ipynb"))
    out = json.load(open(f"{ROOT}dist/labs/{n}.ipynb"))
    code_in = [(c["source"], c.get("outputs")) for c in src["cells"] if c["cell_type"] == "code"]
    code_out = [(c["source"], c.get("outputs")) for c in out["cells"] if c["cell_type"] == "code"]
    check(f"{n}: code cells and outputs identical to the executed notebook", code_in == code_out, f"{len(code_out)} code cells")
    md = "\n".join("".join(c["source"]) if isinstance(c["source"], list) else c["source"]
                   for c in out["cells"] if c["cell_type"] == "markdown")
    check(f"{n}: no variant markers", "-only -->" not in md)
    prose = re.sub(r"```[\s\S]*?```|`[^`\n]*`", " ", md)
    stale = re.findall(r"Part [012] §|Part 2 Step|Notebook \d", prose)
    check(f"{n}: no series-style references left", not stale, ", ".join(stale[:3]))
    links = re.findall(r"\]\((https://[^)]+)\)", md)
    check(f"{n}: book references link to the live site", len(links) > 0 and all(l.startswith("https://tlockney.github.io/celld-book/") for l in links),
          f"{len(links)} links, e.g. {links[0] if links else '-'}")
    check(f"{n}: setup cell still imports ./celld_nb.ts", any('"./celld_nb.ts"' in (c["source"] if isinstance(c["source"], str) else "".join(c["source"]))
                                                             for c in out["cells"] if c["cell_type"] == "code"))

z = zipfile.ZipFile(io.BytesIO(open(f"{ROOT}dist/labs/celld-labs.zip", "rb").read()))
names = sorted(z.namelist())
want = sorted([f"celld-labs/{n}.ipynb" for n in LABS] + ["celld-labs/celld_nb.ts", "celld-labs/README.txt"])
check("zip holds the three labs, the helper, and a README under celld-labs/", names == want, ", ".join(names))
check("zip's helper matches labs/celld_nb.ts", z.read("celld-labs/celld_nb.ts") == open(f"{ROOT}labs/celld_nb.ts", "rb").read())

for i, n in enumerate(LABS, 1):
    page = open(f"{ROOT}dist/lab-{i}.html").read()
    for f in (f"{n}.ipynb", "celld_nb.ts", "celld-labs.zip"):
        check(f"lab-{i}.html links labs/{f} as a download", any(f'href="labs/{f}"' in t and f'download="{f}"' in t for t in re.findall(r"<a\b[^>]*>", page)))
intro = open(f"{ROOT}dist/introduction.html").read()
check("introduction links the labs zip", 'href="labs/celld-labs.zip"' in intro)
sys.exit(1 if bad else 0)
