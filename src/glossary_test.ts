import { assertEquals } from "@std/assert";
import { markTerms, parseGlossary, plainInline, type Term } from "./glossary.ts";

const TABLE = `| Term | Meaning | See |
|----|----|----|
| **Cell** | A Durable Object instance: a small server with a private SQLite database. | [§ 02](#cell-model) |
| **Fleet** | The set of nodes sharing one fleet bucket. | [§ 03](#bucket-coordinator) |
| **Fleet bucket** | The object-storage bucket a fleet shares. | [§ 03](#bucket-coordinator) |
| **Durability mode** | \`CELLD_DURABILITY\`: *fleet* or bucket. | [§ 03](#x) |`;

Deno.test("glossary rows parse to term and plain definition", () => {
  const t = parseGlossary(TABLE);
  assertEquals(t.map((x) => x.term), ["Cell", "Fleet", "Fleet bucket", "Durability mode"]);
  assertEquals(t[3].def, "CELLD_DURABILITY: fleet or bucket.");
});

Deno.test("plainInline strips links, code, and emphasis", () => {
  assertEquals(plainInline("A [link](x) with `code` and **bold** _it_"), "A link with code and bold it");
});

const terms: Term[] = parseGlossary(TABLE);

Deno.test("first occurrence only, longest term first, case-insensitive", () => {
  const used = new Set<string>();
  const segs = markTerms("The fleet bucket holds the fleet's cells. A fleet grows.", terms, used);
  assertEquals(segs, [
    "The ",
    { text: "fleet bucket", term: terms[2] },
    " holds the ",
    { text: "fleet", term: terms[1] },
    "'s ",
    { text: "cells", term: terms[0] },
    ". A fleet grows.",
  ]);
  // Marked once per page: a second text node gets nothing new.
  assertEquals(markTerms("Another cell in the fleet.", terms, used), ["Another cell in the fleet."]);
});

Deno.test("whole words only", () => {
  assertEquals(markTerms("cellar and excellent", terms, new Set()), ["cellar and excellent"]);
});
