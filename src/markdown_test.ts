import { assertEquals, assertThrows } from "@std/assert";
import {
  extractSubsection,
  findCallout,
  promoteHeadings,
  replaceSubsection,
  sectionIds,
  splitFrontmatter,
  splitSections,
} from "./markdown.ts";

const DOC = `---
title: "T"
---

Intro text.

## First {#first}

Body one.

\`\`\`md
## Not a heading {#nope}
\`\`\`

### Sub

Deep.

## Second {#second}

Body two.
`;

Deno.test("frontmatter splits from the body", () => {
  const { data, body } = splitFrontmatter(DOC);
  assertEquals(data.title, "T");
  assertEquals(body.startsWith("\nIntro text."), true);
});

Deno.test("sections split at ## {#id} headings, ignoring fenced code", () => {
  const { preamble, sections } = splitSections(splitFrontmatter(DOC).body);
  assertEquals(preamble.trim(), "Intro text.");
  assertEquals(sections.map((s) => [s.id, s.title]), [["first", "First"], ["second", "Second"]]);
  assertEquals(sections[0].body.includes("## Not a heading {#nope}"), true);
  assertEquals(sectionIds(splitFrontmatter(DOC).body), ["first", "second"]);
});

Deno.test("promotion raises headings but not code", () => {
  const md = "### Sub\n\n```md\n### code\n```\n\n#### Deeper";
  assertEquals(promoteHeadings(md), "## Sub\n\n```md\n### code\n```\n\n### Deeper");
});

Deno.test("a ### subsection lifts out up to the next heading", () => {
  const md = "### A\n\na\n\n### Release notes\n\nrn\n\n### C\n\nc";
  const { rest, extracted } = extractSubsection(md, "Release notes");
  assertEquals(extracted, "rn");
  assertEquals(rest, "### A\n\na\n\n### C\n\nc");
  assertThrows(() => extractSubsection(md, "Missing"));
});

Deno.test("a subsection body can be replaced in place, keeping its heading", () => {
  const md = "### A\n\na\n\n### Release notes\n\nrn\n\n### C\n\nc";
  assertEquals(
    replaceSubsection(md, "Release notes", "See Appendix C."),
    "### A\n\na\n\n### Release notes\n\nSee Appendix C.\n\n### C\n\nc",
  );
});

Deno.test("a callout is found by its title and ends at the first non-quote line", () => {
  const md = "x\n\n> [!WARNING] Warn · upgrade cliffs\n>\n> - rule\n\nafter";
  assertEquals(findCallout(md, "upgrade cliffs"), "> [!WARNING] Warn · upgrade cliffs\n>\n> - rule");
});
