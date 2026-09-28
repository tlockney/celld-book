import { assert, assertEquals } from "@std/assert";
import { unzipSync } from "fflate";
import { absolute, labsZip, notebookForDownload, rewriteMarkdown } from "./downloads.ts";
import type { Resolver } from "./xref.ts";
import type { Notebook } from "../vendor/bench-sheet/render-notebook.ts";

const SITE = "https://example.test/book/";
const r: Resolver = {
  fg: (n) => ({ label: `Chapter ${n}`, href: `ch${n}.html` }),
  part0: (n) => ({ label: `Chapter 1 § 0${n}`, href: `foundations.html#s${n}` }),
  step: (n) => ({ label: `Step ${n}`, href: `building.html#step${n}` }),
  lab: (n, p) => ({ label: `Lab ${n}`, href: `lab-${n}.html${p ? `#part-${p}` : ""}` }),
  local: () => undefined,
  part: () => undefined,
};

Deno.test("relative and anchor hrefs become absolute site URLs", () => {
  assertEquals(absolute("ch4.html", SITE, "lab-1.html"), "https://example.test/book/ch4.html");
  assertEquals(absolute("#cell-3", SITE, "lab-1.html"), "https://example.test/book/lab-1.html#cell-3");
  assertEquals(absolute("https://x.test/", SITE, "lab-1.html"), "https://x.test/");
});

Deno.test("series references become linked book references; code and links are untouched", () => {
  const md = "See Part 1 § 04 and `Part 1 § 04` and [Part 1 § 04](keep).\n```ts\n// Part 1 § 04\n```\nthe series";
  assertEquals(
    rewriteMarkdown(md, r, SITE, "lab-1.html", [["the series", "the book"]]),
    "See [Chapter 4](https://example.test/book/ch4.html) and `Part 1 § 04` and [Part 1 § 04](keep).\n```ts\n// Part 1 § 04\n```\nthe book",
  );
});

Deno.test("a lab's own bare 'Part 2' is left alone", () => {
  assertEquals(rewriteMarkdown("Respect Part 2: no await", r, SITE, "lab-1.html"), "Respect Part 2: no await");
});

Deno.test("only markdown cells change; code, outputs, and variants are handled", () => {
  const nb: Notebook = {
    cells: [
      {
        cell_type: "markdown",
        source: ["<!-- series-only -->S<!-- /series-only --><!-- book-only -->B<!-- /book-only --> Part 1 § 02"],
      },
      {
        cell_type: "code",
        source: "// Part 1 § 02",
        outputs: [{ output_type: "stream", name: "stdout", text: "Part 1 § 02" }],
      },
    ],
  } as Notebook;
  const out = notebookForDownload(nb, r, SITE, "lab-1.html");
  assertEquals(out.cells[0].source, "B [Chapter 2](https://example.test/book/ch2.html)");
  assertEquals(out.cells[1], nb.cells[1]);
});

Deno.test("the labs zip holds every file under one folder", () => {
  const zip = labsZip({ "celld_nb.ts": new TextEncoder().encode("export {}"), "a.ipynb": new Uint8Array([1, 2]) });
  const files = unzipSync(zip);
  assertEquals(Object.keys(files).sort(), ["celld-labs/a.ipynb", "celld-labs/celld_nb.ts"]);
  assert(new TextDecoder().decode(files["celld-labs/celld_nb.ts"]) === "export {}");
});
