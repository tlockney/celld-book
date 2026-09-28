"""Apply a markdown-only text replacement to a lab, in its generator AND its executed notebook,
so the two stay in step and the executed outputs are untouched.

    python3 tools/lab_prose_edit.py <edits.json>

edits.json: [{"lab": "celld-01-cells", "gen": "build_01.py", "from": "...", "to": "..."}, ...]
Every "from" must occur exactly once in the generator's md() blocks and exactly once across the
notebook's markdown cells; otherwise nothing is written for that lab.
"""
import json
import re
import sys

R = __file__.rsplit("/tools/", 1)[0] + "/"
edits = json.load(open(sys.argv[1]))
by_lab: dict[str, list[dict]] = {}
for e in edits:
    by_lab.setdefault(e["lab"], []).append(e)

for lab, es in by_lab.items():
    gen_path = R + "labs/" + es[0]["gen"]
    nb_path = R + f"content/labs/{lab}.ipynb"
    gen = open(gen_path).read()
    nb = json.load(open(nb_path))
    md_blocks = "\n".join(re.findall(r"md\(r'''(.*?)'''\)", gen, re.S))
    md_cells = ["".join(c["source"]) if isinstance(c["source"], list) else c["source"]
                for c in nb["cells"] if c["cell_type"] == "markdown"]
    for e in es:
        assert md_blocks.count(e["from"]) == 1, (lab, "generator", e["from"])
        assert sum(c.count(e["from"]) for c in md_cells) == 1, (lab, "notebook", e["from"])
        assert gen.count(e["from"]) == 1, (lab, "generator outside md()", e["from"])
    for e in es:
        gen = gen.replace(e["from"], e["to"])
        for c in nb["cells"]:
            if c["cell_type"] != "markdown":
                continue
            src = c["source"]
            joined = "".join(src) if isinstance(src, list) else src
            if e["from"] in joined:
                joined = joined.replace(e["from"], e["to"])
                c["source"] = joined.splitlines(keepends=True) if isinstance(src, list) else joined
    open(gen_path, "w").write(gen)
    json.dump(nb, open(nb_path, "w"), indent=1, ensure_ascii=False)
    print(f"{lab}: {len(es)} edit(s) applied to generator and notebook")
