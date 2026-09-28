"""Carry executed outputs into a notebook regenerated from rewritten prose.

    transplant.py EXECUTED.ipynb REGENERATED.ipynb OUT.ipynb

The regenerated notebook comes from a generator whose code() cells are unchanged, so its
code cells must match the executed notebook's code cells one-for-one and byte-for-byte.
If they do, each code cell takes the executed cell's outputs and execution_count, markdown
cells take the regenerated prose, and notebook metadata comes from the executed notebook.
Any mismatch aborts without writing.
"""
import json
import sys

executed_path, regen_path, out_path = sys.argv[1:4]
executed = json.load(open(executed_path))
regen = json.load(open(regen_path))


def src(c: dict) -> str:
    s = c["source"]
    return "".join(s) if isinstance(s, list) else s


ex_code = [c for c in executed["cells"] if c["cell_type"] == "code"]
re_code = [c for c in regen["cells"] if c["cell_type"] == "code"]
if len(ex_code) != len(re_code):
    sys.exit(f"code cell count differs: executed {len(ex_code)} vs regenerated {len(re_code)}")
for i, (a, b) in enumerate(zip(ex_code, re_code)):
    if src(a) != src(b):
        sys.exit(f"code cell {i} source differs; refusing to transplant outputs")

it = iter(ex_code)
ex_md = [c for c in executed["cells"] if c["cell_type"] == "markdown"]
re_md_count = sum(1 for c in regen["cells"] if c["cell_type"] == "markdown")
md_ids = iter(c.get("id") for c in ex_md) if len(ex_md) == re_md_count else None
cells = []
for c in regen["cells"]:
    if c["cell_type"] == "code":
        e = next(it)
        c = dict(c, outputs=e.get("outputs", []), execution_count=e.get("execution_count"))
        if "metadata" in e:
            c["metadata"] = e["metadata"]
        if e.get("id"):
            c["id"] = e["id"]
    elif md_ids is not None:
        mid = next(md_ids)
        if mid:
            c = dict(c, id=mid)
    cells.append(c)

out = dict(executed, cells=cells)
json.dump(out, open(out_path, "w"), indent=1, ensure_ascii=False)
md_before = sum(1 for c in executed["cells"] if c["cell_type"] == "markdown")
md_after = sum(1 for c in cells if c["cell_type"] == "markdown")
print(f"ok: {len(re_code)} code cells carried over; markdown cells {md_before} → {md_after}; wrote {out_path}")
